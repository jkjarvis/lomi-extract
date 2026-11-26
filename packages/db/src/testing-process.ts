/**
 * Test support (not used at runtime) for the `process` test projects: they spawn the real built entry points
 * (`node dist/...`) as child processes with NODE_V8_COVERAGE, so `pnpm coverage` can merge their coverage.
 *
 * Safety: the child gets an explicit environment (nothing inherited but PATH/HOME), the Redis URL must be this
 * stack's Redis (the port compose publishes it on) with a non-zero logical DB, and only that DB is ever flushed.
 */
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** The host port docker compose publishes this stack's Redis on: REDIS_PORT from the repo's .env, else 6379. */
export function stackRedisPort(envFile: string = path.join(REPO_ROOT, '.env')): number {
  const fromFile = existsSync(envFile) ? /^\s*REDIS_PORT\s*=\s*"?(\d+)"?\s*$/m.exec(readFileSync(envFile, 'utf8'))?.[1] : undefined;
  return Number(fromFile ?? process.env.REDIS_PORT ?? 6379);
}

/**
 * This stack's Redis with a dedicated logical DB (PROCESS_TEST_REDIS_URL overrides the server). Refuses DB 0,
 * and any port other than the one compose publishes the stack's Redis on, so an unrelated Redis on the
 * machine (here: another container on 6379) is never touched.
 */
export function processTestRedisUrl(db: number, server: string = process.env.PROCESS_TEST_REDIS_URL || `redis://localhost:${stackRedisPort()}`): string {
  if (!Number.isInteger(db) || db < 1 || db > 15) throw new Error(`Refusing Redis logical DB ${db} (use 1..15, never 0)`);
  const u = new URL(server);
  const port = Number(u.port || 6379);
  if (u.protocol !== 'redis:' || port !== stackRedisPort()) {
    throw new Error(`Refusing Redis "${server}": not this stack's Redis (compose publishes it on port ${stackRedisPort()}, see .env REDIS_PORT)`);
  }
  u.pathname = `/${db}`;
  return u.toString();
}

/** FLUSHDB, but only on a connection that selected a non-zero logical DB. */
export async function flushTestRedis(redis: { options: { db?: number }; flushdb(): Promise<unknown> }): Promise<void> {
  const db = redis.options.db ?? 0;
  if (db < 1) throw new Error('Refusing to FLUSHDB logical DB 0');
  await redis.flushdb();
}

/** Where a package's child processes write raw V8 coverage (merged by `@lomi/config/coverage-merge.mjs`). */
export const v8CoverageDir = (pkgDir: string) => path.join(pkgDir, 'coverage', 'process-v8');

/** Global-setup helper: fail fast when dist/ is older than src/ (the tests run the built entry points). */
export function assertBuilt(pkgDir: string): void {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  for (const src of walk(path.join(pkgDir, 'src')).filter((f) => /\.ts$/.test(f) && !f.endsWith('.d.ts'))) {
    const out = path.join(pkgDir, 'dist', path.relative(path.join(pkgDir, 'src'), src)).replace(/\.ts$/, '.js');
    if (!existsSync(out) || statSync(out).mtimeMs < statSync(src).mtimeMs) {
      throw new Error(`${path.relative(pkgDir, out)} is missing or older than its source: build first (\`pnpm turbo run build\`)`);
    }
  }
}

export function resetV8CoverageDir(pkgDir: string): void {
  rmSync(v8CoverageDir(pkgDir), { recursive: true, force: true });
  mkdirSync(v8CoverageDir(pkgDir), { recursive: true });
}

export interface ExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** ms from the stop signal (or from spawn when the process exited on its own) to exit. */
  ms: number;
}

export interface Spawned {
  child: ChildProcess;
  /** Every stdout/stderr line so far. */
  lines: string[];
  /** Lines that parse as JSON objects (the services log JSON). */
  logs(): Array<Record<string, unknown>>;
  waitForLine(match: RegExp | ((line: string) => boolean), timeoutMs?: number): Promise<string>;
  exited: Promise<ExitResult>;
  /** Send `signal` and wait for exit. */
  stop(signal?: NodeJS.Signals, timeoutMs?: number): Promise<ExitResult>;
}

const running = new Set<ChildProcess>();

/** Spawn `node <script>` in `pkgDir` with exactly `env` (+ PATH, HOME, NODE_V8_COVERAGE). */
export function spawnEntry(pkgDir: string, script: string, env: Record<string, string>): Spawned {
  const child = spawn(process.execPath, [script], {
    cwd: pkgDir,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
      NODE_V8_COVERAGE: v8CoverageDir(pkgDir),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.add(child);
  const lines: string[] = [];
  const waiters = new Set<() => void>();
  for (const stream of [child.stdout!, child.stderr!]) {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        lines.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
      for (const w of [...waiters]) w();
    });
  }
  const started = Date.now();
  let stopAt: number | undefined;
  let done = false;
  const exited = new Promise<ExitResult>((resolve) => {
    child.on('exit', (code, signal) => {
      running.delete(child);
      done = true;
      for (const w of [...waiters]) w();
      resolve({ code, signal, ms: Date.now() - (stopAt ?? started) });
    });
  });

  const tail = () => lines.slice(-30).join('\n');
  return {
    child,
    lines,
    logs: () =>
      lines.flatMap((l) => {
        try {
          const v = JSON.parse(l) as unknown;
          return v && typeof v === 'object' ? [v as Record<string, unknown>] : [];
        } catch {
          return [];
        }
      }),
    waitForLine(match, timeoutMs = 20_000) {
      const test = typeof match === 'function' ? match : (l: string) => match.test(l);
      return new Promise((resolve, reject) => {
        const check = () => {
          const hit = lines.find(test);
          if (hit !== undefined) {
            cleanup();
            resolve(hit);
          } else if (done) {
            cleanup();
            reject(new Error(`process exited before logging ${String(match)}; last output:\n${tail()}`));
          }
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`timed out after ${timeoutMs} ms waiting for ${String(match)}; last output:\n${tail()}`));
        }, timeoutMs);
        const cleanup = () => {
          clearTimeout(timer);
          waiters.delete(check);
        };
        waiters.add(check);
        check();
      });
    },
    exited,
    async stop(signal = 'SIGTERM', timeoutMs = 15_000) {
      if (!done) {
        stopAt = Date.now();
        child.kill(signal);
      }
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`process did not exit within ${timeoutMs} ms of ${signal}; last output:\n${tail()}`)), timeoutMs).unref(),
      );
      return Promise.race([exited, timeout]);
    },
  };
}

/** afterEach/afterAll: SIGKILL anything a failed test left running (no coverage from those, by design). */
export function killAllSpawned(): void {
  for (const c of running) c.kill('SIGKILL');
  running.clear();
}

/** A port nothing listens on (connections are refused). */
export async function closedPort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as net.AddressInfo;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

export interface TcpProxy {
  port: number;
  /** `refuse`: drop every connection (the dependency looks down); `forward`: pipe to the target. */
  setMode(mode: 'refuse' | 'forward'): void;
  close(): Promise<void>;
}

/** A TCP proxy in front of Postgres/Redis, to take a dependency "down" and bring it back without touching it. */
export async function startTcpProxy(target: { host: string; port: number }, mode: 'refuse' | 'forward'): Promise<TcpProxy> {
  let current = mode;
  const open = new Set<net.Socket>();
  const srv = net.createServer((client) => {
    if (current === 'refuse') return client.destroy();
    const upstream = net.connect(target.port, target.host);
    open.add(client).add(upstream);
    const drop = () => {
      client.destroy();
      upstream.destroy();
      open.delete(client);
      open.delete(upstream);
    };
    client.on('error', drop).on('close', drop);
    upstream.on('error', drop).on('close', drop);
    client.pipe(upstream).pipe(client);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return {
    port: (srv.address() as net.AddressInfo).port,
    setMode(m) {
      current = m;
      if (m === 'refuse') for (const s of open) s.destroy();
    },
    async close() {
      for (const s of open) s.destroy();
      await new Promise<void>((r) => srv.close(() => r()));
    },
  };
}

/** Poll `fn` until it returns a truthy value. */
export async function until<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 20_000, what = 'condition'): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
