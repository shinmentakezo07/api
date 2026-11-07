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

// admin key: .env/process env or shi.json override, else generated once and persisted
let adminKey = config.adminKey;
const keyFile = join(ROOT, '.admin-key');
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

console.log('free-pi gateway');
console.log(`  config   : ${configFileUsed}${hasConfigFile ? '' : ' (not found — defaults in use)'}`);
console.log(`  upstream : ${config.base}`);
console.log(`  model    : ${config.defaultModel}`);
console.log(`  admin ui : http://${config.host}:${config.port}/admin`);
console.log(`  admin key: ${adminKey} (${keySource})`);
console.log(`  log      : ${config.logFile} (${config.logLevel})`);

initAccounts();
initUsage();
const { total, enabled } = accountCount();
console.log(`  accounts : ${enabled} enabled / ${total} total (round-robin)`);

try {
  // touch credentials early so a missing file fails fast
  const { initCredentials } = await import('./src/credentials.js');
  initCredentials();
} catch (e) {
  log.warn(e.message, { note: 'gateway still starts; requests need at least one account' });
}

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
