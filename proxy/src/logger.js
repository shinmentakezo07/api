// logger.js — leveled console + JSONL file logging with size-based rotation
import { appendFileSync, mkdirSync, statSync, renameSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join, basename, extname } from 'node:path';
import { config } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

const MAX_BYTES = config.logRotate?.maxBytes ?? 10 * 1024 * 1024;
const MAX_FILES = config.logRotate?.maxFiles ?? 5;

try { mkdirSync(dirname(config.logFile), { recursive: true }); } catch {}

let currentBytes = 0;
try { currentBytes = statSync(config.logFile).size; } catch {}

/** Rotate gateway.log -> gateway.log.1 .. N (oldest dropped) once it exceeds MAX_BYTES. */
function rotateIfNeeded() {
  if (currentBytes < MAX_BYTES) return;
  const dir = dirname(config.logFile);
  const ext = extname(config.logFile);
  const stem = basename(config.logFile, ext);
  try {
    // drop the oldest, shift the rest down
    try { unlinkSync(join(dir, `${stem}.${MAX_FILES}${ext}`)); } catch {}
    for (let i = MAX_FILES - 1; i >= 1; i--) {
      try { renameSync(join(dir, `${stem}.${i}${ext}`), join(dir, `${stem}.${i + 1}${ext}`)); } catch {}
    }
    renameSync(config.logFile, join(dir, `${stem}.1${ext}`));
    currentBytes = 0;
  } catch (e) {
    console.error(`[logger] rotation failed: ${e.message}`);
    currentBytes = 0; // avoid retrying every line
  }
}

function write(level, msg, fields = {}) {
  if (LEVELS[level] < threshold) return;
  const ts = new Date().toISOString();
  const line = fields && Object.keys(fields).length
    ? `${ts} ${level.toUpperCase()} ${msg} ${JSON.stringify(fields)}`
    : `${ts} ${level.toUpperCase()} ${msg}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  const jsonl = JSON.stringify({ ts, level, msg, ...fields }) + '\n';
  try {
    rotateIfNeeded();
    appendFileSync(config.logFile, jsonl);
    currentBytes += Buffer.byteLength(jsonl);
  } catch {}
}

export const log = {
  debug: (msg, fields) => write('debug', msg, fields),
  info: (msg, fields) => write('info', msg, fields),
  warn: (msg, fields) => write('warn', msg, fields),
  error: (msg, fields) => write('error', msg, fields),
};
