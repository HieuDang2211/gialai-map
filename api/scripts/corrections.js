// Áp dụng kết quả xác minh toạ độ (data/corrections/locations.json, sinh bởi verify-locations.py).
// "manual" (người kiểm tra ghi tay hoặc qua trang /review) luôn ưu tiên hơn "auto".
import { readFile, rename, writeFile } from 'node:fs/promises';

/** Ghi chú hiển thị trên trang chi tiết cho một mục hiệu chỉnh. */
export function entryNote(e) {
  return (
    e.note ??
    (e.status === 'corrected' ? `Đã hiệu chỉnh theo OpenStreetMap (${e.ref}), dời ${e.moved_m} m` : e.reason ?? null)
  );
}

/** Áp một mục (auto hoặc manual) vào bảng locations. */
export async function applyEntry(db, id, e) {
  const status = e.status === 'hidden' ? 'suspect' : e.status;
  const note = entryNote(e);
  if (e.status === 'corrected' && Number.isFinite(e.lng) && Number.isFinite(e.lat)) {
    await db.query(
      `UPDATE locations SET geom = g, geom_3857 = ST_Transform(g, 3857), location_status = 'corrected', location_note = $2,
         admin_code = (SELECT a.code FROM admin_units a WHERE ST_Contains(a.geom, g) LIMIT 1), updated_at = now()
       FROM (SELECT ST_SetSRID(ST_MakePoint($3, $4), 4326) AS g) s WHERE id = $1`,
      [id, note, e.lng, e.lat],
    );
  } else {
    await db.query(
      `UPDATE locations SET location_status = $2, location_note = $3, is_active = is_active AND $4, updated_at = now() WHERE id = $1`,
      [
        id,
        status,
        note,
        e.status !== 'hidden', // "hidden" = người kiểm tra xác nhận địa điểm không tồn tại
      ],
    );
  }
}

export async function applyLocationCorrections(db, file) {
  let data;
  try {
    data = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
  const merged = { ...(data.auto ?? {}), ...(data.manual ?? {}) };
  const count = {};
  for (const [id, e] of Object.entries(merged)) {
    await applyEntry(db, id, e);
    count[e.status] = (count[e.status] ?? 0) + 1;
  }
  return count;
}

// Ghi tuần tự: hai quyết định cùng lúc không được làm mất của nhau
let writing = Promise.resolve();

/** Ghi một quyết định vào mục "manual" (giữ nguyên định dạng thụt lề 1 như verify-locations.py). */
export function writeManualEntry(file, id, entry) {
  const run = writing.then(async () => {
    const data = JSON.parse(await readFile(file, 'utf8'));
    data.manual = { ...(data.manual ?? {}), [id]: entry };
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 1), 'utf8');
    await rename(tmp, file);
  });
  writing = run.catch(() => {});
  return run;
}
