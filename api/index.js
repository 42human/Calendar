// Tiny sync API for the calendar app.
//
// Storage model: one row per sync key (a 256-bit random hex string the
// browser generates). Each row holds a map of event id -> record, where a
// record with deleted: true is a tombstone so deletes propagate to every
// device instead of being resurrected by a stale push.

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS calendars (
  k TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`;

const MAX_EVENTS = 2000;
const TOMBSTONE_TTL_MS = 1000 * 60 * 60 * 24 * 120;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, PUT, OPTIONS',
  'access-control-allow-headers': 'content-type, x-sync-key',
  'access-control-max-age': '86400',
};

function reply(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function ensureTable(env) {
  await env.DB.prepare(CREATE_TABLE).run();
}

function sanitizeRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && raw.id.length <= 64 ? raw.id : null;
  const date = typeof raw.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) ? raw.date : null;
  if (!id || !date) return null;

  const text = typeof raw.text === 'string' ? raw.text.slice(0, 200).trim() : '';
  if (!text && !raw.deleted) return null;

  const time = typeof raw.time === 'string' && /^\d{2}:\d{2}$/.test(raw.time) ? raw.time : '';
  const color = ['1', '2', '3', '4', '5'].includes(String(raw.color)) ? String(raw.color) : '1';
  const mtime = Number.isFinite(raw.mtime) ? Math.min(Math.max(Math.trunc(raw.mtime), 0), Date.now() + 60000) : 0;

  const rec = { id, date, time, text, color, mtime };
  if (raw.deleted) rec.deleted = true;
  return rec;
}

function sanitizeItems(rawItems) {
  if (!Array.isArray(rawItems)) return null;
  const out = new Map();
  for (const raw of rawItems.slice(0, MAX_EVENTS)) {
    const rec = sanitizeRecord(raw);
    if (!rec) continue;
    const prev = out.get(rec.id);
    if (!prev || rec.mtime >= prev.mtime) out.set(rec.id, rec);
  }
  return out;
}

// Per-event last-write-wins. Newer record (higher mtime) survives.
function mergeItems(stored, incoming) {
  const now = Date.now();
  const merged = new Map(stored);
  for (const [id, rec] of incoming) {
    const prev = merged.get(id);
    if (!prev || rec.mtime >= prev.mtime) merged.set(id, rec);
  }
  for (const [id, rec] of merged) {
    if (rec.deleted && now - rec.mtime > TOMBSTONE_TTL_MS) merged.delete(id);
  }
  return merged;
}

async function readRow(env, key) {
  const row = await env.DB.prepare('SELECT data, updated_at FROM calendars WHERE k = ?1')
    .bind(key)
    .first();

  if (!row) return { items: new Map(), updatedAt: 0 };
  let parsed;
  try {
    parsed = JSON.parse(row.data);
  } catch {
    return { items: new Map(), updatedAt: 0 };
  }
  const items = new Map();
  for (const rec of parsed.items || []) {
    const clean = sanitizeRecord(rec);
    if (clean) items.set(clean.id, clean);
  }
  return { items, updatedAt: row.updated_at || 0 };
}

async function writeRow(env, key, items) {
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO calendars (k, data, updated_at) VALUES (?1, ?2, ?3) ' +
      'ON CONFLICT(k) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at'
  )
    .bind(key, JSON.stringify({ items: [...items.values()] }), now)
    .run();
  return now;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === '/' || url.pathname === '/api') {
      return reply({ ok: true, service: 'calendar-sync' });
    }

    if (url.pathname !== '/api/events') {
      return reply({ error: 'not_found' }, 404);
    }

    const key = (request.headers.get('x-sync-key') || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(key)) {
      return reply({ error: 'invalid_sync_key' }, 400);
    }

    try {
      await ensureTable(env);

      if (request.method === 'GET') {
        const { items, updatedAt } = await readRow(env, key);
        return reply({ items: [...items.values()], updatedAt });
      }

      if (request.method === 'PUT') {
        let body;
        try {
          body = await request.json();
        } catch {
          return reply({ error: 'invalid_json' }, 400);
        }

        const incoming = sanitizeItems(body && body.items);
        if (!incoming) return reply({ error: 'invalid_body' }, 400);

        const current = await readRow(env, key);
        const merged = mergeItems(current.items, incoming);
        const updatedAt = await writeRow(env, key, merged);
        return reply({ items: [...merged.values()], updatedAt });
      }

      return reply({ error: 'method_not_allowed' }, 405);
    } catch (err) {
      return reply({ error: 'server_error', message: String(err && err.message ? err.message : err) }, 500);
    }
  },
};
