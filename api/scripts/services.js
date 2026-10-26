// Nhập điểm dịch vụ: ATM, ngân hàng (chỉ 5 ngân hàng), cây xăng, trạm sạc.
//
// Nguồn (xem crawl-services.js):
//  - Vietcombank, Agribank: website ngân hàng (chính thức)          -> data/raw/services_gialai.json
//  - MB: ghi lại từ trang bản đồ của MB (API chặn truy cập tự động) -> data/raw/mb_gialai.json
//  - BIDV, VietinBank, cây xăng, trạm sạc: OpenStreetMap            -> data/raw/services_gialai.json
// Với ngân hàng có nguồn chính thức, bản ghi OSM cùng ngân hàng chỉ được giữ khi không có điểm chính thức nào trong 150 m.
import { readFile } from 'node:fs/promises';

export const SERVICE_CATEGORIES = [
  { slug: 'atm', name: 'ATM', icon: '🏧' },
  { slug: 'ngan-hang', name: 'Ngân hàng', icon: '🏦' },
  { slug: 'cay-xang', name: 'Cây xăng', icon: '⛽' },
  { slug: 'tram-sac', name: 'Trạm sạc', icon: '🔌' },
];
const CATEGORY_OF_KIND = { atm: 'atm', bank: 'ngan-hang', fuel: 'cay-xang', charging: 'tram-sac' };

/** Chỉ lấy 5 ngân hàng theo yêu cầu; tên thương hiệu chuẩn hoá từ brand/operator/name. */
const BANKS = [
  ['Vietcombank', /vietcombank|ngoại thương|ngoai thuong|\bvcb\b/i],
  ['BIDV', /\bbidv\b|đầu tư và phát triển|dau tu va phat trien/i],
  ['Agribank', /agribank|nông nghiệp|nong nghiep/i],
  ['VietinBank', /vietinbank|vietin|công thương|cong thuong/i],
  ['MB', /\bmb\b|mbbank|mb bank|quân đội|quan doi/i],
];
const OFFICIAL = new Set(['Vietcombank', 'Agribank', 'MB']);

function bankOf(...texts) {
  const s = texts.filter(Boolean).join(' ');
  return BANKS.find(([, re]) => re.test(s))?.[0] ?? null;
}

const ALL_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const hours247 = () => Object.fromEntries(ALL_DAYS.map((d) => [d, '00:00-23:59']));
const is247 = (h) => !!h && /24\s*\/\s*7|247/.test(h);

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Gom tất cả nguồn về một dạng thống nhất. */
async function collect(rawDir) {
  const items = [];
  const svc = await readJson(`${rawDir}/services_gialai.json`);
  for (const it of svc?.items ?? []) {
    if (it.kind === 'atm' || it.kind === 'bank') {
      const brand = bankOf(it.brand, it.name);
      if (!brand) continue; // ngoài 5 ngân hàng -> bỏ
      if (it.source === 'osm' && OFFICIAL.has(brand)) it.fallbackOnly = true;
      it.brand = brand;
      const label = it.kind === 'atm' ? 'ATM' : 'Ngân hàng';
      if (it.source === 'osm') it.name = it.name && bankOf(it.name) ? it.name : `${label} ${brand}`;
    } else if (it.kind === 'fuel') {
      it.name = it.name ?? (it.brand ? `Cây xăng ${it.brand}` : 'Cây xăng');
    } else if (it.kind === 'charging') {
      it.name = it.name ?? (it.brand ? `Trạm sạc ${it.brand}` : 'Trạm sạc xe điện');
    }
    items.push(it);
  }

  const mb = await readJson(`${rawDir}/mb_gialai.json`);
  for (const [list, id, name, address, lat, lng, desc] of mb?.rows ?? []) {
    const la = Number(lat);
    const lo = Number(lng);
    if (!Number.isFinite(la) || !Number.isFinite(lo) || !la || !lo) continue;
    const kind = list === 'lstBrank' ? 'bank' : 'atm';
    items.push({
      source: 'mb',
      sourceRef: `mb:${list}:${id}`,
      kind,
      brand: 'MB',
      name: kind === 'bank' ? `MB – ${name}` : `${name.replace(/^MB\s*/i, '')} (MB)`,
      address,
      phone: (/(?:ĐT|Số điện thoại):\s*([\d.\s]+)/.exec(desc ?? '') ?? [])[1]?.trim() ?? null,
      hours: desc || null,
      note: list === 'lstSmartBank' ? 'MB SmartBank: giao dịch tự động 24/7' : /^CRM/.test(name) ? 'Máy nộp/rút tiền tự động (CRM)' : null,
      lng: lo,
      lat: la,
    });
  }
  return items;
}

export async function importServices(db, rawDir) {
  const items = await collect(rawDir);
  if (!items.length) return null;

  const { rows: base } = await db.query(`SELECT coalesce(max(sort_order), 0) AS m FROM categories`);
  const catId = {};
  for (const [i, c] of SERVICE_CATEGORIES.entries()) {
    const { rows } = await db.query(
      `INSERT INTO categories (id, slug, name, icon, is_accommodation, sort_order)
       VALUES (md5('cat:' || $1)::uuid, $1, $2, $3, false, $4)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, icon = EXCLUDED.icon RETURNING id`,
      [c.slug, c.name, c.icon, base[0].m + 1 + i],
    );
    catId[c.slug] = rows[0].id;
  }

  // Bảng tạm để lọc theo ranh giới tỉnh + bỏ trùng bằng PostGIS
  await db.query(`CREATE TEMP TABLE svc_stage (ref text PRIMARY KEY, source text, kind text, brand text, name text, address text,
    phone text, hours text, note text, fallback boolean, geom geometry(Point, 4326)) ON COMMIT DROP`);
  for (const it of items) {
    await db.query(
      `INSERT INTO svc_stage VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, ST_SetSRID(ST_MakePoint($11,$12),4326)) ON CONFLICT DO NOTHING`,
      [it.sourceRef, it.source, it.kind, it.brand, it.name, it.address, it.phone, it.hours, it.note, !!it.fallbackOnly, it.lng, it.lat],
    );
  }

  const { rows } = await db.query(`
    SELECT s.*, ST_X(s.geom) AS lng, ST_Y(s.geom) AS lat, a.code AS area_code, a.full_name AS area_name
    FROM svc_stage s
    JOIN province p ON ST_Contains(p.geom, s.geom)
    LEFT JOIN admin_units a ON ST_Contains(a.geom, s.geom)
    WHERE NOT (s.fallback AND EXISTS (
      SELECT 1 FROM svc_stage o
      WHERE NOT o.fallback AND o.brand = s.brand AND o.kind = s.kind
        AND ST_DWithin(o.geom::geography, s.geom::geography, 150)))`);

  const count = {};
  for (const r of rows) {
    const slug = CATEGORY_OF_KIND[r.kind];
    const official = r.source !== 'osm';
    const desc = [r.note, r.hours && !is247(r.hours) ? `Giờ giao dịch: ${r.hours}` : null].filter(Boolean).join(' · ') || null;
    // điểm không tên trên OSM ("Cây xăng") -> thêm xã/phường để phân biệt trong kết quả tìm kiếm
    if (/^(Cây xăng|Trạm sạc xe điện)$/.test(r.name) && r.area_name) r.name = `${r.name} (${r.area_name})`;
    await db.query(
      `INSERT INTO locations (id, name, category_id, admin_code, short_description, address, phone, opening_hours, tags, aliases,
          popularity, priority, source, source_ref, source_license, brand, location_status, geom, geom_3857)
       SELECT md5('svc:' || $1)::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, 20, 30, $11, $1, $12, $13, 'verified', g, ST_Transform(g, 3857)
       FROM (SELECT ST_SetSRID(ST_MakePoint($14, $15), 4326) AS g) s
       ON CONFLICT (id) DO NOTHING`,
      [
        r.ref,
        r.name,
        catId[slug],
        r.area_code,
        desc,
        [r.address, r.area_name, 'Gia Lai'].filter(Boolean).join(', '),
        r.phone,
        r.kind === 'atm' || is247(r.hours) ? JSON.stringify(hours247()) : null,
        [slug.replace('-', ' '), r.brand].filter(Boolean),
        [r.brand?.toLowerCase(), r.kind === 'atm' ? 'rut tien' : null, r.kind === 'fuel' ? 'xang dau do xang' : null,
         r.kind === 'charging' ? 'sac xe dien vinfast' : null].filter(Boolean),
        r.source,
        official ? `Dữ liệu từ website ${r.brand}` : 'ODbL 1.0 © OpenStreetMap contributors',
        r.brand,
        r.lng,
        r.lat,
      ],
    );
    const key = `${slug}${r.brand && slug !== 'cay-xang' && slug !== 'tram-sac' ? `:${r.brand}` : ''}`;
    count[key] = (count[key] ?? 0) + 1;
  }
  return count;
}
