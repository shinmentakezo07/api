// logger.js — leveled console + JSONL file logging
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

try { mkdirSync(dirname(config.logFile), { recursive: true }); } catch {}

function write(level, msg, fields = {}) {
  if (LEVELS[level] < threshold) return;
  const ts = new Date().toISOString();
  const line = fields && Object.keys(fields).length
    ? `${ts} ${level.toUpperCase()} ${msg} ${JSON.stringify(fields)}`
    : `${ts} ${level.toUpperCase()} ${msg}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  try { appendFileSync(config.logFile, JSON.stringify({ ts, level, msg, ...fields }) + '\n'); } catch {}
}

export const log = {
  debug: (msg, fields) => write('debug', msg, fields),
  info: (msg, fields) => write('info', msg, fields),
  warn: (msg, fields) => write('warn', msg, fields),
  error: (msg, fields) => write('error', msg, fields),
};
