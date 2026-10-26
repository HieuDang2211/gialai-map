// Nhập cơ sở lưu trú từ OpenStreetMap (data/raw/osm_lodging_pleiku.json, tạo bởi crawl-osm.js).
// - Chỉ giữ điểm nằm trong 5 phường trung tâm TP Pleiku cũ
// - Bỏ trùng với địa điểm đã có (gần nhau + tên giống nhau)
// - Ghi nguồn + giấy phép ODbL trên từng bản ghi
import { readFile } from 'node:fs/promises';
import { ascii } from '../src/lib.js';

// Phường Pleiku, Diên Hồng, Thống Nhất, Hội Phú, An Phú
export const PLEIKU_CENTER_WARDS = [23575, 23563, 23584, 23586, 23602];

// Tên chung chung, không định danh được cơ sở cụ thể
const GENERIC_NAME = /^(khách sạn|khach san|hotel|nhà nghỉ|nha nghi|guest ?house|motel)(\s+(tại|ở|o|tai)\s+.*)?$/i;

function categoryOf(tags) {
  const n = ascii(tags.name);
  if (/homestay/.test(n)) return 'homestay';
  if (/nha nghi|guest ?house|motel|hostel/.test(n)) return 'nha-nghi';
  if (['guest_house', 'motel', 'hostel'].includes(tags.tourism)) return 'nha-nghi';
  return 'khach-san';
}

function addressOf(tags) {
  const street = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
  return street || null;
}

const STAR_ALIASES = { 'khach-san': ['khach san', 'hotel', 'luu tru'], 'nha-nghi': ['nha nghi', 'nha tro', 'guest house', 'luu tru'], homestay: ['homestay', 'luu tru'] };

export async function importOsmLodging(db, file) {
  let raw;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null; // chưa chạy crawl -> bỏ qua
  }

  await db.query(`CREATE TEMP TABLE osm_stage (ref text, name text, tags jsonb, geom geometry(Point, 4326)) ON COMMIT DROP`);
  for (const it of raw.items) {
    if (!it.tags.name || GENERIC_NAME.test(it.tags.name.trim())) continue;
    await db.query(`INSERT INTO osm_stage VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326))`, [
      `${it.osmType}/${it.osmId}`,
      (it.tags['name:vi'] ?? it.tags.name).trim(),
      JSON.stringify(it.tags),
      it.lng,
      it.lat,
    ]);
  }

  // Lọc theo ranh giới phường + đánh dấu trùng với dữ liệu đã có:
  // trùng = cơ sở lưu trú khác cách < 40 m, hoặc bất kỳ địa điểm nào cách < 250 m có tên giống >= 0.45 (không dấu)
  const { rows } = await db.query(
    `SELECT s.ref, s.name, s.tags, ST_X(s.geom) AS lng, ST_Y(s.geom) AS lat, a.code AS area_code, a.full_name AS area_name,
            (SELECT l.name FROM locations l LEFT JOIN categories c ON c.id = l.category_id
              WHERE ST_DWithin(l.geom::geography, s.geom::geography, 250)
                AND ((c.is_accommodation AND ST_DWithin(l.geom::geography, s.geom::geography, 40))
                     OR similarity(lower(unaccent(l.name)), lower(unaccent(s.name))) >= 0.45)
              ORDER BY l.geom::geography <-> s.geom::geography LIMIT 1) AS duplicate_of
     FROM osm_stage s
     JOIN admin_units a ON a.code = ANY($1) AND ST_Contains(a.geom, s.geom)`,
    [PLEIKU_CENTER_WARDS],
  );

  const { rows: cats } = await db.query(`SELECT id, slug FROM categories`);
  const catId = Object.fromEntries(cats.map((c) => [c.slug, c.id]));

  let inserted = 0;
  const duplicates = [];
  for (const r of rows) {
    if (r.duplicate_of) {
      duplicates.push(`${r.name} ≈ ${r.duplicate_of}`);
      continue;
    }
    const t = r.tags;
    const cat = categoryOf(t);
    const nameAscii = ascii(r.name);
    await db.query(
      `INSERT INTO locations (id, name, category_id, admin_code, address, phone, website, email, tags, aliases,
                              popularity, priority, source, source_ref, source_license, geom, geom_3857)
       SELECT md5('osm:' || $1)::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, 40, 45, 'osm', $1, 'ODbL 1.0 © OpenStreetMap contributors',
              g, ST_Transform(g, 3857)
       FROM (SELECT ST_SetSRID(ST_MakePoint($11, $12), 4326) AS g) s
       ON CONFLICT (id) DO NOTHING`,
      [r.ref, r.name, catId[cat], r.area_code, [addressOf(t), r.area_name, 'Gia Lai'].filter(Boolean).join(', '), t.phone ?? t['contact:phone'] ?? null, t.website ?? t['contact:website'] ?? null,
       t.email ?? null, ['lưu trú', 'pleiku'], [nameAscii, t['name:en'] ? ascii(t['name:en']) : null, ...STAR_ALIASES[cat]].filter(Boolean),
       r.lng, r.lat],
    );
    inserted++;
  }

  return { fetched: raw.items.length, inWards: rows.length, inserted, duplicates };
}
