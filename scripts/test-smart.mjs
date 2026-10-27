#!/usr/bin/env node
// Checks what you changed, and only that.
//
//   npm run check                        type-check the web app when web code changed, then run
//                                        the tests that belong to the changed files
//   npm run test:smart                   the same tests, no type-check
//   npm run test:smart -- --list         show the picks, the gaps and the wider commands; run nothing
//   npm run test:smart -- test/a.test.mjs ...   run exactly these test files, always
//   npm run test:smart -- <source...>    pretend these files changed
//   npm run test:smart -- --near         also run tests that import a changed file directly
//   npm run test:smart -- --wide         also run every test that reaches a changed file (slow)
//   npm run test:smart -- --base <ref>   also count commits since <ref> (e.g. HEAD~2)
//   npm run test:smart -- --fresh        run again even when a pass is saved
//
// Changed files are uncommitted edits, plus this branch's commits when run in
// a worktree branch off main.
//
// A test belongs to a source file by name, the way T3 Code keeps foo.test.ts
// beside foo.ts: Usage.tsx -> test/browser/usage.test.mjs, drivers/claude.js ->
// test/driver-claude.test.mjs. A longer name such as discover-wrapper also
// belongs to discover.js when it imports it, unless a discover-wrapper source
// file exists. Import graphs do not pick tests: one pricing file reached 141
// test files, and a three-file usage fix ran 1,263 tests for 8.5 minutes.
// Changed files with no test of their own are listed with the wider commands,
// never run silently.
//
// A pass is saved per test file in node_modules/.cache/helm-check. Any change
// to the working tree, installed packages, Node or the test settings drops it.
// Failures and skipped tests are never saved. The run is niced so the machine
// stays usable.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runFolder, sweep, sweepCrashed } from './test-cleanup.mjs';

const isFile = (f) => { try { return statSync(f).isFile() } catch { return false } };
const kebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2').toLowerCase();
const CODE = /\.(m?js|jsx|ts|tsx)$/;
const TEST = /^test\/(browser\/)?[^/]+\.test\.mjs$/;
// Folders that say nothing about what a file does.
const PLAIN_DIRS = new Set(['src', 'bin', 'lib', 'scripts', 'test', 'apps', 'packages']);

/** The test names a source file owns: Usage.tsx -> usage, drivers/claude.js -> claude and driver-claude. */
export function testNames(file) {
  const parts = file.split('/');
  const dir = parts.at(-2);
  let base = parts.at(-1).replace(/\.[^.]+$/, '');
  if (base === 'index') return dir === 'src' ? [kebab(parts.at(-3) ?? base)] : [kebab(dir ?? base)];
  const names = [kebab(base)];
  if (dir && !PLAIN_DIRS.has(dir)) names.push(`${kebab(dir).replace(/s$/, '')}-${kebab(base)}`);
  return names;
}

export function selectTests(options = {}) {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const args = options.args ?? process.argv.slice(2);
  const near = args.includes('--near');
  const wide = args.includes('--wide');
  const baseAt = args.indexOf('--base');
  const base = baseAt >= 0 ? args[baseAt + 1] : null;
  const named = args.filter((a, i) => !a.startsWith('--') && !(baseAt >= 0 && i === baseAt + 1));

  const git = (...a) => execFileSync('git', ['-c', 'core.quotePath=false', ...a], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 }).trim();
  const lines = (s) => s.split('\n').filter(Boolean);
  const rel = (f) => path.relative(root, f).split(path.sep).join('/');

  // Shared setup: a change here can break many tests, so no name owns it.
  const SHARED = [/^package(-lock)?\.json$/, /^(packages|apps)\/[^/]+\/package\.json$/, /^test\/helpers(\.mjs|\/)/, /^test\/(hub|fake-agent|fake-cli|automation-env)\.mjs$/, /^test\/fixtures\//, /^tsconfig/];
  // Never affects a test result.
  const IGNORED = [/\.md$/, /^docs\//, /^\.claude\//, /\.(png|jpe?g|svg|gif)$/];

  function changedFiles() {
    if (named.length) return named.map((f) => rel(path.resolve(f)));
    // Local main is the truth here (machines sync from each other, not GitHub),
    // and other agents commit on it too, so on main only uncommitted edits count.
    let from = base;
    if (!from && git('branch', '--show-current') !== 'main') {
      try { from = git('merge-base', 'HEAD', 'main') } catch {}
    }
    const out = new Set();
    if (from) lines(git('diff', '--name-only', '--no-renames', from, 'HEAD')).forEach((f) => out.add(f));
    lines(git('diff', '--name-only', '--no-renames', 'HEAD')).forEach((f) => out.add(f));
    lines(git('ls-files', '--others', '--exclude-standard')).forEach((f) => out.add(f));
    return [...out];
  }

  // Workspace packages, so '@helm/protocol/network' resolves to a file.
  const packages = new Map();
  for (const dir of ['packages', 'apps']) {
    for (const name of readdirSync(path.join(root, dir))) {
      const file = path.join(root, dir, name, 'package.json');
      if (!existsSync(file)) continue;
      const pkg = JSON.parse(readFileSync(file, 'utf8'));
      packages.set(pkg.name, { dir: path.join(root, dir, name), pkg });
    }
  }

  const EXTS = ['', '.ts', '.tsx', '.js', '.mjs', '.jsx', '/index.ts', '/index.tsx', '/index.js'];
  function tryFile(f) {
    for (const ext of EXTS) if (isFile(f + ext)) return f + ext;
    // TypeScript style: './x.js' written for x.ts.
    if (/\.js$/.test(f)) for (const ext of ['.ts', '.tsx']) if (isFile(f.slice(0, -3) + ext)) return f.slice(0, -3) + ext;
    return null;
  }

  function resolve(spec, fromDir) {
    if (spec.startsWith('node:') || spec.includes('\n') || spec.length > 200) return null;
    if (spec.startsWith('@helm/')) {
      const [scope, name, ...rest] = spec.split('/');
      const p = packages.get(`${scope}/${name}`);
      if (!p) return null;
      const sub = rest.length ? `./${rest.join('/')}` : '.';
      const target = typeof p.pkg.exports === 'object' ? p.pkg.exports[sub] : sub === '.' ? p.pkg.main : null;
      return target ? tryFile(path.join(p.dir, target)) : tryFile(path.join(p.dir, sub));
    }
    const local = spec.startsWith('./') || spec.startsWith('../');
    // Tests also name files from the repo root ('apps/web/src/App', resolveDir: cwd).
    const looksRooted = /^(\.\/)?(apps|packages|test|scripts|native)\//.test(spec);
    const tries = [];
    if (local) tries.push(path.resolve(fromDir, spec));
    if (looksRooted) tries.push(path.resolve(root, spec));
    for (const t of tries) {
      const f = tryFile(t);
      if (f && f.startsWith(root + path.sep) && !f.includes(`${path.sep}node_modules${path.sep}`)) return f;
    }
    return null;
  }

  // Files a file imports or names by path (spawned bins, workers, esbuild entries).
  const STRINGS = /(['"`])((?:\.{1,2}\/|@helm\/|(?:apps|packages|test|scripts|native)\/)[^'"`\s${}]*)\1/g;
  const deps = new Map();
  function depsOf(file) {
    if (deps.has(file)) return deps.get(file);
    const out = new Set();
    deps.set(file, out);
    if (!CODE.test(file) || !isFile(file)) return out;
    for (const m of readFileSync(file, 'utf8').matchAll(STRINGS)) {
      const f = resolve(m[2], path.dirname(file));
      if (f && f !== file) out.add(f);
    }
    return out;
  }
  const reached = new Map();
  function reach(start) {
    if (reached.has(start)) return reached.get(start);
    const seen = new Set([start]);
    const stack = [start];
    while (stack.length) for (const d of depsOf(stack.pop())) if (!seen.has(d)) { seen.add(d); stack.push(d) }
    reached.set(start, seen);
    return seen;
  }

  const testFiles = [
    ...readdirSync(path.join(root, 'test')).filter((f) => f.endsWith('.test.mjs')).map((f) => `test/${f}`),
    ...readdirSync(path.join(root, 'test/browser')).filter((f) => f.endsWith('.test.mjs')).map((f) => `test/browser/${f}`),
  ];
  const testName = (t) => path.basename(t, '.test.mjs');

  const changed = (options.changed ?? changedFiles()).filter((f) => !IGNORED.some((r) => r.test(f)));
  // Rust is loaded through a computed binary name, outside the JS import graph.
  if (changed.some((f) => f.startsWith('native/log-index/')) && !changed.includes('packages/connect/src/log-index-native.js')) {
    changed.push('packages/connect/src/log-index-native.js');
  }

  // Every source name in the repo, so a longer name keeps its own tests.
  const sourceNames = new Set();
  for (const f of lines(git('ls-files', '--cached', '--others', '--exclude-standard', 'apps', 'packages', 'scripts'))) {
    if (CODE.test(f) && !f.includes('/node_modules/')) testNames(f).forEach((n) => sourceNames.add(n));
  }
  const owners = (t) => {
    const name = testName(t);
    return [...sourceNames].filter((n) => name === n || name.startsWith(`${n}-`)).sort((a, b) => b.length - a.length);
  };

  const picked = new Map();
  const pick = (t, why) => { if (!picked.has(t)) picked.set(t, []); picked.get(t).push(why) };
  const explicit = [];
  const shared = [];
  const gaps = [];
  for (const f of changed) {
    if (TEST.test(f)) {
      if (!isFile(path.join(root, f))) continue;
      if (named.length) explicit.push(f);
      pick(f, named.length ? 'named' : 'the test itself');
      continue;
    }
    if (SHARED.some((r) => r.test(f))) { shared.push(f); continue }
    let found = false;
    if (CODE.test(f) && !f.startsWith('test/')) {
      const abs = path.join(root, f);
      const names = testNames(f);
      for (const t of testFiles) {
        const name = testName(t);
        // The same name in the other layer (web Usage.tsx, server usage.js) is not enough.
        if (names.includes(name)) {
          if (reach(path.join(root, t)).has(abs)) { pick(t, `${f} (same name)`); found = true }
          continue;
        }
        // A longer test name belongs to the longest source name it starts with,
        // and only when the test imports the file itself.
        const owner = owners(t)[0];
        if (owner && names.includes(owner) && depsOf(path.join(root, t)).has(abs)) { pick(t, `${f} (name and import)`); found = true }
      }
    }
    if (!found) gaps.push(f);
  }

  // The wider picks the owner asks for by name.
  const wider = (mode) => {
    const out = new Map();
    const wanted = new Set(changed.filter((f) => !TEST.test(f)).map((f) => path.join(root, f)));
    if (!wanted.size) return out;
    for (const t of testFiles) {
      const set = mode === 'near' ? depsOf(path.join(root, t)) : reach(path.join(root, t));
      const hits = [...set].filter((f) => wanted.has(f)).map(rel);
      if (hits.length) out.set(t, hits);
    }
    return out;
  };
  const nearPicks = wider('near');
  // A picked test that imports a file with no test of its own covers it too.
  for (const f of [...gaps]) {
    const by = [...picked.keys()].filter((t) => nearPicks.get(t)?.includes(f));
    if (by.length) { gaps.splice(gaps.indexOf(f), 1); by.forEach((t) => pick(t, `${f} (imports)`)) }
  }
  if (near || wide) for (const [t, hits] of wide ? wider('wide') : nearPicks) for (const h of hits) pick(t, `${h} (${wide ? 'reaches' : 'imports'})`);
  // How many tests import each gap file directly, so the owner can choose.
  const gapImporters = new Map(gaps.map((f) => [f, [...nearPicks].filter(([, hits]) => hits.includes(f)).map(([t]) => t)]));

  // network.sh drives two real hubs through the daemon, protocol and relay.
  const network = changed.some((f) => f === 'test/network.sh' || /^(packages\/(connect|protocol)|apps\/relay)\/(src|bin|index|[^/]+\.js$)/.test(f));

  // tsc checks every file under apps/web/src and what it imports.
  const webFiles = lines(git('ls-files', '--cached', '--others', '--exclude-standard', 'apps/web/src')).filter((f) => CODE.test(f));
  const webReach = new Set();
  for (const f of webFiles) for (const d of reach(path.join(root, f))) webReach.add(rel(d));
  const types = changed.some((f) => f.startsWith('apps/web/') || webReach.has(f) || /^package(-lock)?\.json$/.test(f) || f === 'apps/web/package.json');

  const tests = [...picked.keys()];
  const browser = tests.filter((t) => t.startsWith('test/browser/')).length;
  return { root, changed, tests, explicit, picked, gaps, gapImporters, shared, network, types, testFiles, browser, reach, git, lines };
}

/**
 * One key per test. The import scan can miss computed paths and folder reads,
 * so, like T3 Code, the key covers the whole working tree, not what the test
 * seems to use. It also covers installed packages, the built Rust reader,
 * Node, the runner settings and HELM_TEST_* variables.
 */
export function passKeys({ root, tests, git, lines }, settings) {
  const hash = createHash('sha256');
  hash.update(`v1\0${process.version}\0${process.platform}\0${process.arch}\0${settings}\0`);
  // Tracked files keep their index blob id. Edited and new files get the blob id
  // of their content, so a commit of the same content keeps the key.
  const blobs = new Map();
  for (const line of lines(git('ls-files', '-s'))) {
    const [meta, file] = line.split('\t');
    blobs.set(file, meta.split(' ')[1]);
  }
  const dirty = new Set([...lines(git('diff', '--name-only', '--no-renames', 'HEAD')), ...lines(git('ls-files', '--others', '--exclude-standard'))]);
  const blobOf = (file) => {
    let bytes;
    try { bytes = readFileSync(path.join(root, file)) } catch { return 'missing' }
    return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  };
  for (const file of [...new Set([...blobs.keys(), ...dirty])].sort()) {
    hash.update(`${file}\0${dirty.has(file) || !blobs.has(file) ? blobOf(file) : blobs.get(file)}\0`);
  }
  // Ignored files tests use: installed packages, the built Rust reader and .env files.
  for (const file of ['node_modules/.package-lock.json', ...lines(git('ls-files', '--others', '--ignored', '--exclude-standard', '--', 'native/log-index/*.node', ':(glob)**/.env*', ':(exclude,glob)**/node_modules/**'))].sort()) {
    hash.update(`${file}\0${blobOf(file)}\0`);
  }
  for (const [k, v] of Object.entries(process.env).filter(([k]) => k.startsWith('HELM_TEST_') || k === 'CI').sort()) hash.update(`${k}=${v}\0`);
  const tree = hash.digest('hex');
  return new Map(tests.map((t) => [t, createHash('sha256').update(`${tree}\0${t}`).digest('hex')]));
}

async function main() {
  const args = process.argv.slice(2);
  const sel = selectTests({ args });
  const { root, changed, tests, explicit, picked, gaps, gapImporters, shared, network, types, testFiles, browser } = sel;
  const listOnly = args.includes('--list');
  const fresh = args.includes('--fresh');
  const withTypes = args.includes('--types');

  console.log(changed.length ? `Changed: ${changed.join(', ')}` : 'No code changes found.');
  for (const [t, why] of picked) console.log(`  ${t}  <- ${why.slice(0, 3).join(', ')}${why.length > 3 ? ` +${why.length - 3}` : ''}`);
  console.log(`${tests.length} of ${testFiles.length} test files (${browser} browser).`);
  const notes = [];
  for (const f of gaps) {
    const importers = gapImporters.get(f) ?? [];
    const hint = !importers.length ? '' : importers.length <= 6 ? ` (imported by ${importers.join(' ')})` : ` (${importers.length} tests import it: --near)`;
    notes.push(`  no test of its own: ${f}${hint}`);
  }
  for (const f of shared) notes.push(`  shared test setup: ${f}`);
  if (notes.length) {
    console.log('Not covered by a test named after the file:');
    for (const n of notes) console.log(n);
    console.log('  Name the tests to run (docs/features lists tests per feature), or add --near or --wide.');
  }

  // Browser tests need Playwright's Chromium; fall back to the system one when it is missing.
  const env = { ...process.env };
  // Started from inside a node --test run, the runner would report to that
  // parent and skip our reporters.
  delete env.NODE_TEST_CONTEXT;
  if (browser && !env.HELM_TEST_CHROMIUM) {
    const { chromium } = await import('@playwright/test').catch(() => ({}));
    const own = chromium?.executablePath?.();
    const system = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(isFile);
    if ((!own || !isFile(own)) && system) env.HELM_TEST_CHROMIUM = system;
  }

  const RUNNER = ['--test', '--test-concurrency=2'];
  const reporter = pathToFileURL(path.join(root, 'scripts/test-pass-reporter.mjs')).href;
  const settings = `${RUNNER.join(' ')}\0${env.HELM_TEST_CHROMIUM ?? ''}`;
  const cacheDir = process.env.HELM_CHECK_CACHE || path.join(root, 'node_modules/.cache/helm-check');
  const cacheFile = path.join(cacheDir, 'passes.json');
  const readCache = () => { try { return JSON.parse(readFileSync(cacheFile, 'utf8')) } catch { return {} } };
  const keys = tests.length ? passKeys(sel, settings) : new Map();
  const cache = readCache();
  // Named tests always run; others reuse a saved pass for the same key.
  const reused = fresh ? [] : tests.filter((t) => !explicit.includes(t) && cache[t] === keys.get(t));
  const toRun = tests.filter((t) => !reused.includes(t));
  if (reused.length) console.log(`Saved pass, not run again: ${reused.join(', ')}`);

  const later = ['  not run: web build and every test (npm run check:full)'];
  if (network) later.unshift('  not run: network.sh, two real hubs (npm run test:network)');
  if (listOnly) {
    if (withTypes) console.log(types ? 'Type-check: web app.' : 'Type-check: not needed.');
    console.log(later.join('\n'));
    return;
  }

  const run = (cmd, cmdArgs) => new Promise((done) => {
    const nice = process.platform !== 'win32' && isFile('/usr/bin/nice') ? ['/usr/bin/nice', ['-n', '10', cmd, ...cmdArgs]] : [cmd, cmdArgs];
    const started = performance.now();
    spawn(nice[0], nice[1], { cwd: root, env, stdio: 'inherit' }).on('exit', (code) => done({ code: code ?? 1, seconds: ((performance.now() - started) / 1000).toFixed(1) }));
  });
  const summary = ['check summary'];
  let failed = false;

  if (withTypes && types) {
    // Incremental: an unchanged web app checks in about a second.
    mkdirSync(cacheDir, { recursive: true });
    const tsc = path.join(root, 'node_modules/typescript/bin/tsc');
    const r = await run(process.execPath, [tsc, '-p', 'apps/web/tsconfig.json', '--noEmit', '--incremental', '--tsBuildInfoFile', path.join(cacheDir, 'web.tsbuildinfo')]);
    summary.push(`  ${r.code ? 'FAIL' : 'pass'}  web types  ${r.seconds}s`);
    failed ||= !!r.code;
  } else if (withTypes) summary.push('  skip  web types: no web code changed');

  if (toRun.length) {
    const report = path.join(tmpdir(), `helm-check-${process.pid}.json`);
    // Tests make their temporary files in a folder of this run's own, and
    // whatever they leave running is stopped when the run ends.
    const crashed = await sweepCrashed();
    const scratch = runFolder();
    env.TMPDIR = scratch;
    const stop = () => { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort on exit */ } };
    process.once('exit', stop);
    const r = await run(process.execPath, [...RUNNER, '--test-reporter=spec', '--test-reporter-destination=stdout', `--test-reporter=${reporter}`, `--test-reporter-destination=${report}`, ...toRun]);
    const left = [...crashed, ...await sweep(scratch)];
    process.off('exit', stop);
    if (left.length) {
      summary.push(`  stopped ${left.length} programs that tests left running:`);
      for (const { command } of left.slice(0, 10)) summary.push(`    ${command.slice(0, 160)}`);
    }
    let passed = {};
    try { passed = JSON.parse(readFileSync(report, 'utf8')) } catch {}
    rmSync(report, { force: true });
    summary.push(`  ${r.code ? 'FAIL' : 'pass'}  ${toRun.length} test files  ${r.seconds}s`);
    failed ||= !!r.code;
    // Save only files that passed, and only when nothing they use changed during the run.
    const after = passKeys(sel, settings);
    const next = readCache();
    let changedDuringRun = 0;
    for (const t of toRun) {
      if (passed[path.join(root, t)] !== true) { delete next[t]; continue }
      if (after.get(t) !== keys.get(t)) { changedDuringRun++; continue }
      next[t] = keys.get(t);
    }
    if (changedDuringRun) summary.push(`  ${changedDuringRun} passes not saved: files changed during the run`);
    try {
      mkdirSync(cacheDir, { recursive: true });
      const temp = `${cacheFile}.${process.pid}`;
      writeFileSync(temp, JSON.stringify(next));
      renameSync(temp, cacheFile);
    } catch (error) {
      summary.push(`  passes not saved: ${error.message}`);
    }
  }
  if (reused.length) summary.push(`  pass  ${reused.length} test files from a saved pass`);
  if (!tests.length) summary.push('  no test files picked');
  if (gaps.length || shared.length) summary.push(`  not covered: ${gaps.length + shared.length} changed files (see above)`);
  summary.push(...later);
  console.log(`\n${summary.join('\n')}`);
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
