import type { PlaceDetail } from '../api';
import { prefetchPlace } from '../api';
import { formatDistance, imageUrl, openStatus, PRICE_LABELS } from '../format';

interface Props {
  place: PlaceDetail;
  onOpenPlace: (id: string) => void;
  onOpenArea: (code: number) => void;
  onClose: () => void;
  inTrip: boolean;
  tripFull: boolean;
  onToggleTrip: () => void;
  saved: boolean;
  onToggleSaved: () => void;
  /** vào chế độ chọn vị trí đúng trên bản đồ (ReportPanel) */
  onReport: () => void;
}

/** Mức độ tin cậy của vị trí (xem api/scripts/verify-locations.py). */
const LOCATION_BADGE: Record<string, string> = {
  verified: '✓ Vị trí đã đối chiếu',
  corrected: '✓ Vị trí đã được hiệu chỉnh',
  unverified: 'Vị trí chưa được đối chiếu',
  suspect: '⚠ Vị trí có thể chưa chính xác',
};

export function PlacePanel({ place, onOpenPlace, onOpenArea, onClose, inTrip, tripFull, onToggleTrip, saved, onToggleSaved, onReport }: Props) {
  const status = openStatus(place.openingHours);
  const directions = `https://www.google.com/maps/dir/?api=1&destination=${place.lat},${place.lng}`;

  const share = async () => {
    const data = { title: place.name, text: place.shortDescription ?? place.name, url: location.href };
    if (navigator.share) await navigator.share(data).catch(() => {});
    else await navigator.clipboard.writeText(location.href).then(() => alert('Đã sao chép liên kết'));
  };

  return (
    <article className="place" aria-label={place.name}>
      {place.images.length > 0 && (
        <div className="place-gallery">
          {place.images.map((src, i) => (
            <img key={src} src={imageUrl(src, 320, 200)} alt={`${place.name} – ảnh ${i + 1}`} loading={i === 0 ? 'eager' : 'lazy'} decoding="async" />
          ))}
        </div>
      )}

      <header className="place-header">
        <div>
          <h2>{place.name}</h2>
          <p className="place-meta">
            <span>{place.icon} {place.categoryName}</span>
            {place.rating !== null && (
              <span>
                ★ {place.rating.toLocaleString('vi-VN')} <span className="muted">({place.reviewCount})</span>
              </span>
            )}
            {place.priceRange && <span>{PRICE_LABELS[place.priceRange] ?? place.priceRange}</span>}
          </p>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Đóng">×</button>
      </header>

      <div className="place-actions">
        <button
          className={'btn' + (inTrip ? '' : ' btn-primary')}
          onClick={onToggleTrip}
          disabled={!inTrip && tripFull}
          aria-pressed={inTrip}
          title={!inTrip && tripFull ? 'Lộ trình đã đủ 12 điểm' : undefined}
        >
          {inTrip ? '✓ Trong lộ trình' : '+ Thêm vào lộ trình'}
        </button>
        {/* dự phòng: mở chỉ đường của Google Maps */}
        <a className="btn" href={directions} target="_blank" rel="noopener">Chỉ đường</a>
        <button className={'btn' + (saved ? ' is-saved' : '')} onClick={onToggleSaved} aria-pressed={saved}>
          {saved ? '♥ Đã lưu' : '♡ Lưu'}
        </button>
        {place.phone && <a className="btn" href={`tel:${place.phone.replace(/\s/g, '')}`}>Gọi</a>}
        <button className="btn" onClick={share}>Chia sẻ</button>
      </div>

      {/* điểm từ OSM / website ngân hàng: nguồn đã ghi ở cuối, toạ độ lấy trực tiếp từ nguồn */}
      {(place.source === 'gialai-travel' || place.source === 'survey') && LOCATION_BADGE[place.locationStatus] && (
        <p className={`loc-badge loc-${place.locationStatus}`} title={place.locationNote ?? undefined}>
          {LOCATION_BADGE[place.locationStatus]}
          {place.locationNote && place.locationStatus !== 'verified' && <span className="loc-note"> · {place.locationNote}</span>}
        </p>
      )}
      <button className="link report-link" onClick={onReport}>📍 Báo sai vị trí</button>

      {place.shortDescription && <p className="place-lead">{place.shortDescription}</p>}

      <dl className="place-facts">
        {status && (
          <>
            <dt>Giờ mở cửa</dt>
            <dd className={status.open ? 'ok' : 'warn'}>{status.text}</dd>
          </>
        )}
        {place.address && (
          <>
            <dt>Địa chỉ</dt>
            <dd>{place.address}</dd>
          </>
        )}
        {place.areaName && (
          <>
            <dt>Xã/phường</dt>
            <dd>
              <button className="link" onClick={() => place.areaCode && onOpenArea(place.areaCode)}>{place.areaName}</button>
              {place.areaMergedFrom && <span className="muted"> · trước đây: {place.areaMergedFrom}</span>}
            </dd>
          </>
        )}
        {place.checkIn && (
          <>
            <dt>Nhận/trả phòng</dt>
            <dd>{place.checkIn} – {place.checkOut}</dd>
          </>
        )}
        {place.priceRefs && place.priceRefs.length > 0 && (
          <>
            <dt>Giá tham khảo</dt>
            <dd>
              {place.priceRefs.map((p) => (
                <div key={p.name}>{p.name}: {Number(p.price).toLocaleString('vi-VN')} đ</div>
              ))}
            </dd>
          </>
        )}
        {place.website && (
          <>
            <dt>Website</dt>
            <dd><a href={place.website} target="_blank" rel="noopener">{place.website.replace(/^https?:\/\//, '')}</a></dd>
          </>
        )}
      </dl>

      {place.description && place.description !== place.shortDescription && (
        <details className="place-desc">
          <summary>Giới thiệu</summary>
          <p>{place.description}</p>
        </details>
      )}

      {place.source !== 'osm' && place.source !== 'gialai-travel' && place.sourceLicense && (
        <p className="place-source">{place.sourceLicense}</p>
      )}

      {place.source === 'osm' && (
        <p className="place-source">
          Dữ liệu từ{' '}
          <a href={`https://www.openstreetmap.org/${place.sourceRef ?? ''}`} target="_blank" rel="noopener">
            OpenStreetMap
          </a>{' '}
          (© OpenStreetMap contributors, ODbL) · thông tin chưa được xác minh.
        </p>
      )}

      {place.nearby.length > 0 && (
        <section className="place-nearby">
          <h3>Gần đây (trong 3 km)</h3>
          <ul className="result-list">
            {place.nearby.map((n) => (
              <li key={n.id}>
                <button
                  className="result"
                  onMouseEnter={() => prefetchPlace(n.id)}
                  onTouchStart={() => prefetchPlace(n.id)}
                  onClick={() => onOpenPlace(n.id)}
                >
                  <span className="result-icon">{n.icon}</span>
                  <span className="result-text">
                    <span className="result-title">{n.name}</span>
                    <span className="result-sub">{n.categoryName}{n.rating !== null ? ` · ★ ${n.rating}` : ''}</span>
                  </span>
                  <span className="result-dist">{formatDistance(n.distanceM)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
