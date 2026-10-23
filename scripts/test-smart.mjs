#!/usr/bin/env node
// Runs only the tests that can see the files you changed.
//
//   node scripts/test-smart.mjs            uncommitted edits, plus this branch's commits
//                                          when run in a worktree branch off main
//   node scripts/test-smart.mjs --list     show the picked tests and why, run nothing
//   node scripts/test-smart.mjs --near     only tests that use a changed file directly:
//                                          a fast loop while you work, not the final check
//   node scripts/test-smart.mjs --base <ref>   also count commits since <ref> (e.g. HEAD~2)
//   node scripts/test-smart.mjs <file...>  pretend these files changed
//
// A test "sees" a file when the file is reachable from the test through
// imports, dynamic imports, esbuild stdin bundles or path strings (spawned
// bins, workers). Changes to shared setup (package.json, lockfile, test
// helpers with no clear owner) run everything. Docs-only changes run nothing.
// The run is niced so the machine stays usable while it works.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const isFile = (f) => { try { return statSync(f).isFile() } catch { return false } };

export function selectTests(options = {}) {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const args = options.args ?? process.argv.slice(2);
  const near = args.includes('--near');
  const baseAt = args.indexOf('--base');
  const base = baseAt >= 0 ? args[baseAt + 1] : null;
  const named = args.filter((a, i) => !a.startsWith('--') && !(baseAt >= 0 && i === baseAt + 1));

  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
  const rel = (f) => path.relative(root, f).split(path.sep).join('/');

  // Shared setup: a change here can break any test, so run them all.
  const EVERYTHING = [/^package(-lock)?\.json$/, /^(packages|apps)\/[^/]+\/package\.json$/, /^test\/helpers(\.mjs|\/)/, /^test\/(hub|fake-agent|fake-cli)\.mjs$/, /^tsconfig/];
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
    const add = (s) => s.split('\n').filter(Boolean).forEach((f) => out.add(f));
    if (from) add(git('diff', '--name-only', from, 'HEAD'));
    add(git('diff', '--name-only', 'HEAD'));
    add(git('ls-files', '--others', '--exclude-standard'));
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
    const looksRooted = /^(\.\/)?(apps|packages|test|scripts)\//.test(spec);
    const tries = [];
    if (local) tries.push(path.resolve(fromDir, spec));
    if (looksRooted) tries.push(path.resolve(root, spec));
    for (const t of tries) {
      const f = tryFile(t);
      if (f && f.startsWith(root + path.sep) && !f.includes(`${path.sep}node_modules${path.sep}`)) return f;
    }
    return null;
  }

  const SOURCE = /\.(m?js|jsx|ts|tsx|css)$/;
  const STRINGS = /(['"`])((?:\.{1,2}\/|@helm\/|(?:apps|packages|test|scripts)\/)[^'"`\s${}]*)\1/g;
  const deps = new Map();
  function depsOf(file) {
    if (deps.has(file)) return deps.get(file);
    const out = new Set();
    deps.set(file, out);
    if (!SOURCE.test(file) || file.endsWith('.css')) return out;
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(STRINGS)) {
      const f = resolve(m[2], path.dirname(file));
      if (f && f !== file) out.add(f);
    }
    return out;
  }

  function reach(start) {
    const seen = new Set([start]);
    const stack = [start];
    while (stack.length) for (const d of depsOf(stack.pop())) if (!seen.has(d)) { seen.add(d); stack.push(d) }
    return seen;
  }

  const testFiles = [
    ...readdirSync(path.join(root, 'test')).filter((f) => f.endsWith('.test.mjs')).map((f) => `test/${f}`),
    ...readdirSync(path.join(root, 'test/browser')).filter((f) => f.endsWith('.test.mjs')).map((f) => `test/browser/${f}`),
  ];

  const changed = (options.changed ?? changedFiles()).filter((f) => !IGNORED.some((r) => r.test(f)));
  const all = changed.some((f) => EVERYTHING.some((r) => r.test(f)));
  const picked = new Map();
  // network.sh drives two real hubs through the daemon, protocol and relay.
  let network = false;

  if (!all) {
    const wanted = new Set(changed.map((f) => path.join(root, f)));
    for (const t of testFiles) {
      if (wanted.has(path.join(root, t))) { picked.set(t, ['the test itself']); continue }
      const hits = [...(near ? depsOf(path.join(root, t)) : reach(path.join(root, t)))].filter((f) => wanted.has(f)).map(rel);
      if (hits.length) picked.set(t, hits);
    }
    network = !near && changed.some((f) => f === 'test/network.sh' || /^(packages\/(connect|protocol)|apps\/relay)\/(src|bin|index|[^/]+\.js$)/.test(f));
  }

  const tests = all ? testFiles : [...picked.keys()];
  const browser = tests.filter((t) => t.startsWith('test/browser/')).length;
  return { root, changed, all, tests, network, testFiles, picked, browser };
}

async function main() {
    const options = { args: process.argv.slice(2) };
    const { root, changed, all, tests, network, testFiles, picked, browser } = selectTests(options);
    const args = options.args;
    const listOnly = args.includes('--list');
    console.log(changed.length ? `Changed: ${changed.join(', ')}` : 'No code changes found.');
    if (all) console.log('Shared setup changed: running every test.');
    else for (const [t, why] of picked) console.log(`  ${t}  <- ${why.slice(0, 3).join(', ')}${why.length > 3 ? ` +${why.length - 3}` : ''}`);
    console.log(`${tests.length} of ${testFiles.length} test files (${browser} browser)${network ? ' + network.sh' : ''}.`);
    if (listOnly || (!tests.length && !network)) return;

  // Browser tests need Playwright's Chromium; fall back to the system one when it is missing.
  const env = { ...process.env };
  if (browser && !env.HELM_TEST_CHROMIUM) {
    const { chromium } = await import('@playwright/test').catch(() => ({}));
    const own = chromium?.executablePath?.();
    const system = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(isFile);
    if ((!own || !isFile(own)) && system) env.HELM_TEST_CHROMIUM = system;
  }

  const run = (cmd, cmdArgs) => new Promise((done) => {
    const nice = process.platform !== 'win32' && isFile('/usr/bin/nice') ? ['/usr/bin/nice', ['-n', '10', cmd, ...cmdArgs]] : [cmd, cmdArgs];
    spawn(nice[0], nice[1], { cwd: root, env, stdio: 'inherit' }).on('exit', (code) => done(code ?? 1));
  });
  let code = tests.length ? await run(process.execPath, ['--test', '--test-concurrency=2', ...tests]) : 0;
  if (!code && network) code = await run('bash', ['test/network.sh']);
  process.exit(code);

}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
