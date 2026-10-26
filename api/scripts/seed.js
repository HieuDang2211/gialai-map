// ETL: đọc dữ liệu thô trong /data/raw -> PostGIS -> chỉ mục Meilisearch.
// Chạy lại bao nhiêu lần cũng được (xoá và nạp lại toàn bộ).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pool, meili, waitTask, ascii } from '../src/lib.js';
import { importOsmLodging } from './osm.js';
import { applyLocationCorrections } from './corrections.js';
import { importServices } from './services.js';
import { importSurvey } from './survey.js';

const RAW = process.env.RAW_DIR ?? '/data/raw';
const IMAGE_BASE = process.env.IMAGE_BASE_URL ?? '';
const readJson = async (f) => JSON.parse(await readFile(path.join(RAW, f), 'utf8'));

// Alias quá chung chung làm nhiễu kết quả (khớp mọi địa điểm) -> bỏ
const GENERIC_ALIASES = new Set(['gl', 'gia lai', 'gialai', 'tay nguyen', 'viet nam', 'vietnam']);

// Biểu thức chuẩn hoá hình học: sửa lỗi topo, ép về MultiPolygon 4326
const MULTI = `ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)), 3))`;

async function loadDatabase() {
  const districts = (await readJson('districts.json')).data;
  const categories = (await readJson('categories.json')).data.data;
  const locations = [
    ...(await readJson('locations_p1.json')).data.data,
    ...(await readJson('locations_p2.json')).data.data,
  ];

  const db = await pool.connect();
  try {
    // nâng cấp lược đồ cho DB tạo từ phiên bản trước
    await db.query(`ALTER TABLE locations
      ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'gialai-travel',
      ADD COLUMN IF NOT EXISTS source_ref text,
      ADD COLUMN IF NOT EXISTS source_license text,
      ADD COLUMN IF NOT EXISTS brand text,
      ADD COLUMN IF NOT EXISTS location_status text NOT NULL DEFAULT 'unverified',
      ADD COLUMN IF NOT EXISTS location_note text`);
    await db.query('BEGIN');
    await db.query('TRUNCATE locations, categories, admin_units, province RESTART IDENTITY CASCADE');

    // Tỉnh + mặt nạ "ngoài tỉnh"
    const boundary = districts.boundary;
    await db.query(
      `INSERT INTO province (code, name, geom, geom_3857, mask_3857)
       SELECT 52, $2, g, ST_Transform(g, 3857),
              ST_Difference(ST_MakeEnvelope(-20037508.34, -20037508.34, 20037508.34, 20037508.34, 3857), ST_Transform(g, 3857))
       FROM (SELECT ${MULTI} AS g) s`,
      [boundary.geoJsonData, 'Gia Lai'],
    );

    // Xã / phường
    for (const f of districts.districts.features.features) {
      const p = f.properties;
      await db.query(
        `INSERT INTO admin_units (code, name, full_name, type, province_code, population, area_km2, density_km2,
                                  merged_from, headquarter, geom, geom_3857, label_3857)
         SELECT $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, g, ST_Transform(g, 3857), ST_PointOnSurface(ST_Transform(g, 3857))
         FROM (SELECT ${MULTI} AS g) s`,
        [JSON.stringify(f.geometry), Number(p.ma_xa), p.ten_xa, `${p.loai} ${p.ten_xa}`, p.loai, Number(p.ma_tinh),
         p.dan_so ?? null, p.dtich_km2 ?? null, p.matdo_km2 ?? null, p.sap_nhap ?? null, p.tru_so ?? null],
      );
    }

    // Danh mục: chỉ giữ danh mục đang có địa điểm, sắp theo số lượng
    const sorted = [...categories].sort((a, b) => b._count.locations - a._count.locations);
    for (const [i, c] of sorted.entries()) {
      await db.query(
        `INSERT INTO categories (id, slug, name, icon, is_accommodation, sort_order) VALUES ($1,$2,$3,$4,$5,$6)`,
        [c.id, c.slug, c.name, c.icon, c.isAccommodation, i],
      );
    }

    for (const l of locations) {
      const code = Number(l.administrativeUnit?.officialCode) || null;
      await db.query(
        `INSERT INTO locations (id, name, category_id, admin_code, short_description, description, address, phone,
            website, email, images, rating, review_count, popularity, priority, opening_hours, best_time, check_in,
            check_out, price_range, price_refs, tags, aliases, is_active, geom, geom_3857)
         SELECT $1,$2,$3,(SELECT code FROM admin_units WHERE code = $4),$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
                $19,$20,$21,$22,$23,$24, g, ST_Transform(g, 3857)
         FROM (SELECT ST_SetSRID(ST_MakePoint($25, $26), 4326) AS g) s`,
        [l.id, l.name, l.category?.id ?? null, code, l.shortDescription, l.description, l.address, l.phone,
         l.website, l.email, (l.images ?? []).map((u) => (u.startsWith('/') ? IMAGE_BASE + u : u)),
         // nguồn có bản ghi rating = 0 nhưng vẫn có hàng trăm đánh giá -> coi là chưa có điểm
         l.rating > 0 ? l.rating : null, l.reviewCount ?? 0, l.popularityScore ?? 0, l.priorityScore ?? 0,
         l.openingHours ? JSON.stringify(l.openingHours) : null,
         l.bestTimeToVisit ? JSON.stringify(l.bestTimeToVisit) : null,
         l.checkInTime, l.checkOutTime, l.priceRange,
         l.priceReferences ? JSON.stringify(l.priceReferences) : null,
         l.tags ?? [],
         (l.normalizedAliases ?? []).filter((a) => !GENERIC_ALIASES.has(a) && !/^\d+$/.test(a)),
         l.isActive !== false, l.longitude, l.latitude],
      );
    }

    // Địa điểm thiếu mã xã -> gán theo vị trí (point-in-polygon)
    await db.query(
      `UPDATE locations l SET admin_code = a.code
       FROM admin_units a WHERE l.admin_code IS NULL AND ST_Contains(a.geom, l.geom)`,
    );

    // Hiệu chỉnh / đánh dấu toạ độ đã xác minh (verify-locations.py) — chạy TRƯỚC khi nhập OSM để so trùng đúng vị trí
    const fixes = await applyLocationCorrections(db, path.join(RAW, '..', 'corrections', 'locations.json'));

    // Bổ sung lưu trú trung tâm Pleiku cũ từ OpenStreetMap (nếu đã chạy crawl-osm.js)
    const osm = await importOsmLodging(db, path.join(RAW, 'osm_lodging_pleiku.json'));
    await db.query(`UPDATE locations SET location_status = 'verified' WHERE source = 'osm'`);

    // ATM, ngân hàng (5 ngân hàng), cây xăng, trạm sạc (nếu đã chạy crawl-services.js)
    const services = await importServices(db, RAW);

    // Kết quả khảo sát quán ăn (nếu đã chạy convert-survey.py) — chạy sau cùng để so với mọi nguồn khác
    const survey = await importSurvey(db, path.join(RAW, 'survey_quan_an_pleiku.json'));

    // Áp lại quyết định kiểm tra vị trí lần cuối: các mục "manual" của điểm OSM / ngân hàng / khảo sát
    // (sua_vi_tri_dia_diem.xlsx, trang /review) chỉ khớp được sau khi các nguồn đó đã nạp
    await applyLocationCorrections(db, path.join(RAW, '..', 'corrections', 'locations.json'));

    await db.query('COMMIT');
    console.log(`DB: ${districts.districts.features.features.length} xã/phường, ${categories.length} danh mục, ${locations.length} địa điểm`);
    if (fixes) console.log('Toạ độ:', fixes);
    if (services) console.log('Dịch vụ:', services);
    if (survey) console.log('Khảo sát quán ăn:', survey);
    if (osm) {
      console.log(`OSM: ${osm.fetched} thu thập, ${osm.inWards} trong 5 phường trung tâm, thêm ${osm.inserted}, trùng ${osm.duplicates.length}`);
      for (const d of osm.duplicates) console.log(`  trùng: ${d}`);
    }
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally {
    db.release();
  }
}

async function buildSearchIndexes() {
  const { rows: locs } = await pool.query(`
    SELECT l.id, l.fid, l.name, l.aliases, l.tags, l.address, l.short_description, l.rating, l.review_count,
           l.popularity, l.priority, l.images[1] AS image, l.price_range,
           c.slug AS cat, c.name AS cat_name, c.icon, c.is_accommodation,
           a.code AS area_code, a.full_name AS area_name,
           ST_Y(l.geom) AS lat, ST_X(l.geom) AS lng
    FROM locations l
    LEFT JOIN categories c ON c.id = l.category_id
    LEFT JOIN admin_units a ON a.code = l.admin_code
    WHERE l.is_active`);

  const locationDocs = locs.map((r) => ({
    id: r.id,
    fid: r.fid,
    name: r.name,
    nameAscii: ascii(r.name),
    aliases: r.aliases,
    tags: r.tags,
    categorySlug: r.cat,
    categoryName: r.cat_name,
    icon: r.icon,
    isAccommodation: r.is_accommodation ?? false,
    areaCode: r.area_code,
    areaName: r.area_name,
    address: r.address,
    shortDescription: r.short_description,
    rating: r.rating === null ? null : Number(r.rating),
    reviewCount: r.review_count,
    popularity: r.popularity,
    priceRange: r.price_range,
    image: r.image,
    _geo: { lat: r.lat, lng: r.lng },
  }));

  const { rows: areas } = await pool.query(`
    SELECT code, name, full_name, type, population, area_km2, merged_from,
           ST_XMin(geom) AS minx, ST_YMin(geom) AS miny, ST_XMax(geom) AS maxx, ST_YMax(geom) AS maxy,
           ST_X(ST_PointOnSurface(geom)) AS lng, ST_Y(ST_PointOnSurface(geom)) AS lat
    FROM admin_units`);

  const areaDocs = areas.map((r) => ({
    id: r.code,
    name: r.name,
    fullName: r.full_name,
    nameAscii: ascii(r.full_name),
    type: r.type,
    population: r.population,
    areaKm2: r.area_km2 === null ? null : Number(r.area_km2),
    mergedFrom: r.merged_from,
    mergedFromAscii: ascii(r.merged_from),
    bbox: [r.minx, r.miny, r.maxx, r.maxy],
    _geo: { lat: r.lat, lng: r.lng },
  }));

  await meili('/indexes/locations', { method: 'DELETE' }).catch(() => {});
  await meili('/indexes/areas', { method: 'DELETE' }).catch(() => {});
  await waitTask(await meili('/indexes', { method: 'POST', body: { uid: 'locations', primaryKey: 'id' } }));
  await waitTask(await meili('/indexes', { method: 'POST', body: { uid: 'areas', primaryKey: 'id' } }));

  // Xếp hạng: khớp văn bản trước, rồi khoảng cách (sort), cuối cùng mới đến độ phổ biến
  await waitTask(await meili('/indexes/locations/settings', {
    method: 'PATCH',
    body: {
      searchableAttributes: ['name', 'nameAscii', 'aliases', 'tags', 'categoryName', 'areaName', 'address', 'shortDescription'],
      filterableAttributes: ['categorySlug', 'areaCode', 'isAccommodation', 'priceRange', '_geo'],
      sortableAttributes: ['_geo', 'popularity', 'rating'],
      rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness', 'popularity:desc'],
      synonyms: {
        cafe: ['cà phê', 'coffee'], 'cà phê': ['cafe', 'coffee'], coffee: ['cafe', 'cà phê'], 'ca phe': ['cafe', 'coffee'],
        hotel: ['khách sạn'], 'khách sạn': ['hotel'], ks: ['khách sạn'],
        homestay: ['nhà nghỉ'], 'nhà nghỉ': ['homestay', 'nhà trọ'],
        'quán ăn': ['nhà hàng'], 'nhà hàng': ['quán ăn', 'restaurant'],
        thac: ['thác'], waterfall: ['thác'], chua: ['chùa'], pagoda: ['chùa'], market: ['chợ'],
      },
      // Âm tiết tiếng Việt ngắn (bin -> biển): cho phép 1 lỗi gõ từ từ 3 ký tự
      typoTolerance: { minWordSizeForTypos: { oneTypo: 3, twoTypos: 7 } },
      faceting: { maxValuesPerFacet: 50 },
      pagination: { maxTotalHits: 500 },
    },
  }));

  await waitTask(await meili('/indexes/areas/settings', {
    method: 'PATCH',
    body: {
      // mergedFrom: tìm được bằng tên xã/phường CŨ trước sáp nhập
      searchableAttributes: ['name', 'nameAscii', 'fullName', 'mergedFrom', 'mergedFromAscii'],
      filterableAttributes: ['type'],
    },
  }));

  await waitTask(await meili('/indexes/locations/documents', { method: 'POST', body: locationDocs }));
  await waitTask(await meili('/indexes/areas/documents', { method: 'POST', body: areaDocs }));
  console.log(`Meilisearch: ${locationDocs.length} địa điểm, ${areaDocs.length} xã/phường`);
}

try {
  await loadDatabase();
  await buildSearchIndexes();
} finally {
  await pool.end();
}
