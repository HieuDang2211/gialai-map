import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Category } from '../api';
import { colorOf } from '../map';

export type BarCategory = Category & { isPinned: boolean; isFrequent: boolean };

interface Props {
  categories: BarCategory[];
  active: string | null;
  onSelect: (slug: string | null) => void;
  near: { radiusKm: number } | null;
  radii: number[];
  onToggleNear: () => void;
  onRadius: (km: number) => void;
  onOpenAll: () => void;
  allOpen: boolean;
}

/**
 * Thanh chip lọc:
 *  - cuộn ngang có mũi tên + mờ dần ở mép khi còn chip bị che (trước đây chip bị "khuyết" mà không có dấu hiệu)
 *  - lăn chuột dọc = cuộn ngang trên máy tính
 *  - nút "Tất cả" luôn hiện ở cuối, mở màn Khám phá để chọn/ghim danh mục
 */
export function CategoryBar({ categories, active, onSelect, near, radii, onToggleNear, onRadius, onOpenAll, allOpen }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setEdges({ left: el.scrollLeft > 2, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2 });
  }, []);

  useLayoutEffect(() => {
    measure();
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, categories.length, near]);

  // Chip đang chọn luôn nằm trong vùng nhìn thấy
  useEffect(() => {
    scroller.current?.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [active]);

  const page = (dir: -1 | 1) => {
    const el = scroller.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.75, behavior: 'smooth' });
  };

  const onWheel = (e: React.WheelEvent) => {
    const el = scroller.current;
    if (!el || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    el.scrollLeft += e.deltaY;
  };

  return (
    <div className="catbar" role="toolbar" aria-label="Lọc theo danh mục">
      <button className={'chip chip-near' + (near ? ' is-on' : '')} onClick={onToggleNear} aria-pressed={!!near}>
        📍 Gần tôi
      </button>

      <div className={'catbar-track' + (edges.left ? ' fade-left' : '') + (edges.right ? ' fade-right' : '')}>
        {edges.left && (
          <button className="catbar-arrow left" onClick={() => page(-1)} aria-label="Danh mục trước" tabIndex={-1}>
            ‹
          </button>
        )}
        <div className="catbar-scroll" ref={scroller} onScroll={measure} onWheel={onWheel}>
          {near &&
            radii.map((r) => (
              <button
                key={r}
                className={'chip chip-radius' + (near.radiusKm === r ? ' is-on' : '')}
                onClick={() => onRadius(r)}
                aria-pressed={near.radiusKm === r}
              >
                {r} km
              </button>
            ))}
          {categories.map((c) => (
            <button
              key={c.slug}
              className={'chip' + (active === c.slug ? ' is-on' : '')}
              style={{ '--chip-color': colorOf(c.slug) } as React.CSSProperties}
              onClick={() => onSelect(active === c.slug ? null : c.slug)}
              aria-pressed={active === c.slug}
              title={c.isPinned ? 'Đã ghim' : c.isFrequent ? 'Bạn hay dùng' : undefined}
            >
              {c.icon} {c.name}
              {c.isPinned && <span className="chip-pin" aria-label="đã ghim">📌</span>}
            </button>
          ))}
        </div>
        {edges.right && (
          <button className="catbar-arrow right" onClick={() => page(1)} aria-label="Danh mục tiếp" tabIndex={-1}>
            ›
          </button>
        )}
      </div>

      <button className={'chip chip-all' + (allOpen ? ' is-on' : '')} onClick={onOpenAll} aria-pressed={allOpen} title="Tất cả danh mục · ghim danh mục yêu thích">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path fill="currentColor" d="M4 4h6v6H4zm10 0h6v6h-6zM4 14h6v6H4zm10 0h6v6h-6z" />
        </svg>
        Tất cả
      </button>
    </div>
  );
}
