#!/usr/bin/env node
// index.js — entry point for the free-pi gateway
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config, configFileUsed, hasConfigFile, ROOT } from './src/config.js';
import { log } from './src/logger.js';
import { initAccounts, accountCount } from './src/accounts.js';
import { initUsage, stopUsage } from './src/usage.js';
import { createServer } from './src/server.js';
import { initVersion, refreshVersion, versionInfo } from './src/version.js';

// admin key: .env/process env or shi.json override, else generated once and persisted
let adminKey = config.adminKey;
const keyFile = join(config.dataDir ?? ROOT, '.admin-key');
let keySource = config.adminKey ? '.env / config' : null;
if (!adminKey) {
  if (existsSync(keyFile)) adminKey = readFileSync(keyFile, 'utf8').trim();
  if (adminKey) keySource = '.admin-key';
  if (!adminKey) {
    adminKey = randomUUID().replace(/-/g, '');
    keySource = 'generated (stored in .admin-key)';
    try { writeFileSync(keyFile, adminKey, { mode: 0o600 }); } catch {}
  }
}
config.adminKey = adminKey;

// Client version: upstream refuses a stale x-client-version with 426
// upgrade_required, so ask /client-version (the CLI's own update check) for the
// current min/latest instead of hard-coding one. Refreshed on a timer after this.
initVersion();
// A restart always re-reads it (never a cached value); retry a flaky fetch so
// the first request is not the one that discovers a stale version.
await refreshVersion({ attempts: 3 });
const clientInfo = versionInfo();

console.log('free-pi gateway');
console.log(`  config   : ${configFileUsed}${hasConfigFile ? '' : ' (not found — defaults in use)'}`);
console.log(`  upstream : ${config.base}`);
console.log(`  client   : ${clientInfo.version} (${clientInfo.source}${clientInfo.min ? `; upstream min ${clientInfo.min}, latest ${clientInfo.latest}` : ''}${clientInfo.error ? `; fetch failed: ${clientInfo.error}` : ''})`);
console.log(`  model    : ${config.defaultModel}`);
console.log(`  admin ui : http://${config.host}:${config.port}/admin`);
console.log(`  admin key: ${adminKey} (${keySource})`);
console.log(`  log      : ${config.logFile} (${config.logLevel})`);

initAccounts();
initUsage();
const { total, enabled } = accountCount();
console.log(`  accounts : ${enabled} enabled / ${total} total (round-robin)`);

// keep accounts ad-compliant like the real CLI (banner cycle every 10 min)
const { startAdHeartbeat } = await import('./src/ads.js');
const { accountsForAds } = await import('./src/accounts.js');
startAdHeartbeat(accountsForAds);

try {
  // touch credentials early so a missing file fails fast
  const { initCredentials } = await import('./src/credentials.js');
  initCredentials();
} catch (e) {
  log.warn(e.message, { note: 'gateway still starts; requests need at least one account' });
}

// re-read the version detail periodically; a 426 still bumps it immediately
const versionTimer = setInterval(() => { refreshVersion().catch(() => {}); }, Math.max(60_000, config.versionCheckMs ?? 6 * 60 * 60 * 1000));
versionTimer.unref();

const gw = createServer();
await gw.listen();

const shutdown = async (signal) => {
  log.info('shutting down', { signal });
  stopUsage();
  await gw.close().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
