import type { AreaDetail } from '../api';
import { formatNumber } from '../format';

interface Props {
  area: AreaDetail;
  onShowPlaces: () => void;
  onClose: () => void;
}

export function AreaCard({ area, onShowPlaces, onClose }: Props) {
  return (
    <section className="area" aria-label={area.name}>
      <header className="results-header">
        <div>
          <p className="eyebrow">{area.type} · mã {area.code}</p>
          <h2>{area.name}</h2>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Đóng">×</button>
      </header>
      <dl className="area-stats">
        <div>
          <dt>Dân số</dt>
          <dd>{formatNumber(area.population)}</dd>
        </div>
        <div>
          <dt>Diện tích</dt>
          <dd>{area.areaKm2 !== null ? `${formatNumber(area.areaKm2)} km²` : '—'}</dd>
        </div>
        <div>
          <dt>Mật độ</dt>
          <dd>{area.densityKm2 !== null ? `${formatNumber(Math.round(area.densityKm2))}/km²` : '—'}</dd>
        </div>
      </dl>
      {area.mergedFrom && (
        <p className="area-merged">
          <strong>Sáp nhập từ:</strong> {area.mergedFrom}
        </p>
      )}
      {area.locationCount > 0 && (
        <button className="btn btn-primary btn-block" onClick={onShowPlaces}>
          Xem {area.locationCount} địa điểm trong {area.type.toLowerCase()} này
        </button>
      )}
    </section>
  );
}
