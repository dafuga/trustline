# Acceptance and validation

This replaces the prior product concept with a small HTTP ciphertext mailbox. Source: Daniel's mission in this executor's conversation. No UI is shipped; API/workerd and Web Crypto evidence apply, screenshots do not.

The repository began at `9edae88` with no executable code. The initial executable test scaffold deliberately returns 404; the red run records the absent API rather than claiming an old implementation existed.

| Criterion | Observable assertion and test layer | Review |
| --- | --- | --- |
| HTTP send/receive, both directions | `HTTP store-and-forward`: ordered full responses, two independent non-destructive readers | accurate and complete |
| Offline/reconnect and durable cursors | Same suite: catch-up, pagination, eviction, monotonic sequence, concurrent requests, empty/future cursor | accurate and complete |
| Channel separation | Same suite: two channel URLs have separate messages and sequences | accurate and complete |
| Bounded retention | 503 sends retain exactly 500, 100 per page, gap flag, exact boundary | accurate and complete |
| TTL and idle cleanup | TTL suite: exact seven-day edge, read/write pruning, early/rescheduled idle alarm, ciphertext removed, sequence survives | accurate and complete |
| Input and HTTP boundaries | Validation suite: paths, cursors, queries, methods, media, schema, canonical base64url, minimum/maximum ciphertext, bounded streamed body, no mutation after rejection | accurate and complete |
| Phone/browser transport | Validation suite: CORS preflight, no-cache/referrer headers on success/errors; crypto suite exercises injected Fetch with no installation requirement | accurate and complete |
| E2E encryption | Client recipe suite: independent clients exchange encrypted Unicode both directions, request has no key/plaintext, randomized IV, tamper/wrong-key/channel binding failures | accurate and complete |
| Actual HTTP and runtime persistence | `test/network.test.mjs`: native Node Fetch/Web Crypto and curl against the emitted Worker, two-way encrypted values, channel separation, independent saved cursor, dispose/recreate with disk data, monotonic sequence | accurate and complete |
| Existing production namespace compatibility | Three workerd cases require the earlier class exports, retain synthetic stored state through a 410 request, an alarm, and eviction; no destructive migrations are used | covered by deployment regression |

Tests use generated synthetic channel/key material, never live credentials. Each test gets an independent channel. Local workerd tests require no Cloudflare login. All retention clocks are controlled in tests; the platform alarm helper triggers the real alarm handler.

## Commands

Use Node 22.12 or newer (validated with Node v24.22.1):

```sh
npm ci
npm test
npm run check
npm run build
npm run test:http
```

`build` is Wrangler's local dry run. It does not deploy. The official [Workers Vitest guide](https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/) and [Durable Object test helpers](https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/) describe the runtime used here.

`test:http` builds the Worker, runs one isolated loopback fixture on an ephemeral port, and disposes only its own runtime and temporary storage in `finally`. It does not start, stop, or restart a shared service. The curl assertions require curl on the development machine; phone bots do not need it.

## Scope of proof

Tests prove local API, durable storage lifecycle, retention, and client cryptography. No cloud deployment, real phone/Grok integration, security audit, traffic/load guarantee, or production acceptance is claimed. A bot must actually have HTTP and Web Crypto execution tools; a chat-only bot cannot autonomously run this recipe. No accounts, pairing, grants, approval UI, CLI product, or WebSockets are implemented.

## Recorded results

- Production compatibility repair, 2026-11-11: the added regression first failed for all three missing legacy class exports (**3 failed / 70 passed**). With compatibility exports and the preserved `v1`/`v2` migration history plus the new `v3` channel migration, **73 passed / 73** and the native HTTP fixture **1 passed / 1**, with no skips. Type/syntax checks and the dry-run build passed. Automated tests ran on `harbor-mbp-2`; no browser UI exists for screenshot testing. The compatibility cases seed synthetic legacy data and verify it survives a retired-handler request, an alarm, and object eviction.
- Initial executable scaffold: **62 failed / 8 passed / 70 total**. Missing send/read routes returned 404 instead of 201/200; missing client behavior failed the recipe assertions. The eight already-correct checks were invalid-route 404s. This scaffold was created for a repository containing only README/LICENSE, not represented as a prior deployed implementation.
- Delivered implementation: **70 passed / 70** across two workerd/Vitest files; **1 passed / 1** native-HTTP fixture. No skipped or cancelled tests. The HTTP fixture also exercises the README's curl POST/GET shapes and checks the pasted recipe equals the tested source.
- `npm run check`: passed (strict TypeScript for Worker, browser recipe, workerd tests; Node fixture syntax check). `npm run build`: passed, local dry run; bundle **7.36 KiB / gzip 2.63 KiB**. `git diff --check`: passed.
- Review covered SQL parameter binding, transaction/sequence allocation, independent reader semantics, pruning/gap boundaries, empty-channel behavior, alarm lifecycle, key derivation/IV/AAD, URL fragment removal, request logging, and capability/key exposure. No remaining correctness finding in covered local flows. Confidence is high for local tested behavior; real Grok/phone and Cloudflare deployment behavior are unverified.
- The browser client's `redirect: 'error'` is preserved. Workerd lacks that browser option, so only the in-process test Fetch adapter maps it to `manual`; the client rejects non-2xx responses. The native-HTTP fixture uses the unmodified recipe and Node's native Fetch.
- Environment: **Node v24.22.1**, Wrangler **4.158.0**, Vitest **4.1.12**, Cloudflare Vitest plugin **1.6.0**. Local commands had no Cloudflare authentication errors and did not require a login.
- This executor's filesystem ran out of **inodes**, not bytes, during ordinary `npm install`. No unrelated files were deleted. Dependencies were installed in task-owned `/dev/shm/trustline-http-deps` with `--ignore-scripts`, then six native ELF files were copied to `/tmp/trustline-http-native` and linked back to accommodate noexec storage. The worktree's ignored `node_modules` is a temporary symlink. The lockfile remains a normal, reproducible npm lockfile; `npm ci` on a machine with sufficient inodes is the standard setup. Test/build commands were run through Node (as encoded in package scripts), with access to that temporary dependency tree.
- The required read-only GitHub default-branch command initially hit the network sandbox, then succeeded with network access: `gh repo view dafuga/trustline --json defaultBranchRef` returned **main**. No push, PR creation/update, deploy, route/secret/account changes, production-relay requests, or shared service restarts were performed.
