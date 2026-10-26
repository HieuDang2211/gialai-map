import type { Category } from '../api';
import { colorOf } from '../map';
import { CATEGORY_GROUPS, MAX_PINNED, resetPersonalization, togglePin } from '../personalize';

interface Props {
  categories: Category[];
  pinned: string[];
  active: string | null;
  onSelect: (slug: string) => void;
  onNotify: (msg: string) => void;
  onClose: () => void;
}

/** Màn "Khám phá": toàn bộ danh mục theo nhóm, chọn để lọc, ghim để đưa lên đầu thanh chip. */
export function ExplorePanel({ categories, pinned, active, onSelect, onNotify, onClose }: Props) {
  const known = new Set(CATEGORY_GROUPS.flatMap((g) => g.slugs));
  const groups = [
    ...CATEGORY_GROUPS.map((g) => ({ title: g.title, items: g.slugs.flatMap((s) => categories.filter((c) => c.slug === s)) })),
    { title: 'Khác', items: categories.filter((c) => !known.has(c.slug)) },
  ].filter((g) => g.items.length);

  const pin = (c: Category) => {
    if (!togglePin(c.slug)) onNotify(`Chỉ ghim được tối đa ${MAX_PINNED} danh mục.`);
  };

  return (
    <section className="explore" aria-label="Khám phá danh mục">
      <header className="results-header">
        <div>
          <h2>Khám phá</h2>
          <p className="muted">Chọn danh mục để lọc · bấm 📌 để ghim lên đầu thanh lọc</p>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Đóng">×</button>
      </header>

      {groups.map((g) => (
        <div key={g.title} className="explore-group">
          <h3>{g.title}</h3>
          <ul className="explore-grid">
            {g.items.map((c) => {
              const isPinned = pinned.includes(c.slug);
              return (
                <li key={c.slug} className={'explore-tile' + (active === c.slug ? ' is-on' : '')} style={{ '--chip-color': colorOf(c.slug) } as React.CSSProperties}>
                  <button className="explore-pick" onClick={() => onSelect(c.slug)} aria-pressed={active === c.slug}>
                    <span className="explore-icon">{c.icon}</span>
                    <span className="explore-name">{c.name}</span>
                    <span className="explore-count">{c.count} địa điểm</span>
                  </button>
                  <button
                    className={'explore-pin' + (isPinned ? ' is-pinned' : '')}
                    onClick={() => pin(c)}
                    aria-pressed={isPinned}
                    aria-label={isPinned ? `Bỏ ghim ${c.name}` : `Ghim ${c.name}`}
                    title={isPinned ? 'Bỏ ghim' : 'Ghim lên thanh lọc'}
                  >
                    📌
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      <p className="explore-note">
        Thanh lọc tự xếp danh mục bạn hay dùng lên trước. Dữ liệu cá nhân hoá chỉ lưu trên trình duyệt này.{' '}
        <button
          className="link"
          onClick={() => {
            resetPersonalization();
            onNotify('Đã đặt lại thứ tự danh mục.');
          }}
        >
          Đặt lại
        </button>
      </p>
    </section>
  );
}
