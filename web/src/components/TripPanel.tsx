import { useMemo, useState, type ReactNode } from 'react';
import type { TravelMode, TripResult, TripStop } from '../api';
import { formatClock, formatDistance, formatDuration, isOpenAt } from '../format';

export const MAX_TRIP_STOPS = 12;

interface Props {
  stops: TripStop[];
  result: TripResult | null;
  loading: 'optimize' | 'route' | null;
  error: string | null;
  roundtrip: boolean;
  onRoundtrip: (v: boolean) => void;
  onMove: (index: number, delta: -1 | 1) => void;
  onRemove: (index: number) => void;
  onClear: () => void;
  onOptimize: () => void;
  onRoute: () => void;
  onOpenPlace: (id: string) => void;
  onClose: () => void;
  mode: TravelMode;
  onMode: (m: TravelMode) => void;
  /** nút/khung mô phỏng di chuyển (khi đã có tuyến) */
  simulation: ReactNode;
}

const DWELL_OPTIONS = [30, 60, 90, 120];

export const MODES: { id: TravelMode; icon: string; label: string; gmaps: string; disabled?: string }[] = [
  { id: 'motorbike', icon: '🛵', label: 'Xe máy', gmaps: 'two-wheeler' },
  { id: 'car', icon: '🚗', label: 'Ô tô', gmaps: 'driving' },
  { id: 'foot', icon: '🚶', label: 'Đi bộ', gmaps: 'walking' },
  { id: 'bus', icon: '🚌', label: 'Xe buýt', gmaps: 'transit', disabled: 'Chưa có dữ liệu tuyến xe buýt Gia Lai (cần GTFS)' },
];

/** Giờ khởi hành mặc định: giờ tròn kế tiếp (hoặc 7:00 nếu đang là ban đêm). */
function defaultDeparture(): string {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  if (d.getHours() < 6 || d.getHours() > 20) d.setHours(7);
  return formatClock(d);
}

/** Link Google Maps dự phòng (tối đa 9 điểm dừng giữa). */
function googleMapsUrl(stops: TripStop[], roundtrip: boolean, mode: TravelMode): string {
  const ll = (s: TripStop) => `${s.lat},${s.lng}`;
  const origin = stops[0];
  const destination = roundtrip ? stops[0] : stops[stops.length - 1];
  const waypoints = (roundtrip ? stops.slice(1) : stops.slice(1, -1)).slice(0, 9);
  const travelmode = MODES.find((m) => m.id === mode)?.gmaps ?? 'driving';
  const p = new URLSearchParams({ api: '1', origin: ll(origin), destination: ll(destination), travelmode });
  if (waypoints.length) p.set('waypoints', waypoints.map(ll).join('|'));
  return `https://www.google.com/maps/dir/?${p}`;
}

export function TripPanel(props: Props) {
  const { stops, result, loading, error, roundtrip } = props;
  const [departure, setDeparture] = useState(defaultDeparture);
  const [dwellMin, setDwellMin] = useState(60);

  // Giờ đến từng điểm = khởi hành + thời gian các chặng trước + thời gian tham quan các điểm trước
  const schedule = useMemo(() => {
    if (!result) return null;
    const [h, m] = departure.split(':').map(Number);
    const t = new Date();
    t.setHours(h, m, 0, 0);
    const arrivals: Date[] = [new Date(t)];
    result.legs.forEach((leg, i) => {
      t.setSeconds(t.getSeconds() + leg.duration + (i === 0 ? 0 : dwellMin * 60));
      arrivals.push(new Date(t));
    });
    return arrivals;
  }, [result, departure, dwellMin]);

  const saved = result?.baseline ? result.baseline.distance - result.distance : 0;

  return (
    <section className="trip" aria-label="Lộ trình">
      <header className="results-header">
        <div>
          <h2>Lộ trình</h2>
          <p className="muted">
            {stops.length} / {MAX_TRIP_STOPS} điểm · {MODES.find((m) => m.id === props.mode)?.label.toLowerCase()}
          </p>
        </div>
        <button className="icon-btn" onClick={props.onClose} aria-label="Đóng">×</button>
      </header>

      {stops.length === 0 && (
        <p className="empty">Mở một địa điểm rồi bấm “Thêm vào lộ trình”. Chọn từ 2 điểm để chỉ đường hoặc tối ưu thứ tự tham quan.</p>
      )}

      <div className="mode-switch" role="radiogroup" aria-label="Phương tiện">
        {MODES.map((m) => (
          <button
            key={m.id}
            role="radio"
            aria-checked={props.mode === m.id}
            className={'mode-btn' + (props.mode === m.id ? ' is-on' : '')}
            onClick={() => props.onMode(m.id)}
            aria-disabled={!!m.disabled}
            title={m.disabled ?? m.label}
          >
            <span aria-hidden>{m.icon}</span> {m.label}
          </button>
        ))}
      </div>

      {result && (
        <div className="trip-summary" role="status">
          <strong>{formatDistance(result.distance)}</strong>
          <span>· {formatDuration(result.duration)} di chuyển</span>
          {saved > 500 && result.baseline && (
            <span className="trip-saved">
              Ngắn hơn {formatDistance(saved)} so với thứ tự ban đầu ({formatDistance(result.baseline.distance)})
            </span>
          )}
          {result.optimized && saved <= 500 && <span className="trip-saved">Thứ tự hiện tại đã gần tối ưu</span>}
        </div>
      )}

      {props.simulation}

      <ol className="trip-stops">
        {stops.map((s, i) => {
          const leg = result?.legs[i];
          const arrive = schedule?.[i];
          const open = arrive ? isOpenAt(s.openingHours, arrive) : null;
          return (
            <li key={s.id}>
              <div className="trip-stop">
                <span className="trip-num" aria-hidden>{i + 1}</span>
                <button className="trip-name" onClick={() => props.onOpenPlace(s.id)}>
                  <span className="result-title">{s.icon} {s.name}</span>
                  {arrive && (
                    <span className={'result-sub' + (open === false ? ' trip-warn' : '')}>
                      {i === 0 ? 'Khởi hành' : 'Đến'} {formatClock(arrive)}
                      {open === false && ' · có thể đã đóng cửa'}
                    </span>
                  )}
                </button>
                <span className="trip-tools">
                  <button className="icon-btn sm" onClick={() => props.onMove(i, -1)} disabled={i === 0} aria-label={`Đưa ${s.name} lên`}>↑</button>
                  <button className="icon-btn sm" onClick={() => props.onMove(i, 1)} disabled={i === stops.length - 1} aria-label={`Đưa ${s.name} xuống`}>↓</button>
                  <button className="icon-btn sm" onClick={() => props.onRemove(i)} aria-label={`Bỏ ${s.name}`}>×</button>
                </span>
              </div>
              {leg && (
                <details className="trip-leg">
                  <summary>
                    {formatDuration(leg.duration)} · {formatDistance(leg.distance)}
                    {leg.summary && <span className="muted"> · qua {leg.summary}</span>}
                  </summary>
                  <ol className="trip-steps">
                    {leg.steps?.map((st, k) => (
                      <li key={k}>
                        <span>{st.instruction}</span>
                        {st.distance > 0 && <span className="muted"> {formatDistance(st.distance)}</span>}
                      </li>
                    ))}
                  </ol>
                </details>
              )}
            </li>
          );
        })}
        {result?.roundtrip && stops.length > 0 && (
          <li>
            <div className="trip-stop">
              <span className="trip-num" aria-hidden>↺</span>
              <span className="trip-name">
                <span className="result-title">Về {stops[0].name}</span>
                {schedule && <span className="result-sub">Đến {formatClock(schedule[schedule.length - 1])}</span>}
              </span>
            </div>
          </li>
        )}
      </ol>

      {error && <p className="trip-error" role="alert">{error}</p>}

      {stops.length >= 2 && (
        <>
          <div className="trip-options">
            <label>
              <input type="checkbox" checked={roundtrip} onChange={(e) => props.onRoundtrip(e.target.checked)} /> Quay về điểm đầu
            </label>
            <label>
              Khởi hành <input type="time" value={departure} onChange={(e) => e.target.value && setDeparture(e.target.value)} />
            </label>
            <label>
              Ở mỗi điểm
              <select value={dwellMin} onChange={(e) => setDwellMin(Number(e.target.value))}>
                {DWELL_OPTIONS.map((m) => (
                  <option key={m} value={m}>{formatDuration(m * 60)}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="place-actions">
            <button className="btn btn-primary" onClick={props.onOptimize} disabled={loading !== null}>
              {loading === 'optimize' ? 'Đang tính…' : 'Tối ưu thứ tự'}
            </button>
            <button className="btn" onClick={props.onRoute} disabled={loading !== null}>
              {loading === 'route' ? 'Đang tính…' : 'Chỉ đường'}
            </button>
            <a className="btn" href={googleMapsUrl(stops, roundtrip, props.mode)} target="_blank" rel="noopener" title="Mở trong Google Maps">
              Google Maps
            </a>
          </div>
          <p className="trip-note">
            Điểm 1 là nơi xuất phát. Giờ đến là ước tính cho {MODES.find((m) => m.id === props.mode)?.label.toLowerCase()}, chưa tính kẹt xe.
            {stops.length > 11 && ' Google Maps chỉ nhận tối đa 10 điểm.'}
          </p>
        </>
      )}

      {stops.length > 0 && (
        <button className="link trip-clear" onClick={props.onClear}>Xoá lộ trình</button>
      )}
    </section>
  );
}
