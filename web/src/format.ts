export function formatDistance(m: number | null | undefined): string | null {
  if (m === null || m === undefined) return null;
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} km`;
}

/** URL ảnh đã thu nhỏ qua imgproxy (gateway /img); w,h theo CSS px, nhân đôi cho màn hình nét. */
export function imageUrl(src: string, w: number, h: number): string {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  return `/img/insecure/rs:fill:${Math.round(w * dpr)}:${Math.round(h * dpr)}/plain/${encodeURIComponent(src)}@webp`;
}

export const formatNumber = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n.toLocaleString('vi-VN'));

export const PRICE_LABELS: Record<string, string> = {
  budget: 'Bình dân',
  low: 'Bình dân',
  mid_range: 'Tầm trung',
  high: 'Cao cấp',
  high_end: 'Cao cấp',
  luxury: 'Sang trọng',
};

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** Trạng thái mở cửa hôm nay từ dạng { monday: "05:30-18:30", ... }. */
export function openStatus(hours: Record<string, string> | null, now = new Date()): { open: boolean; text: string } | null {
  const today = hours?.[DAYS[now.getDay()]];
  if (!today) return null;
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(today.trim());
  if (!m) return { open: false, text: today };
  const mins = now.getHours() * 60 + now.getMinutes();
  const start = Number(m[1]) * 60 + Number(m[2]);
  let end = Number(m[3]) * 60 + Number(m[4]);
  if (end <= start) end += 24 * 60; // mở qua đêm
  const open = (mins >= start && mins < end) || (mins + 24 * 60 >= start && mins + 24 * 60 < end);
  return { open, text: open ? `Đang mở · đóng lúc ${m[3]}:${m[4]}` : `Đã đóng · mở lúc ${m[1]}:${m[2]}` };
}

/** Escape HTML rồi chỉ khôi phục thẻ <mark> do Meilisearch chèn vào (tránh XSS từ dữ liệu). */
export function safeHighlight(html: string): string {
  return html
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/&lt;mark&gt;/g, '<mark>')
    .replace(/&lt;\/mark&gt;/g, '</mark>');
}

/** "1 giờ 5 phút" / "12 phút" từ số giây. */
export function formatDuration(s: number): string {
  const mins = Math.max(1, Math.round(s / 60));
  if (mins < 60) return `${mins} phút`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} giờ ${m} phút` : `${h} giờ`;
}

export const formatClock = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/**
 * Địa điểm có mở cửa vào thời điểm `at` không (giờ dạng { monday: "07:00-18:00" | "closed" }).
 * null = không có dữ liệu / không đọc được.
 */
export function isOpenAt(hours: Record<string, string> | null | undefined, at: Date): boolean | null {
  const check = (dayOffset: number, minsOfDay: number) => {
    const day = new Date(at);
    day.setDate(day.getDate() + dayOffset);
    const v = hours?.[DAYS[day.getDay()]]?.trim().toLowerCase();
    if (!v) return null;
    if (v === 'closed' || v === 'đóng cửa') return false;
    const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(v);
    if (!m) return null;
    const start = Number(m[1]) * 60 + Number(m[2]);
    let end = Number(m[3]) * 60 + Number(m[4]);
    if (end <= start) end += 24 * 60;
    if (end === 23 * 60 + 59) end = 24 * 60; // "00:00-23:59" = cả ngày
    return minsOfDay >= start && minsOfDay < end;
  };
  const mins = at.getHours() * 60 + at.getMinutes();
  const today = check(0, mins);
  // khung giờ qua đêm của hôm trước (vd 18:00-02:00)
  return today || check(-1, mins + 24 * 60) || today;
}
