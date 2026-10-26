import osrmTextInstructions from 'osrm-text-instructions';
import { pool } from './lib.js';

// Máy chủ OSRM tự host (profile xe máy, dữ liệu cắt theo khung Gia Lai). Không dùng router.project-osrm.org:
// máy chủ demo đó chỉ cho thử nghiệm, cấm dùng trong ứng dụng.
// Mỗi phương tiện là một tiến trình osrm-routed riêng (profile Lua khác nhau, cùng dữ liệu OSM)
const OSRM_BY_MODE = {
  motorbike: process.env.OSRM_URL ?? 'http://localhost:5000',
  car: process.env.OSRM_CAR_URL ?? 'http://localhost:5001',
  foot: process.env.OSRM_FOOT_URL ?? 'http://localhost:5002',
};
export const MODES = ['motorbike', 'car', 'foot', 'bus'];
const PROFILE = 'driving'; // tên trong URL; osrm-routed phục vụ đúng một profile bất kể tên này
const MAX_STOPS = 12;
const BBOX = [107.0, 12.5, 109.6, 15.0];
const UUID = /^[0-9a-f-]{36}$/i;

const instructions = osrmTextInstructions('v5');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Lấy địa điểm theo danh sách id, giữ đúng thứ tự đầu vào; báo lỗi nếu có id không tồn tại. */
async function loadLocations(ids) {
  const { rows } = await pool.query(`
    SELECT l.id, l.name, c.icon, c.slug AS category, l.opening_hours AS "openingHours",
           ST_X(l.geom) AS lng, ST_Y(l.geom) AS lat
    FROM locations l LEFT JOIN categories c ON c.id = l.category_id
    WHERE l.id = ANY($1::uuid[]) AND l.is_active`, [ids]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) throw new HttpError(404, `Không tìm thấy địa điểm: ${missing.join(', ')}`);
  return ids.map((id) => byId.get(id));
}

/** "uuid" -> địa điểm trong CSDL; "lng,lat" -> điểm tự do (vd vị trí người dùng), phải nằm trong khung Gia Lai. */
async function resolvePoint(value, label) {
  const v = String(value ?? '').trim();
  if (UUID.test(v)) return (await loadLocations([v.toLowerCase()]))[0];
  const m = /^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/.exec(v);
  if (!m) throw new HttpError(400, `${label}: cần id địa điểm hoặc "lng,lat"`);
  const lng = Number(m[1]);
  const lat = Number(m[2]);
  if (lng < BBOX[0] || lng > BBOX[2] || lat < BBOX[1] || lat > BBOX[3]) {
    throw new HttpError(400, `${label}: toạ độ nằm ngoài vùng dữ liệu Gia Lai`);
  }
  return { id: null, name: label === 'from' ? 'Điểm xuất phát' : 'Điểm đến', lng, lat };
}

/** Kiểm tra phương tiện. Xe buýt: chưa có dữ liệu tuyến (OSM chưa có tuyến buýt Gia Lai, cần GTFS). */
function parseMode(raw) {
  const mode = String(raw ?? 'motorbike');
  if (!MODES.includes(mode)) throw new HttpError(400, `mode phải là một trong: ${MODES.join(', ')}`);
  if (mode === 'bus') {
    throw new HttpError(501, 'Chưa có dữ liệu tuyến xe buýt Gia Lai (OpenStreetMap chưa có tuyến). Cần dữ liệu GTFS từ đơn vị vận tải để bật chế độ này.');
  }
  return mode;
}

async function osrm(service, points, params, mode = 'motorbike') {
  const coords = points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const qs = new URLSearchParams({ overview: 'full', geometries: 'geojson', ...params });
  let res;
  try {
    res = await fetch(`${OSRM_BY_MODE[mode]}/${service}/v1/${PROFILE}/${coords}?${qs}`, { signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new HttpError(503, 'Máy chủ chỉ đường chưa sẵn sàng (đang dựng dữ liệu OSRM?)');
  }
  const json = await res.json().catch(() => null);
  if (json?.code === 'Ok') return json;
  if (json?.code === 'NoRoute' || json?.code === 'NoTrips') throw new HttpError(422, 'Không tìm được đường đi giữa các điểm này');
  if (json?.code === 'NoSegment') throw new HttpError(422, 'Có điểm nằm quá xa đường giao thông');
  throw new HttpError(502, `OSRM lỗi: ${json?.code ?? res.status} ${json?.message ?? ''}`.trim());
}

const round = (n) => Math.round(n);
const publicStop = (p) => ({ id: p.id, name: p.name, icon: p.icon ?? null, category: p.category ?? null, openingHours: p.openingHours ?? null, lng: p.lng, lat: p.lat });

/** Chặng: khoảng cách/thời gian + (tuỳ chọn) các bước rẽ có câu hướng dẫn tiếng Việt. */
function mapLegs(legs, withSteps) {
  return legs.map((leg, legIndex) => ({
    distance: round(leg.distance),
    duration: round(leg.duration),
    summary: leg.summary || null,
    steps: withSteps
      ? leg.steps.map((s) => ({
          instruction: instructions.compile('vi', s, { legCount: legs.length, legIndex }),
          name: s.name || null,
          ref: s.ref || null,
          distance: round(s.distance),
          duration: round(s.duration),
          type: s.maneuver.type,
          modifier: s.maneuver.modifier ?? null,
          location: s.maneuver.location,
        }))
      : undefined,
  }));
}

/**
 * Thời gian (giây) của từng đoạn giữa hai đỉnh liên tiếp của geometry — dùng cho mô phỏng di chuyển
 * (tốc độ thay đổi theo loại đường). Các chặng nối nhau dùng chung đỉnh nên số đoạn = số đỉnh - 1.
 */
function segmentDurations(legs, geometry) {
  const segs = legs.flatMap((l) => l.annotation?.duration ?? []);
  return segs.length === geometry.coordinates.length - 1 ? segs.map((s) => Math.round(s * 10) / 10) : null;
}

/** Tuyến đi qua các điểm theo đúng thứ tự cho trước. */
async function routeInOrder(points, withSteps, mode) {
  const r = await osrm('route', points, { steps: String(withSteps), continue_straight: 'false', annotations: 'duration' }, mode);
  const route = r.routes[0];
  return {
    distance: round(route.distance),
    duration: round(route.duration),
    legs: mapLegs(route.legs, withSteps),
    geometry: route.geometry,
    segmentDurations: segmentDurations(route.legs, route.geometry),
  };
}

function parseIds(raw) {
  if (!Array.isArray(raw)) throw new HttpError(400, 'ids phải là mảng id địa điểm');
  const ids = raw.map((x) => String(x).toLowerCase());
  if (ids.some((id) => !UUID.test(id))) throw new HttpError(400, 'id không hợp lệ');
  if (new Set(ids).size !== ids.length) throw new HttpError(400, 'Có địa điểm bị trùng trong lộ trình');
  if (ids.length < 2) throw new HttpError(400, 'Cần ít nhất 2 điểm');
  if (ids.length > MAX_STOPS) throw new HttpError(400, `Tối đa ${MAX_STOPS} điểm`);
  return ids;
}

export function registerRouting(app) {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    app.log.error(err);
    return reply.code(500).send({ error: 'Lỗi máy chủ' });
  });

  /**
   * Chỉ đường giữa hai điểm.
   *  from, to: id địa điểm hoặc "lng,lat"
   */
  app.get('/api/route', async (req, reply) => {
    const mode = parseMode(req.query.mode);
    const from = await resolvePoint(req.query.from, 'from');
    const to = await resolvePoint(req.query.to, 'to');
    const route = await routeInOrder([from, to], true, mode);
    reply.header('Cache-Control', 'public, max-age=300');
    return { mode, stops: [publicStop(from), publicStop(to)], ...route };
  });

  /**
   * Lộ trình nhiều điểm.
   *  ids       : 2..12 id địa điểm (thứ tự người dùng chọn)
   *  start     : id điểm xuất phát (mặc định ids[0]); luôn đứng đầu
   *  roundtrip : true -> quay về điểm xuất phát
   *  optimize  : false -> giữ nguyên thứ tự (chỉ tính đường), mặc định true -> OSRM /trip sắp lại thứ tự
   *  steps     : true -> kèm hướng dẫn rẽ tiếng Việt
   */
  app.post('/api/trip', async (req) => {
    const body = req.body ?? {};
    let ids = parseIds(body.ids);
    const start = body.start ? String(body.start).toLowerCase() : ids[0];
    if (!ids.includes(start)) throw new HttpError(400, 'start phải là một trong các ids');
    ids = [start, ...ids.filter((id) => id !== start)];
    const roundtrip = body.roundtrip === true;
    const mode = parseMode(body.mode);
    const optimize = body.optimize !== false;
    const withSteps = body.steps === true;

    const stops = await loadLocations(ids);
    const routePoints = (list) => (roundtrip ? [...list, list[0]] : list);

    // Đường đi theo thứ tự người dùng chọn: dùng làm mốc so sánh (hoặc là kết quả khi optimize=false)
    const given = await routeInOrder(routePoints(stops), withSteps && !optimize, mode);
    if (!optimize) {
      return { mode, optimized: false, roundtrip, stops: stops.map(publicStop), ...given, baseline: null };
    }

    // OSRM /trip: bài toán người du lịch (TSP) gần đúng trên ma trận thời gian thực tế.
    // roundtrip=false chỉ hỗ trợ khi cố định điểm đầu (source=first).
    const t = await osrm('trip', stops, {
      source: 'first',
      destination: 'any',
      roundtrip: String(roundtrip),
      steps: String(withSteps),
      annotations: 'duration',
    }, mode);
    const trip = t.trips[0];
    const order = t.waypoints.map((w, inputIndex) => ({ inputIndex, pos: w.waypoint_index }))
      .sort((a, b) => a.pos - b.pos)
      .map((x) => x.inputIndex);

    // Heuristic của OSRM đôi khi không hơn thứ tự gốc với ít điểm -> không bao giờ trả về kết quả tệ hơn
    if (trip.duration >= given.duration) {
      return { mode, optimized: true, roundtrip, stops: stops.map(publicStop), ...(withSteps ? await routeInOrder(routePoints(stops), true, mode) : given), baseline: { distance: given.distance, duration: given.duration } };
    }

    return {
      mode,
      optimized: true,
      roundtrip,
      stops: order.map((i) => publicStop(stops[i])),
      distance: round(trip.distance),
      duration: round(trip.duration),
      legs: mapLegs(trip.legs, withSteps),
      geometry: trip.geometry,
      segmentDurations: segmentDurations(trip.legs, trip.geometry),
      baseline: { distance: given.distance, duration: given.duration },
    };
  });
}
