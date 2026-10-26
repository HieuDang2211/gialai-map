import type {
  ExpressionSpecification,
  LayerSpecification,
  StyleSpecification,
} from 'maplibre-gl';

/** Vector tile nền (OpenMapTiles). Production: thay bằng PMTiles tự host trên CDN. */
export const BASEMAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

export const GIA_LAI_BOUNDS: [number, number, number, number] = [107.3, 12.6, 109.5, 14.7];

export const CATEGORY_COLORS: Record<string, string> = {
  'nha-hang': '#ea580c',
  'quan-ca-phe': '#92400e',
  'quan-nuoc': '#0891b2',
  cho: '#db2777',
  'danh-lam-thang-canh': '#16a34a',
  'dia-danh-van-hoa': '#7c3aed',
  'dia-diem-check-in': '#e11d48',
  'khu-vui-choi': '#ca8a04',
  'nha-nghi': '#2563eb',
  'khach-san': '#1d4ed8',
  homestay: '#0d9488',
  resort: '#0369a1',
  'villa-bungalow': '#4f46e5',
  atm: '#059669',
  'ngan-hang': '#047857',
  'cay-xang': '#b91c1c',
  'tram-sac': '#0284c7',
};
export const colorOf = (slug: string) => CATEGORY_COLORS[slug] ?? '#475569';

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/** Vẽ ghim (pin) có emoji danh mục lên canvas -> ảnh cho layer symbol. */
export function createPinImage(color: string, emoji: string): { image: ImageData; pixelRatio: number } {
  const pr = 2;
  const w = 34;
  const h = 44;
  const canvas = document.createElement('canvas');
  canvas.width = w * pr;
  canvas.height = h * pr;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(pr, pr);

  // bóng đổ nhẹ
  ctx.shadowColor = 'rgba(15, 23, 42, 0.35)';
  ctx.shadowBlur = 3;
  ctx.shadowOffsetY = 1;

  // thân ghim: đầu tròn + mũi nhọn
  ctx.beginPath();
  ctx.arc(17, 16, 14, Math.PI * 0.82, Math.PI * 2.18);
  ctx.lineTo(17, 41);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();

  // nền trắng cho emoji
  ctx.beginPath();
  ctx.arc(17, 16, 10.5, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();

  ctx.font = '13px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(emoji || '📍', 17, 16.5);

  return { image: ctx.getImageData(0, 0, canvas.width, canvas.height), pixelRatio: pr };
}

/** Đa giác hình tròn (bán kính mét) để vẽ vùng "Gần tôi". */
export function circlePolygon(lng: number, lat: number, radiusM: number, steps = 72): GeoJSON.Feature<GeoJSON.Polygon> {
  const coords: [number, number][] = [];
  const dLat = radiusM / 111320;
  const dLng = radiusM / (111320 * Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    coords.push([lng + dLng * Math.cos(t), lat + dLat * Math.sin(t)]);
  }
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [coords] } };
}

const NAME_VI: ExpressionSpecification = ['coalesce', ['get', 'name:vi'], ['get', 'name'], ['get', 'name:latin']];

/**
 * Ghép style nền với các lớp dữ liệu Gia Lai (vector tile từ Martin qua gateway /tiles).
 * Thứ tự: nền -> mặt nạ + ranh giới -> nhãn nền -> vùng bán kính -> tuyến đường -> POI -> điểm đang chọn -> số thứ tự lộ trình.
 */
export function buildStyle(base: StyleSpecification, origin: string, tilesVersion: string | number = 0): StyleSpecification {
  const style: StyleSpecification = structuredClone(base);

  style.sources['gl-boundaries'] = {
    type: 'vector',
    tiles: [`${origin}/tiles/boundaries/{z}/{x}/{y}`],
    minzoom: 5,
    maxzoom: 14,
    bounds: [107.0, 12.5, 109.6, 15.0],
  };
  style.sources['gl-pois'] = {
    type: 'vector',
    // ?v= đổi sau mỗi lần sửa toạ độ ở /review -> trình duyệt + service worker không dùng lại tile cũ
    tiles: [`${origin}/tiles/pois/{z}/{x}/{y}?v=${tilesVersion}`],
    minzoom: 6,
    maxzoom: 14,
    bounds: [107.0, 12.5, 109.6, 15.0],
  };
  style.sources['gl-selected'] = { type: 'geojson', data: EMPTY_FC };
  style.sources['gl-radius'] = { type: 'geojson', data: EMPTY_FC };
  style.sources['gl-route'] = { type: 'geojson', data: EMPTY_FC };
  style.sources['gl-trip-stops'] = { type: 'geojson', data: EMPTY_FC };

  const baseLayers = style.layers
    // ẩn POI của bản đồ nền để không chồng lên dữ liệu của mình
    .filter((l) => !('source-layer' in l && l['source-layer'] === 'poi'))
    .map((l) => {
      // nhãn nền ưu tiên tên tiếng Việt
      if (l.type === 'symbol' && l.layout && JSON.stringify(l.layout['text-field'] ?? '').includes('name:latin')) {
        return { ...l, layout: { ...l.layout, 'text-field': NAME_VI } } as LayerSpecification;
      }
      return l;
    });

  const firstSymbol = baseLayers.findIndex((l) => l.type === 'symbol');
  const below = baseLayers.slice(0, firstSymbol);
  const labels = baseLayers.slice(firstSymbol);

  const boundaryLayers: LayerSpecification[] = [
    {
      id: 'gl-mask',
      type: 'fill',
      source: 'gl-boundaries',
      'source-layer': 'mask',
      paint: { 'fill-color': '#0b1220', 'fill-opacity': 0.25 },
    },
    {
      id: 'gl-communes-fill',
      type: 'fill',
      source: 'gl-boundaries',
      'source-layer': 'communes',
      minzoom: 7,
      paint: {
        'fill-color': [
          'case',
          ['boolean', ['feature-state', 'selected'], false], '#0f766e',
          ['boolean', ['feature-state', 'hover'], false], '#14b8a6',
          '#000000',
        ],
        'fill-opacity': [
          'case',
          ['boolean', ['feature-state', 'selected'], false], 0.14,
          ['boolean', ['feature-state', 'hover'], false], 0.08,
          0,
        ],
      },
    },
    {
      id: 'gl-communes-line',
      type: 'line',
      source: 'gl-boundaries',
      'source-layer': 'communes',
      minzoom: 8,
      paint: {
        'line-color': '#64748b',
        'line-opacity': 0.6,
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.4, 13, 1.4],
        'line-dasharray': [3, 2],
      },
    },
    {
      id: 'gl-communes-selected',
      type: 'line',
      source: 'gl-boundaries',
      'source-layer': 'communes',
      paint: {
        'line-color': '#0f766e',
        'line-width': 2.5,
        'line-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 1, 0],
      },
    },
    {
      id: 'gl-province-line',
      type: 'line',
      source: 'gl-boundaries',
      'source-layer': 'province',
      paint: {
        'line-color': '#0f766e',
        'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1.5, 12, 3.5],
      },
    },
  ];

  const topLayers: LayerSpecification[] = [
    {
      id: 'gl-radius-fill',
      type: 'fill',
      source: 'gl-radius',
      paint: { 'fill-color': '#2563eb', 'fill-opacity': 0.07 },
    },
    {
      id: 'gl-radius-line',
      type: 'line',
      source: 'gl-radius',
      paint: { 'line-color': '#2563eb', 'line-width': 1.5, 'line-dasharray': [2, 2] },
    },
    {
      id: 'gl-commune-labels',
      type: 'symbol',
      source: 'gl-boundaries',
      'source-layer': 'commune_labels',
      minzoom: 10,
      layout: {
        'text-field': ['get', 'name'],
        'text-font': ['Noto Sans Bold'],
        'text-size': 11,
        'text-transform': 'uppercase',
        'text-letter-spacing': 0.06,
        'symbol-sort-key': ['-', 0, ['coalesce', ['get', 'population'], 0]],
      },
      paint: { 'text-color': '#475569', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5, 'text-opacity': 0.85 },
    },
    {
      // tuyến đường lộ trình (OSRM): viền trắng + lõi màu, nằm dưới ghim địa điểm
      id: 'gl-route-casing',
      type: 'line',
      source: 'gl-route',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 5, 15, 11] },
    },
    {
      id: 'gl-route-line',
      type: 'line',
      source: 'gl-route',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#2563eb', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3, 15, 7] },
    },
    {
      // vòng sáng dưới các địa điểm thuộc kết quả tìm kiếm (lọc theo uid, như cách của bando.tphcm)
      id: 'gl-results-halo',
      type: 'circle',
      source: 'gl-pois',
      'source-layer': 'pois',
      filter: ['in', ['get', 'uid'], ['literal', []]],
      paint: {
        'circle-radius': 15,
        'circle-color': '#f59e0b',
        'circle-opacity': 0.3,
        'circle-stroke-color': '#f59e0b',
        'circle-stroke-width': 2,
        'circle-translate': [0, -4],
      },
    },
    {
      id: 'gl-pois',
      type: 'symbol',
      source: 'gl-pois',
      'source-layer': 'pois',
      layout: {
        'icon-image': ['concat', 'pin-', ['get', 'cat']],
        'icon-anchor': 'bottom',
        'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 0.7, 14, 1],
        'icon-padding': 1,
        'icon-allow-overlap': ['step', ['zoom'], false, 15, true],
        // địa điểm nổi bật được vẽ trước, không bị che khi va chạm
        'symbol-sort-key': ['-', 100, ['coalesce', ['get', 'priority'], 0]],
        'text-field': ['step', ['zoom'], '', 13, ['get', 'name']],
        'text-font': ['Noto Sans Regular'],
        'text-size': 12,
        'text-anchor': 'top',
        'text-offset': [0, 0.2],
        'text-max-width': 9,
        'text-optional': true,
      },
      paint: { 'text-color': '#1e293b', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
    },
    {
      id: 'gl-selected',
      type: 'symbol',
      source: 'gl-selected',
      layout: {
        'icon-image': ['get', 'pin'],
        'icon-anchor': 'bottom',
        'icon-size': 1.4,
        'icon-allow-overlap': true,
        'text-field': ['get', 'name'],
        'text-font': ['Noto Sans Bold'],
        'text-size': 13,
        'text-anchor': 'top',
        'text-offset': [0, 0.3],
        'text-allow-overlap': true,
      },
      paint: { 'text-color': '#0f172a', 'text-halo-color': '#ffffff', 'text-halo-width': 2 },
    },
    {
      // điểm dừng đánh số 1, 2, 3… trên cùng
      id: 'gl-trip-stops',
      type: 'circle',
      source: 'gl-trip-stops',
      paint: {
        'circle-radius': 12,
        'circle-color': '#2563eb',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2.5,
      },
    },
    {
      id: 'gl-trip-numbers',
      type: 'symbol',
      source: 'gl-trip-stops',
      layout: {
        'text-field': ['to-string', ['get', 'n']],
        'text-font': ['Noto Sans Bold'],
        'text-size': 13,
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: { 'text-color': '#ffffff' },
    },
  ];

  style.layers = [...below, ...boundaryLayers, ...labels, ...topLayers];
  return style;
}
