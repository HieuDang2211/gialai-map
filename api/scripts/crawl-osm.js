// Thu thập cơ sở lưu trú (khách sạn, nhà nghỉ, homestay…) từ OpenStreetMap qua Overpass API.
// Dữ liệu OSM theo giấy phép ODbL: được dùng lại, phải ghi nguồn "© OpenStreetMap contributors".
//
// Chạy trên máy (Node 22+):  node api/scripts/crawl-osm.js
// Kết quả: data/raw/osm_lodging_pleiku.json (lọc theo ranh giới phường diễn ra lúc import, trong PostGIS)
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/raw/osm_lodging_pleiku.json');
const ENDPOINT = process.env.OVERPASS_URL ?? 'https://overpass-api.de/api/interpreter';

// Khung bao 5 phường trung tâm TP Pleiku cũ: Pleiku, Diên Hồng, Thống Nhất, Hội Phú, An Phú
const BBOX = { south: 13.88, west: 107.94, north: 14.065, east: 108.1 };
const TOURISM = ['hotel', 'guest_house', 'motel', 'hostel', 'apartment', 'chalet'];

const query = `
[out:json][timeout:60];
(
  nwr["tourism"~"^(${TOURISM.join('|')})$"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});
  nwr["building"="hotel"]["name"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});
);
out center tags;`;

const res = await fetch(ENDPOINT, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    // Overpass yêu cầu User-Agent nhận diện được
    'User-Agent': 'gialai-map-student-project/0.1 (Duy Tan University)',
  },
  body: new URLSearchParams({ data: query }),
});
if (!res.ok) throw new Error(`Overpass ${res.status}: ${(await res.text()).slice(0, 300)}`);
const json = await res.json();

const items = json.elements
  .map((e) => ({
    osmType: e.type,
    osmId: e.id,
    lat: e.lat ?? e.center?.lat,
    lng: e.lon ?? e.center?.lon,
    tags: e.tags ?? {},
  }))
  .filter((e) => e.lat && e.lng);

await writeFile(
  OUT,
  JSON.stringify({ source: 'OpenStreetMap (Overpass API)', license: 'ODbL 1.0', fetchedAt: new Date().toISOString(), bbox: BBOX, items }, null, 1),
);

const named = items.filter((i) => i.tags.name);
const byType = Object.groupBy(items, (i) => i.tags.tourism ?? `building=${i.tags.building}`);
console.log(`OSM: ${items.length} đối tượng (${named.length} có tên) -> ${path.relative(process.cwd(), OUT)}`);
console.log(Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, v.length])));
