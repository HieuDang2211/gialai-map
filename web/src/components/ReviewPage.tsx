import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { type GeoJSONSource, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { fetchConfig, reviewApi, type ReviewDetail, type ReviewItem } from '../api';
import { BASEMAP_STYLE_URL } from '../map';
import { formatDistance } from '../format';
import { disableSatellite, enableSatellite, getAttribution } from '../satellite';

const TOKEN_KEY = 'gl-review-token';

const STATUS_LABEL: Record<string, string> = {
  suspect: 'Nghi ngờ',
  unverified: 'Chưa đối chiếu',
  verified: 'Đã đối chiếu',
  corrected: 'Đã hiệu chỉnh',
};

const ACTION_LABEL: Record<string, string> = { accept: 'Dời vị trí', verify: 'Xác nhận đúng', hide: 'Ẩn (không tồn tại)' };

/** Điểm người kiểm tra sắp chấp nhận + nguồn gốc của nó (để ghi chú trong locations.json). */
interface Pick {
  lng: number;
  lat: number;
  reportId?: number;
  ref?: string;
  label: string;
}

const readToken = () => {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
};

const dist = (a: [number, number], b: [number, number]) =>
  Math.hypot((a[0] - b[0]) * 111320 * Math.cos((a[1] * Math.PI) / 180), (a[1] - b[1]) * 110540);

const fmtTime = (s: string) => new Date(s).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });

export function ReviewPage() {
  const [token, setToken] = useState(readToken);
  const [tokenInput, setTokenInput] = useState('');
  const api = useMemo(() => reviewApi(token), [token]);
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [decided, setDecided] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState('');
  const [onlyReports, setOnlyReports] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [pick, setPick] = useState<Pick | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);

  const logout = useCallback((text?: string) => {
    try {
      sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* bỏ qua */
    }
    setToken('');
    setItems(null);
    if (text) setMessage({ text, error: true });
  }, []);

  const fail = useCallback(
    (e: unknown) => {
      const err = e as Error & { status?: number };
      if (err.status === 401 || err.status === 503) logout(err.message);
      else setMessage({ text: err.message ?? 'Có lỗi xảy ra', error: true });
    },
    [logout],
  );

  const loadQueue = useCallback(async () => {
    try {
      const q = await api.queue();
      setItems(q.items);
      setDecided(q.decided);
      return q.items;
    } catch (e) {
      fail(e);
      return null;
    }
  }, [api, fail]);

  useEffect(() => {
    document.title = 'Kiểm tra vị trí · Bản đồ số Gia Lai';
  }, []);

  useEffect(() => {
    if (token) void loadQueue();
  }, [token, loadQueue]);

  const loadDetail = useCallback(
    async (id: string) => {
      setSelectedId(id);
      setDetail(null);
      setNote('');
      try {
        const d = await api.detail(id);
        setDetail(d);
        // gợi ý sẵn: báo cáo đang chờ đầu tiên, nếu không thì ứng viên OSM trùng tên
        const r = d.reports.find((x) => x.status === 'pending' && x.kind === 'moved');
        const c = d.candidates.find((x) => x.nameScore >= 0.5);
        setPick(
          r ? { lng: r.lng, lat: r.lat, reportId: r.id, label: `Báo cáo #${r.id}` }
            : c ? { lng: c.lng, lat: c.lat, ref: c.ref, label: `OSM ${c.ref}` }
              : null,
        );
      } catch (e) {
        fail(e);
      }
    },
    [api, fail],
  );

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (items ?? []).filter((i) => (!onlyReports || i.reports > 0) && (!f || i.name.toLowerCase().includes(f)));
  }, [items, filter, onlyReports]);

  const decide = async (action: 'accept' | 'verify' | 'hide') => {
    if (!detail) return;
    const p = detail.place;
    if (action === 'hide' && !confirm(`Ẩn “${p.name}” khỏi bản đồ và tìm kiếm (địa điểm không tồn tại)?`)) return;
    if (action === 'accept' && !pick) return;
    setBusy(true);
    setMessage(null);
    try {
      const n = note.trim() || undefined;
      const res = await api.decide(
        p.id,
        action === 'accept'
          ? { action, lng: pick!.lng, lat: pick!.lat, reportId: pick!.reportId, ref: pick!.ref, note: n }
          : { action, note: n },
      );
      const tiles = res.tiles ? ` · đã xoá ${res.tiles.removed}/${res.tiles.tiles} tile trong cache` : '';
      setMessage({ text: `${ACTION_LABEL[action]}: “${p.name}” — đã ghi vào data/corrections/locations.json${tiles}.` });
      const next = await loadQueue();
      // sang địa điểm kế tiếp trong hàng chờ
      const idx = shown.findIndex((i) => i.id === p.id);
      const after = next?.filter((i) => i.id !== p.id && (!onlyReports || i.reports > 0));
      const target = after?.[Math.min(Math.max(idx, 0), after.length - 1)];
      if (target) void loadDetail(target.id);
      else {
        setSelectedId(null);
        setDetail(null);
      }
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const rejectReport = async (rid: number) => {
    if (!detail) return;
    setBusy(true);
    try {
      await api.rejectReport(rid);
      await loadQueue();
      await loadDetail(detail.place.id);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <div className="review-login">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const t = tokenInput.trim();
            if (!t) return;
            try {
              sessionStorage.setItem(TOKEN_KEY, t);
            } catch {
              /* bỏ qua */
            }
            setMessage(null);
            setToken(t);
          }}
        >
          <h1>Kiểm tra vị trí địa điểm</h1>
          <p className="muted">Nhập mã kiểm tra (biến môi trường <code>REVIEW_TOKEN</code> của API).</p>
          <input type="password" autoComplete="current-password" value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} placeholder="Mã kiểm tra" aria-label="Mã kiểm tra" />
          <button className="btn btn-primary" type="submit">Vào trang kiểm tra</button>
          {message && <p className="report-error" role="alert">{message.text}</p>}
          <p><a href="/">← Về bản đồ</a></p>
        </form>
      </div>
    );
  }

  const pending = detail?.reports.filter((r) => r.status === 'pending') ?? [];
  const past = detail?.reports.filter((r) => r.status !== 'pending') ?? [];

  return (
    <div className="review">
      <aside className="review-list" aria-label="Hàng chờ kiểm tra">
        <header>
          <h1>Kiểm tra vị trí</h1>
          <p className="muted">
            {items ? `${items.length} địa điểm cần xem` : 'Đang tải…'}
            {Object.keys(decided).length > 0 && ` · đã quyết định: ${Object.entries(decided).map(([k, v]) => `${ACTION_LABEL[k] ?? k} ${v}`).join(', ')}`}
          </p>
          <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Lọc theo tên…" aria-label="Lọc theo tên" />
          <label className="report-check">
            <input type="checkbox" checked={onlyReports} onChange={(e) => setOnlyReports(e.target.checked)} />
            Chỉ địa điểm có báo cáo
          </label>
          <div className="review-links">
            <a href="/">Bản đồ</a>
            <button className="link" onClick={() => logout()}>Thoát</button>
          </div>
        </header>
        <ul>
          {shown.map((i) => (
            <li key={i.id}>
              <button className={'review-item' + (i.id === selectedId ? ' is-active' : '')} onClick={() => void loadDetail(i.id)} aria-current={i.id === selectedId}>
                <span className="review-item-name">{i.icon} {i.name}</span>
                <span className="review-item-sub">
                  <span className={`review-status st-${i.status}`}>{STATUS_LABEL[i.status] ?? i.status}</span>
                  {i.reports > 0 && <span className="review-count">{i.reports} báo cáo{i.missingReports ? ` (${i.missingReports} “không tồn tại”)` : ''}</span>}
                  {i.areaName && <span className="muted">{i.areaName}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <main className="review-main">
        {message && (
          <p className={'review-msg' + (message.error ? ' is-error' : '')} role="status">
            {message.text}
          </p>
        )}
        {!selectedId && <p className="muted review-empty">Chọn một địa điểm trong danh sách (nghi ngờ xếp trước, rồi theo số báo cáo).</p>}
        {selectedId && !detail && <p className="muted review-empty">Đang tải…</p>}
        {detail && (
          <>
            <header className="review-head">
              <div>
                <h2>{detail.place.icon} {detail.place.name}</h2>
                <p className="muted">
                  {detail.place.categoryName} · {detail.place.areaName ?? 'ngoài xã/phường'} {detail.place.address && `· ${detail.place.address}`}
                </p>
                <p>
                  <span className={`review-status st-${detail.place.status}`}>{STATUS_LABEL[detail.place.status] ?? detail.place.status}</span>
                  {detail.place.note && <span className="muted"> {detail.place.note}</span>}
                </p>
              </div>
              <a className="btn" href={`/?place=${detail.place.id}`} target="_blank" rel="noopener">Mở trên bản đồ ↗</a>
            </header>

            <ReviewMap detail={detail} pick={pick} onPick={setPick} />

            <section className="review-actions" aria-label="Quyết định">
              <p>
                Điểm chọn:{' '}
                {pick ? (
                  <>
                    <strong>{pick.label}</strong> · {pick.lat.toFixed(6)}, {pick.lng.toFixed(6)} · dời{' '}
                    {formatDistance(dist([pick.lng, pick.lat], [detail.place.lng, detail.place.lat]))}
                  </>
                ) : (
                  <span className="muted">chạm vào bản đồ, một báo cáo hoặc một ứng viên OSM để chọn</span>
                )}
              </p>
              <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Ghi chú (không bắt buộc) — hiện trên trang chi tiết địa điểm" aria-label="Ghi chú quyết định" />
              <div className="place-actions">
                <button className="btn btn-primary" disabled={busy || !pick} onClick={() => void decide('accept')}>✓ Chấp nhận điểm đã chọn</button>
                <button className="btn" disabled={busy} onClick={() => void decide('verify')}>Vị trí hiện tại đúng</button>
                <button className="btn btn-danger" disabled={busy} onClick={() => void decide('hide')}>Ẩn — không tồn tại</button>
              </div>
            </section>

            <section>
              <h3>Báo cáo đang chờ ({pending.length})</h3>
              {pending.length === 0 && <p className="muted">Không có.</p>}
              <ul className="review-rows">
                {pending.map((r) => (
                  <li key={r.id} className={pick?.reportId === r.id ? 'is-picked' : ''}>
                    <button className="link" onClick={() => r.kind === 'moved' && setPick({ lng: r.lng, lat: r.lat, reportId: r.id, label: `Báo cáo #${r.id}` })} disabled={r.kind !== 'moved'}>
                      <span className="dot dot-report">{r.id}</span>
                      {r.kind === 'missing' ? 'Báo “không tồn tại”' : `Dời ${formatDistance(r.distanceM)}`}
                    </button>
                    <span className="muted"> · {fmtTime(r.createdAt)}</span>
                    {r.note && <q>{r.note}</q>}
                    <button className="link review-reject" disabled={busy} onClick={() => void rejectReport(r.id)}>Bỏ qua</button>
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <h3>Ứng viên OpenStreetMap ({detail.candidates.length})</h3>
              {detail.candidates.length === 0 && <p className="muted">Không có đối tượng OSM trùng tên trong 20 km hay sát vị trí (hoặc chưa trích data/osm/reference.geojsonseq).</p>}
              <ul className="review-rows">
                {detail.candidates.map((c) => (
                  <li key={c.ref} className={pick?.ref === c.ref ? 'is-picked' : ''}>
                    <button className="link" onClick={() => setPick({ lng: c.lng, lat: c.lat, ref: c.ref, label: `OSM ${c.ref}` })}>
                      <span className="dot dot-osm">◆</span>
                      {c.name}
                    </button>
                    <span className="muted"> · {c.kind}{c.polygon ? ' (tâm vùng)' : ''} · cách {formatDistance(c.distanceM)}{c.nameScore >= 0.5 ? ' · trùng tên' : ''}</span>
                    <a href={`https://www.openstreetmap.org/${c.ref}`} target="_blank" rel="noopener"> ↗</a>
                  </li>
                ))}
              </ul>
            </section>

            {(past.length > 0 || detail.history.length > 0) && (
              <section>
                <h3>Lịch sử</h3>
                <ul className="review-rows">
                  {detail.history.map((h) => (
                    <li key={h.createdAt}>{fmtTime(h.createdAt)} · <strong>{ACTION_LABEL[h.action] ?? h.action}</strong>{h.note && ` — ${h.note}`}</li>
                  ))}
                  {past.map((r) => (
                    <li key={r.id} className="muted">Báo cáo #{r.id} ({fmtTime(r.createdAt)}): {r.status === 'accepted' ? 'đã chấp nhận' : 'đã bỏ qua'}{r.note && ` — ${r.note}`}</li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------- bản đồ nhỏ

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

function ReviewMap({ detail, pick, onPick }: { detail: ReviewDetail; pick: Pick | null; onPick: (p: Pick) => void }) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const marker = useRef<maplibregl.Marker | null>(null);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const [ready, setReady] = useState(false);
  const [googleKey, setGoogleKey] = useState<string | null>(null);
  const [satellite, setSatellite] = useState(false);
  const [attribution, setAttribution] = useState('');

  useEffect(() => {
    let map: maplibregl.Map | null = null;
    let cancelled = false;
    (async () => {
      const [base, config] = await Promise.all([
        fetch(BASEMAP_STYLE_URL).then((r) => r.json() as Promise<StyleSpecification>),
        fetchConfig().catch(() => ({ googleMapsKey: null })),
      ]);
      if (cancelled || !el.current) return;
      setGoogleKey(config.googleMapsKey);
      map = new maplibregl.Map({ container: el.current, style: base, center: [108, 13.98], zoom: 14, dragRotate: false, attributionControl: { compact: true } });
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
      map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
      mapRef.current = map;
      map.on('load', () => {
        if (!map) return;
        map.addSource('rv', { type: 'geojson', data: EMPTY });
        map.addLayer({
          id: 'rv-line',
          type: 'line',
          source: 'rv',
          filter: ['==', ['geometry-type'], 'LineString'],
          paint: { 'line-color': '#64748b', 'line-width': 1.5, 'line-dasharray': [2, 2] },
        });
        map.addLayer({
          id: 'rv-points',
          type: 'circle',
          source: 'rv',
          filter: ['==', ['geometry-type'], 'Point'],
          paint: {
            'circle-radius': ['match', ['get', 'kind'], 'current', 9, 8],
            'circle-color': ['match', ['get', 'kind'], 'current', '#2563eb', 'report', '#dc2626', '#16a34a'],
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 2,
          },
        });
        map.addLayer({
          id: 'rv-labels',
          type: 'symbol',
          source: 'rv',
          filter: ['==', ['geometry-type'], 'Point'],
          layout: {
            'text-field': ['get', 'label'],
            'text-font': ['Noto Sans Regular'],
            'text-size': 12,
            'text-anchor': 'left',
            'text-offset': [1, 0],
            'text-allow-overlap': true,
          },
          paint: { 'text-color': '#0f172a', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
        });
        map.on('click', (e) => {
          const f = map!.queryRenderedFeatures(e.point, { layers: ['rv-points'] })[0];
          const p = f?.properties as { kind?: string; reportId?: number; ref?: string; label?: string } | undefined;
          const [lng, lat] = f ? (f.geometry as GeoJSON.Point).coordinates : [e.lngLat.lng, e.lngLat.lat];
          if (p?.kind === 'report') onPickRef.current({ lng, lat, reportId: Number(p.reportId), label: `Báo cáo #${p.reportId}` });
          else if (p?.kind === 'osm') onPickRef.current({ lng, lat, ref: p.ref, label: `OSM ${p.ref}` });
          else onPickRef.current({ lng, lat, label: 'Điểm chọn trên bản đồ' });
        });
        map.on('mousemove', (e) => {
          map!.getCanvas().style.cursor = map!.queryRenderedFeatures(e.point, { layers: ['rv-points'] }).length ? 'pointer' : 'crosshair';
        });
        setReady(true);
      });
    })().catch(console.error);
    return () => {
      cancelled = true;
      map?.remove();
      mapRef.current = null;
    };
  }, []);

  // dữ liệu + khung nhìn theo địa điểm đang xem
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const p = detail.place;
    const here: [number, number] = [p.lng, p.lat];
    const feats: GeoJSON.Feature[] = [
      { type: 'Feature', properties: { kind: 'current', label: 'Vị trí hiện tại' }, geometry: { type: 'Point', coordinates: here } },
    ];
    for (const r of detail.reports.filter((x) => x.status === 'pending' && x.kind === 'moved')) {
      feats.push({ type: 'Feature', properties: { kind: 'report', reportId: r.id, label: `#${r.id}` }, geometry: { type: 'Point', coordinates: [r.lng, r.lat] } });
      feats.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [here, [r.lng, r.lat]] } });
    }
    for (const c of detail.candidates) {
      feats.push({ type: 'Feature', properties: { kind: 'osm', ref: c.ref, label: c.name }, geometry: { type: 'Point', coordinates: [c.lng, c.lat] } });
    }
    (map.getSource('rv') as GeoJSONSource).setData({ type: 'FeatureCollection', features: feats });
    const pts = feats.filter((f) => f.geometry.type === 'Point').map((f) => (f.geometry as GeoJSON.Point).coordinates);
    const xs = pts.map((c) => c[0]);
    const ys = pts.map((c) => c[1]);
    if (pts.length > 1) map.fitBounds([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], { padding: 60, maxZoom: 17, duration: 0 });
    else map.jumpTo({ center: here, zoom: 16 });
  }, [ready, detail]);

  // ghim cam = điểm sẽ chấp nhận, kéo được để tinh chỉnh
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    if (!pick) {
      marker.current?.remove();
      marker.current = null;
      return;
    }
    if (!marker.current) {
      marker.current = new maplibregl.Marker({ draggable: true, color: '#f59e0b' }).setLngLat([pick.lng, pick.lat]).addTo(map);
      marker.current.on('dragend', () => {
        const ll = marker.current!.getLngLat();
        onPickRef.current({ lng: ll.lng, lat: ll.lat, label: 'Điểm chọn trên bản đồ' });
      });
    } else marker.current.setLngLat([pick.lng, pick.lat]);
  }, [ready, pick]);

  useEffect(() => () => void marker.current?.remove(), []);

  // vệ tinh Google (nếu đã cấu hình key) — dễ nhận ra công trình, cổng vào
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !googleKey) return;
    if (!satellite) {
      disableSatellite(map);
      setAttribution('');
      return;
    }
    const refresh = () => void getAttribution(map).then(setAttribution).catch(() => {});
    // lớp vệ tinh nằm dưới các điểm kiểm tra
    enableSatellite(map, googleKey, 'rv-line').then(refresh).catch((e) => console.error(e));
    map.on('moveend', refresh);
    return () => {
      map.off('moveend', refresh);
    };
  }, [ready, satellite, googleKey]);

  return (
    <div className="review-map-wrap">
      <div ref={el} className="review-map" aria-label="Bản đồ kiểm tra: xanh dương = vị trí hiện tại, đỏ = báo cáo, xanh lá = OSM, cam = điểm chọn" />
      <div className="review-legend">
        <span><i className="dot-current" /> hiện tại</span>
        <span><i className="dot-report" /> báo cáo</span>
        <span><i className="dot-osm" /> OSM</span>
        <span><i className="dot-pick" /> điểm chọn (kéo được)</span>
        {googleKey && (
          <button className="link" onClick={() => setSatellite((s) => !s)}>{satellite ? '🗺️ Bản đồ' : '🛰️ Vệ tinh'}</button>
        )}
      </div>
      {satellite && <div className="review-attrib">Google Maps {attribution}</div>}
    </div>
  );
}
