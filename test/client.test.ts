import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createInvite, openChannel } from '../examples/client.js';

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
  .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const random = () => b64(crypto.getRandomValues(new Uint8Array(32)));
const fixture = () => `https://relay.test/c/${random()}#key=${random()}`;
// Workers Fetch lacks the browser's redirect:'error'. Manual never follows;
// the client rejects the non-2xx response, preserving the browser behavior.
const localFetch: typeof fetch = (input, init) => exports.default.fetch(input, {
  ...init, redirect: init?.redirect === 'error' ? 'manual' : init?.redirect,
});

describe('copy-paste Web Crypto client recipe', () => {
  it('generates independent 256-bit channel and key material without any network call', () => {
    const one = createInvite('https://relay.test'), two = createInvite('https://relay.test');
    expect(one).toMatch(/^https:\/\/relay\.test\/c\/[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]#key=[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
    expect(two).not.toBe(one);
    const parts = new URL(one);
    expect(parts.hash.slice(5)).not.toBe(parts.pathname.slice(3));
  });

  it('exchanges encrypted Unicode JSON in both directions with independent reconnect cursors', async () => {
    const invite = fixture();
    const daniel = await openChannel(invite, localFetch);
    const frances = await openChannel(invite, localFetch);
    const outbound = { from: 'Daniel', text: 'Olá Frances 👋', id: 'd-1' };
    expect(await daniel.send(outbound)).toMatchObject({ cursor: '1' });
    const first = await frances.receive();
    expect(first).toMatchObject({ nextCursor: '1', hasMore: false, truncated: false,
      messages: [{ cursor: '1', value: outbound }] });
    const reply = { from: 'Frances', text: 'Bonjour Daniel 💬', id: 'f-1' };
    expect(await frances.send(reply)).toMatchObject({ cursor: '2' });
    const reconnected = await openChannel(invite, localFetch);
    expect(await reconnected.receive('1')).toMatchObject({ nextCursor: '2', messages: [{ cursor: '2', value: reply }] });
    expect((await daniel.receive()).messages.map((m: any) => m.value)).toEqual([outbound, reply]);
    expect(await frances.receive('2')).toMatchObject({ messages: [], nextCursor: '2' });
  });

  it('sends only ciphertext with no fragment, key, plaintext or redirects, and uses fresh IVs', async () => {
    const invite = fixture(), seen: { url: string; init?: RequestInit }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      seen.push({ url: String(input), init });
      return localFetch(input, init);
    };
    const client = await openChannel(invite, fetcher);
    const value = { private: 'plaintext-sentinel-秘密' };
    expect(await client.send(value)).toMatchObject({ cursor: '1' });
    expect(await client.send(value)).toMatchObject({ cursor: '2' });
    const page = await client.receive();
    expect(page.messages.map((m: any) => m.value)).toEqual([value, value]);
    expect(seen).toHaveLength(3);
    const secret = new URL(invite).hash.slice(5);
    for (const call of seen) {
      expect(call.url).not.toContain('#');
      expect(call.url).not.toContain(secret);
      expect(JSON.stringify(call.init)).not.toContain(secret);
      expect(JSON.stringify(call.init)).not.toContain(value.private);
      expect(call.init).toMatchObject({ redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store' });
    }
    const a = JSON.parse(String(seen[0].init?.body));
    const b = JSON.parse(String(seen[1].init?.body));
    expect(Object.keys(a)).toEqual(['ciphertext']);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(atob(a.ciphertext.replaceAll('-', '+').replaceAll('_', '/')).slice(0, 12))
      .not.toBe(atob(b.ciphertext.replaceAll('-', '+').replaceAll('_', '/')).slice(0, 12));
    const wire = await localFetch(invite.split('#')[0]);
    const raw = await wire.text();
    expect(raw).not.toContain(value.private);
    expect(raw).not.toContain(secret);
  });

  it('rejects wrong keys, modified ciphertext, and ciphertext moved to a different channel', async () => {
    const invite = fixture();
    const client = await openChannel(invite, localFetch);
    expect(await client.send({ text: 'authenticated' })).toMatchObject({ cursor: '1' });
    const wrongKey = await openChannel(invite.split('#')[0] + `#key=${random()}`, localFetch);
    await expect(wrongKey.receive()).rejects.toThrow();
    const response = await localFetch(invite.split('#')[0]);
    const page = await response.json<any>();
    const otherInvite = fixture(), otherUrl = otherInvite.split('#')[0];
    const moved = await localFetch(otherUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ciphertext: page.messages[0].ciphertext }) });
    expect(moved.status).toBe(201);
    await moved.text();
    // Keep the same secret, change only the channel: HKDF and AAD bind the channel.
    const other = await openChannel(otherUrl + new URL(invite).hash, localFetch);
    await expect(other.receive()).rejects.toThrow();
    const tamperingFetch: typeof fetch = async (input, init) => {
      const result = await localFetch(input, init);
      const data = await result.json<any>();
      const bytes = Uint8Array.from(atob(data.messages[0].ciphertext.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
      bytes[12] ^= 1;
      data.messages[0].ciphertext = b64(bytes);
      return Response.json(data);
    };
    const tampered = await openChannel(invite, tamperingFetch);
    await expect(tampered.receive()).rejects.toThrow();
  });

  it('accepts the exact plaintext byte boundary and rejects excess before making a request', async () => {
    const invite = fixture();
    let calls = 0;
    const fetcher: typeof fetch = async (input, init) => { calls++; return localFetch(input, init); };
    const client = await openChannel(invite, fetcher);
    // JSON string quotes add two bytes; AES-GCM tag and IV add 28 bytes.
    expect(await client.send('a'.repeat(16_354))).toMatchObject({ cursor: '1' });
    await expect(client.send('a'.repeat(16_355))).rejects.toThrow('too large');
    expect(calls).toBe(1);
    await expect(client.send(undefined)).rejects.toThrow('JSON');
    expect(calls).toBe(1);
  });

  it('reports HTTP errors and does not return a cursor for an undecryptable page', async () => {
    const invite = fixture();
    const fetcher: typeof fetch = async () => Response.json({ error: 'cursor_ahead' }, { status: 400 });
    const client = await openChannel(invite, fetcher);
    await expect(client.receive('999')).rejects.toThrow('HTTP 400');
    await expect(client.send({ text: 'hello' })).rejects.toThrow('HTTP 400');
  });

  it.each([
    'http://relay.test/c/CHANNEL#key=KEY', 'https://user:pass@relay.test/c/CHANNEL#key=KEY',
    'https://relay.test/c/short#key=KEY', `https://relay.test/c/${'A'.repeat(43)}`,
    `https://relay.test/c/${'A'.repeat(43)}?key=oops#key=${'A'.repeat(43)}`,
    `https://relay.test/c/${'A'.repeat(43)}#key=short`,
    `https://relay.test/c/${'A'.repeat(43)}#key=${'A'.repeat(42)}B`,
  ])('rejects unsafe or malformed invitation %s before network activity', async invite => {
    let called = false;
    const fetcher: typeof fetch = async () => { called = true; return Response.json({}); };
    await expect(openChannel(invite, fetcher)).rejects.toThrow('invitation');
    expect(called).toBe(false);
  });

  it('permits loopback HTTP for local development only', async () => {
    expect(createInvite('http://localhost:8787')).toMatch(/^http:\/\/localhost:8787\/c\//);
    expect(createInvite('http://127.0.0.1:8787')).toMatch(/^http:\/\/127\.0\.0\.1:8787\/c\//);
    expect(() => createInvite('http://relay.test')).toThrow();
    expect(() => createInvite('https://relay.test/path')).toThrow();
  });
});
