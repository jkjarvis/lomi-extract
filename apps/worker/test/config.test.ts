import { describe, expect, it, vi } from 'vitest';
import { loadConfig, log } from '../src/config.js';

describe('loadConfig', () => {
  it('uses the contract defaults (lease 30 s, reconcile every 10 s, 3 attempts)', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ leaseMs: 30_000, reconcileIntervalMs: 10_000, maxRunAttempts: 3, concurrency: 4, redisUrl: 'redis://localhost:6379' });
    expect(c.workerId.length).toBeGreaterThan(0);
  });

  it('reads env knobs and rejects nonsense instead of running with a 0 ms lease', () => {
    expect(loadConfig({ LEASE_MS: '1500', RECONCILE_INTERVAL_MS: '250', MAX_RUN_ATTEMPTS: '5', WORKER_ID: 'w9', WORKER_CONCURRENCY: '2' })).toMatchObject({
      leaseMs: 1500, reconcileIntervalMs: 250, maxRunAttempts: 5, workerId: 'w9', concurrency: 2,
    });
    expect(loadConfig({ LEASE_MS: '10', RECONCILE_INTERVAL_MS: 'abc', MAX_RUN_ATTEMPTS: '0' })).toMatchObject({
      leaseMs: 30_000, reconcileIntervalMs: 10_000, maxRunAttempts: 3,
    });
  });
});

describe('log', () => {
  it('writes one JSON line per event, errors to stderr', () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    log('info', 'hello', { runId: 'r1' });
    log('error', 'bad');
    expect(JSON.parse(out.mock.calls[0]![0] as string)).toMatchObject({ level: 'info', svc: 'worker', msg: 'hello', runId: 'r1' });
    expect(JSON.parse(err.mock.calls[0]![0] as string)).toMatchObject({ level: 'error', msg: 'bad' });
  });
});
