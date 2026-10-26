// Nhập kết quả khảo sát quán ăn (data/raw/survey_quan_an_pleiku.json, tạo bởi convert-survey.py).
//  - Quán đã có trên bản đồ (cùng tên/tên gần giống, cách < 120 m): cập nhật tên + ghi chú khảo sát, không tạo bản trùng
//  - Quán mới: thêm với nguồn "survey"
//  - Đã đóng cửa / không tìm thấy / không phải quán ăn: ẩn nếu đang có, không thêm nếu chưa có
//  - Đã chuyển địa chỉ: đánh dấu "nghi sai" (chưa có địa chỉ mới)
// Mức tin cậy vị trí:
//  verified   = toạ độ đo GPS tại chỗ, không trùng quán khác
//  unverified = đã đến quán nhưng toạ độ trùng y toạ độ tham khảo (chưa đo GPS độc lập)
//  suspect    = cùng toạ độ với quán khác -> cần đo lại
// Tên người khảo sát không được công khai (chỉ giữ trong file nguồn).
import { readFile } from 'node:fs/promises';
import { ascii } from '../src/lib.js';

const CATEGORY = { 'Nhà hàng': 'nha-hang', 'Quán cà phê': 'quan-ca-phe', 'Quán nước': 'quan-nuoc' };
const vnDate = (iso) => (iso ? iso.split('-').reverse().join('/') : '');

function cleanAddress(a) {
  // "22-24 Nguyễn Văn Trỗi, Phường Hội Thương, TP. Pleiku" -> giữ phần số nhà + đường (phường cũ đã đổi tên)
  return (a ?? '').split(',').map((s) => s.trim()).filter((s) => s && !/^(phường|xã|tp\.?|thành phố|gia lai|việt nam|\d{5,6})\b/i.test(s)).join(', ') || null;
}

export async function importSurvey(db, file) {
  let data;
  try {
    data = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
  const { rows: cats } = await db.query(`SELECT id, slug FROM categories`);
  const catId = Object.fromEntries(cats.map((c) => [c.slug, c.id]));
  const count = { updated: 0, inserted: 0, hidden: 0, moved: 0, skipped: 0 };

  for (const r of data.rows) {
    const when = vnDate(r.visitedAt);
    // quán đang có: tên giống (không dấu) và gần nhau; chỉ so trong nhóm ăn uống
    const { rows: match } = await db.query(
      `SELECT l.id, l.name FROM locations l JOIN categories c ON c.id = l.category_id
       WHERE c.slug IN ('nha-hang', 'quan-ca-phe', 'quan-nuoc') AND l.source <> 'survey'
         AND ST_DWithin(l.geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, 300)
         AND (lower(unaccent(l.name)) = lower(unaccent($3)) OR lower(unaccent(l.name)) = lower(unaccent($4))
              OR (similarity(lower(unaccent(l.name)), lower(unaccent($3))) >= 0.6
                  AND ST_DWithin(l.geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, 120)))
       ORDER BY l.geom::geography <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography LIMIT 1`,
      [r.lng, r.lat, r.name, r.listedName],
    );
    const existing = match[0];

    if (r.action === 'close') {
      if (existing) {
        await db.query(`UPDATE locations SET is_active = false, location_note = $2, updated_at = now() WHERE id = $1`,
          [existing.id, `Khảo sát ${when}: ${r.result.toLowerCase()}`]);
        count.hidden++;
      } else count.skipped++;
      continue;
    }
    if (r.action === 'moved') {
      if (existing) {
        await db.query(`UPDATE locations SET location_status = 'suspect', location_note = $2, updated_at = now() WHERE id = $1`,
          [existing.id, `Khảo sát ${when}: quán đã chuyển địa chỉ, chưa có địa chỉ mới`]);
        count.moved++;
      } else count.skipped++;
      continue;
    }
    if (r.action !== 'publish') {
      count.skipped++;
      continue;
    }

    // GPS đã có file GPX/KML khớp -> verified; GPS do người khảo sát cung cấp, chưa có file -> unverified, ghi rõ
    const proven = data.gpsProof === 'gpx';
    const status = r.sharedPoint ? 'suspect' : r.gpsIndependent && proven ? 'verified' : 'unverified';
    const note = r.sharedPoint
      ? `Đã khảo sát ${when}; trùng toạ độ với quán khác – cần đo lại GPS`
      : r.gpsIndependent
        ? proven
          ? `Khảo sát thực địa ${when}, toạ độ GPS đã đối chiếu file GPX`
          : `Khảo sát ${when}; toạ độ GPS điện thoại do người khảo sát cung cấp, chờ đối chiếu file GPX`
        : `Đã khảo sát ${when}; toạ độ chưa đo GPS độc lập`;
    // toạ độ đo tại chỗ (không trùng quán khác) thay toạ độ cũ của quán đã có
    const moveTo = r.gpsIndependent && !r.sharedPoint;

    if (existing) {
      await db.query(
        `UPDATE locations SET name = $2, location_note = $3,
           location_status = CASE WHEN $4 = 'suspect' THEN 'suspect'
                                  WHEN $5 THEN $4
                                  WHEN location_status IN ('verified', 'corrected') THEN location_status ELSE $4 END,
           geom = CASE WHEN $5 THEN ST_SetSRID(ST_MakePoint($6, $7), 4326) ELSE geom END,
           geom_3857 = CASE WHEN $5 THEN ST_Transform(ST_SetSRID(ST_MakePoint($6, $7), 4326), 3857) ELSE geom_3857 END,
           admin_code = CASE WHEN $5 THEN (SELECT a.code FROM admin_units a WHERE ST_Contains(a.geom, ST_SetSRID(ST_MakePoint($6, $7), 4326)) LIMIT 1) ELSE admin_code END,
           tags = (SELECT array_agg(DISTINCT t) FROM unnest(tags || ARRAY['đã khảo sát']) t), updated_at = now()
         WHERE id = $1`,
        [existing.id, r.name, note, status, moveTo, r.lng, r.lat],
      );
      count.updated++;
      continue;
    }

    const slug = CATEGORY[r.category] ?? 'nha-hang';
    await db.query(
      `INSERT INTO locations (id, name, category_id, admin_code, address, tags, aliases, popularity, priority,
          source, source_ref, source_license, location_status, location_note, geom, geom_3857)
       SELECT md5('survey:' || $1)::uuid, $2, $3,
              (SELECT a.code FROM admin_units a WHERE ST_Contains(a.geom, g) LIMIT 1),
              concat_ws(', ', $4::text, (SELECT a.full_name FROM admin_units a WHERE ST_Contains(a.geom, g) LIMIT 1), 'Gia Lai'),
              $5, $6, 30, 50, 'survey', $1, $7, $8, $9, g, ST_Transform(g, 3857)
       FROM (SELECT ST_SetSRID(ST_MakePoint($10, $11), 4326) AS g) s
       ON CONFLICT (id) DO NOTHING`,
      [r.code, r.name, catId[slug], cleanAddress(r.address), [r.category.toLowerCase(), 'đã khảo sát', 'pleiku'],
       [ascii(r.name), ascii(r.listedName)].filter((v, i, a) => v && a.indexOf(v) === i),
       `Khảo sát thực địa tháng ${r.visitedAt?.slice(5, 7) ?? ''}/${r.visitedAt?.slice(0, 4) ?? ''}`,
       status, note, r.lng, r.lat],
    );
    count.inserted++;
  }
  return count;
}
