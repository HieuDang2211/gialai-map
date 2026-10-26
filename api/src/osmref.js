// Ứng viên tham chiếu OpenStreetMap cho trang kiểm tra vị trí (/review).
// Dùng cùng file với verify-locations.py: data/osm/reference.geojsonseq (trích từ file OSM của OSRM, xem README).
import { readFile } from 'node:fs/promises';
import { ascii } from './lib.js';

const REF_FILE = process.env.OSM_REFERENCE_FILE ?? '/data/osm/reference.geojsonseq';
const KEYS = ['tourism', 'historic', 'natural', 'waterway', 'amenity', 'water', 'leisure', 'shop'];
// từ chung chung không giúp phân biệt địa điểm (giống GENERIC trong verify-locations.py)
const GENERIC = new Set(['pleiku', 'gia', 'lai', 'tp', 'thanh', 'pho', 'tinh', 'xa', 'huyen', 'phuong', 'viet', 'nam', 'moi',
  'quan', 'cafe', 'coffee', 'ca', 'phe', 'nha', 'hang', 'khach', 'san', 'homestay', 'cho']);

let cache = null;

const norm = (s) => ascii(s).replace(/[^a-z0-9]+/g, ' ').trim();
const words = (s) => norm(s).split(' ').filter((w) => w && !GENERIC.has(w));

function center(g) {
  if (g.type === 'Point') return g.coordinates;
  const ring = g.type === 'Polygon' ? g.coordinates[0] : g.coordinates[0][0];
  return [ring.reduce((s, c) => s + c[0], 0) / ring.length, ring.reduce((s, c) => s + c[1], 0) / ring.length];
}

async function load() {
  if (cache) return cache;
  let text;
  try {
    text = await readFile(REF_FILE, 'utf8');
  } catch {
    return (cache = []); // chưa trích dữ liệu tham chiếu -> không có ứng viên
  }
  cache = [];
  for (let line of text.split('\n')) {
    line = line.replace(/^\x1e/, '').trim();
    if (!line) continue;
    const f = JSON.parse(line);
    const p = f.properties;
    const names = [p['name:vi'], p.name, p.alt_name, p.old_name].filter(Boolean);
    if (!names.length) continue;
    const key = KEYS.find((k) => k in p);
    const [lng, lat] = center(f.geometry);
    cache.push({
      name: names[0],
      words: new Set(names.flatMap(words)),
      kind: key ? `${key}=${p[key]}` : '?',
      ref: `${p['@type'] ?? 'x'}/${p['@id']}`,
      polygon: f.geometry.type !== 'Point',
      lng,
      lat,
    });
  }
  return cache;
}

const dist = (a, b) =>
  Math.hypot((a[0] - b[0]) * 111320 * Math.cos((a[1] * Math.PI) / 180), (a[1] - b[1]) * 110540);

/**
 * Ứng viên: đối tượng OSM có tên trùng từ khoá (trong 20 km) + đối tượng bất kỳ ngay sát (trong 300 m).
 * Tên trùng xếp trước, rồi theo khoảng cách.
 */
export async function osmCandidates(name, lng, lat, limit = 8) {
  const feats = await load();
  const want = new Set(words(name));
  const out = [];
  for (const f of feats) {
    const d = dist([lng, lat], [f.lng, f.lat]);
    if (d > 20000) continue;
    const common = [...want].filter((w) => f.words.has(w)).length;
    const score = want.size ? common / want.size : 0;
    if (score >= 0.5 || d <= 300) {
      out.push({ ref: f.ref, name: f.name, kind: f.kind, polygon: f.polygon, lng: f.lng, lat: f.lat, distanceM: Math.round(d), nameScore: Math.round(score * 100) / 100 });
    }
  }
  out.sort((a, b) => (b.nameScore >= 0.5) - (a.nameScore >= 0.5) || b.nameScore - a.nameScore || a.distanceM - b.distanceM);
  return out.slice(0, limit);
}
