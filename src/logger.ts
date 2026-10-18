import { Writable } from 'node:stream';
import { pino } from 'pino';
import { config } from './config.js';
import { bus } from './events.js';

export interface LogEntry {
  id: number;
  time: string;
  level: number;
  msg: string;
  data?: Record<string, unknown>;
}

const RING_SIZE = 1000;
const ring: LogEntry[] = [];
let seq = 0;

/** Keeps the last log lines in memory for the web UI. */
const ringStream = new Writable({
  write(chunk: Buffer, _enc, cb) {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const { level, time, msg, ...data } = JSON.parse(line) as { level: number; time: string; msg?: string } & Record<string, unknown>;
        ring.push({ id: ++seq, time, level, msg: msg ?? '', data: Object.keys(data).length ? data : undefined });
        if (ring.length > RING_SIZE) ring.shift();
      } catch {
        // not JSON – ignore
      }
    }
    bus.emitEvent({ type: 'log' });
    cb();
  },
});

export const logger = pino(
  {
    level: config.LOG_LEVEL,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.multistream([
    { level: 'trace', stream: process.stdout },
    { level: 'trace', stream: ringStream },
  ]),
);

export function recentLogs(opts: { afterId?: number; minLevel?: number; limit?: number } = {}) {
  return ring.filter((e) => e.id > (opts.afterId ?? 0) && e.level >= (opts.minLevel ?? 0)).slice(-(opts.limit ?? 300));
}

export type Logger = typeof logger;
