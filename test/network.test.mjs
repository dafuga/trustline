import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Miniflare, convertV4MiniflareOptions, Log, LogLevel } from 'miniflare';
import { createInvite, openChannel } from '../examples/client.js';

test('built Worker serves native HTTP clients and persists offline messages across runtime recreation', { timeout: 30_000 }, async () => {
  const storage = await mkdtemp(join(tmpdir(), 'trustline-http-test-'));
  let runtime;
  const start = () => new Miniflare(convertV4MiniflareOptions({
    name: 'trustline-http-network-test',
    scriptPath: 'dist/index.js',
    modules: true,
    compatibilityDate: '2026-11-08',
    durableObjects: { CHANNELS: { className: 'Channel', useSQLite: true } },
    resourcePersistencePath: storage,
    host: '127.0.0.1', port: 0,
    cf: false, telemetry: { enabled: false }, logRequests: false,
    log: new Log(LogLevel.ERROR),
  }));
  try {
    runtime = start();
    const firstOrigin = (await runtime.ready).origin;
    const invitation = createInvite(firstOrigin);
    const daniel = await openChannel(invitation);
    const frances = await openChannel(invitation);
    const outbound = { from: 'Daniel', text: 'Native HTTP: olá 👋', id: 'd-1' };
    assert.equal((await daniel.send(outbound)).cursor, '1');
    const received = await frances.receive();
    assert.deepEqual(received.messages.map(m => m.value), [outbound]);
    const savedCursor = received.nextCursor;
    const reply = { from: 'Frances', text: 'Reply retained while offline', id: 'f-1' };
    assert.equal((await frances.send(reply)).cursor, '2');
    const isolated = await openChannel(createInvite(firstOrigin));
    assert.deepEqual((await isolated.receive()).messages, []);

    // Dispose only this test's runtime, then reconstruct with the same disk data.
    await runtime.dispose();
    runtime = undefined;
    runtime = start();
    const nextOrigin = (await runtime.ready).origin;
    const resumedInvite = new URL(invitation);
    const newOrigin = new URL(nextOrigin);
    resumedInvite.host = newOrigin.host;
    const resumed = await openChannel(resumedInvite.href);
    const catchup = await resumed.receive(savedCursor);
    assert.deepEqual(catchup.messages.map(m => m.value), [reply]);
    assert.equal(catchup.nextCursor, '2');
    assert.equal((await resumed.send({ text: 'After recreation' })).cursor, '3');

    // Run the documented curl POST/GET shapes against loopback with synthetic data.
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const endpoint = resumedInvite.href.split('#')[0];
    const { stdout: firstPage } = await run('curl', ['--fail-with-body', '--silent', `${endpoint}?after=0`]);
    const wire = JSON.parse(firstPage);
    assert.equal(wire.messages.length, 3);
    assert.ok(!firstPage.includes(outbound.text));
    const { stdout: receipt } = await run('curl', ['--fail-with-body', '--silent', '-X', 'POST', endpoint,
      '-H', 'Content-Type: application/json', '--data-binary', JSON.stringify({ ciphertext: wire.messages[0].ciphertext })]);
    assert.equal(JSON.parse(receipt).cursor, '4');
    const { stdout: lastPage } = await run('curl', ['--fail-with-body', '--silent', `${endpoint}?after=3`]);
    assert.equal(JSON.parse(lastPage).messages[0].cursor, '4');

    // The README's pasted implementation must be the same independently tested recipe.
    const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
    const recipe = await readFile(new URL('../examples/client.js', import.meta.url), 'utf8');
    const documented = readme.split('<!-- CLIENT_RECIPE_START -->\n```js\n')[1]?.split('\n```\n<!-- CLIENT_RECIPE_END -->')[0];
    assert.equal(documented, recipe.trimEnd());
  } finally {
    try { await runtime?.dispose(); }
    finally { await rm(storage, { recursive: true, force: true }); }
  }
});
