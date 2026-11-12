// test/version.test.js — x-client-version resolution and 426 upgrade parsing.
//
// Upstream refuses a stale x-client-version with
//   426 {"code":"upgrade_required","message":"... below the required minimum (0.6.19) ..."}
// so the gateway reads GET /client-version instead of hard-coding a version.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { config } from '../src/config.js';
import {
  parseVersion, isVersion, compareVersions, requiredVersionFrom,
  applyVersionInfo, noteRequiredVersion, clientVersion, versionInfo, initVersion,
  refreshVersion,
} from '../src/version.js';

test('the version is re-checked every 10–15 minutes', () => {
  assert.ok(config.versionCheckMs >= 10 * 60 * 1000, 'at most every 10 min');
  assert.ok(config.versionCheckMs <= 15 * 60 * 1000, 'not slower than 15 min');
});

test('compareVersions orders numerically, not lexically', () => {
  assert.equal(compareVersions('0.6.9', '0.6.19'), -1);
  assert.equal(compareVersions('0.6.19', '0.6.9'), 1);
  assert.equal(compareVersions('0.6.19', '0.6.19'), 0);
  assert.equal(compareVersions('v1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.2.3-beta.1', '1.2.3'), 0, 'prerelease suffixes compare as the release');
});

test('parseVersion rejects anything that is not a version', () => {
  assert.equal(parseVersion('auto'), null);
  assert.equal(parseVersion(''), null);
  assert.equal(parseVersion(undefined), null);
  assert.equal(isVersion('0.6.19'), true);
  assert.equal(isVersion('auto'), false);
});

test('requiredVersionFrom reads the 426 message the way upstream writes it', () => {
  const body = JSON.stringify({
    code: 'upgrade_required',
    message: 'your free-pi-cli is below the required minimum (0.6.19); update with: npx free-pi-cli@latest',
    error: { message: 'your free-pi-cli is below the required minimum (0.6.19); update with: npx free-pi-cli@latest', code: 'upgrade_required', type: 'free_pi_error' },
  });
  assert.equal(requiredVersionFrom(body), '0.6.19');
  assert.equal(requiredVersionFrom('your free-pi-cli is below the required minimum (1.2.3); update with: x'), '1.2.3');
  assert.equal(requiredVersionFrom('{"min":"0.7.0"}'), '0.7.0');
  assert.equal(requiredVersionFrom('something else'), null);
  assert.equal(requiredVersionFrom(''), null);
});

test('applyVersionInfo adopts the newest release and records the detail', () => {
  initVersion();
  applyVersionInfo({ min: '100.0.0', latest: '100.2.0', min_desktop_version: '0.0.0', latest_desktop_version: '0.3.4' });
  assert.equal(clientVersion(), '100.2.0');
  const info = versionInfo();
  assert.equal(info.min, '100.0.0');
  assert.equal(info.latest, '100.2.0');
  assert.equal(info.detail.latestDesktop, '0.3.4');
  assert.equal(info.source, 'client-version');
});

test('a 426 bump is never undone by a later catalog refresh', () => {
  assert.equal(noteRequiredVersion('999.0.0'), true);
  assert.equal(clientVersion(), '999.0.0');
  applyVersionInfo({ min: '100.0.0', latest: '100.2.0' });
  assert.equal(clientVersion(), '999.0.0', 'the version only moves up');
});

test('noteRequiredVersion ignores older or invalid minimums', () => {
  assert.equal(noteRequiredVersion('0.0.1'), false);
  assert.equal(noteRequiredVersion('nonsense'), false);
  assert.equal(clientVersion(), '999.0.0');
});

/** Run fn against a throwaway /client-version server. */
async function withVersionServer(handler, fn) {
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const prevBase = config.base;
  config.base = 'http://127.0.0.1:' + srv.address().port;
  try { return await fn(); } finally {
    config.base = prevBase;
    await new Promise((r) => srv.close(r));
  }
}

test('refreshVersion fetches /client-version and adopts latest', async () => {
  const seen = [];
  await withVersionServer((req, res) => {
    seen.push(req.headers['x-client-version']);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ min: '1001.0.0', latest: '1001.5.0', models: [] }));
  }, async () => {
    await refreshVersion();
    assert.equal(clientVersion(), '1001.5.0', 'latest is the version that gets sent');
    assert.equal(versionInfo().latest, '1001.5.0');
    assert.equal(seen.length, 1);
    assert.ok(seen[0], 'the request carried the previous x-client-version');
  });
});

test('startup retries a flaky /client-version fetch', async () => {
  let hits = 0;
  await withVersionServer((req, res) => {
    hits++;
    if (hits < 3) { res.writeHead(503); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ min: '2000.0.0', latest: '2000.9.0' }));
  }, async () => {
    await refreshVersion({ attempts: 3, backoffMs: 1 });
    assert.equal(hits, 3, 'two failures then success');
    assert.equal(clientVersion(), '2000.9.0');
  });
});

test('a failed refresh keeps the last known version and reports the error', async () => {
  const before = clientVersion();
  const prevBase = config.base;
  config.base = 'http://127.0.0.1:1';   // nothing listens there
  try {
    const v = await refreshVersion({ timeoutMs: 500 });
    assert.equal(v, before);
    assert.equal(clientVersion(), before, 'a failed fetch never downgrades or blanks the version');
    assert.ok(versionInfo().error, 'the failure is visible on /health');
  } finally { config.base = prevBase; }
});
