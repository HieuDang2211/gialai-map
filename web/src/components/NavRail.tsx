export type NavView = 'explore' | 'saved' | 'recent' | 'trip';

interface Props {
  view: NavView | null;
  onChange: (v: NavView) => void;
  counts: { saved: number; trip: number };
}

const ICONS: Record<NavView, string> = {
  explore: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm3.5 6.5-2 5-5 2 2-5 5-2Z',
  saved: 'M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3 4.5 6.7 4.5c2.1 0 3.6 1.1 4.3 2.4h2c.7-1.3 2.2-2.4 4.3-2.4 3.7 0 5.8 3.9 4.3 7.3C19.5 16.4 12 21 12 21Z',
  recent: 'M13 3a9 9 0 1 0 8.9 10.4h-2A7 7 0 1 1 13 5v3l4-4-4-4v3Zm-1 5v5.4l4.3 2.6.8-1.3-3.6-2.1V8H12Z',
  trip: 'M6 3a3 3 0 0 0-1 5.8V21h2v-6h4l.6 2H18V9h-5.4L12 7H7V8.8A3 3 0 0 0 6 3Z',
};

const ITEMS: { id: NavView; label: string }[] = [
  { id: 'explore', label: 'Khám phá' },
  { id: 'saved', label: 'Đã lưu' },
  { id: 'recent', label: 'Gần đây' },
  { id: 'trip', label: 'Lộ trình' },
];

/** Thanh điều hướng: cột dọc bên trái (máy tính) / thanh dưới cùng (điện thoại), như Google Maps. */
export function NavRail({ view, onChange, counts }: Props) {
  return (
    <nav className="rail" aria-label="Điều hướng">
      {ITEMS.map((it) => {
        const badge = it.id === 'saved' ? counts.saved : it.id === 'trip' ? counts.trip : 0;
        return (
          <button key={it.id} className={'rail-item' + (view === it.id ? ' is-on' : '')} onClick={() => onChange(it.id)} aria-pressed={view === it.id}>
            <span className="rail-icon">
              <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
                <path fill="currentColor" d={ICONS[it.id]} />
              </svg>
              {badge > 0 && <span className="rail-badge">{badge}</span>}
            </span>
            <span className="rail-label">{it.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
