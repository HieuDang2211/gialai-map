import { useEffect, useId, useRef, useState } from 'react';
import { prefetchPlace, search, type AreaHit, type LocationHit, type SearchResult } from '../api';
import { formatDistance, safeHighlight } from '../format';

interface Props {
  value: string;
  onChange: (q: string) => void;
  /** vị trí dùng để xếp kết quả gần hơn lên trước (người dùng hoặc tâm bản đồ) */
  getOrigin: () => { lat: number; lng: number };
  category: string | null;
  onPickLocation: (hit: LocationHit) => void;
  onPickArea: (hit: AreaHit) => void;
  onSubmit: (q: string) => void;
  onClear: () => void;
}

type Option = { kind: 'area'; hit: AreaHit } | { kind: 'location'; hit: LocationHit };

const DEBOUNCE_MS = 120;

export function SearchBox({ value, onChange, getOrigin, category, onPickLocation, onPickArea, onSubmit, onClear }: Props) {
  const [result, setResult] = useState<SearchResult | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  // Tìm tức thì: debounce + huỷ request cũ bằng AbortController
  useEffect(() => {
    const q = value.trim();
    if (!q) {
      setResult(null);
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const o = getOrigin();
        const r = await search({ q, cat: category, lat: o.lat, lng: o.lng, limit: 6 }, ctrl.signal);
        setResult(r);
        setActive(-1);
      } catch (e) {
        if ((e as Error).name !== 'AbortError') console.error(e);
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
    // getOrigin đọc vị trí mới nhất qua ref nên không cần nằm trong deps
  }, [value, category]);

  const options: Option[] = [
    ...(result?.areas ?? []).map((hit) => ({ kind: 'area' as const, hit })),
    ...(result?.locations ?? []).map((hit) => ({ kind: 'location' as const, hit })),
  ];

  const pick = (o: Option) => {
    setOpen(false);
    inputRef.current?.blur();
    if (o.kind === 'area') onPickArea(o.hit);
    else onPickLocation(o.hit);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, options.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (active >= 0 && options[active]) pick(options[active]);
      else if (value.trim()) {
        setOpen(false);
        inputRef.current?.blur();
        onSubmit(value.trim());
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  const showList = open && value.trim() !== '' && result !== null;

  return (
    <div className="searchbox" role="search">
      <div className="searchbox-field">
        <svg className="searchbox-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M10.5 3a7.5 7.5 0 0 1 5.96 12.06l4.24 4.24-1.42 1.42-4.24-4.24A7.5 7.5 0 1 1 10.5 3Zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z" />
        </svg>
        <input
          ref={inputRef}
          type="search"
          value={value}
          placeholder="Tìm địa điểm, món ăn, xã/phường…"
          aria-label="Tìm kiếm trên bản đồ"
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
          autoComplete="off"
          enterKeyHint="search"
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={onKeyDown}
        />
        {loading && <span className="searchbox-spinner" aria-hidden="true" />}
        {value && (
          <button
            className="icon-btn"
            aria-label="Xoá tìm kiếm"
            onClick={() => {
              onClear();
              setResult(null);
              inputRef.current?.focus();
            }}
          >
            ×
          </button>
        )}
      </div>

      {showList && (
        <ul className="suggestions" id={listId} role="listbox">
          {options.length === 0 && <li className="suggestion-empty">Không tìm thấy “{value}”. Thử từ khoá khác hoặc bỏ dấu.</li>}
          {options.map((o, i) => (
            <li
              key={o.kind + (o.kind === 'area' ? o.hit.code : o.hit.id)}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={'suggestion' + (i === active ? ' is-active' : '')}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => {
                setActive(i);
                if (o.kind === 'location') prefetchPlace(o.hit.id);
              }}
              onTouchStart={() => o.kind === 'location' && prefetchPlace(o.hit.id)}
              onClick={() => pick(o)}
            >
              {o.kind === 'area' ? (
                <>
                  <span className="suggestion-icon">🗺️</span>
                  <span className="suggestion-text">
                    <span className="suggestion-title">{o.hit.name}</span>
                    {o.hit.mergedFrom && <span className="suggestion-sub">Sáp nhập từ: {o.hit.mergedFrom}</span>}
                  </span>
                </>
              ) : (
                <>
                  <span className="suggestion-icon">{o.hit.icon}</span>
                  <span className="suggestion-text">
                    <span className="suggestion-title" dangerouslySetInnerHTML={{ __html: safeHighlight(o.hit.nameHtml) }} />
                    <span className="suggestion-sub">
                      {o.hit.categoryName}
                      {o.hit.areaName ? ` · ${o.hit.areaName}` : ''}
                    </span>
                  </span>
                  {o.hit.distanceM !== null && <span className="suggestion-dist">{formatDistance(o.hit.distanceM)}</span>}
                </>
              )}
            </li>
          ))}
          {result && result.total > result.locations.length && (
            <li
              className="suggestion suggestion-more"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setOpen(false);
                onSubmit(value.trim());
              }}
            >
              Xem tất cả {result.total} kết quả →
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
