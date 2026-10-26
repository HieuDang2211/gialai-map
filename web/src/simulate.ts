import maplibregl, { type GeoJSONSource } from 'maplibre-gl';

/** Biểu tượng người theo phương tiện. */
export const MODE_ICON: Record<string, string> = { motorbike: '🛵', car: '🚗', foot: '🚶', bus: '🚌' };

export interface SimState {
  playing: boolean;
  /** 0..1 */
  progress: number;
  /** giây "thực tế" đã đi trong hành trình mô phỏng */
  simSeconds: number;
  totalSeconds: number;
  /** chỉ số chặng đang đi (0 = từ điểm 1 tới điểm 2) */
  leg: number;
  finished: boolean;
}

const TRAIL_SOURCE = 'gl-sim-trail';
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
const STOP_PAUSE_MS = 900; // dừng nhẹ ở mỗi điểm cho dễ theo dõi

function haversine(a: number[], b: number[]) {
  const r = 6371000;
  const p1 = (a[1] * Math.PI) / 180;
  const p2 = (b[1] * Math.PI) / 180;
  const dp = p2 - p1;
  const dl = ((b[0] - a[0]) * Math.PI) / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}

function bearing(a: number[], b: number[]) {
  const p1 = (a[1] * Math.PI) / 180;
  const p2 = (b[1] * Math.PI) / 180;
  const dl = ((b[0] - a[0]) * Math.PI) / 180;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * Mô phỏng một người di chuyển dọc tuyến đường.
 * Thời gian mỗi đoạn lấy từ OSRM (annotation duration) nên đoạn đường lớn đi nhanh, đường nhỏ/đông đi chậm.
 */
export class RouteSimulator {
  private coords: number[][];
  /** thời điểm (giây hành trình) tại từng đỉnh */
  private times: number[];
  private legEnds: number[];
  private marker: maplibregl.Marker;
  private el: HTMLDivElement;
  private arrow: HTMLDivElement;
  private raf = 0;
  private lastTs = 0;
  private pauseUntil = 0;
  private sim = 0;
  private playing = false;
  speed = 60; // 1 giây thật = speed giây hành trình
  follow = true;

  constructor(
    private map: maplibregl.Map,
    geometry: GeoJSON.LineString,
    segmentDurations: number[] | null,
    legDurations: number[],
    mode: string,
    private onChange: (s: SimState) => void,
  ) {
    this.coords = geometry.coordinates;
    // không có annotation -> chia thời gian theo quãng đường
    const total = legDurations.reduce((a, b) => a + b, 0);
    let segs = segmentDurations;
    if (!segs || segs.length !== this.coords.length - 1) {
      const d = this.coords.slice(1).map((c, i) => haversine(this.coords[i], c));
      const sum = d.reduce((a, b) => a + b, 0) || 1;
      segs = d.map((x) => (x / sum) * total);
    }
    this.times = [0];
    for (const s of segs) this.times.push(this.times[this.times.length - 1] + Math.max(0, s));
    let acc = 0;
    this.legEnds = legDurations.map((d) => (acc += d));
    // ranh giới chặng tính theo tổng thời gian đoạn (khớp với times)
    const scale = this.totalSeconds / (acc || 1);
    this.legEnds = this.legEnds.map((t) => t * scale);

    this.el = document.createElement('div');
    this.el.className = 'sim-marker';
    this.el.setAttribute('role', 'img');
    this.el.setAttribute('aria-label', 'Vị trí mô phỏng');
    this.arrow = document.createElement('div');
    this.arrow.className = 'sim-arrow';
    const face = document.createElement('span');
    face.className = 'sim-face';
    face.textContent = MODE_ICON[mode] ?? '🚶';
    this.el.append(this.arrow, face);
    this.marker = new maplibregl.Marker({ element: this.el, anchor: 'center' }).setLngLat(this.coords[0] as [number, number]).addTo(map);

    if (!map.getSource(TRAIL_SOURCE)) {
      map.addSource(TRAIL_SOURCE, { type: 'geojson', data: EMPTY });
      map.addLayer(
        {
          id: TRAIL_SOURCE,
          type: 'line',
          source: TRAIL_SOURCE,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#f97316', 'line-width': 6, 'line-opacity': 0.9 },
        },
        map.getLayer('gl-trip-stops') ? 'gl-trip-stops' : undefined,
      );
    }
    this.render();
  }

  get totalSeconds() {
    return this.times[this.times.length - 1];
  }

  /** Tốc độ để cả hành trình phát trong khoảng `seconds` giây. */
  fitTo(seconds: number) {
    this.speed = Math.max(1, this.totalSeconds / seconds);
  }

  play() {
    if (this.sim >= this.totalSeconds) this.sim = 0;
    this.playing = true;
    this.lastTs = 0;
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.tick);
    this.emit();
  }

  pause() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.emit();
  }

  seek(progress: number) {
    this.sim = Math.min(1, Math.max(0, progress)) * this.totalSeconds;
    this.render();
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.marker.remove();
    (this.map.getSource(TRAIL_SOURCE) as GeoJSONSource | undefined)?.setData(EMPTY);
  }

  private tick = (ts: number) => {
    if (!this.playing) return;
    // máy yếu / tab bị hạ tốc khung hình vẫn đúng nhịp thời gian; chỉ chặn bước nhảy lớn khi quay lại tab
    const dt = this.lastTs ? Math.min(1, (ts - this.lastTs) / 1000) : 0;
    this.lastTs = ts;
    if (ts >= this.pauseUntil) {
      const before = this.legIndex(this.sim);
      this.sim = Math.min(this.totalSeconds, this.sim + dt * this.speed);
      // vừa tới một điểm dừng -> dừng nhẹ
      if (this.legIndex(this.sim) !== before && this.sim < this.totalSeconds) this.pauseUntil = ts + STOP_PAUSE_MS;
    }
    this.render();
    if (this.sim >= this.totalSeconds) {
      this.playing = false;
      this.emit();
      return;
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  private legIndex(t: number) {
    const i = this.legEnds.findIndex((end) => t < end - 1e-6);
    return i === -1 ? this.legEnds.length - 1 : i;
  }

  private position(t: number): { at: number[]; seg: number } {
    const times = this.times;
    let lo = 0;
    let hi = times.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= t) lo = mid;
      else hi = mid;
    }
    const span = times[hi] - times[lo] || 1;
    const f = Math.min(1, Math.max(0, (t - times[lo]) / span));
    const a = this.coords[lo];
    const b = this.coords[hi];
    return { at: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], seg: lo };
  }

  private render() {
    const { at, seg } = this.position(this.sim);
    this.marker.setLngLat(at as [number, number]);
    const next = this.coords[Math.min(seg + 1, this.coords.length - 1)];
    if (next[0] !== at[0] || next[1] !== at[1]) this.arrow.style.transform = `rotate(${bearing(at, next)}deg)`;
    (this.map.getSource(TRAIL_SOURCE) as GeoJSONSource | undefined)?.setData({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: [...this.coords.slice(0, seg + 1), at] },
    });
    if (this.follow && this.playing) this.map.jumpTo({ center: at as [number, number] });
    this.emit();
  }

  private emit() {
    this.onChange({
      playing: this.playing,
      progress: this.totalSeconds ? this.sim / this.totalSeconds : 0,
      simSeconds: this.sim,
      totalSeconds: this.totalSeconds,
      leg: this.legIndex(this.sim),
      finished: this.sim >= this.totalSeconds,
    });
  }
}
