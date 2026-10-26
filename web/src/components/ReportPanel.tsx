import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { submitLocationReport, type PlaceDetail } from '../api';
import { formatDistance } from '../format';

interface Props {
  map: maplibregl.Map;
  place: PlaceDetail;
  /** phần bản đồ bị thanh bên che, để ghim không nằm dưới panel */
  padding: maplibregl.PaddingOptions;
  onDone: (message: string) => void;
  onCancel: () => void;
}

/** Khớp giới hạn của API (api/src/reports.js). */
const MAX_MOVE_M = 20000;

const distanceM = (a: [number, number], b: [number, number]) =>
  Math.hypot((a[0] - b[0]) * 111320 * Math.cos((a[1] * Math.PI) / 180), (a[1] - b[1]) * 110540);

/**
 * Chế độ chọn vị trí đúng: ghim kéo được, bắt đầu ở vị trí hiện tại; chạm vào bản đồ cũng dời ghim tới đó.
 * Gửi tới POST /api/locations/:id/reports, người kiểm tra duyệt ở /review.
 */
export function ReportPanel({ map, place, padding, onDone, onCancel }: Props) {
  const [pos, setPos] = useState<[number, number]>([place.lng, place.lat]);
  const [note, setNote] = useState('');
  const [missing, setMissing] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const marker = useRef<maplibregl.Marker | null>(null);

  useEffect(() => {
    const m = new maplibregl.Marker({ draggable: true, color: '#dc2626' }).setLngLat([place.lng, place.lat]).addTo(map);
    m.getElement().setAttribute('aria-label', 'Ghim vị trí đúng (kéo để di chuyển)');
    m.getElement().classList.add('report-marker');
    m.on('drag', () => {
      const p = m.getLngLat();
      setPos([p.lng, p.lat]);
    });
    marker.current = m;
    const onClick = (e: maplibregl.MapMouseEvent) => {
      m.setLngLat(e.lngLat);
      setPos([e.lngLat.lng, e.lngLat.lat]);
    };
    map.on('click', onClick);
    // phóng to đủ để đặt ghim chính xác tới cửa/lối vào
    map.easeTo({ center: [place.lng, place.lat], zoom: Math.max(map.getZoom(), 16), padding, duration: 600 });
    return () => {
      map.off('click', onClick);
      m.remove();
      marker.current = null;
    };
  }, [map, place.id, place.lng, place.lat]);

  useEffect(() => {
    marker.current?.getElement().classList.toggle('is-hidden', missing);
  }, [missing]);

  const moved = distanceM(pos, [place.lng, place.lat]);
  const tooFar = !missing && moved > MAX_MOVE_M;
  const notMoved = !missing && moved < 10;
  const canSend = !sending && !tooFar && !notMoved && (!missing || note.trim().length > 0);

  const send = async () => {
    setSending(true);
    setError(null);
    try {
      await submitLocationReport(place.id, { kind: missing ? 'missing' : 'moved', lng: pos[0], lat: pos[1], note: note.trim() });
      onDone('Cảm ơn bạn! Báo cáo đã được gửi và sẽ được kiểm tra.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Không gửi được báo cáo.');
    } finally {
      setSending(false);
    }
  };

  return (
    <article className="report" aria-label={`Báo sai vị trí: ${place.name}`}>
      <header className="place-header">
        <div>
          <h2>Báo sai vị trí</h2>
          <p className="place-meta">{place.icon} {place.name}</p>
        </div>
        <button className="icon-btn" onClick={onCancel} aria-label="Huỷ">×</button>
      </header>

      {!missing && (
        <p className="report-help">
          Kéo <strong className="report-pin">ghim đỏ</strong> tới đúng vị trí (cổng/lối vào), hoặc chạm vào bản đồ để đặt ghim.
          Có thể bật <em>Vệ tinh</em> để dễ nhận ra công trình.
        </p>
      )}

      {!missing && (
        <p className={'report-moved' + (tooFar ? ' warn' : '')} aria-live="polite">
          {notMoved
            ? 'Ghim đang ở vị trí hiện tại.'
            : tooFar
              ? `Ghim cách vị trí hiện tại ${formatDistance(moved)} — tối đa 20 km.`
              : `Dời ${formatDistance(moved)} so với vị trí hiện tại.`}
        </p>
      )}

      <label className="report-check">
        <input type="checkbox" checked={missing} onChange={(e) => setMissing(e.target.checked)} />
        Địa điểm này không tồn tại / đã đóng cửa
      </label>

      <label className="report-label" htmlFor="report-note">
        Ghi chú {missing ? '(bắt buộc)' : '(không bắt buộc)'}
      </label>
      <textarea
        id="report-note"
        className="report-note"
        rows={3}
        maxLength={500}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={missing ? 'Vd: đã đóng cửa từ 2024, chỗ này là nhà dân…' : 'Vd: lối vào nằm ở đường Phạm Văn Đồng, cạnh cây xăng…'}
      />

      {error && <p className="report-error" role="alert">{error}</p>}

      <div className="place-actions">
        <button className="btn btn-primary" onClick={() => void send()} disabled={!canSend}>
          {sending ? 'Đang gửi…' : 'Gửi báo cáo'}
        </button>
        <button className="btn" onClick={onCancel}>Huỷ</button>
      </div>
      <p className="muted report-fine">Báo cáo được người kiểm tra xem xét trước khi vị trí trên bản đồ thay đổi.</p>
    </article>
  );
}
