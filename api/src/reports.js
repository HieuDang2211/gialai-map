// Báo sai vị trí (người dân) + trang kiểm tra (/review, bảo vệ bằng REVIEW_TOKEN).
// Quyết định của người kiểm tra được ghi vào mục "manual" của data/corrections/locations.json (nguồn sự thật,
// seed.js áp dụng lại mỗi lần nạp) rồi cập nhật ngay DB, Meilisearch và cache tile ở gateway.
import { createHash, timingSafeEqual } from 'node:crypto';
import { pool, meili, waitTask } from './lib.js';
import { applyEntry, writeManualEntry } from '../scripts/corrections.js';
import { purgePoiTiles } from './tilecache.js';
import { osmCandidates } from './osmref.js';

const CORRECTIONS_FILE = process.env.CORRECTIONS_FILE ?? '/data/corrections/locations.json';
const REVIEW_TOKEN = process.env.REVIEW_TOKEN ?? '';
const MAX_MOVE_M = 20000;
const MAX_NOTE = 500;
// mỗi IP: tối đa 5 báo cáo / 10 phút và 20 báo cáo / ngày
const LIMITS = [
  { windowMs: 10 * 60_000, max: 5 },
  { windowMs: 24 * 3600_000, max: 20 },
];

const UUID = /^[0-9a-f-]{36}$/i;

/** Bảng báo cáo + nhật ký quyết định. Không có khoá ngoại tới locations: seed.js TRUNCATE ... CASCADE sẽ xoá mất. */
export async function ensureReportSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS location_reports (
      id          bigserial PRIMARY KEY,
      location_id uuid NOT NULL,
      kind        text NOT NULL DEFAULT 'moved' CHECK (kind IN ('moved', 'missing')),
      lng         double precision NOT NULL,
      lat         double precision NOT NULL,
      note        text,
      client_hash text,
      status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
      created_at  timestamptz NOT NULL DEFAULT now(),
      reviewed_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS location_reports_pending_idx ON location_reports (location_id) WHERE status = 'pending';
    CREATE TABLE IF NOT EXISTS location_reviews (
      id          bigserial PRIMARY KEY,
      location_id uuid NOT NULL,
      action      text NOT NULL,
      lng         double precision,
      lat         double precision,
      from_lng    double precision,
      from_lat    double precision,
      note        text,
      report_id   bigint,
      created_at  timestamptz NOT NULL DEFAULT now()
    );`);
}

/**
 * Phiên bản tile địa điểm -> web thêm ?v= để bỏ qua cache trình duyệt/service worker.
 * Đổi khi BẤT KỲ dữ liệu địa điểm nào đổi: quyết định ở /review, nạp lại seed (dời, ẩn, thêm, xoá).
 * Trước đây chỉ tính theo location_reviews nên sau một lần seed, trình duyệt vẫn dùng tile cũ: ghim ở vị trí cũ,
 * địa điểm đã ẩn vẫn hiện, bấm vào thì bản đồ "nhảy" tới toạ độ mới.
 */
export async function tilesVersion() {
  const { rows } = await pool.query(`
    SELECT substr(md5(concat_ws('|',
      (SELECT count(*) FROM locations WHERE is_active),
      (SELECT max(updated_at) FROM locations),
      (SELECT coalesce(max(id), 0) FROM location_reviews))), 1, 10) AS v`);
  return rows[0].v;
}

// ---------------------------------------------------------------- giới hạn tần suất (trong bộ nhớ, đủ cho 1 tiến trình API)
const hits = new Map(); // ip -> [timestamp...]

function rateLimited(ip) {
  const now = Date.now();
  const longest = Math.max(...LIMITS.map((l) => l.windowMs));
  const list = (hits.get(ip) ?? []).filter((t) => now - t < longest);
  hits.set(ip, list);
  return LIMITS.some((l) => list.filter((t) => now - t < l.windowMs).length >= l.max);
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of hits) if (!list.some((t) => now - t < 24 * 3600_000)) hits.delete(ip);
}, 3600_000).unref();

const clientHash = (ip) => createHash('sha256').update(`gialai-map:${ip}`).digest('hex').slice(0, 32);

// ---------------------------------------------------------------- xác thực người kiểm tra
const digest = (s) => createHash('sha256').update(s).digest();

function checkReviewer(req, reply) {
  if (!REVIEW_TOKEN) {
    reply.code(503).send({ error: 'Chưa cấu hình REVIEW_TOKEN cho API.' });
    return false;
  }
  const given = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  if (!given || !timingSafeEqual(digest(given), digest(REVIEW_TOKEN))) {
    reply.code(401).send({ error: 'Mã kiểm tra không đúng.' });
    return false;
  }
  return true;
}

const fmtDist = (m) => (m >= 1000 ? `${(m / 1000).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} km` : `${Math.round(m)} m`);
const round6 = (v) => Math.round(v * 1e6) / 1e6;

export function registerReports(app) {
  // ---------------------------------------------------------------- người dân: báo sai vị trí
  app.post('/api/locations/:id/reports', async (req, reply) => {
    const { id } = req.params;
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id không hợp lệ' });
    const body = req.body ?? {};
    const kind = body.kind === 'missing' ? 'missing' : 'moved';
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, MAX_NOTE) || null : null;
    let lng = Number(body.lng);
    let lat = Number(body.lat);

    // mọi lần gửi đều tính (kể cả bị từ chối) để không thể dò thử liên tục
    if (rateLimited(req.ip)) {
      return reply.code(429).send({ error: 'Bạn đã gửi quá nhiều báo cáo. Vui lòng thử lại sau.' });
    }
    hits.get(req.ip).push(Date.now());

    const { rows } = await pool.query(
      `SELECT ST_X(l.geom) AS lng, ST_Y(l.geom) AS lat FROM locations l WHERE l.id = $1 AND l.is_active`,
      [id],
    );
    if (!rows.length) return reply.code(404).send({ error: 'Không tìm thấy địa điểm' });
    if (kind === 'missing') {
      // "không tồn tại": giữ toạ độ hiện tại, bắt buộc có ghi chú để người kiểm tra có căn cứ
      ({ lng, lat } = rows[0]);
      if (!note) return reply.code(400).send({ error: 'Vui lòng ghi rõ lý do (vd: đã đóng cửa, không có ở địa chỉ này).' });
    } else if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
      return reply.code(400).send({ error: 'Toạ độ không hợp lệ' });
    }

    const { rows: chk } = await pool.query(
      `SELECT ST_Contains(p.geom, pt) AS inside,
              ST_Distance(pt::geography, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography) AS moved
       FROM province p, (SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326) AS pt) s`,
      [lng, lat, rows[0].lng, rows[0].lat],
    );
    if (kind === 'moved') {
      if (!chk[0]?.inside) return reply.code(422).send({ error: 'Vị trí phải nằm trong tỉnh Gia Lai.' });
      if (chk[0].moved > MAX_MOVE_M) return reply.code(422).send({ error: 'Vị trí mới cách vị trí hiện tại quá 20 km.' });
      if (chk[0].moved < 10) return reply.code(422).send({ error: 'Hãy kéo ghim tới vị trí đúng trước khi gửi.' });
    }

    const hash = clientHash(req.ip);
    const { rows: dup } = await pool.query(
      `SELECT 1 FROM location_reports WHERE location_id = $1 AND client_hash = $2 AND status = 'pending'`,
      [id, hash],
    );
    if (dup.length) return reply.code(409).send({ error: 'Bạn đã báo địa điểm này, báo cáo đang chờ kiểm tra.' });

    const { rows: ins } = await pool.query(
      `INSERT INTO location_reports (location_id, kind, lng, lat, note, client_hash) VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, status, created_at AS "createdAt"`,
      [id, kind, lng, lat, note, hash],
    );
    return reply.code(201).send({ ...ins[0], movedM: Math.round(chk[0]?.moved ?? 0) });
  });

  // ---------------------------------------------------------------- người kiểm tra
  app.register(async (r) => {
    r.addHook('onRequest', async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!checkReviewer(req, reply)) return reply;
    });

    /** Hàng chờ: địa điểm nghi ngờ trước, rồi theo số báo cáo đang chờ. */
    r.get('/api/review/queue', async () => {
      const { rows } = await pool.query(`
        SELECT l.id, l.name, c.icon, c.name AS "categoryName", a.full_name AS "areaName", l.address,
               l.location_status AS status, l.location_note AS note, ST_X(l.geom) AS lng, ST_Y(l.geom) AS lat,
               coalesce(r.n, 0)::int AS reports, coalesce(r.missing, 0)::int AS "missingReports"
        FROM locations l
        LEFT JOIN categories c ON c.id = l.category_id
        LEFT JOIN admin_units a ON a.code = l.admin_code
        LEFT JOIN (SELECT location_id, count(*) AS n, count(*) FILTER (WHERE kind = 'missing') AS missing
                   FROM location_reports WHERE status = 'pending' GROUP BY location_id) r ON r.location_id = l.id
        WHERE l.is_active
          AND ((l.source = 'gialai-travel' AND l.location_status IN ('suspect', 'unverified')) OR r.n > 0)
        ORDER BY (l.location_status = 'suspect') DESC, coalesce(r.n, 0) DESC, l.name`);
      const { rows: done } = await pool.query(`
        SELECT action, count(*)::int AS n FROM (
          SELECT DISTINCT ON (location_id) location_id, action FROM location_reviews ORDER BY location_id, id DESC) d
        GROUP BY action`);
      return { items: rows, decided: Object.fromEntries(done.map((d) => [d.action, d.n])) };
    });

    r.get('/api/review/locations/:id', async (req, reply) => {
      const { id } = req.params;
      if (!UUID.test(id)) return reply.code(400).send({ error: 'id không hợp lệ' });
      const { rows } = await pool.query(
        `SELECT l.id, l.name, l.address, l.source, l.is_active AS "isActive", c.icon, c.name AS "categoryName",
                a.full_name AS "areaName", l.location_status AS status, l.location_note AS note,
                ST_X(l.geom) AS lng, ST_Y(l.geom) AS lat
         FROM locations l
         LEFT JOIN categories c ON c.id = l.category_id
         LEFT JOIN admin_units a ON a.code = l.admin_code
         WHERE l.id = $1`,
        [id],
      );
      if (!rows.length) return reply.code(404).send({ error: 'Không tìm thấy địa điểm' });
      const p = rows[0];
      const { rows: reports } = await pool.query(
        `SELECT r.id::int, r.kind, r.lng, r.lat, r.note, r.status, r.created_at AS "createdAt",
                round(ST_Distance(ST_SetSRID(ST_MakePoint(r.lng, r.lat), 4326)::geography,
                                  ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography))::int AS "distanceM"
         FROM location_reports r WHERE r.location_id = $1
         ORDER BY (r.status = 'pending') DESC, r.created_at DESC LIMIT 50`,
        [id, p.lng, p.lat],
      );
      const { rows: history } = await pool.query(
        `SELECT action, note, lng, lat, from_lng AS "fromLng", from_lat AS "fromLat", created_at AS "createdAt"
         FROM location_reviews WHERE location_id = $1 ORDER BY id DESC LIMIT 10`,
        [id],
      );
      return { place: p, reports, history, candidates: await osmCandidates(p.name, p.lng, p.lat) };
    });

    /**
     * Quyết định cho một địa điểm.
     *  accept : dời về (lng, lat) — điểm báo cáo, ứng viên OSM hoặc điểm người kiểm tra kéo tới
     *  verify : vị trí hiện tại đúng
     *  hide   : địa điểm không tồn tại -> ẩn khỏi bản đồ và tìm kiếm
     */
    r.post('/api/review/locations/:id/decision', async (req, reply) => {
      const { id } = req.params;
      if (!UUID.test(id)) return reply.code(400).send({ error: 'id không hợp lệ' });
      const b = req.body ?? {};
      if (!['accept', 'verify', 'hide'].includes(b.action)) return reply.code(400).send({ error: 'action không hợp lệ' });
      const reportId = b.reportId == null ? null : Number(b.reportId);
      const ref = typeof b.ref === 'string' && /^(node|way|relation|n|w|r)\/\d+$/.test(b.ref) ? b.ref : null;
      const userNote = typeof b.note === 'string' ? b.note.trim().slice(0, MAX_NOTE) || null : null;

      const { rows } = await pool.query(
        `SELECT name, ST_X(geom) AS lng, ST_Y(geom) AS lat FROM locations WHERE id = $1 AND is_active`,
        [id],
      );
      if (!rows.length) return reply.code(404).send({ error: 'Không tìm thấy địa điểm (hoặc đã bị ẩn)' });
      const cur = rows[0];
      const reviewedAt = new Date().toISOString();

      let entry;
      let movedM = 0;
      if (b.action === 'accept') {
        const lng = round6(Number(b.lng));
        const lat = round6(Number(b.lat));
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) return reply.code(400).send({ error: 'Toạ độ không hợp lệ' });
        const { rows: chk } = await pool.query(
          `SELECT ST_Contains(p.geom, pt) AS inside,
                  ST_Distance(pt::geography, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography) AS moved
           FROM province p, (SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326) AS pt) s`,
          [lng, lat, cur.lng, cur.lat],
        );
        if (!chk[0]?.inside) return reply.code(422).send({ error: 'Vị trí phải nằm trong tỉnh Gia Lai.' });
        movedM = Math.round(chk[0].moved);
        const via = reportId ? 'báo cáo của người dùng' : ref ? `OpenStreetMap (${ref})` : 'người kiểm tra';
        entry = {
          status: 'corrected',
          lng,
          lat,
          note: userNote ?? `Đã hiệu chỉnh theo ${via}, dời ${fmtDist(movedM)}`,
          from: [round6(cur.lng), round6(cur.lat)],
          moved_m: movedM,
          ...(ref && { ref }),
          ...(reportId && { report: reportId }),
        };
      } else if (b.action === 'verify') {
        entry = { status: 'verified', note: userNote ?? 'Người kiểm tra xác nhận vị trí' };
      } else {
        entry = { status: 'hidden', note: userNote ?? 'Người kiểm tra xác nhận địa điểm không tồn tại' };
      }
      entry = { ...entry, name: cur.name, reviewed_at: reviewedAt };

      // 1) file trước: đây là thứ seed.js đọc lại, nên quyết định không mất khi nạp lại toàn bộ
      await writeManualEntry(CORRECTIONS_FILE, id, entry);

      // 2) DB
      const db = await pool.connect();
      try {
        await db.query('BEGIN');
        await applyEntry(db, id, entry);
        // báo cáo đang chờ: báo cáo được chọn (hoặc báo "không tồn tại" khi ẩn) -> accepted, còn lại -> rejected
        await db.query(
          `UPDATE location_reports SET reviewed_at = now(),
             status = CASE WHEN id = $2 OR ($3 = 'hide' AND kind = 'missing') THEN 'accepted' ELSE 'rejected' END
           WHERE location_id = $1 AND status = 'pending'`,
          [id, reportId, b.action],
        );
        await db.query(
          `INSERT INTO location_reviews (location_id, action, lng, lat, from_lng, from_lat, note, report_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [id, b.action, entry.lng ?? null, entry.lat ?? null, cur.lng, cur.lat, entry.note, reportId],
        );
        await db.query('COMMIT');
      } catch (e) {
        await db.query('ROLLBACK');
        throw e;
      } finally {
        db.release();
      }

      // 3) tìm kiếm + 4) tile: chỉ khi vị trí đổi hoặc địa điểm bị ẩn
      let tiles = null;
      if (b.action === 'hide') {
        await waitTask(await meili(`/indexes/locations/documents/${id}`, { method: 'DELETE' }));
        tiles = await purgePoiTiles([[cur.lng, cur.lat]]);
      } else if (b.action === 'accept') {
        const { rows: doc } = await pool.query(
          `SELECT a.code AS "areaCode", a.full_name AS "areaName" FROM locations l
           LEFT JOIN admin_units a ON a.code = l.admin_code WHERE l.id = $1`,
          [id],
        );
        // PUT = cập nhật một phần tài liệu (giữ các trường khác)
        await waitTask(await meili('/indexes/locations/documents', {
          method: 'PUT',
          body: [{ id, _geo: { lat: entry.lat, lng: entry.lng }, ...doc[0] }],
        }));
        tiles = await purgePoiTiles([[cur.lng, cur.lat], [entry.lng, entry.lat]]);
      }
      req.log.info({ id, action: b.action, movedM, tiles }, 'review decision');
      return { ok: true, entry, tiles, tilesVersion: await tilesVersion() };
    });

    r.post('/api/review/reports/:id/reject', async (req, reply) => {
      const rid = Number(req.params.id);
      if (!Number.isInteger(rid)) return reply.code(400).send({ error: 'id không hợp lệ' });
      const { rowCount } = await pool.query(
        `UPDATE location_reports SET status = 'rejected', reviewed_at = now() WHERE id = $1 AND status = 'pending'`,
        [rid],
      );
      if (!rowCount) return reply.code(404).send({ error: 'Không có báo cáo đang chờ với id này' });
      return { ok: true };
    });
  });
}
