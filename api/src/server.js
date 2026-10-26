import Fastify from 'fastify';
import { pool, meili } from './lib.js';
import { registerRouting } from './routing.js';
import { ensureReportSchema, registerReports, tilesVersion } from './reports.js';

// trustProxy: 1 -> req.ip lấy địa chỉ do gateway (nginx) thêm vào X-Forwarded-For, không tin phần client tự gửi
const app = Fastify({ logger: { level: 'info' }, trustProxy: 1 });

const num = (v) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

// /api/route, /api/trip (OSRM) + bộ xử lý lỗi chung
registerRouting(app);

// /api/locations/:id/reports (báo sai vị trí) + /api/review/* (người kiểm tra)
await ensureReportSchema();
registerReports(app);

app.get('/api/health', async () => ({ ok: true }));

// Cấu hình phía client. Key Google lộ ra trình duyệt là bình thường với Map Tiles API,
// nhưng PHẢI giới hạn key theo HTTP referrer + chỉ cho phép Map Tiles API trong Google Cloud Console.
// tilesVersion đổi sau mỗi quyết định ở /review -> không cache lâu
app.get('/api/config', async (_req, reply) => {
  reply.header('Cache-Control', 'no-cache');
  return { googleMapsKey: process.env.GOOGLE_MAPS_API_KEY || null, tilesVersion: await tilesVersion() };
});

app.get('/api/categories', async (_req, reply) => {
  const { rows } = await pool.query(`
    SELECT c.slug, c.name, c.icon, c.is_accommodation AS "isAccommodation", count(l.id)::int AS count
    FROM categories c LEFT JOIN locations l ON l.category_id = c.id AND l.is_active
    GROUP BY c.id HAVING count(l.id) > 0
    ORDER BY c.sort_order`);
  reply.header('Cache-Control', 'public, max-age=300');
  return rows;
});

/**
 * Tìm kiếm tức thì.
 *  q      : từ khoá (có/không dấu, gõ sai nhẹ đều được)
 *  cat    : slug danh mục
 *  area   : mã xã/phường
 *  lat,lng: vị trí người dùng hoặc tâm bản đồ -> xếp gần hơn lên trước (sau độ khớp văn bản)
 *  radius : km; khi có thì chỉ lấy trong bán kính quanh lat,lng ("Gần tôi")
 */
app.get('/api/search', async (req, reply) => {
  const { q = '', cat } = req.query;
  const lat = num(req.query.lat);
  const lng = num(req.query.lng);
  const radiusKm = num(req.query.radius);
  const limit = Math.min(num(req.query.limit) ?? 8, 50);
  const offset = num(req.query.offset) ?? 0;

  const filter = [];
  if (cat) filter.push(`categorySlug = ${JSON.stringify(String(cat))}`);
  const area = num(req.query.area);
  if (area !== null) filter.push(`areaCode = ${area}`);
  const hasGeo = lat !== null && lng !== null;
  if (hasGeo && radiusKm) filter.push(`_geoRadius(${lat}, ${lng}, ${Math.round(radiusKm * 1000)})`);

  const queries = [{
    indexUid: 'locations',
    q,
    limit,
    offset,
    filter,
    sort: hasGeo ? [`_geoPoint(${lat}, ${lng}):asc`] : q ? undefined : ['popularity:desc'],
    facets: ['categorySlug'],
    attributesToRetrieve: ['id', 'fid', 'name', 'categorySlug', 'categoryName', 'icon', 'areaName', 'address',
      'rating', 'reviewCount', 'image', '_geo'],
    attributesToHighlight: ['name'],
    highlightPreTag: '<mark>',
    highlightPostTag: '</mark>',
  }];
  // Gợi ý xã/phường (kể cả tên cũ trước sáp nhập) chỉ khi đang gõ từ khoá
  if (q.trim() && !cat && area === null && offset === 0) {
    queries.push({ indexUid: 'areas', q, limit: 3, matchingStrategy: 'all', attributesToRetrieve: ['id', 'fullName', 'type', 'mergedFrom', 'bbox', '_geo'] });
  }

  const { results } = await meili('/multi-search', { method: 'POST', body: { queries } });
  const [loc, areas] = results;

  reply.header('Cache-Control', 'public, max-age=30');
  return {
    query: q,
    total: loc.estimatedTotalHits,
    tookMs: loc.processingTimeMs,
    facets: loc.facetDistribution?.categorySlug ?? {},
    locations: loc.hits.map((h) => ({
      id: h.id,
      fid: h.fid,
      name: h.name,
      nameHtml: h._formatted?.name ?? h.name,
      category: h.categorySlug,
      categoryName: h.categoryName,
      icon: h.icon,
      areaName: h.areaName,
      address: h.address,
      rating: h.rating,
      reviewCount: h.reviewCount,
      image: h.image,
      lng: h._geo.lng,
      lat: h._geo.lat,
      distanceM: h._geoDistance ?? null,
    })),
    areas: (areas?.hits ?? []).map((a) => ({
      code: a.id,
      name: a.fullName,
      type: a.type,
      mergedFrom: a.mergedFrom,
      bbox: a.bbox,
      lng: a._geo.lng,
      lat: a._geo.lat,
    })),
  };
});

app.get('/api/locations/:id', async (req, reply) => {
  const { id } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.code(400).send({ error: 'id không hợp lệ' });

  const { rows } = await pool.query(`
    SELECT l.id, l.fid, l.name, l.short_description AS "shortDescription", l.description, l.address, l.phone,
           l.website, l.email, l.images, l.rating::float, l.review_count AS "reviewCount",
           l.opening_hours AS "openingHours", l.best_time AS "bestTime", l.check_in AS "checkIn",
           l.check_out AS "checkOut", l.price_range AS "priceRange", l.price_refs AS "priceRefs", l.tags,
           l.source, l.source_ref AS "sourceRef", l.source_license AS "sourceLicense", l.brand,
           l.location_status AS "locationStatus", l.location_note AS "locationNote",
           c.slug AS category, c.name AS "categoryName", c.icon,
           a.code AS "areaCode", a.full_name AS "areaName", a.merged_from AS "areaMergedFrom",
           ST_X(l.geom) AS lng, ST_Y(l.geom) AS lat
    FROM locations l
    LEFT JOIN categories c ON c.id = l.category_id
    LEFT JOIN admin_units a ON a.code = l.admin_code
    WHERE l.id = $1 AND l.is_active`, [id]);
  if (!rows.length) return reply.code(404).send({ error: 'Không tìm thấy địa điểm' });

  // Địa điểm lân cận trong 3 km: truy vấn bán kính thật trên server (ST_DWithin + chỉ mục GiST)
  const { rows: nearby } = await pool.query(`
    SELECT n.id, n.fid, n.name, c.icon, c.name AS "categoryName", n.rating::float,
           round(ST_Distance(n.geom::geography, l.geom::geography))::int AS "distanceM"
    FROM locations l
    JOIN locations n ON n.id <> l.id AND n.is_active
         AND ST_DWithin(n.geom::geography, l.geom::geography, 3000)
    LEFT JOIN categories c ON c.id = n.category_id
    WHERE l.id = $1
    ORDER BY n.geom::geography <-> l.geom::geography
    LIMIT 6`, [id]);

  reply.header('Cache-Control', 'public, max-age=300');
  return { ...rows[0], nearby };
});

app.get('/api/areas/:code', async (req, reply) => {
  const code = num(req.params.code);
  if (code === null) return reply.code(400).send({ error: 'mã không hợp lệ' });
  const { rows } = await pool.query(`
    SELECT a.code, a.full_name AS name, a.type, a.population, a.area_km2::float AS "areaKm2",
           a.density_km2::float AS "densityKm2", a.merged_from AS "mergedFrom", a.headquarter,
           ARRAY[ST_XMin(a.geom), ST_YMin(a.geom), ST_XMax(a.geom), ST_YMax(a.geom)] AS bbox,
           (SELECT count(*)::int FROM locations l WHERE l.admin_code = a.code AND l.is_active) AS "locationCount"
    FROM admin_units a WHERE a.code = $1`, [code]);
  if (!rows.length) return reply.code(404).send({ error: 'Không tìm thấy xã/phường' });
  reply.header('Cache-Control', 'public, max-age=3600');
  return rows[0];
});

await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 8080) });
