import { prefetchPlace, type SearchResult } from '../api';
import { formatDistance, imageUrl, safeHighlight } from '../format';

interface Props {
  title: string;
  result: SearchResult | null;
  loading: boolean;
  onOpenPlace: (id: string) => void;
  onClose: () => void;
}

export function ResultList({ title, result, loading, onOpenPlace, onClose }: Props) {
  return (
    <section className="results" aria-label={title}>
      <header className="results-header">
        <div>
          <h2>{title}</h2>
          {result && !loading && <p className="muted">{result.total} địa điểm · {result.tookMs} ms</p>}
          {loading && <p className="muted">Đang tìm…</p>}
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Đóng">×</button>
      </header>

      {result && result.locations.length === 0 && !loading && (
        <p className="empty">Không có địa điểm phù hợp. Thử mở rộng bán kính hoặc đổi danh mục.</p>
      )}

      <ul className="result-list">
        {result?.locations.map((h) => (
          <li key={h.id}>
            <button
              className="result"
              onMouseEnter={() => prefetchPlace(h.id)}
              onTouchStart={() => prefetchPlace(h.id)}
              onClick={() => onOpenPlace(h.id)}
            >
              {h.image ? (
                <img className="result-thumb" src={imageUrl(h.image, 56, 56)} alt="" loading="lazy" decoding="async" width={56} height={56} />
              ) : (
                <span className="result-icon">{h.icon}</span>
              )}
              <span className="result-text">
                <span className="result-title" dangerouslySetInnerHTML={{ __html: safeHighlight(h.nameHtml) }} />
                <span className="result-sub">
                  {h.icon} {h.categoryName}
                  {h.rating !== null ? ` · ★ ${h.rating}` : ''}
                </span>
                {h.areaName && <span className="result-sub">{h.areaName}</span>}
              </span>
              {h.distanceM !== null && <span className="result-dist">{formatDistance(h.distanceM)}</span>}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
