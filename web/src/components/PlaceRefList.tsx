import { prefetchPlace } from '../api';
import type { PlaceRef } from '../personalize';

interface Props {
  title: string;
  items: PlaceRef[];
  empty: string;
  /** "Đã lưu": nút bỏ lưu từng mục; "Gần đây": nút xoá lịch sử */
  onRemove?: (p: PlaceRef) => void;
  onClearAll?: () => void;
  onOpenPlace: (id: string) => void;
  onClose: () => void;
}

const timeAgo = (at: number) => {
  const m = Math.round((Date.now() - at) / 60000);
  if (m < 1) return 'vừa xong';
  if (m < 60) return `${m} phút trước`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} giờ trước`;
  return `${Math.round(h / 24)} ngày trước`;
};

export function PlaceRefList({ title, items, empty, onRemove, onClearAll, onOpenPlace, onClose }: Props) {
  return (
    <section className="results" aria-label={title}>
      <header className="results-header">
        <div>
          <h2>{title}</h2>
          <p className="muted">{items.length ? `${items.length} địa điểm · lưu trên trình duyệt này` : ''}</p>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Đóng">×</button>
      </header>

      {items.length === 0 && <p className="empty">{empty}</p>}

      <ul className="result-list">
        {items.map((p) => (
          <li key={p.id} className="ref-row">
            <button
              className="result"
              onMouseEnter={() => prefetchPlace(p.id)}
              onTouchStart={() => prefetchPlace(p.id)}
              onClick={() => onOpenPlace(p.id)}
            >
              <span className="result-icon">{p.icon}</span>
              <span className="result-text">
                <span className="result-title">{p.name}</span>
                <span className="result-sub">{p.categoryName} · {timeAgo(p.at)}</span>
              </span>
            </button>
            {onRemove && (
              <button className="icon-btn sm" onClick={() => onRemove(p)} aria-label={`Bỏ lưu ${p.name}`} title="Bỏ lưu">
                ×
              </button>
            )}
          </li>
        ))}
      </ul>

      {onClearAll && items.length > 0 && (
        <button className="btn btn-block" onClick={onClearAll}>
          Xoá lịch sử đã xem
        </button>
      )}
    </section>
  );
}
