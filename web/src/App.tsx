import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { type FilterSpecification, type GeoJSONSource, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  fetchArea,
  fetchCategories,
  fetchConfig,
  fetchPlace,
  fetchTrip,
  search,
  type AreaDetail,
  type Category,
  type PlaceDetail,
  type SearchResult,
  type TravelMode,
  type TripResult,
  type TripStop,
} from './api';
import { RouteSimulator, type SimState } from './simulate';
import { SimControls } from './components/SimControls';
import { BASEMAP_STYLE_URL, buildStyle, circlePolygon, colorOf, createPinImage, GIA_LAI_BOUNDS } from './map';
import { SearchBox } from './components/SearchBox';
import { PlacePanel } from './components/PlacePanel';
import { ReportPanel } from './components/ReportPanel';
import { ResultList } from './components/ResultList';
import { AreaCard } from './components/AreaCard';
import { MAX_TRIP_STOPS, MODES, TripPanel } from './components/TripPanel';
import { CategoryBar } from './components/CategoryBar';
import { ExplorePanel } from './components/ExplorePanel';
import { PlaceRefList } from './components/PlaceRefList';
import { NavRail, type NavView } from './components/NavRail';
import { disableSatellite, enableSatellite, getAttribution } from './satellite';
import { clearRecent, forgetPlace, orderCategories, recordCategoryUse, recordRecent, toggleSaved, usePrefs } from './personalize';

type BaseLayer = 'map' | 'satellite';
const BASE_LAYER_KEY = 'gl-base-layer';

interface Near {
  lat: number;
  lng: number;
  radiusKm: number;
  fromDevice: boolean;
}

const RADII = [1, 3, 5, 10];
const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

const toStop = (p: PlaceDetail): TripStop => ({
  id: p.id,
  name: p.name,
  icon: p.icon,
  category: p.category,
  openingHours: p.openingHours,
  lng: p.lng,
  lat: p.lat,
});
const isMobile = () => window.matchMedia('(max-width: 767px)').matches;

/** Kích thước bố cục máy tính (khớp với styles.css). */
const RAIL_W = 72;
const PANEL_W = 408;

/** Phần bản đồ bị panel che (trái trên máy tính, dưới trên di động), cập nhật mỗi lần render. */
const panelInset = { left: RAIL_W, sheetOpen: false };

/** Chừa chỗ cho panel khi di chuyển bản đồ. */
const mapPadding = () =>
  isMobile()
    ? { top: 120, bottom: panelInset.sheetOpen ? Math.round(window.innerHeight * 0.48) : 90, left: 24, right: 24 }
    : { top: 80, bottom: 40, left: panelInset.left + 24, right: 60 };

export function App() {
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const userLoc = useRef<{ lat: number; lng: number } | null>(null);
  const selectedArea = useRef<number | null>(null);
  const hoverArea = useRef<number | null>(null);
  const initialParams = useRef(new URLSearchParams(location.search));
  const initialHash = useRef(location.hash);

  const [ready, setReady] = useState(false);
  const [categories, setCategories] = useState<Category[]>([]);
  const [query, setQuery] = useState(() => new URLSearchParams(location.search).get('q') ?? '');
  const [submitted, setSubmitted] = useState<string | null>(() => new URLSearchParams(location.search).get('q'));
  const [cat, setCat] = useState<string | null>(() => new URLSearchParams(location.search).get('cat'));
  const [near, setNear] = useState<Near | null>(null);
  const [areaFilter, setAreaFilter] = useState<{ code: number; name: string } | null>(null);
  const [list, setList] = useState<{ result: SearchResult | null; loading: boolean } | null>(null);
  const [place, setPlace] = useState<PlaceDetail | null>(null);
  // chế độ "Báo sai vị trí": chạm bản đồ dời ghim báo cáo thay vì mở địa điểm/xã
  const [reporting, setReporting] = useState(false);
  const reportingRef = useRef(false);
  reportingRef.current = reporting && place !== null;
  const [area, setArea] = useState<AreaDetail | null>(null);
  const [expanded, setExpanded] = useState(false);
  // Thanh bên: view từ thanh điều hướng + trạng thái ẩn (máy tính: trượt ra ngoài; di động: chỉ còn tiêu đề)
  const [navView, setNavView] = useState<NavView | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const prefs = usePrefs();
  const [toast, setToast] = useState<string | null>(null);
  const [googleKey, setGoogleKey] = useState<string | null>(null);
  const [baseLayer, setBaseLayer] = useState<BaseLayer>(() => {
    try {
      return localStorage.getItem(BASE_LAYER_KEY) === 'satellite' ? 'satellite' : 'map';
    } catch {
      return 'map';
    }
  });
  const [googleAttribution, setGoogleAttribution] = useState('');

  // Lộ trình: danh sách điểm (thứ tự = thứ tự đi), kết quả OSRM khớp với danh sách hiện tại hoặc null
  const [tripStops, setTripStops] = useState<TripStop[]>([]);
  const setTripOpen = (open: boolean) => setNavView(open ? 'trip' : null);
  const [tripResult, setTripResult] = useState<TripResult | null>(null);
  const [tripLoading, setTripLoading] = useState<'optimize' | 'route' | null>(null);
  const [tripError, setTripError] = useState<string | null>(null);
  const [roundtrip, setRoundtrip] = useState(false);
  const [tripMode, setTripMode] = useState<TravelMode>('motorbike');
  const tripReq = useRef<AbortController | null>(null);

  // Mô phỏng di chuyển trên tuyến đã tính
  const simRef = useRef<RouteSimulator | null>(null);
  const [sim, setSim] = useState<SimState | null>(null);
  const [simSpeed, setSimSpeed] = useState(60);
  const [simFollow, setSimFollow] = useState(() => !window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 3500);
  }, []);

  // ---------------------------------------------------------------- khởi tạo bản đồ
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [base, cats, config] = await Promise.all([
        fetch(BASEMAP_STYLE_URL).then((r) => r.json() as Promise<StyleSpecification>),
        fetchCategories(),
        fetchConfig().catch(() => ({ googleMapsKey: null, tilesVersion: 0 })),
      ]);
      if (cancelled || !mapEl.current) return;
      setCategories(cats);
      setGoogleKey(config.googleMapsKey);
      const icons = new Map(cats.map((c) => [c.slug, c.icon]));

      const map = new maplibregl.Map({
        container: mapEl.current,
        style: buildStyle(base, location.origin, config.tilesVersion),
        bounds: location.hash ? undefined : GIA_LAI_BOUNDS,
        hash: true, // vị trí bản đồ nằm trên URL -> chia sẻ được
        maxBounds: [[104.5, 11.0], [112.0, 16.5]],
        minZoom: 6,
        pixelRatio: Math.min(window.devicePixelRatio, 2),
        attributionControl: { compact: true },
        dragRotate: false,
      });
      map.touchZoomRotate.disableRotation();
      mapRef.current = map;

      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
      map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

      // Ghim danh mục được vẽ khi style cần tới (không phải tải sprite riêng)
      map.on('styleimagemissing', (e) => {
        if (!e.id.startsWith('pin-') || map.hasImage(e.id)) return;
        const slug = e.id.slice(4);
        const { image, pixelRatio } = createPinImage(colorOf(slug), icons.get(slug) ?? '📍');
        map.addImage(e.id, image, { pixelRatio });
      });

      map.on('load', () => !cancelled && setReady(true));
    })().catch((e) => {
      console.error(e);
      notify('Không tải được bản đồ. Kiểm tra kết nối mạng.');
    });
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [notify]);

  const getOrigin = useCallback(() => {
    if (near) return { lat: near.lat, lng: near.lng };
    if (userLoc.current) return userLoc.current;
    const c = mapRef.current?.getCenter();
    return c ? { lat: c.lat, lng: c.lng } : { lat: 13.98, lng: 108.0 };
  }, [near]);

  // ---------------------------------------------------------------- mở địa điểm / xã
  const openPlace = useCallback(async (id: string, fly = true) => {
    try {
      const p = await fetchPlace(id);
      setPlace(p);
      setReporting(false);
      setExpanded(false);
      const ref = { id: p.id, name: p.name, icon: p.icon, category: p.category, categoryName: p.categoryName, lng: p.lng, lat: p.lat };
      recordRecent(ref);
      recordCategoryUse(p.category, 0.5);
      const map = mapRef.current;
      if (!map) return;
      (map.getSource('gl-selected') as GeoJSONSource | undefined)?.setData({
        type: 'Feature',
        properties: { name: p.name, pin: `pin-${p.category}` },
        geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
      });
      if (fly) map.easeTo({ center: [p.lng, p.lat], zoom: Math.max(map.getZoom(), 15), padding: mapPadding(), duration: 700 });
    } catch (e) {
      // 404 = địa điểm đã bị xoá khỏi bản đồ: bỏ khỏi Đã lưu / Gần đây để không gặp lại
      if (String((e as Error).message).startsWith('404')) {
        forgetPlace(id);
        notify('Địa điểm này đã bị xoá khỏi bản đồ.');
      } else notify('Không mở được địa điểm này.');
    }
  }, [notify]);

  const setAreaHighlight = useCallback((code: number | null) => {
    const map = mapRef.current;
    if (!map) return;
    if (selectedArea.current !== null) {
      map.setFeatureState({ source: 'gl-boundaries', sourceLayer: 'communes', id: selectedArea.current }, { selected: false });
    }
    selectedArea.current = code;
    if (code !== null) map.setFeatureState({ source: 'gl-boundaries', sourceLayer: 'communes', id: code }, { selected: true });
  }, []);

  const openArea = useCallback(async (code: number, fit = true) => {
    try {
      const a = await fetchArea(code);
      setPlace(null);
      setArea(a);
      setAreaHighlight(code);
      if (fit) mapRef.current?.fitBounds(a.bbox, { padding: mapPadding(), duration: 700, maxZoom: 13 });
    } catch {
      notify('Không mở được xã/phường này.');
    }
  }, [notify, setAreaHighlight]);

  const closePlace = useCallback(() => {
    setPlace(null);
    setReporting(false);
    (mapRef.current?.getSource('gl-selected') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: [] });
  }, []);

  const closeArea = useCallback(() => {
    setArea(null);
    setAreaHighlight(null);
  }, [setAreaHighlight]);

  // ---------------------------------------------------------------- tương tác trên bản đồ
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;

    const onClick = (e: maplibregl.MapMouseEvent) => {
      if (reportingRef.current) return; // ReportPanel tự xử lý: dời ghim tới điểm chạm
      const poi = map.queryRenderedFeatures(e.point, { layers: ['gl-trip-stops', 'gl-pois', 'gl-selected'] })[0];
      if (poi?.properties?.uid) return void openPlace(String(poi.properties.uid));
      if (poi) return; // bấm vào ghim đang chọn
      if (map.getZoom() < 8) return;
      const commune = map.queryRenderedFeatures(e.point, { layers: ['gl-communes-fill'] })[0];
      if (commune?.id !== undefined) void openArea(Number(commune.id), false);
    };

    const onMove = (e: maplibregl.MapMouseEvent) => {
      const onPoi = map.queryRenderedFeatures(e.point, { layers: ['gl-pois', 'gl-trip-stops'] }).length > 0;
      map.getCanvas().style.cursor = onPoi ? 'pointer' : '';
      const f = map.queryRenderedFeatures(e.point, { layers: ['gl-communes-fill'] })[0];
      const id = f?.id === undefined ? null : Number(f.id);
      if (id === hoverArea.current) return;
      if (hoverArea.current !== null) {
        map.setFeatureState({ source: 'gl-boundaries', sourceLayer: 'communes', id: hoverArea.current }, { hover: false });
      }
      hoverArea.current = id;
      if (id !== null) map.setFeatureState({ source: 'gl-boundaries', sourceLayer: 'communes', id }, { hover: true });
    };

    map.on('click', onClick);
    map.on('mousemove', onMove);
    return () => {
      map.off('click', onClick);
      map.off('mousemove', onMove);
    };
  }, [ready, openPlace, openArea]);

  // Trạng thái ban đầu từ URL (?place=, ?area=)
  useEffect(() => {
    if (!ready) return;
    // đọc tham số lúc tải trang: effect đồng bộ URL bên dưới đã ghi đè location.search trước khi bản đồ sẵn sàng
    const p = initialParams.current;
    const placeId = p.get('place');
    const areaCode = p.get('area');
    if (placeId) void openPlace(placeId, !location.hash);
    else if (areaCode) void openArea(Number(areaCode), !location.hash);
    const tripIds = (p.get('trip') ?? '').split(',').filter(Boolean).slice(0, MAX_TRIP_STOPS);
    const sharedView = initialHash.current !== ''; // link có sẵn vị trí bản đồ -> giữ nguyên, không căn lại
    if (tripIds.length) {
      void Promise.allSettled(tripIds.map((id) => fetchPlace(id))).then((rs) => {
        const stops = rs.flatMap((r) => (r.status === 'fulfilled' ? [toStop(r.value)] : []));
        setTripStops(stops);
        if (!placeId) setTripOpen(true);
        if (!placeId && !sharedView && stops.length > 1) {
          const xs = stops.map((s) => s.lng);
          const ys = stops.map((s) => s.lat);
          mapRef.current?.fitBounds([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], { padding: mapPadding(), maxZoom: 14 });
        }
        if (stops.length < tripIds.length) notify('Một số điểm trong lộ trình không còn tồn tại.');
      });
    }
    // chỉ chạy một lần khi bản đồ sẵn sàng
  }, [ready]);

  // ---------------------------------------------------------------- danh sách kết quả
  const listActive = submitted !== null || cat !== null || near !== null || areaFilter !== null;
  const catName = categories.find((c) => c.slug === cat)?.name;
  const listTitle = near
    ? `Gần ${near.fromDevice ? 'bạn' : 'tâm bản đồ'} · ${near.radiusKm} km${catName ? ` · ${catName}` : ''}`
    : areaFilter
      ? `Tại ${areaFilter.name}${catName ? ` · ${catName}` : ''}`
      : submitted
        ? `Kết quả cho “${submitted}”${catName ? ` · ${catName}` : ''}`
        : (catName ?? 'Kết quả');

  useEffect(() => {
    if (!listActive) {
      setList(null);
      return;
    }
    const ctrl = new AbortController();
    setList((l) => ({ result: l?.result ?? null, loading: true }));
    const origin = getOrigin();
    search(
      { q: submitted ?? '', cat, area: areaFilter?.code, lat: origin.lat, lng: origin.lng, radiusKm: near?.radiusKm, limit: 40 },
      ctrl.signal,
    )
      .then((result) => setList({ result, loading: false }))
      .catch((e) => {
        if ((e as Error).name !== 'AbortError') {
          setList({ result: null, loading: false });
          notify('Tìm kiếm đang gặp sự cố, thử lại sau.');
        }
      });
    return () => ctrl.abort();
  }, [listActive, submitted, cat, near, areaFilter, getOrigin, notify]);

  // Đồng bộ bản đồ với bộ lọc: lọc ghim theo danh mục + vòng sáng các kết quả
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    map.setFilter('gl-pois', cat ? (['==', ['get', 'cat'], cat] as FilterSpecification) : null);
    const uids = list?.result?.locations.map((l) => l.id) ?? [];
    map.setFilter('gl-results-halo', ['in', ['get', 'uid'], ['literal', uids]] as FilterSpecification);
  }, [ready, cat, list]);

  // Vẽ vùng bán kính "Gần tôi"
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const src = map.getSource('gl-radius') as GeoJSONSource | undefined;
    if (!near) {
      src?.setData({ type: 'FeatureCollection', features: [] });
      return;
    }
    const circle = circlePolygon(near.lng, near.lat, near.radiusKm * 1000);
    src?.setData(circle);
    const xs = circle.geometry.coordinates[0].map((c) => c[0]);
    const ys = circle.geometry.coordinates[0].map((c) => c[1]);
    map.fitBounds([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], { padding: mapPadding(), duration: 700 });
  }, [ready, near]);

  // Lớp nền: bản đồ vector <-> vệ tinh Google (bật lười: chỉ gọi Google khi người dùng chọn)
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    try {
      localStorage.setItem(BASE_LAYER_KEY, baseLayer);
    } catch {
      /* bỏ qua */
    }
    if (baseLayer === 'map') {
      disableSatellite(map);
      setGoogleAttribution('');
      return;
    }
    if (!googleKey) {
      notify('Chưa cấu hình GOOGLE_MAPS_API_KEY nên chưa bật được ảnh vệ tinh.');
      setBaseLayer('map');
      return;
    }
    let ctrl = new AbortController();
    const refresh = () => {
      ctrl.abort();
      ctrl = new AbortController();
      getAttribution(map, ctrl.signal).then(setGoogleAttribution).catch(() => {});
    };
    enableSatellite(map, googleKey)
      .then(refresh)
      .catch((e: Error) => {
        notify(`Không bật được vệ tinh Google: ${e.message}`);
        setBaseLayer('map');
      });
    map.on('moveend', refresh);
    return () => {
      map.off('moveend', refresh);
      ctrl.abort();
    };
  }, [ready, baseLayer, googleKey, notify]);

  // URL luôn phản ánh trạng thái -> gửi link là người nhận thấy đúng thứ mình thấy
  useEffect(() => {
    const p = new URLSearchParams();
    if (submitted) p.set('q', submitted);
    if (cat) p.set('cat', cat);
    if (place) p.set('place', place.id);
    else if (area) p.set('area', String(area.code));
    if (tripStops.length) p.set('trip', tripStops.map((s) => s.id).join(','));
    const qs = p.toString().replace(/%2C/g, ',');
    history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`);
    document.title = place ? `${place.name} · Bản đồ số Gia Lai` : 'Bản đồ số Gia Lai';
  }, [submitted, cat, place, area, tripStops]);

  // ---------------------------------------------------------------- lộ trình
  const editTrip = useCallback((fn: (stops: TripStop[]) => TripStop[]) => {
    tripReq.current?.abort();
    setTripLoading(null);
    setTripStops(fn);
    setTripResult(null); // thứ tự/tuỳ chọn đã đổi -> kết quả cũ không còn đúng
    setTripError(null);
  }, []);

  const toggleTripStop = (p: PlaceDetail) => {
    if (tripStops.some((s) => s.id === p.id)) return editTrip((st) => st.filter((s) => s.id !== p.id));
    if (tripStops.length >= MAX_TRIP_STOPS) return notify(`Lộ trình tối đa ${MAX_TRIP_STOPS} điểm.`);
    editTrip((st) => [...st, toStop(p)]);
    notify(`Đã thêm “${p.name}” vào lộ trình (${tripStops.length + 1} điểm).`);
  };

  const runTrip = async (optimize: boolean, mode: TravelMode = tripMode) => {
    tripReq.current?.abort();
    const ctrl = new AbortController();
    tripReq.current = ctrl;
    setTripLoading(optimize ? 'optimize' : 'route');
    setTripError(null);
    try {
      const r = await fetchTrip(tripStops.map((s) => s.id), { optimize, roundtrip, mode }, ctrl.signal);
      setTripStops(r.stops);
      setTripResult(r);
      const xs = r.geometry.coordinates.map((c) => c[0]);
      const ys = r.geometry.coordinates.map((c) => c[1]);
      mapRef.current?.fitBounds([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], { padding: mapPadding(), duration: 700 });
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setTripError((e as Error).message || 'Không tính được lộ trình.');
    } finally {
      if (tripReq.current === ctrl) setTripLoading(null);
    }
  };

  // Đổi phương tiện: tính lại ngay nếu đang có tuyến (giữ nguyên kiểu tối ưu / theo thứ tự)
  const changeMode = (m: TravelMode) => {
    const def = MODES.find((x) => x.id === m);
    if (def?.disabled) return notify(def.disabled);
    if (m === tripMode) return;
    const had = tripResult;
    setTripMode(m);
    if (had && tripStops.length >= 2) void runTrip(had.optimized, m);
    else editTrip((st) => st);
  };

  // Tuyến thay đổi -> bỏ mô phỏng cũ (vị trí/thời gian không còn khớp)
  useEffect(() => {
    simRef.current?.destroy();
    simRef.current = null;
    setSim(null);
  }, [tripResult]);
  useEffect(() => () => simRef.current?.destroy(), []);

  const startSim = () => {
    const map = mapRef.current;
    if (!map || !tripResult) return;
    simRef.current?.destroy();
    const s = new RouteSimulator(map, tripResult.geometry, tripResult.segmentDurations, tripResult.legs.map((l) => l.duration), tripResult.mode, setSim);
    // mặc định: cả hành trình phát trong ~40 giây, làm tròn về mức tốc độ gần nhất
    s.fitTo(40);
    s.speed = [30, 60, 120, 300].reduce((best, v) => (Math.abs(v - s.speed) < Math.abs(best - s.speed) ? v : best), 60);
    s.follow = simFollow;
    setSimSpeed(s.speed);
    simRef.current = s;
    if (simFollow) mapRef.current?.easeTo({ center: tripResult.geometry.coordinates[0] as [number, number], zoom: Math.max(map.getZoom(), 15), padding: mapPadding(), duration: 600 });
    setTimeout(() => s.play(), simFollow ? 650 : 0);
  };

  const stopSim = () => {
    simRef.current?.destroy();
    simRef.current = null;
    setSim(null);
  };

  // Vẽ tuyến đường + số thứ tự các điểm dừng
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    (map.getSource('gl-trip-stops') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: tripStops.map((s, i) => ({
        type: 'Feature',
        properties: { n: i + 1, uid: s.id },
        geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
      })),
    });
    (map.getSource('gl-route') as GeoJSONSource | undefined)?.setData(
      tripResult ? { type: 'Feature', properties: {}, geometry: tripResult.geometry } : EMPTY_FC,
    );
  }, [ready, tripStops, tripResult]);

  // ---------------------------------------------------------------- "Gần tôi"
  const toggleNear = () => {
    if (near) return setNear(null);
    setAreaFilter(null);
    const fallback = () => {
      const c = mapRef.current!.getCenter();
      setNear({ lat: c.lat, lng: c.lng, radiusKm: 3, fromDevice: false });
      notify('Không lấy được vị trí của bạn, đang dùng tâm bản đồ.');
    };
    if (!navigator.geolocation) return fallback();
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        userLoc.current = loc;
        const [w, s, e, n] = GIA_LAI_BOUNDS;
        if (loc.lng < w || loc.lng > e || loc.lat < s || loc.lat > n) {
          const c = mapRef.current!.getCenter();
          setNear({ lat: c.lat, lng: c.lng, radiusKm: 3, fromDevice: false });
          notify('Bạn đang ở ngoài Gia Lai, đang dùng tâm bản đồ.');
        } else setNear({ ...loc, radiusKm: 3, fromDevice: true });
      },
      fallback,
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 },
    );
  };

  const clearList = () => {
    setSubmitted(null);
    setCat(null);
    setNear(null);
    setAreaFilter(null);
  };

  // Thứ tự ưu tiên nội dung thanh bên: địa điểm > xã/phường > màn từ thanh điều hướng > danh sách kết quả
  const panel = useMemo(() => {
    if (place) return 'place';
    if (area) return 'area';
    if (navView) return navView;
    if (list) return 'list';
    return null;
  }, [place, area, list, navView]);

  // Có nội dung mới -> tự hiện lại thanh bên nếu người dùng đã ẩn
  const panelKey = `${panel}:${place?.id ?? ''}:${area?.code ?? ''}`;
  useEffect(() => {
    if (panel) setCollapsed(false);
  }, [panelKey]);

  const panelVisible = panel !== null && !collapsed;
  panelInset.left = RAIL_W + (panelVisible ? PANEL_W : 0);
  panelInset.sheetOpen = panelVisible;

  const orderedCategories = useMemo(() => orderCategories(categories, prefs), [categories, prefs]);
  const isSaved = !!place && prefs.saved.some((s) => s.id === place.id);

  const selectCategory = (slug: string | null) => {
    closePlace();
    if (navView === 'explore') setNavView(null);
    if (slug) recordCategoryUse(slug);
    setCat(slug);
  };

  const onNav = (v: NavView) => {
    closePlace();
    closeArea();
    setNavView(navView === v && !collapsed ? null : v);
  };

  return (
    <div
      className={'app' + (panel ? ' has-panel' : '') + (collapsed ? ' is-collapsed' : '')}
      style={{ '--panel-w': panelVisible ? `${PANEL_W}px` : '0px' } as React.CSSProperties}
    >
      <div ref={mapEl} className="map" aria-label="Bản đồ Gia Lai" />

      <NavRail view={place || area ? null : navView} onChange={onNav} counts={{ saved: prefs.saved.length, trip: tripStops.length }} />

      <div className="topbar">
        <SearchBox
          value={query}
          onChange={setQuery}
          getOrigin={getOrigin}
          category={cat}
          onPickLocation={(h) => void openPlace(h.id)}
          onPickArea={(h) => void openArea(h.code)}
          onSubmit={(q) => {
            closePlace();
            closeArea();
            setSubmitted(q);
          }}
          onClear={() => {
            setQuery('');
            setSubmitted(null);
          }}
        />

      </div>

      <CategoryBar
        categories={orderedCategories}
        active={cat}
        onSelect={selectCategory}
        near={near}
        radii={RADII}
        onToggleNear={toggleNear}
        onRadius={(r) => near && setNear({ ...near, radiusKm: r })}
        onOpenAll={() => onNav('explore')}
        allOpen={panel === 'explore' && !collapsed}
      />

      {panel && (
        <aside id="sidebar" className={'panel' + (expanded ? ' is-expanded' : '') + (collapsed ? ' is-collapsed' : '')} aria-label="Thanh thông tin">
          {/* di động: nửa màn hình -> toàn màn hình -> chỉ tiêu đề -> nửa màn hình */}
          <button
            className="panel-handle"
            onClick={() => {
              if (collapsed) setCollapsed(false);
              else if (!expanded) setExpanded(true);
              else {
                setExpanded(false);
                setCollapsed(true);
              }
            }}
            aria-label={collapsed ? 'Hiện thông tin' : expanded ? 'Thu nhỏ' : 'Mở rộng'}
          />
          <div className="panel-body">
            {panel === 'place' && place && (
              <>
                {(navView || list) && (
                  <button className="back" onClick={closePlace}>
                    ← Quay lại {navView === 'trip' ? 'lộ trình' : navView === 'saved' ? 'đã lưu' : navView === 'recent' ? 'gần đây' : navView === 'explore' ? 'khám phá' : 'danh sách'}
                  </button>
                )}
                {reporting && mapRef.current ? (
                  <ReportPanel
                    map={mapRef.current}
                    place={place}
                    padding={mapPadding()}
                    onCancel={() => setReporting(false)}
                    onDone={(msg) => {
                      setReporting(false);
                      notify(msg);
                    }}
                  />
                ) : (
                  <PlacePanel
                    place={place}
                    onReport={() => setReporting(true)}
                    onOpenPlace={(id) => void openPlace(id)}
                    onOpenArea={(c) => void openArea(c)}
                    onClose={closePlace}
                    inTrip={tripStops.some((s) => s.id === place.id)}
                    tripFull={tripStops.length >= MAX_TRIP_STOPS}
                    onToggleTrip={() => toggleTripStop(place)}
                    saved={isSaved}
                    onToggleSaved={() => {
                      const now = toggleSaved({ id: place.id, name: place.name, icon: place.icon, category: place.category, categoryName: place.categoryName, lng: place.lng, lat: place.lat });
                      notify(now ? `Đã lưu “${place.name}”.` : `Đã bỏ lưu “${place.name}”.`);
                    }}
                  />
                )}
              </>
            )}
            {panel === 'explore' && (
              <ExplorePanel
                categories={categories}
                pinned={prefs.pinned}
                active={cat}
                onSelect={(slug) => selectCategory(slug)}
                onNotify={notify}
                onClose={() => setNavView(null)}
              />
            )}
            {panel === 'saved' && (
              <PlaceRefList
                title="Đã lưu"
                items={prefs.saved}
                empty="Chưa có địa điểm nào. Mở một địa điểm và bấm “♡ Lưu” để lưu lại."
                onRemove={(p) => toggleSaved(p)}
                onOpenPlace={(id) => void openPlace(id)}
                onClose={() => setNavView(null)}
              />
            )}
            {panel === 'recent' && (
              <PlaceRefList
                title="Gần đây"
                items={prefs.recent}
                empty="Bạn chưa xem địa điểm nào."
                onClearAll={clearRecent}
                onOpenPlace={(id) => void openPlace(id)}
                onClose={() => setNavView(null)}
              />
            )}
            {panel === 'trip' && (
              <TripPanel
                stops={tripStops}
                result={tripResult}
                loading={tripLoading}
                error={tripError}
                roundtrip={roundtrip}
                onRoundtrip={(v) => {
                  setRoundtrip(v);
                  editTrip((st) => st);
                }}
                onMove={(i, d) =>
                  editTrip((st) => {
                    const next = [...st];
                    [next[i], next[i + d]] = [next[i + d], next[i]];
                    return next;
                  })
                }
                onRemove={(i) => editTrip((st) => st.filter((_, k) => k !== i))}
                onClear={() => {
                  editTrip(() => []);
                  setTripOpen(false);
                }}
                onOptimize={() => void runTrip(true)}
                onRoute={() => void runTrip(false)}
                onOpenPlace={(id) => void openPlace(id)}
                onClose={() => setTripOpen(false)}
                mode={tripMode}
                onMode={changeMode}
                simulation={
                  tripResult &&
                  (sim ? (
                    <SimControls
                      state={sim}
                      stops={tripStops}
                      roundtrip={tripResult.roundtrip}
                      mode={tripResult.mode}
                      speed={simSpeed}
                      follow={simFollow}
                      onPlay={() => simRef.current?.play()}
                      onPause={() => simRef.current?.pause()}
                      onSeek={(p) => simRef.current?.seek(p)}
                      onSpeed={(v) => {
                        setSimSpeed(v);
                        if (simRef.current) simRef.current.speed = v;
                      }}
                      onFollow={(v) => {
                        setSimFollow(v);
                        if (simRef.current) simRef.current.follow = v;
                      }}
                      onStop={stopSim}
                    />
                  ) : (
                    <button className="btn btn-block sim-start" onClick={startSim}>
                      ▶ Mô phỏng di chuyển {MODES.find((m) => m.id === tripResult.mode)?.icon}
                    </button>
                  ))
                }
              />
            )}
            {panel === 'area' && area && (
              <AreaCard
                area={area}
                onClose={closeArea}
                onShowPlaces={() => {
                  setNear(null);
                  setAreaFilter({ code: area.code, name: area.name });
                  setArea(null);
                }}
              />
            )}
            {panel === 'list' && list && (
              <ResultList title={listTitle} result={list.result} loading={list.loading} onOpenPlace={(id) => void openPlace(id)} onClose={clearList} />
            )}
          </div>
        </aside>
      )}

      {/* Nút ẩn/hiện thanh bên (máy tính), gắn ở mép phải của panel như Google Maps */}
      {panel && (
        <button
          className="panel-toggle"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          aria-controls="sidebar"
          aria-label={collapsed ? 'Hiện thanh bên' : 'Ẩn thanh bên'}
          title={collapsed ? 'Hiện thanh bên' : 'Ẩn thanh bên'}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path fill="currentColor" d={collapsed ? 'm9 6 6 6-6 6-1.4-1.4 4.6-4.6-4.6-4.6z' : 'm15 6-6 6 6 6 1.4-1.4-4.6-4.6 4.6-4.6z'} />
          </svg>
        </button>
      )}

      <div className="layer-switch" role="group" aria-label="Lớp bản đồ nền">
        <button aria-pressed={baseLayer === 'map'} onClick={() => setBaseLayer('map')}>
          🗺️ Bản đồ
        </button>
        <button
          aria-pressed={baseLayer === 'satellite'}
          onClick={() => setBaseLayer('satellite')}
          title={googleKey ? 'Ảnh vệ tinh Google' : 'Cần cấu hình GOOGLE_MAPS_API_KEY'}
        >
          🛰️ Vệ tinh
        </button>
      </div>

      {baseLayer === 'satellite' && (
        <div className="google-attrib">
          <span className="google-logo" aria-label="Google Maps">Google Maps</span>
          {googleAttribution && <span>{googleAttribution}</span>}
        </div>
      )}

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
