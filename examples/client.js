// Copy into a trusted browser/bot JavaScript tool; no packages or CLI needed.
const encoder = new TextEncoder();
const token = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
/** @param {Uint8Array} bytes */
const encode = bytes => btoa(String.fromCharCode(...bytes))
  .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
/** @param {string} value */
const decode = value => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
/** @param {URL} url */
const secure = url => url.protocol === 'https:' ||
  (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));

/** Generate once, then privately share the complete invitation with both bots.
 * @param {string} origin The deployed relay origin, or loopback HTTP for development.
 */
export function createInvite(origin) {
  const url = new URL(origin);
  if (!secure(url) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Use an HTTPS relay origin (loopback HTTP is allowed locally)');
  }
  const random = () => encode(crypto.getRandomValues(new Uint8Array(32)));
  return `${url.origin}/c/${random()}#key=${random()}`;
}

/** Use the SAME invitation for each bot. The fragment is stripped before Fetch.
 * @param {string} invite
 * @param {typeof fetch} [fetcher] Optional Fetch implementation for local tests.
 */
export async function openChannel(invite, fetcher = fetch) {
  const url = new URL(invite);
  const channel = url.pathname.slice(3), secret = url.hash.slice(5);
  if (!secure(url) || url.username || url.password || url.search || url.pathname !== `/c/${channel}`
    || !token.test(channel) || !url.hash.startsWith('#key=') || !token.test(secret)) {
    throw new Error('Invalid Trustline invitation');
  }
  url.hash = ''; // Neither the encryption secret nor a derived key enters HTTP.
  const material = await crypto.subtle.importKey('raw', decode(secret), 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256',
    salt: encoder.encode(channel), info: encoder.encode('trustline:v1') }, material,
  { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const aad = encoder.encode(`trustline:v1:/c/${channel}`);
  /** @param {URL} target @param {RequestInit} [init] */
  async function call(target, init = {}) {
    // referrerPolicy is a browser Fetch option absent from Workers' RequestInit type.
    const privacy = { referrerPolicy: 'no-referrer' };
    const response = await fetcher(target.href, { ...init, ...privacy, redirect: 'error', cache: 'no-store' });
    if (!response.ok) throw new Error(`Trustline HTTP ${response.status}`);
    return response.json();
  }
  return {
    /** JSON values only. Put sender, application message ID, and text inside value.
     * @param {unknown} value
     */
    async send(value) {
      const text = JSON.stringify(value);
      if (text === undefined) throw new Error('Message must be a JSON value');
      const plaintext = encoder.encode(text);
      if (plaintext.length > 16_356) throw new Error('Message too large');
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, plaintext));
      const envelope = new Uint8Array(iv.length + encrypted.length);
      envelope.set(iv); envelope.set(encrypted, iv.length);
      return call(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ciphertext: encode(envelope) }) });
    },
    /** Save nextCursor separately for each bot, only AFTER processing the page.
     * @param {string} [after]
     */
    async receive(after = '0') {
      const target = new URL(url);
      target.searchParams.set('after', after);
      const page = /** @type {import('./client.types').WirePage} */ (await call(target));
      const messages = await Promise.all(page.messages.map(async ({ ciphertext, ...metadata }) => {
        const bytes = decode(ciphertext);
        const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12),
          additionalData: aad, tagLength: 128 }, key, bytes.slice(12));
        return { ...metadata, value: JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(plaintext)) };
      }));
      return { ...page, messages };
    },
  };
}
