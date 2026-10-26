export interface Category {
  slug: string;
  name: string;
  icon: string;
  isAccommodation: boolean;
  count: number;
}

export interface LocationHit {
  id: string;
  fid: number;
  name: string;
  nameHtml: string;
  category: string;
  categoryName: string;
  icon: string;
  areaName: string | null;
  address: string | null;
  rating: number | null;
  reviewCount: number;
  image: string | null;
  lng: number;
  lat: number;
  distanceM: number | null;
}

export interface AreaHit {
  code: number;
  name: string;
  type: string;
  mergedFrom: string | null;
  bbox: [number, number, number, number];
  lng: number;
  lat: number;
}

export interface SearchResult {
  query: string;
  total: number;
  tookMs: number;
  facets: Record<string, number>;
  locations: LocationHit[];
  areas: AreaHit[];
}

export interface PlaceDetail {
  id: string;
  fid: number;
  name: string;
  shortDescription: string | null;
  description: string | null;
  address: string | null;
  phone: string | null;
  website: string | null;
  email: string | null;
  images: string[];
  rating: number | null;
  reviewCount: number;
  openingHours: Record<string, string> | null;
  bestTime: Record<string, string> | null;
  checkIn: string | null;
  checkOut: string | null;
  priceRange: string | null;
  priceRefs: { name: string; price: string }[] | null;
  tags: string[];
  source: string;
  sourceRef: string | null;
  sourceLicense: string | null;
  brand: string | null;
  /** verified | corrected | unverified | suspect */
  locationStatus: string;
  locationNote: string | null;
  category: string;
  categoryName: string;
  icon: string;
  areaCode: number | null;
  areaName: string | null;
  areaMergedFrom: string | null;
  lng: number;
  lat: number;
  nearby: { id: string; fid: number; name: string; icon: string; categoryName: string; rating: number | null; distanceM: number }[];
}

export interface AreaDetail {
  code: number;
  name: string;
  type: string;
  population: number | null;
  areaKm2: number | null;
  densityKm2: number | null;
  mergedFrom: string | null;
  headquarter: string | null;
  bbox: [number, number, number, number];
  locationCount: number;
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json() as Promise<T>;
}

export const fetchCategories = () => getJson<Category[]>('/api/categories');

/** tilesVersion tăng sau mỗi quyết định ở trang kiểm tra vị trí -> URL tile mới, bỏ qua cache trình duyệt. */
export const fetchConfig = () => getJson<{ googleMapsKey: string | null; tilesVersion?: string | number }>('/api/config');

export interface SearchParams {
  q: string;
  cat?: string | null;
  area?: number | null;
  lat?: number;
  lng?: number;
  radiusKm?: number | null;
  limit?: number;
}

// Cache kết quả tìm kiếm gần đây: gõ lùi/gõ lại không phải gọi mạng
const searchCache = new Map<string, SearchResult>();

export async function search(p: SearchParams, signal?: AbortSignal): Promise<SearchResult> {
  const qs = new URLSearchParams({ q: p.q, limit: String(p.limit ?? 8) });
  if (p.cat) qs.set('cat', p.cat);
  if (p.area) qs.set('area', String(p.area));
  if (p.lat !== undefined && p.lng !== undefined) {
    // làm tròn ~100 m để tăng tỉ lệ trúng cache
    qs.set('lat', p.lat.toFixed(3));
    qs.set('lng', p.lng.toFixed(3));
  }
  if (p.radiusKm) qs.set('radius', String(p.radiusKm));
  const key = qs.toString();
  const hit = searchCache.get(key);
  if (hit) return hit;
  const result = await getJson<SearchResult>(`/api/search?${key}`, signal);
  searchCache.set(key, result);
  if (searchCache.size > 200) searchCache.delete(searchCache.keys().next().value!);
  return result;
}

// Chi tiết địa điểm: tải trước khi người dùng rê chuột/chạm vào kết quả
const placeCache = new Map<string, Promise<PlaceDetail>>();

export function fetchPlace(id: string): Promise<PlaceDetail> {
  let p = placeCache.get(id);
  if (!p) {
    p = getJson<PlaceDetail>(`/api/locations/${id}`);
    p.catch(() => placeCache.delete(id));
    placeCache.set(id, p);
  }
  return p;
}

export const prefetchPlace = (id: string) => void fetchPlace(id).catch(() => {});

export const fetchArea = (code: number) => getJson<AreaDetail>(`/api/areas/${code}`);

// ---------------------------------------------------------------- lộ trình (OSRM tự host qua /api/trip)
export interface TripStop {
  id: string;
  name: string;
  icon: string | null;
  category?: string | null;
  openingHours?: Record<string, string> | null;
  lng: number;
  lat: number;
}

export interface TripStep {
  instruction: string;
  name: string | null;
  distance: number;
  duration: number;
  type: string;
  modifier: string | null;
  location: [number, number];
}

export interface TripLeg {
  distance: number;
  duration: number;
  summary: string | null;
  steps?: TripStep[];
}

export interface TripResult {
  mode: TravelMode;
  /** thời gian (giây) từng đoạn giữa hai đỉnh của geometry, dùng cho mô phỏng */
  segmentDurations: number[] | null;
  optimized: boolean;
  roundtrip: boolean;
  stops: TripStop[];
  distance: number;
  duration: number;
  legs: TripLeg[];
  geometry: GeoJSON.LineString;
  /** Đường đi theo thứ tự người dùng chọn (khi tối ưu) để so sánh. */
  baseline: { distance: number; duration: number } | null;
}

export type TravelMode = 'motorbike' | 'car' | 'foot' | 'bus';

export async function fetchTrip(
  ids: string[],
  opts: { optimize: boolean; roundtrip: boolean; mode: TravelMode },
  signal?: AbortSignal,
): Promise<TripResult> {
  const res = await fetch('/api/trip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, ...opts, steps: true }),
    signal,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error ?? `Lỗi ${res.status}`);
  return json as TripResult;
}

// ---------------------------------------------------------------- báo sai vị trí
export interface LocationReportInput {
  kind: 'moved' | 'missing';
  lng: number;
  lat: number;
  note: string;
}

async function sendJson<T>(url: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error ?? `Lỗi ${res.status}`);
  return json as T;
}

export const submitLocationReport = (id: string, r: LocationReportInput) =>
  sendJson<{ id: number; movedM: number }>(`/api/locations/${id}/reports`, r);

// ---------------------------------------------------------------- trang kiểm tra (/review)
export interface ReviewItem {
  id: string;
  name: string;
  icon: string | null;
  categoryName: string | null;
  areaName: string | null;
  address: string | null;
  status: string;
  note: string | null;
  lng: number;
  lat: number;
  reports: number;
  missingReports: number;
}

export interface ReviewReport {
  id: number;
  kind: 'moved' | 'missing';
  lng: number;
  lat: number;
  note: string | null;
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: string;
  distanceM: number;
}

export interface OsmCandidate {
  ref: string;
  name: string;
  kind: string;
  polygon: boolean;
  lng: number;
  lat: number;
  distanceM: number;
  nameScore: number;
}

export interface ReviewDetail {
  place: ReviewItem & { source: string; isActive: boolean };
  reports: ReviewReport[];
  history: { action: string; note: string | null; createdAt: string }[];
  candidates: OsmCandidate[];
}

export type ReviewDecision =
  | { action: 'accept'; lng: number; lat: number; reportId?: number; ref?: string; note?: string }
  | { action: 'verify' | 'hide'; note?: string };

export function reviewApi(token: string) {
  const auth = { Authorization: `Bearer ${token}` };
  const get = async <T,>(url: string): Promise<T> => {
    const res = await fetch(url, { headers: auth });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error(json?.error ?? `Lỗi ${res.status}`), { status: res.status });
    return json as T;
  };
  return {
    queue: () => get<{ items: ReviewItem[]; decided: Record<string, number> }>('/api/review/queue'),
    detail: (id: string) => get<ReviewDetail>(`/api/review/locations/${id}`),
    decide: (id: string, d: ReviewDecision) =>
      sendJson<{ ok: true; tiles: { tiles: number; removed: number } | null; tilesVersion: number }>(`/api/review/locations/${id}/decision`, d, auth),
    rejectReport: (rid: number) => sendJson<{ ok: true }>(`/api/review/reports/${rid}/reject`, {}, auth),
  };
}
