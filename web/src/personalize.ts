import { useSyncExternalStore } from 'react';
import type { Category } from './api';

/**
 * Cá nhân hoá lưu NGAY TRÊN TRÌNH DUYỆT (localStorage), không gửi lên máy chủ:
 *  - pinned : danh mục người dùng ghim -> luôn đứng đầu thanh chip
 *  - usage  : điểm dùng danh mục, giảm dần theo thời gian (nửa đời 14 ngày) -> tự xếp danh mục hay dùng lên trước
 *  - saved  : địa điểm đã lưu ("Đã lưu")
 *  - recent : địa điểm đã xem gần đây ("Gần đây")
 */
export interface PlaceRef {
  id: string;
  name: string;
  icon: string;
  category: string;
  categoryName: string;
  lng: number;
  lat: number;
  at: number; // thời điểm lưu / xem (ms)
}

interface Prefs {
  v: 1;
  pinned: string[];
  usage: Record<string, { score: number; at: number }>;
  saved: PlaceRef[];
  recent: PlaceRef[];
}

const KEY = 'gl-prefs-v1';
const HALF_LIFE_DAYS = 14;
export const MAX_PINNED = 6;
const MAX_RECENT = 20;
const EMPTY: Prefs = { v: 1, pinned: [], usage: {}, saved: [], recent: [] };

function load(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    return p?.v === 1 ? { ...EMPTY, ...p } : EMPTY;
  } catch {
    return EMPTY;
  }
}

let state: Prefs = load();
const listeners = new Set<() => void>();

function commit(next: Prefs) {
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* chế độ ẩn danh / bị chặn: vẫn chạy trong phiên hiện tại */
  }
  listeners.forEach((l) => l());
}

// đồng bộ giữa các tab đang mở
window.addEventListener('storage', (e) => {
  if (e.key === KEY) {
    state = load();
    listeners.forEach((l) => l());
  }
});

export function usePrefs(): Prefs {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

const decayed = (u: { score: number; at: number } | undefined, now: number) =>
  u ? u.score * 0.5 ** ((now - u.at) / (HALF_LIFE_DAYS * 86_400_000)) : 0;

/** Ghi nhận một lần dùng danh mục (bấm chip: 1, mở địa điểm thuộc danh mục: 0.5). */
export function recordCategoryUse(slug: string, weight = 1) {
  const now = Date.now();
  commit({ ...state, usage: { ...state.usage, [slug]: { score: decayed(state.usage[slug], now) + weight, at: now } } });
}

/** Ghim/bỏ ghim. Trả về false nếu đã đủ số ghim tối đa. */
export function togglePin(slug: string): boolean {
  if (state.pinned.includes(slug)) {
    commit({ ...state, pinned: state.pinned.filter((s) => s !== slug) });
    return true;
  }
  if (state.pinned.length >= MAX_PINNED) return false;
  commit({ ...state, pinned: [...state.pinned, slug] });
  return true;
}

export function toggleSaved(p: Omit<PlaceRef, 'at'>): boolean {
  const exists = state.saved.some((s) => s.id === p.id);
  commit({ ...state, saved: exists ? state.saved.filter((s) => s.id !== p.id) : [{ ...p, at: Date.now() }, ...state.saved] });
  return !exists;
}

export function recordRecent(p: Omit<PlaceRef, 'at'>) {
  commit({ ...state, recent: [{ ...p, at: Date.now() }, ...state.recent.filter((r) => r.id !== p.id)].slice(0, MAX_RECENT) });
}

export const clearRecent = () => commit({ ...state, recent: [] });

/** Địa điểm đã bị xoá khỏi bản đồ -> bỏ khỏi "Đã lưu" và "Gần đây" trên trình duyệt này. */
export function forgetPlace(id: string) {
  if (!state.saved.some((p) => p.id === id) && !state.recent.some((p) => p.id === id)) return false;
  commit({ ...state, saved: state.saved.filter((p) => p.id !== id), recent: state.recent.filter((p) => p.id !== id) });
  return true;
}

/** Xoá toàn bộ ghim + thói quen (giữ địa điểm đã lưu). */
export const resetPersonalization = () => commit({ ...state, pinned: [], usage: {} });

/**
 * Thứ tự chip: danh mục ghim (theo thứ tự ghim) -> danh mục hay dùng (điểm giảm dần) -> còn lại theo số địa điểm.
 * `isPinned` / `isFrequent` dùng để hiển thị dấu hiệu nhỏ trên chip.
 */
export function orderCategories(categories: Category[], prefs: Prefs) {
  const now = Date.now();
  const bySlug = new Map(categories.map((c) => [c.slug, c]));
  const pinned = prefs.pinned.flatMap((s) => (bySlug.has(s) ? [bySlug.get(s)!] : []));
  const rest = categories
    .filter((c) => !prefs.pinned.includes(c.slug))
    // điểm < 0.5 (dùng 1 lần đã lâu) coi như 0 để thứ tự không nhảy lung tung
    .map((c, i) => ({ c, i, score: Math.max(0, decayed(prefs.usage[c.slug], now) - 0.5) }))
    .sort((a, b) => b.score - a.score || a.i - b.i);
  return [
    ...pinned.map((c) => ({ ...c, isPinned: true, isFrequent: false })),
    ...rest.map(({ c, score }) => ({ ...c, isPinned: false, isFrequent: score >= 1.5 })),
  ];
}

/** Nhóm danh mục cho màn "Khám phá". Slug lạ rơi vào "Khác". */
export const CATEGORY_GROUPS: { title: string; slugs: string[] }[] = [
  { title: 'Ăn uống', slugs: ['nha-hang', 'quan-ca-phe', 'quan-nuoc', 'cho'] },
  { title: 'Tham quan', slugs: ['danh-lam-thang-canh', 'dia-danh-van-hoa', 'dia-diem-check-in', 'khu-vui-choi'] },
  { title: 'Lưu trú', slugs: ['khach-san', 'nha-nghi', 'homestay', 'resort', 'villa-bungalow'] },
  { title: 'Dịch vụ', slugs: ['atm', 'ngan-hang', 'cay-xang', 'tram-sac'] },
];
