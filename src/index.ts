import { DurableObject } from 'cloudflare:workers';
import type { ChannelState, Env, StoredMessage } from './index.types';

const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RETAINED_MESSAGES = 500;
const PAGE_SIZE = 100;
const MAX_BODY_BYTES = 24_576;
const MAX_CIPHERTEXT_BYTES = 16_384;
const CHANNEL_ID = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: HEADERS });
}

// The public relay previously provisioned these namespaces. Keep their exports
// and storage intact: removing a class would require a destructive migration.
// No public route or binding exposes them in the HTTP protocol.
class RetiredRelayState extends DurableObject<Env> {
  async fetch() {
    return json({ error: 'protocol_retired' }, 410);
  }

  async alarm() {
    // Consume any legacy alarm without changing its stored data.
  }
}

export class Mailbox extends RetiredRelayState {}
export class PairingRoom extends RetiredRelayState {}
export class RateGate extends RetiredRelayState {}

// Enforce the limit while streaming, even if Content-Length is absent or false.
async function readMessage(request: Request): Promise<string | Response> {
  const mediaType = request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
  const encoding = request.headers.get('Content-Encoding');
  if (mediaType !== 'application/json' || (encoding && encoding !== 'identity')) {
    return json({ error: 'unsupported_media_type' }, 415);
  }
  if (Number(request.headers.get('Content-Length')) > MAX_BODY_BYTES) {
    return json({ error: 'message_too_large' }, 413);
  }
  const reader = request.body?.getReader();
  if (!reader) return json({ error: 'invalid_message' }, 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return json({ error: 'message_too_large' }, 413);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
    if (body === null || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).length !== 1 || !('ciphertext' in body) || typeof body.ciphertext !== 'string') {
      return json({ error: 'invalid_message' }, 400);
    }
    const ciphertext = body.ciphertext;
    // The relay checks an opaque encoding/size, never decrypts or holds a key.
    if (!/^[A-Za-z0-9_-]+$/.test(ciphertext)) return json({ error: 'invalid_message' }, 400);
    const decoded = atob(ciphertext.replaceAll('-', '+').replaceAll('_', '/'));
    if (decoded.length > MAX_CIPHERTEXT_BYTES) return json({ error: 'message_too_large' }, 413);
    if (decoded.length < 28 || btoa(decoded).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '') !== ciphertext) {
      return json({ error: 'invalid_message' }, 400);
    }
    return ciphertext;
  } catch {
    return json({ error: 'invalid_message' }, 400);
  } finally {
    reader.releaseLock();
  }
}

export class Channel extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.storage.transactionSync(() => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS channel_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        lastSeq INTEGER NOT NULL, droppedThrough INTEGER NOT NULL
      )`);
      this.sql.exec('INSERT OR IGNORE INTO channel_state VALUES (1, 0, 0)');
      this.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY, ciphertext TEXT NOT NULL,
        createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL
      )`);
    });
  }

  private state() {
    return this.sql.exec<ChannelState>('SELECT lastSeq, droppedThrough FROM channel_state').one();
  }

  private prune(now: number) {
    const removed = this.sql.exec<{ seq: number }>(
      'DELETE FROM messages WHERE expiresAt <= ? OR seq <= ? RETURNING seq',
      now, this.state().lastSeq - RETAINED_MESSAGES,
    ).toArray();
    if (removed.length) {
      this.sql.exec('UPDATE channel_state SET droppedThrough = MAX(droppedThrough, ?)',
        Math.max(...removed.map(message => message.seq)));
    }
  }

  private async scheduleCleanup() {
    const { expiresAt } = this.sql.exec<{ expiresAt: number | null }>(
      'SELECT MIN(expiresAt) AS expiresAt FROM messages',
    ).one();
    if (expiresAt === null) {
      await this.ctx.storage.deleteAlarm();
    } else if (await this.ctx.storage.getAlarm() !== expiresAt) {
      await this.ctx.storage.setAlarm(expiresAt);
    }
  }

  async append(ciphertext: string) {
    const result = this.ctx.storage.transactionSync(() => {
      const seq = this.state().lastSeq + 1;
      if (!Number.isSafeInteger(seq)) throw new Error('Channel sequence exhausted');
      const createdAt = Date.now(), expiresAt = createdAt + TTL_MS;
      this.sql.exec('UPDATE channel_state SET lastSeq = ?', seq);
      this.sql.exec('INSERT INTO messages VALUES (?, ?, ?, ?)', seq, ciphertext, createdAt, expiresAt);
      this.prune(createdAt);
      return { cursor: String(seq), createdAt, expiresAt };
    });
    await this.scheduleCleanup();
    return result;
  }

  async read(after: number) {
    const result = this.ctx.storage.transactionSync(() => {
      this.prune(Date.now());
      const state = this.state();
      if (after > state.lastSeq) return { error: 'cursor_ahead' } as const;
      const rows = this.sql.exec<StoredMessage>(
        'SELECT seq, ciphertext, createdAt, expiresAt FROM messages WHERE seq > ? ORDER BY seq LIMIT ?',
        after, PAGE_SIZE + 1,
      ).toArray();
      const messages = rows.slice(0, PAGE_SIZE).map(({ seq, ...message }) => ({ cursor: String(seq), ...message }));
      return {
        messages,
        nextCursor: messages.at(-1)?.cursor ?? String(state.lastSeq),
        hasMore: rows.length > PAGE_SIZE,
        truncated: after < state.droppedThrough,
      };
    });
    await this.scheduleCleanup();
    return result;
  }

  async alarm() {
    this.ctx.storage.transactionSync(() => this.prune(Date.now()));
    await this.scheduleCleanup();
  }
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const match = /^\/c\/([^/]+)$/.exec(url.pathname);
      if (!match || !CHANNEL_ID.test(match[1])) return json({ error: 'not_found' }, 404);
      const afterValues = url.searchParams.getAll('after');
      if ([...url.searchParams.keys()].some(key => key !== 'after') || afterValues.length > 1
        || (request.method !== 'GET' && url.search !== '')) {
        return json({ error: 'invalid_query' }, 400);
      }
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: HEADERS });
      if (request.method !== 'GET' && request.method !== 'POST') {
        return Response.json({ error: 'method_not_allowed' }, {
          status: 405, headers: { ...HEADERS, Allow: 'GET, POST, OPTIONS' },
        });
      }
      if (request.method === 'POST') {
        const ciphertext = await readMessage(request);
        if (ciphertext instanceof Response) return ciphertext;
        return json(await env.CHANNELS.getByName(match[1]).append(ciphertext), 201);
      }
      const cursor = afterValues[0] ?? '0';
      if (!/^(0|[1-9][0-9]*)$/.test(cursor) || !Number.isSafeInteger(Number(cursor))) {
        return json({ error: 'invalid_cursor' }, 400);
      }
      const page = await env.CHANNELS.getByName(match[1]).read(Number(cursor));
      return json(page, 'error' in page ? 400 : 200);
    } catch {
      // Never log request URLs, ciphertext, or keys, including on failure.
      return json({ error: 'internal_error' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
