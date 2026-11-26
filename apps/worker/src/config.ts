import os from 'node:os';

const int = (v: string | undefined, d: number, min = 0) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : d;
};

export interface WorkerConfig {
  databaseUrl: string;
  redisUrl: string;
  workerId: string;
  leaseMs: number;
  reconcileIntervalMs: number;
  maxRunAttempts: number;
  concurrency: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return {
    databaseUrl: env.DATABASE_URL ?? 'postgresql://lomi:lomi@localhost:5432/lomi',
    redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
    workerId: env.WORKER_ID || os.hostname(),
    leaseMs: int(env.LEASE_MS, 30_000, 1000),
    reconcileIntervalMs: int(env.RECONCILE_INTERVAL_MS, 10_000, 100),
    maxRunAttempts: int(env.MAX_RUN_ATTEMPTS, 3, 1),
    concurrency: int(env.WORKER_CONCURRENCY, 4, 1),
  };
}

export function log(level: 'info' | 'warn' | 'error', msg: string, extra: Record<string, unknown> = {}) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, svc: 'worker', msg, ...extra });
  if (level === 'error') console.error(line);
  else console.log(line);
}
