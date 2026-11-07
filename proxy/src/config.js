// config.js — layered config: defaults <- shi.json <- env <- CLI args
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = dirname(here);

const DEFAULTS = {
  port: 8787,
  host: '127.0.0.1',
  base: 'https://api.freepi.ai',
  cliVersion: '0.6.14',
  defaultModel: 'deepseek/deepseek-v4-flash',
  credentialsFile: join(homedir(), '.free-pi', 'agent', 'credentials.json'),
  logFile: join(ROOT, 'logs', 'gateway.log'),
  logLevel: 'info',            // debug | info | warn | error
  logRotate: { maxBytes: 10 * 1024 * 1024, maxFiles: 5 }, // gateway.log.N kept
  maxInFlightPerAccount: 4,    // free-pi backend session limit, logged when approached
  envFile: join(ROOT, '.env'),
  accountsFile: join(ROOT, 'accounts.json'),
  usageFile: join(ROOT, 'logs', 'usage.json'),
  adminKey: '',                // empty = generate one at startup (persisted to .admin-key)
  clientKeys: [],              // empty = accept any key; else list of allowed keys
  catalogTtlMs: 300_000,
  retry: { maxAttempts: 3, backoffMs: 500 },   // on 429/5xx, before first byte sent
  resetOnConcurrent: { maxResets: 2, settleMs: 500 }, // auto /close-other-session on concurrent_session
  credRefreshMs: 60_000,       // re-read credentials.json at most this often
  requestTimeoutMs: 300_000,   // hard cap per upstream call
};

// --- CLI args -----------------------------------------------------------
const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : 'true';
};

// --- file layer ----------------------------------------------------------
const configFile = argOf('--config') ?? join(ROOT, 'shi.json');
let fileCfg = {};
if (existsSync(configFile)) {
  try { fileCfg = JSON.parse(readFileSync(configFile, 'utf8')); }
  catch (e) { console.error(`[config] invalid ${configFile}: ${e.message}`); }
}

// --- env layer -----------------------------------------------------------
// parse .env (same format as accounts.js): KEY=VALUE lines, # comments, quotes stripped
function parseEnvFile(path) {
  try {
    if (!existsSync(path)) return {};
    const out = {};
    for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      out[line.slice(0, eq).trim()] = val;
    }
    return out;
  } catch { return {}; }
}

const envFile = parseEnvFile(join(ROOT, '.env'));
const envCfg = {};
if (process.env.PORT) envCfg.port = Number(process.env.PORT);
if (process.env.HOST) envCfg.host = process.env.HOST;          // 0.0.0.0 in containers
if (process.env.FREEPI_BASE_URL) envCfg.base = process.env.FREEPI_BASE_URL;
if (process.env.FREEPI_LOG_LEVEL) envCfg.logLevel = process.env.FREEPI_LOG_LEVEL;
if (process.env.DATA_DIR) envCfg.dataDir = process.env.DATA_DIR; // writable state dir (docker)
if (process.env.FREEPI_CREDENTIALS_FILE) envCfg.credentialsFile = process.env.FREEPI_CREDENTIALS_FILE;
// admin key from .env or process env (ADMIN_KEY or FREEPI_ADMIN_KEY)
if (process.env.ADMIN_KEY) envCfg.adminKey = process.env.ADMIN_KEY;
if (process.env.FREEPI_ADMIN_KEY) envCfg.adminKey = process.env.FREEPI_ADMIN_KEY;
if (envFile.ADMIN_KEY) envCfg.adminKey = envFile.ADMIN_KEY;
if (envFile.FREEPI_ADMIN_KEY) envCfg.adminKey = envFile.FREEPI_ADMIN_KEY;

// --- merge ---------------------------------------------------------------
const merged = { ...DEFAULTS, ...fileCfg, ...envCfg };
if (argOf('--port')) merged.port = Number(argOf('--port'));
if (argOf('--base')) merged.base = argOf('--base');
if (argOf('--log-level')) merged.logLevel = argOf('--log-level');
if (argOf('--default-model')) merged.defaultModel = argOf('--default-model');
merged.base = String(merged.base).replace(/\/+$/, '');
merged.port = Number(merged.port);

// dataDir: where writable state lives (logs, accounts.json, .admin-key).
// Defaults to the install dir; containers set DATA_DIR=/app/data.
const dataDir = merged.dataDir ?? ROOT;
merged.dataDir = dataDir;
merged.logFile = fileCfg.logFile ?? join(dataDir, 'logs', 'gateway.log');
merged.accountsFile = fileCfg.accountsFile ?? join(dataDir, 'accounts.json');
merged.usageFile = fileCfg.usageFile ?? join(dataDir, 'logs', 'usage.json');

export const config = merged;
export const configFileUsed = configFile;
export const hasConfigFile = existsSync(configFile);
export const SESSION_ID = fileCfg.sessionId ?? randomUUID();
export const CLIENT_VERSION = merged.cliVersion;
