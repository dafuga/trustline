import { env, exports } from 'cloudflare:workers';
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi, afterEach } from 'vitest';

// Synthetic test data only. The channel is a 32-byte, unpadded base64url value.
const origin = 'https://relay.test';
const channel = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
  .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const opaque = (byte = 1, size = 28) => btoa(String.fromCharCode(...new Uint8Array(size).fill(byte)))
  .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const url = (id: string) => `${origin}/c/${id}`;
const request = (input: string, init?: RequestInit) => exports.default.fetch(input, init);
const post = (id: string, ciphertext = opaque()) => request(url(id), {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ciphertext }),
});
async function append(id: string, ciphertext = opaque()) {
  const response = await post(id, ciphertext);
  expect(response.status).toBe(201);
  return response.json<any>();
}
async function read(id: string, after = '0') {
  const response = await request(`${url(id)}?after=${after}`);
  expect(response.status).toBe(200);
  return response.json<any>();
}

afterEach(() => vi.useRealTimers());

describe('retired relay namespace compatibility', () => {
  it.each(['Mailbox', 'PairingRoom', 'RateGate'])('preserves stored %s data through requests, alarms, and eviction', async className => {
    const namespaces = exports as unknown as Record<string, DurableObjectNamespace>;
    expect(namespaces[className], 'existing production namespace must remain exported').toBeDefined();
    const stub = namespaces[className].getByName(crypto.randomUUID());
    const saved = { version: 1, retained: 'synthetic legacy state' };
    await runInDurableObject(stub, async (_instance, ctx) => {
      await ctx.storage.put('legacy-state', saved);
      await ctx.storage.setAlarm(Date.now() + 60_000);
    });
    const response = await stub.fetch('https://legacy.test/');
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: 'protocol_retired' });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (_instance, ctx) => {
      expect(await ctx.storage.get('legacy-state')).toEqual(saved);
    });
  });
});

describe('HTTP store-and-forward', () => {
  it('starts empty, sends both ways, and lets two readers catch up independently', async () => {
    const id = channel();
    expect(await read(id)).toEqual({ messages: [], nextCursor: '0', hasMore: false, truncated: false });
    const first = await append(id, opaque(1));
    expect(first).toEqual({ cursor: '1', createdAt: expect.any(Number), expiresAt: expect.any(Number) });
    expect(first.expiresAt - first.createdAt).toBe(7 * 24 * 60 * 60 * 1000);
    await append(id, opaque(2));
    const readerA = await read(id);
    expect(readerA).toEqual({
      messages: [
        { ...first, ciphertext: opaque(1) },
        { cursor: '2', ciphertext: opaque(2), createdAt: expect.any(Number), expiresAt: expect.any(Number) },
      ], nextCursor: '2', hasMore: false, truncated: false,
    });
    expect(await read(id)).toEqual(readerA);
    expect(await read(id, '1')).toEqual({
      ...readerA, messages: [readerA.messages[1]],
    });
    expect(await read(id, readerA.nextCursor)).toEqual({
      messages: [], nextCursor: '2', hasMore: false, truncated: false,
    });
    await append(id, opaque(3));
    expect((await read(id, '2')).messages.map((m: any) => m.cursor)).toEqual(['3']);
  });

  it('isolates channels and their independent cursor sequences', async () => {
    const a = channel(), b = channel();
    await append(a, opaque(1));
    expect((await read(b)).messages).toEqual([]);
    expect((await append(b, opaque(2))).cursor).toBe('1');
    expect((await read(a)).messages.map((m: any) => m.ciphertext)).toEqual([opaque(1)]);
    expect((await read(b)).messages.map((m: any) => m.ciphertext)).toEqual([opaque(2)]);
  });

  it('persists messages and cursor high-water mark across object eviction', async () => {
    const id = channel();
    await append(id);
    await evictDurableObject(env.CHANNELS.getByName(id));
    expect((await read(id)).messages[0].cursor).toBe('1');
    expect((await append(id)).cursor).toBe('2');
  });

  it('serializes concurrent sends without losing messages or reusing cursors', async () => {
    const id = channel();
    const sent = await Promise.all(Array.from({ length: 25 }, (_, i) => append(id, opaque(i))));
    expect(sent.map((m: any) => Number(m.cursor)).sort((a: number, b: number) => a - b))
      .toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    const page = await read(id);
    expect(page.messages.map((m: any) => m.cursor)).toEqual(Array.from({ length: 25 }, (_, i) => String(i + 1)));
    expect(new Set(page.messages.map((m: any) => m.ciphertext)).size).toBe(25);
  });

  it('paginates at 100 and retains only the newest 500, reporting a missed-history gap', async () => {
    const id = channel();
    for (let i = 0; i < 503; i++) await append(id, opaque(i % 256));
    const seen: string[] = [];
    let after = '0';
    for (let pageNo = 0; pageNo < 5; pageNo++) {
      const page = await read(id, after);
      expect(page.messages).toHaveLength(100);
      expect(page.truncated).toBe(pageNo === 0);
      expect(page.hasMore).toBe(pageNo < 4);
      seen.push(...page.messages.map((m: any) => m.cursor));
      after = page.nextCursor;
    }
    expect(seen).toEqual(Array.from({ length: 500 }, (_, i) => String(i + 4)));
    expect(after).toBe('503');
    expect((await read(id, '3')).truncated).toBe(false);
    expect((await read(id, '2')).truncated).toBe(true);
    expect((await read(id, after)).messages).toEqual([]);
    await runInDurableObject(env.CHANNELS.getByName(id), (_instance, state) => {
      expect(state.storage.sql.exec('SELECT COUNT(*) AS count FROM messages').one().count).toBe(500);
    });
  });

  it('rejects future cursors so a mistaken checkpoint cannot silently skip new traffic', async () => {
    const id = channel();
    await append(id);
    const response = await request(`${url(id)}?after=2`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'cursor_ahead' });
    expect((await append(id)).cursor).toBe('2');
    expect((await read(id, '1')).messages[0].cursor).toBe('2');
  });
});

describe('TTL and idle cleanup', () => {
  it('serves a message just before expiry and removes it at the exact TTL on read', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    const id = channel();
    const sent = await append(id);
    vi.setSystemTime(sent.expiresAt - 1);
    expect((await read(id)).messages).toHaveLength(1);
    vi.setSystemTime(sent.expiresAt);
    expect(await read(id)).toEqual({ messages: [], nextCursor: '1', hasMore: false, truncated: true });
    expect(await read(id, '1')).toEqual({ messages: [], nextCursor: '1', hasMore: false, truncated: false });
    expect((await append(id)).cursor).toBe('2');
  });

  it('schedules cleanup, handles early alarms, and deletes expired ciphertext while offline', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-02-01T00:00:00Z'));
    const id = channel(), stub = env.CHANNELS.getByName(id);
    const first = await append(id);
    vi.setSystemTime(first.createdAt + 1000);
    const second = await append(id);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBe(first.expiresAt);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await read(id)).messages).toHaveLength(2);
    vi.setSystemTime(first.expiresAt);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.storage.sql.exec('SELECT COUNT(*) AS count FROM messages').one().count).toBe(1);
      expect(await state.storage.getAlarm()).toBe(second.expiresAt);
    });
    vi.setSystemTime(second.expiresAt);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.storage.sql.exec('SELECT COUNT(*) AS count FROM messages').one().count).toBe(0);
      expect(await state.storage.getAlarm()).toBeNull();
    });
    await evictDurableObject(stub);
    expect(await read(id)).toEqual({ messages: [], nextCursor: '2', hasMore: false, truncated: true });
    expect((await append(id)).cursor).toBe('3');
  });

  it('also prunes expired messages on append', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-03-01T00:00:00Z'));
    const id = channel();
    const first = await append(id);
    vi.setSystemTime(first.expiresAt);
    await append(id, opaque(2));
    const page = await read(id);
    expect(page.messages.map((m: any) => m.cursor)).toEqual(['2']);
    expect(page.truncated).toBe(true);
  });
});

describe('validation and HTTP boundaries', () => {
  it.each(['', '/c/short', `/c/${'a'.repeat(42)}`, `/c/${'a'.repeat(44)}`, `/c/${'a'.repeat(42)}B`,
    `/c/${'a'.repeat(43)}/extra`, `/c/${'a'.repeat(43)}/`, `/c/${'a'.repeat(42)}%41`])
    ('rejects invalid route %s', async path => {
      const response = await request(origin + path);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'not_found' });
    });

  it.each(['', '-1', '1.5', '01', '+1', '1e2', 'NaN', 'Infinity', '9007199254740992', ' 1'])
    ('rejects malformed cursor %j', async after => {
      const response = await request(`${url(channel())}?after=${encodeURIComponent(after)}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_cursor' });
    });

  it.each(['?after=0&after=0', '?limit=10', '?key=never-send-encryption-keys', '?after=0&x=1'])
    ('rejects unexpected or duplicate parameters %s', async query => {
      const response = await request(url(channel()) + query);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_query' });
    });

  it('rejects POST query parameters', async () => {
    const response = await request(`${url(channel())}?after=0`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ciphertext: opaque() }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_query' });
  });

  it.each(['PUT', 'DELETE', 'PATCH', 'HEAD'])('rejects method %s', async method => {
    const response = await request(url(channel()), { method });
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET, POST, OPTIONS');
    await response.text();
  });

  it('supports browser CORS and prevents caching and referrer leakage', async () => {
    const id = channel();
    const preflight = await request(url(id), {
      method: 'OPTIONS', headers: { Origin: 'https://phone.test', 'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, OPTIONS');
    expect(preflight.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type');
    for (const response of [preflight, await post(id), await request(`${url(id)}?after=bad`), await request(origin)]) {
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      await response.text();
    }
  });

  it('requires JSON media type and identity content encoding', async () => {
    const cases: HeadersInit[] = [{}, { 'Content-Type': 'text/plain' },
      { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }];
    for (const headers of cases) {
      const response = await request(url(channel()), { method: 'POST', headers, body: '{}' });
      expect(response.status).toBe(415);
      expect(await response.json()).toEqual({ error: 'unsupported_media_type' });
    }
    const response = await request(url(channel()), { method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ ciphertext: opaque() }) });
    expect(response.status).toBe(201);
    await response.text();
  });

  it.each(['', '{', 'null', '[]', '1', '"text"', '{}', '{"ciphertext":null}', '{"ciphertext":42}',
    '{"ciphertext":""}', '{"ciphertext":"hello"}', '{"ciphertext":"a==="}',
    JSON.stringify({ ciphertext: opaque(), plaintext: 'oops' }), JSON.stringify({ ciphertext: opaque(1, 27) }),
    JSON.stringify({ ciphertext: opaque() + '=' }), JSON.stringify({ ciphertext: opaque().slice(0, -1) + 'B' })])
    ('rejects malformed body %s without appending', async body => {
      const id = channel();
      const response = await request(url(id), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_message' });
      expect((await read(id)).messages).toEqual([]);
      expect((await append(id)).cursor).toBe('1');
    });

  it('accepts exactly 16 KiB ciphertext, rejects larger ciphertext and body, and leaves cursor unchanged', async () => {
    const id = channel();
    await append(id, opaque(1, 16_384));
    for (const body of [JSON.stringify({ ciphertext: opaque(1, 16_385) }), ' '.repeat(24_577)]) {
      const response = await request(url(id), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: 'message_too_large' });
    }
    expect((await append(id)).cursor).toBe('2');
    expect((await read(id)).messages).toHaveLength(2);
  });

  it('bounds streamed bodies without relying on Content-Length', async () => {
    const id = channel();
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(12_000).fill(32));
      controller.enqueue(new Uint8Array(12_000).fill(32));
      controller.enqueue(new Uint8Array(577).fill(32));
      controller.close();
    } });
    const response = await request(url(id), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: stream });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'message_too_large' });
    expect((await read(id)).nextCursor).toBe('0');
  });
});
