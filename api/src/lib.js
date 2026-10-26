import pg from 'pg';

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

const MEILI_URL = process.env.MEILI_URL ?? 'http://localhost:7700';
const MEILI_KEY = process.env.MEILI_MASTER_KEY ?? '';

/** Gọi REST API của Meilisearch. */
export async function meili(path, { method = 'GET', body } = {}) {
  const res = await fetch(MEILI_URL + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MEILI_KEY}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Meilisearch ${method} ${path} -> ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

/** Chờ một task bất đồng bộ của Meilisearch hoàn tất. */
export async function waitTask(task) {
  for (;;) {
    const t = await meili(`/tasks/${task.taskUid}`);
    if (t.status === 'succeeded') return t;
    if (t.status === 'failed' || t.status === 'canceled') throw new Error(`Task ${t.uid} ${t.status}: ${JSON.stringify(t.error)}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** Bỏ dấu tiếng Việt: "Biển Hồ T'Nưng" -> "bien ho t'nung". */
export function ascii(s) {
  return (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}
