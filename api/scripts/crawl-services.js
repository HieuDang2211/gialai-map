// Thu thập điểm dịch vụ: ATM, ngân hàng, cây xăng, trạm sạc trong tỉnh Gia Lai.
//
// Nguồn:
//  1. Website ngân hàng (dữ liệu chính thức, toạ độ chính xác):
//     - Vietcombank: API công khai của trang "Mạng lưới" (robots.txt cho phép), gồm điểm giao dịch, ATM, R-ATM.
//     - Agribank: file dữ liệu tĩnh của trang "ATM - Chi nhánh".
//     - MB: API chặn truy cập tự động (403) -> dữ liệu ghi lại từ trang bản đồ, lưu ở data/raw/mb_gialai.json.
//     - BIDV (trang chống bot), VietinBank (robots.txt chặn /api): KHÔNG thu thập từ website -> dùng OpenStreetMap.
//  2. OpenStreetMap (Overpass, ODbL): ATM/ngân hàng (lọc 5 ngân hàng lúc import), cây xăng, trạm sạc xe điện.
//
// Chạy trên máy (Node 22+):  node api/scripts/crawl-services.js
// Kết quả: data/raw/services_gialai.json (lọc theo ranh giới tỉnh + bỏ trùng diễn ra lúc import, trong PostGIS)
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/raw/services_gialai.json');
const UA = 'gialai-map-student-project/0.1 (Duy Tan University)';
const BBOX = { south: 12.5, west: 107.0, north: 15.0, east: 109.6 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- Vietcombank
const VCB = {
  url: 'https://www.vietcombank.com.vn/api/network/filterdataresult',
  province: '{E6467A8B-921B-4547-A627-5F6BDD139E79}', // Gia Lai (sau sáp nhập)
  chips: [
    { code: '{E57A2832-1BB1-4AAC-BCB6-5F2E30F723DC}', kind: 'bank' }, // Điểm giao dịch (CN/PGD)
    { code: '{5968EF13-5ADC-46EF-B94F-A7EA7C00977E}', kind: 'atm' }, // ATM
    { code: '{B21940D1-3408-4051-8532-1B0EA9827088}', kind: 'atm', cashIn: true }, // Nộp/rút tiền R-ATM
  ],
};

async function vietcombank() {
  const items = [];
  for (const chip of VCB.chips) {
    const res = await fetch(VCB.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({ Longitude: '', Latitude: '', l: 'vi-VN', ProvinceCode: VCB.province, Chip: chip.code }),
    });
    if (!res.ok) throw new Error(`Vietcombank ${res.status}`);
    const json = await res.json();
    for (const g of json.filterResults ?? []) {
      for (const b of g.branches) {
        const lng = Number(b.longitude);
        const lat = Number(b.latitude);
        if (!Number.isFinite(lng) || !Number.isFinite(lat) || !lng || !lat) continue;
        items.push({
          source: 'vietcombank',
          sourceRef: `vietcombank:${b.id}`,
          kind: chip.kind,
          brand: 'Vietcombank',
          name: chip.kind === 'atm' ? `${chip.cashIn ? 'R-ATM' : 'ATM'} Vietcombank – ${b.title}` : `Vietcombank – ${b.branch_name ?? b.title}`,
          address: b.address?.replace(/\s+/g, ' ').trim() ?? null,
          phone: b.phone ?? null,
          hours: b.services_hour ?? null,
          note: chip.cashIn ? 'Máy nộp/rút tiền tự động (R-ATM)' : null,
          lng,
          lat,
        });
      }
    }
    await sleep(1500); // lịch sự với máy chủ ngân hàng
  }
  return items;
}

// ---------------------------------------------------------------- Agribank
// Trang "ATM - Chi nhánh" nạp toàn bộ mạng lưới từ một file JS tĩnh (biến arrBranch).
// Nhiều chi nhánh không có toạ độ -> bỏ qua (không đoán vị trí); "gialai" + "binhdinh" = tỉnh Gia Lai mới.
const AGRI_URL = 'https://www.agribank.com.vn/wcm/connect/f19a8ca1-0507-486d-aa95-cb78b559b142/atm-chi-nhanh.js?MOD=AJPERES&attachment=true&id=1570853146584';

async function agribank() {
  const res = await fetch(AGRI_URL, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Agribank ${res.status}`);
  const js = await res.text();
  const m = /var\s+arrBranch\s*=\s*(\[[\s\S]*?\]);/.exec(js);
  if (!m) throw new Error('Agribank: không tìm thấy arrBranch (trang đã đổi cấu trúc?)');
  return JSON.parse(m[1]).flatMap((b) => {
    if (!['gialai', 'binhdinh'].includes(b.city)) return [];
    const lng = Number(String(b.lng).trim());
    const lat = Number(String(b.lat).trim());
    if (!Number.isFinite(lng) || !Number.isFinite(lat) || !lng || !lat) return [];
    const isAtm = b.cn === 'atm' || /^ATM\b/i.test(b.title);
    return [{
      source: 'agribank',
      sourceRef: `agribank:${b.id}`,
      kind: isAtm ? 'atm' : 'bank',
      brand: 'Agribank',
      name: isAtm ? (/^ATM/i.test(b.title) ? `${b.title} (Agribank)` : `ATM Agribank – ${b.title}`) : `Agribank – ${b.title}`,
      address: b.address?.trim() || null,
      phone: b.phone || null,
      hours: b.time || null,
      note: null,
      lng,
      lat,
    }];
  });
}

const BANK_SOURCES = [vietcombank, agribank];

// ---------------------------------------------------------------- OpenStreetMap
const KIND = { atm: 'atm', bank: 'bank', fuel: 'fuel', charging_station: 'charging' };

async function openStreetMap() {
  const b = `${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east}`;
  const query = `[out:json][timeout:120];
(nwr["amenity"~"^(atm|bank|fuel|charging_station)$"](${b}););
out center tags;`;
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
    body: new URLSearchParams({ data: query }),
  });
  if (!res.ok) throw new Error(`Overpass ${res.status}`);
  const json = await res.json();
  return json.elements.flatMap((e) => {
    const t = e.tags ?? {};
    const lat = e.lat ?? e.center?.lat;
    const lng = e.lon ?? e.center?.lon;
    if (!lat || !lng) return [];
    const kind = KIND[t.amenity];
    const brand = t.brand ?? t.operator ?? null;
    const name = (t['name:vi'] ?? t.name)?.trim() || null;
    return [{
      source: 'osm',
      sourceRef: `${e.type}/${e.id}`,
      kind,
      brand,
      name,
      address: [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ') || null,
      phone: t.phone ?? t['contact:phone'] ?? null,
      hours: t.opening_hours ?? (t.atm === 'yes' || kind === 'atm' ? null : null),
      note: kind === 'charging' ? [t.socket && `Ổ sạc: ${t.socket}`, t.capacity && `${t.capacity} cổng`].filter(Boolean).join(' · ') || null : null,
      lng,
      lat,
    }];
  });
}

// ---------------------------------------------------------------- main
const items = [];
for (const src of BANK_SOURCES) {
  const got = await src();
  console.log(`${src.name}: ${got.length} điểm`);
  items.push(...got);
}
const osm = await openStreetMap();
console.log(`OpenStreetMap: ${osm.length} điểm`);
items.push(...osm);

await writeFile(OUT, JSON.stringify({
  fetchedAt: new Date().toISOString(),
  sources: {
    vietcombank: 'https://www.vietcombank.com.vn/vi-VN/Mang-luoi',
    osm: 'OpenStreetMap (Overpass API), ODbL 1.0',
  },
  items,
}, null, 1));

const count = {};
for (const i of items) count[`${i.source}:${i.kind}`] = (count[`${i.source}:${i.kind}`] ?? 0) + 1;
console.log(count, '->', path.relative(process.cwd(), OUT));
