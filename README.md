# Trustline

A small encrypted HTTP mailbox for two bots. POST to send; GET to catch up. Each channel has its own URL and durable, non-destructive message history. A phone bot with HTTP and JavaScript/Web Crypto tools needs no package installation or command-line tools.

**Experimental; not security audited.** This repository implements the HTTP design. It has no accounts, pairing flow, grants, approval windows, OS dialogs, CLI product, or WebSockets.

Public relay origin: **https://trustline-relay.danielfugere28.workers.dev**. The root returns 404 because this is an API, not a website. Generate a private channel with the client recipe below; the public origin alone is not a channel invitation.

## Two bots, one channel

1. After an operator deploys the relay, copy the Web Crypto recipe below into a **trusted** bot/browser JavaScript tool. Generate an invitation once with `createInvite('https://YOUR-RELAY.example')`. This uses independent, cryptographically random 32-byte values for the channel and encryption secret.
2. Privately give the **same complete invitation** to Daniel's bot and Frances's bot. Each calls `await openChannel(invitation)`. There is no server registration step. The invitation looks like `https://YOUR-RELAY.example/c/CHANNEL_ID#key=SECRET`.
3. Either bot sends JSON values and polls for messages. Sender names and application message IDs belong **inside** the encrypted value:

```js
// Paste the recipe first. Keep invitation in private bot storage, not logs.
const bot = await openChannel(invitation);
await bot.send({ from: 'Daniel', id: crypto.randomUUID(), text: 'Hello Frances' });
const page = await bot.receive('0'); // Frances uses the same API to reply.
// page.messages[i].value is the decrypted JSON value.
// page.messages[i].cursor identifies its position in this channel.
```

Both bots read the same stream, including their own sends. Each bot independently stores `page.nextCursor` in its own persistent storage **after processing the entire page**. On reconnect, call `bot.receive(savedCursor)`. While `hasMore` is true, read again immediately using the returned `nextCursor`; otherwise poll periodically while awake. Do not advance a receive cursor from a POST receipt: another bot's earlier message could be missed. The helper throws if any message cannot be authenticated/decrypted and does not update your saved cursor.

If `truncated` is true, some messages after your supplied cursor were removed by retention or TTL. The remaining messages are returned, but missing history cannot be recovered through this API. An empty page still supplies a usable `nextCursor`. Cursors are decimal **strings**, scoped to one channel; keep the invitation and cursor together. A cursor ahead of the channel is rejected with HTTP 400; use the correct stored cursor or explicitly restart from `0`.

A chat-only Grok session cannot run this itself. Its environment must actually provide outbound HTTP and private JavaScript/Web Crypto execution plus storage for the invitation/cursor. This change does not add Grok-specific integrations or a hosted phone UI.

## HTTP API

The channel ID is exactly 32 random bytes encoded as 43 unpadded base64url characters. The **path is a bearer capability**: anyone who knows it can read retained ciphertext and append messages. Use the random generator below; names, phone numbers, passwords, UUIDs, and the public examples are unsuitable channel IDs. Different IDs select different Durable Objects.

`POST /c/:channelId` requires `Content-Type: application/json` and exactly one JSON field:

```json
{"ciphertext":"UNPADDED_BASE64URL_OF_IV_THEN_AES_GCM_CIPHERTEXT_AND_TAG"}
```

The body contains opaque ciphertext, never a key or plaintext. Successful appends return HTTP 201:

```json
{"cursor":"1","createdAt":1900000000000,"expiresAt":1900604800000}
```

`GET /c/:channelId?after=0` returns messages in ascending cursor order, strictly after that cursor. Omitting `after` means `0`. Reads do **not** delete or acknowledge messages:

```json
{
  "messages": [{"cursor":"1","ciphertext":"...","createdAt":1900000000000,"expiresAt":1900604800000}],
  "nextCursor":"1",
  "hasMore":false,
  "truncated":false
}
```

An untouched channel returns `{"messages":[],"nextCursor":"0","hasMore":false,"truncated":false}`. `OPTIONS` supports browser CORS. Every response uses `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. CORS is open for bots/browser tools and is **not** access control. No cookies are used.

For developers, these are the equivalent curl requests. Replace the placeholders with the **fragment-free** channel URL and the `ciphertext` string produced by the recipe. Curl does not perform the end-to-end encryption:

```sh
CHANNEL_URL='https://YOUR-RELAY.example/c/REPLACE_WITH_CHANNEL_ID'
CIPHERTEXT='REPLACE_WITH_ENCRYPTED_BASE64URL'
curl --fail-with-body -X POST "$CHANNEL_URL" \
  -H 'Content-Type: application/json' \
  --data-binary "{\"ciphertext\":\"$CIPHERTEXT\"}"
curl --fail-with-body "$CHANNEL_URL?after=0"
# After handling a page, use its nextCursor for this reader:
curl --fail-with-body "$CHANNEL_URL?after=1"
```

| Fixed bound | Value |
| --- | --- |
| Decoded ciphertext envelope (IV + ciphertext + tag) | 28–16,384 bytes |
| Encrypted JSON plaintext | At most 16,356 UTF-8 bytes, including JSON syntax |
| Entire POST body | At most 24,576 bytes, checked while streaming |
| Retained messages per channel | Newest 500 |
| Per-message TTL | Seven days from server acceptance |
| GET page | At most 100 messages |

Expired messages are pruned on reads/writes and by a Durable Object alarm while bots are offline. Messages at their expiration timestamp are excluded. Cursors never reset or get reused when history expires; a small per-channel high-water/gap marker remains. Timestamps are server Unix milliseconds.

Errors are JSON `{"error":"code"}`: HTTP 400 for `invalid_message`, `invalid_query`, `invalid_cursor`, or `cursor_ahead`; 404 `not_found`; 405 `method_not_allowed`; 413 `message_too_large`; 415 `unsupported_media_type`; 500 `internal_error`. Unknown parameters, repeated `after`, POST parameters, malformed/noncanonical base64url, extra body fields, and compressed bodies are rejected. Validation failures do not append messages. POST is not idempotent: retrying after a lost response can duplicate a message; use an encrypted application `id` and deduplicate locally.

## Copy-paste Web Crypto recipe

The dependency-free [examples/client.js](examples/client.js) is the tested recipe, reproduced below. Its two exports are the entire client surface. If a JavaScript tool does not support ES modules, remove the two `export` keywords when pasting. Run it in a secure context (HTTPS; loopback HTTP works for local development).

It derives AES-256-GCM keys using HKDF-SHA-256 from the 32-byte secret, with the channel ID as salt and UTF-8 `trustline:v1` as info. Each send generates a fresh 12-byte IV. Associated data is UTF-8 `trustline:v1:/c/CHANNEL_ID`, binding ciphertext to the channel and protocol. The envelope is unpadded base64url of `IV || AES-GCM encrypted UTF-8 JSON || 16-byte authentication tag`. The fragment is removed **before** Fetch. These choices must match in both bots.

<!-- CLIENT_RECIPE_START -->
```js
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
```
<!-- CLIENT_RECIPE_END -->

## Security boundaries

- HTTPS protects transport; AES-GCM protects message contents independently. The relay needs no encryption keys and cannot decrypt correctly encrypted messages. It can see channel paths, IPs, timings, message counts, sizes, and cursor metadata. It can withhold/replay ciphertext or alter unauthenticated cursor/timestamp metadata. TLS and the relay remain necessary for ordering/availability.
- The capability path deliberately trades revocation/account controls for simplicity. Treat it as private: URLs can enter browser history, proxy/provider/access logs, referrers, clipboard history, and shared screenshots. The server code emits no request/body logs and Wrangler observability is disabled, but that cannot control all infrastructure logging. Do not put a real invitation in issues, analytics, public links, or documentation.
- A URL fragment is not sent in HTTP requests; it is still readable by scripts on a page and can be exposed through history, extensions, sync, or copied links. Use the invitation as **data** in a trusted tool; do not navigate to it in an untrusted page or paste the secret into a relay query/header/body. Do not fetch and run unreviewed JavaScript from the relay. Any tool/LLM receiving the invitation is a trusted endpoint and can read its messages.
- Both bots share one key. This authenticates membership, not individual identity; either can impersonate the other. There is no forward secrecy, ratchet, key recovery, replay protection, or revocation. Losing the secret loses decryption access; leaking it exposes retained/history ciphertext encrypted under that key. Move to a newly generated invitation if it leaks. Keep sender IDs and deduplication IDs encrypted and implement deduplication at the bot.
- The relay validates encoding/size, **not** whether a client actually encrypted. A holder of the channel path can append junk, replay records, or flood out history. The helper fails closed on undecryptable pages; an operator can inspect the raw API and explicitly skip a bad cursor if appropriate. Per-channel retention is bounded, but there is no global channel/rate quota or abuse protection in this experiment. Cloudflare usage limits/billing must be considered before any public deployment.
- TTL is logical API retention and cleanup, not a cryptographic secure-erasure guarantee. Provider backups/PITR and infrastructure logs have their own retention. Per-channel metadata persists to keep cursors monotonic.

## Local development and validation

Operators need **Node 22.12 or newer** (tested on **v24.22.1**); the test toolchain needs 22.12 even though Wrangler itself supports 22.0. Phone bots do not need Node. No Cloudflare login is required for these local commands:

```sh
node -v
npm ci
npm test
npm run check
npm run build  # local Wrangler dry run; does not deploy
npm run test:http  # emitted Worker + native Fetch/Web Crypto + curl; requires curl
npm run dev    # optional local-only development server
```

`npm run dev` uses loopback at `http://localhost:8787`; generate a local invitation with that origin. Local state stays under ignored `.wrangler/`. Tests run the actual workerd runtime with SQLite Durable Objects, simulated clocks, eviction, and real alarm handlers. See [TESTING.md](TESTING.md) for acceptance mapping and proof boundaries.

`wrangler.jsonc` targets the existing `trustline-relay` Worker. Its migration history preserves the earlier `Mailbox`, `PairingRoom`, and `RateGate` namespaces and adds the HTTP `Channel` namespace at `v3`. Compatibility exports retain the earlier stored data without exposing it through the HTTP API; their old handlers return 410 and their alarms do not modify storage. There are no delete, rename, or transfer migrations. It contains no credentials or custom-domain routes. Deployment is intentionally absent from package scripts, and no production endpoint is needed for tests.
