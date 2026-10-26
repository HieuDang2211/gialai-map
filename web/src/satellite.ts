import type maplibregl from 'maplibre-gl';

/**
 * Lớp vệ tinh Google qua Map Tiles API chính thức (2D tiles).
 * - Cần API key bật "Map Tiles API" (có billing), nên giới hạn key theo HTTP referrer.
 * - Không cache/tải trước tile Google (điều khoản) -> service worker bỏ qua tile.googleapis.com.
 * - Bắt buộc hiển thị "Google Maps" + chuỗi bản quyền theo khung nhìn (getAttribution).
 */
const SESSION_KEY = 'gl-google-sat-session';
const SOURCE_ID = 'google-satellite';
const LAYER_ID = 'google-satellite';
/** nguồn của bản đồ nền vector (OpenFreeMap) — ẩn đi khi bật vệ tinh */
const BASEMAP_SOURCES = new Set(['openmaptiles', 'ne2_shaded']);

interface Session {
  session: string;
  expiry: number; // giây (epoch)
  keyHint: string;
}

async function getSession(apiKey: string): Promise<string> {
  const keyHint = apiKey.slice(-6);
  try {
    const cached = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null') as Session | null;
    // dùng lại token nếu còn hạn > 1 giờ (token sống ~2 tuần)
    if (cached && cached.keyHint === keyHint && cached.expiry * 1000 - Date.now() > 3600_000) return cached.session;
  } catch {
    /* localStorage có thể bị chặn */
  }

  const res = await fetch(`https://tile.googleapis.com/v1/createSession?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // satellite + layerRoadmap = ảnh vệ tinh có tên đường (tương đương "hybrid")
    body: JSON.stringify({ mapType: 'satellite', language: 'vi-VN', region: 'VN', layerTypes: ['layerRoadmap'], overlay: false }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.session) {
    throw new Error(json?.error?.message ?? `createSession ${res.status}`);
  }
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ session: json.session, expiry: Number(json.expiry), keyHint }));
  } catch {
    /* bỏ qua */
  }
  return json.session as string;
}

let current: { apiKey: string; session: string } | null = null;

export async function enableSatellite(map: maplibregl.Map, apiKey: string, beforeId = 'gl-mask'): Promise<void> {
  const session = await getSession(apiKey);
  current = { apiKey, session };

  if (!map.getSource(SOURCE_ID)) {
    map.addSource(SOURCE_ID, {
      type: 'raster',
      tiles: [`https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=${session}&key=${encodeURIComponent(apiKey)}`],
      tileSize: 256,
      maxzoom: 21,
    });
  }
  if (!map.getLayer(LAYER_ID)) {
    // nằm dưới mặt nạ + ranh giới + POI của mình
    map.addLayer({ id: LAYER_ID, type: 'raster', source: SOURCE_ID, paint: { 'raster-fade-duration': 150 } }, beforeId);
  }
  setBasemapVisible(map, false);
}

export function disableSatellite(map: maplibregl.Map): void {
  if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
  setBasemapVisible(map, true);
  current = null;
}

function setBasemapVisible(map: maplibregl.Map, visible: boolean) {
  for (const layer of map.getStyle().layers) {
    if ('source' in layer && typeof layer.source === 'string' && BASEMAP_SOURCES.has(layer.source)) {
      map.setLayoutProperty(layer.id, 'visibility', visible ? 'visible' : 'none');
    }
    if (layer.type === 'background') map.setLayoutProperty(layer.id, 'visibility', visible ? 'visible' : 'none');
  }
}

/** Chuỗi bản quyền Google theo khung nhìn hiện tại (bắt buộc hiển thị). */
export async function getAttribution(map: maplibregl.Map, signal?: AbortSignal): Promise<string> {
  if (!current) return '';
  const b = map.getBounds();
  const clamp = (v: number, lim: number) => Math.max(-lim + 1e-6, Math.min(lim - 1e-6, v));
  const qs = new URLSearchParams({
    session: current.session,
    key: current.apiKey,
    zoom: String(Math.max(0, Math.round(map.getZoom()))),
    north: String(clamp(b.getNorth(), 90)),
    south: String(clamp(b.getSouth(), 90)),
    east: String(clamp(b.getEast(), 180)),
    west: String(clamp(b.getWest(), 180)),
  });
  const res = await fetch(`https://tile.googleapis.com/tile/v1/viewport?${qs}`, { signal });
  if (!res.ok) return '';
  const json = (await res.json()) as { copyright?: string };
  return json.copyright ?? '';
}
