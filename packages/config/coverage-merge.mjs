#!/usr/bin/env node
// Merge the coverage of real child processes (the entry points spawned by the `process` test projects) into
// vitest's own coverage, then print and write the merged report.
//
// The child processes run the built `dist/*.js` with NODE_V8_COVERAGE=<pkg>/coverage/process-v8. Their raw V8
// coverage is converted with v8-to-istanbul through the tsc source maps back to `src/*.ts`.
//
// Vitest's map stays canonical: it decides what counts as a statement (it drops blank and comment lines; plain
// v8-to-istanbul does not), so the child data is projected onto it instead of being unioned. That way the
// totals keep the same denominators as before and only gain hits.
//  - A file vitest never loaded (no statement hit; a stand-in entry) takes the child's
//    functions and branches as they are, and its statements restricted to vitest's statement lines.
//  - A file both saw gets the child's hits added per statement line, and per function and branch block
//    (the child's count for the lines inside it).
//
// Usage (from a package dir, after `vitest run --coverage... --coverage.reporter=json`):
//   node node_modules/@lomi/config/coverage-merge.mjs [--exclude src/testing.ts ...]
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mergeProcessCovs } from '@bcoe/v8-coverage';
import libCoverage from 'istanbul-lib-coverage';
import libReport from 'istanbul-lib-report';
import reports from 'istanbul-reports';
import v8ToIstanbul from 'v8-to-istanbul';

const pkgDir = process.cwd();
const reportsDir = path.join(pkgDir, 'coverage');
const v8Dir = path.join(reportsDir, 'process-v8');
const srcDir = path.join(pkgDir, 'src') + path.sep;
const distUrl = pathToFileURL(path.join(pkgDir, 'dist') + path.sep).href;
const excluded = new Set();
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--exclude') excluded.add(path.resolve(pkgDir, process.argv[++i]));
}

const finalJson = path.join(reportsDir, 'coverage-final.json');
if (!existsSync(finalJson)) {
  console.error(`[coverage-merge] ${finalJson} is missing: run vitest with --coverage.reporter=json first`);
  process.exit(1);
}
const vitestMap = libCoverage.createCoverageMap(JSON.parse(readFileSync(finalJson, 'utf8')));

// 1. Child processes → one merged V8 process coverage → istanbul, keyed by original src file. The raw V8
// dumps are merged first (as vitest and c8 do): V8 omits a block whose count equals its parent's, so merging
// after conversion would read "absent in this dump" as "never ran".
const procs = [];
for (const f of existsSync(v8Dir) ? readdirSync(v8Dir).filter((n) => n.endsWith('.json')) : []) {
  const { result = [] } = JSON.parse(readFileSync(path.join(v8Dir, f), 'utf8'));
  procs.push({ result: result.filter((s) => s.url?.startsWith(distUrl) && s.url.endsWith('.js')) });
}
const childMap = libCoverage.createCoverageMap({});
let scripts = 0;
for (const script of procs.length ? mergeProcessCovs(procs).result : []) {
  const file = fileURLToPath(script.url);
  if (!existsSync(file)) continue;
  const converter = v8ToIstanbul(file, 0);
  await converter.load();
  converter.applyCoverage(script.functions);
  for (const [src, fc] of Object.entries(converter.toIstanbul())) {
    if (src.startsWith(srcDir) && !excluded.has(src)) childMap.addFileCoverage(fc);
  }
  converter.destroy();
  scripts += 1;
}

// 2. Project the child hits onto vitest's map.
// V8 reports a block range only where the count differs from the enclosing range, and every function that
// never ran as a count-0 range, so the child's per-line counts are exact; branches and functions with no
// explicit child entry take the count of the lines inside them.
const maxByLine = (hits, map, lineOf) => {
  const out = new Map();
  for (const [k, n] of Object.entries(hits)) {
    const line = lineOf(map[k]);
    out.set(line, Math.max(out.get(line) ?? 0, Array.isArray(n) ? Math.max(...n) : n));
  }
  return out;
};
const stmtLine = (s) => s.start.line;
const fnLoc = (f) => f.loc ?? f.decl;
const brLoc = (b) => b.loc ?? b.locations[0];

const merged = libCoverage.createCoverageMap({});
let touched = 0;
for (const file of vitestMap.files()) {
  const base = vitestMap.fileCoverageFor(file).toJSON();
  if (!childMap.files().includes(file)) {
    merged.addFileCoverage(base);
    continue;
  }
  touched += 1;
  const childFc = childMap.fileCoverageFor(file);
  const child = childFc.toJSON();
  const lineHits = new Map(Object.entries(childFc.getLineCoverage()).map(([l, n]) => [Number(l), n]));
  const blockHits = (loc, explicit) => {
    let inner = -1;
    for (let l = loc.start.line + 1; l < loc.end.line; l++) if (lineHits.has(l)) inner = Math.max(inner, lineHits.get(l));
    if (inner >= 0) return inner;
    return explicit.get(loc.start.line) ?? lineHits.get(loc.start.line) ?? 0;
  };

  const out = structuredClone(base);
  for (const [k, st] of Object.entries(out.statementMap)) out.s[k] += lineHits.get(stmtLine(st)) ?? 0;

  // Never loaded in-process (no statement ran): vitest's entry is a stand-in with one whole-file
  // "(empty-report)" function and branch, so take the child's real functions and branches.
  const placeholder = Object.values(base.s).every((n) => n === 0);
  if (placeholder) {
    out.fnMap = child.fnMap;
    out.f = child.f;
    out.branchMap = child.branchMap;
    out.b = child.b;
  } else {
    const childFns = maxByLine(child.f, child.fnMap, (f) => fnLoc(f).start.line);
    for (const [k, fn] of Object.entries(out.fnMap)) out.f[k] += blockHits(fnLoc(fn), childFns);
    const childBranches = maxByLine(child.b, child.branchMap, (b) => brLoc(b).start.line);
    for (const [k, br] of Object.entries(out.branchMap)) {
      const add = blockHits(brLoc(br), childBranches);
      out.b[k] = out.b[k].map((n) => n + add);
    }
  }
  merged.addFileCoverage(out);
}

writeFileSync(finalJson, JSON.stringify(merged.toJSON()));
const context = libReport.createContext({ dir: reportsDir, coverageMap: merged, defaultSummarizer: 'nested' });
for (const r of ['text', 'json-summary']) reports.create(r).execute(context);
console.log(`[coverage-merge] ${procs.length} child process dump(s), ${scripts} dist script(s) → merged into ${touched} src file(s)`);
