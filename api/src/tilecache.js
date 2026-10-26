// Xoá tile địa điểm đã cache ở gateway (nginx proxy_cache) quanh một toạ độ sau khi toạ độ trong DB đổi.
// nginx mã nguồn mở không có lệnh purge -> xoá thẳng file cache: tên file = md5(proxy_cache_key),
// thư mục theo levels=1:2 (ký tự cuối / hai ký tự trước đó). Khoá cache là "$uri" (xem web/nginx.conf),
// nên ?v=<phiên bản> trên URL chỉ để trình duyệt + service worker tải lại, không làm nguội cache gateway.
import { createHash } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import path from 'node:path';

const CACHE_DIR = process.env.TILE_CACHE_DIR ?? '/var/cache/nginx/tiles';
const WORLD = 40075016.68557849; // chu vi Trái Đất theo EPSG:3857 (m)
const MAX_ZOOM = 18; // khớp maxzoom của nguồn "pois" trong martin/martin.yaml
const BUFFER = 64 / 4096; // ST_AsMVTGeom(..., 4096, 64, true) trong tiles_pois

const toMerc = (lng, lat) => {
  const x = (lng * WORLD) / 360;
  const y = (Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * WORLD) / (2 * Math.PI);
  return [x, y];
};

/** Mọi tile z/x/y có thể chứa điểm (kể cả vùng đệm 64/4096 của tile lân cận). */
export function tilesAround(lng, lat) {
  const [mx, my] = toMerc(lng, lat);
  const out = [];
  for (let z = 0; z <= MAX_ZOOM; z++) {
    const n = 2 ** z;
    const size = WORLD / n;
    const fx = (mx + WORLD / 2) / size;
    const fy = (WORLD / 2 - my) / size;
    const clamp = (v) => Math.min(n - 1, Math.max(0, v));
    for (let x = clamp(Math.floor(fx - BUFFER)); x <= clamp(Math.floor(fx + BUFFER)); x++) {
      for (let y = clamp(Math.floor(fy - BUFFER)); y <= clamp(Math.floor(fy + BUFFER)); y++) out.push([z, x, y]);
    }
  }
  return out;
}

/** Xoá cache tile "pois" quanh các điểm [lng, lat]; trả về số file đã xoá. */
export async function purgePoiTiles(points) {
  const keys = new Set();
  for (const [lng, lat] of points) for (const [z, x, y] of tilesAround(lng, lat)) keys.add(`/tiles/pois/${z}/${x}/${y}`);
  let removed = 0;
  await Promise.all(
    [...keys].map(async (key) => {
      const h = createHash('md5').update(key).digest('hex');
      try {
        await unlink(path.join(CACHE_DIR, h.slice(-1), h.slice(-3, -1), h));
        removed++;
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }),
  );
  return { tiles: keys.size, removed };
}
