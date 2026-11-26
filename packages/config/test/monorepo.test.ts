// Brief §0 and §5 as executable checks: a real Turborepo pipeline over pnpm workspaces, and one `docker compose up`
// that starts everything (migrations + seed before the app). Cheap guards against the config quietly rotting.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');
const json = (p: string) => JSON.parse(read(p)) as Record<string, any>;

const workspacePackages = ['apps', 'packages', 'tests'].flatMap((dir) =>
  readdirSync(path.join(ROOT, dir))
    .filter((d) => existsSync(path.join(ROOT, dir, d, 'package.json')))
    .map((d) => ({ dir: `${dir}/${d}`, pkg: json(`${dir}/${d}/package.json`) })),
);
const code = workspacePackages.filter((p) => p.dir.startsWith('apps/') || (p.dir.startsWith('packages/') && p.dir !== 'packages/config'));

describe('monorepo (brief §0)', () => {
  it('is a pnpm workspace over apps/*, packages/*, tests/* with Turborepo at the root', () => {
    expect(parse(read('pnpm-workspace.yaml')).packages).toEqual(['apps/*', 'packages/*', 'tests/*']);
    const root = json('package.json');
    expect(root.packageManager).toMatch(/^pnpm@/);
    expect(root.devDependencies.turbo).toBeTruthy();
    for (const s of ['build', 'test', 'lint', 'typecheck', 'coverage', 'test:db', 'test:process']) expect(root.scripts[s]).toBe(`turbo run ${s}`);
  });

  it('turbo.json wires build → test/lint/typecheck/coverage through the dependency graph', () => {
    const { tasks } = json('turbo.json');
    expect(tasks.build.dependsOn).toEqual(['^build']);
    expect(tasks.build.outputs).toEqual(['dist/**']);
    for (const t of ['test', 'lint', 'typecheck', 'test:db', 'test:integration']) expect(tasks[t].dependsOn).toEqual(['^build']);
    // These spawn the package's own built entry points (node dist/...), so they also need its own build.
    for (const t of ['coverage', 'test:process']) expect(tasks[t].dependsOn).toEqual(['^build', 'build']);
    expect(tasks.coverage.outputs).toEqual(['coverage/**']);
    expect(tasks['test:integration'].cache).toBe(false); // runs against live infrastructure
  });

  it('every code package builds, tests, lints and typechecks through its own scripts', () => {
    expect(code.map((p) => p.pkg.name).sort()).toEqual(['@lomi/api', '@lomi/core', '@lomi/db', '@lomi/extraction', '@lomi/web', '@lomi/worker']);
    for (const { pkg } of code) {
      for (const s of ['build', 'test', 'lint', 'typecheck', 'coverage']) expect(pkg.scripts?.[s], `${pkg.name} ${s}`).toBeTruthy();
    }
  });

  it('internal dependencies are workspace links, and the pure core has no I/O dependencies', () => {
    for (const { pkg } of workspacePackages) {
      for (const [dep, v] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
        if (dep.startsWith('@lomi/')) expect(v, `${pkg.name} → ${dep}`).toBe('workspace:*');
      }
    }
    const core = code.find((p) => p.pkg.name === '@lomi/core')!.pkg;
    expect(core.dependencies ?? {}).toEqual({});
  });
});

describe('docker compose (brief §5)', () => {
  const compose = parse(read('docker-compose.yml')) as { services: Record<string, any> };

  it('one compose file starts Postgres, Redis, migrations+seed, API, worker and web', () => {
    expect(Object.keys(compose.services).sort()).toEqual(['api', 'migrate', 'postgres', 'redis', 'web', 'worker']);
  });

  it('API and worker wait for migrations + seed to finish; the worker defaults to the mock LLM without a key', () => {
    for (const s of ['api', 'worker']) {
      expect(compose.services[s].depends_on.migrate.condition).toBe('service_completed_successfully');
      expect(compose.services[s].depends_on.postgres.condition).toBe('service_healthy');
    }
    expect(compose.services.worker.environment.LLM_PROVIDER).toBe('${LLM_PROVIDER:-mock}');
    expect(read('Dockerfile')).toMatch(/prisma migrate deploy && node dist\/seed\.js/);
  });

  it('no hard-coded project name, so two checkouts never share containers or volumes', () => {
    expect(compose).not.toHaveProperty('name');
  });

  it('Redis is deliberately non-durable: losing it must be harmless', () => {
    expect(compose.services.redis.command).toEqual(['redis-server', '--save', '', '--appendonly', 'no']);
    expect(compose.services.postgres.volumes).toEqual(['pgdata:/var/lib/postgresql/data']);
  });
});
