import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import {
  existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const helmDir = mkdtempSync(join(tmpdir(), 'helm-code-transfer-'));
process.env.HELM_DIR = helmDir;
const work = join(process.cwd(), `.helm-code-transfer-test-${process.pid}`);
rmSync(work, { recursive: true, force: true });

test.after(() => {
  rmSync(helmDir, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

test('code handoff encrypts, excludes common secrets, and materializes safely', async () => {
  const { codeKeyInfo, createCodeSnapshot, materializeCode, sealCodeSnapshot } =
    await import('../packages/connect/src/code-transfer.js');
  const source = join(helmDir, 'source');
  mkdirSync(join(source, 'src'), { recursive: true });
  writeFileSync(join(source, 'src', 'main.js'), 'console.log("safe")');
  writeFileSync(join(source, '.env'), 'TOKEN=should-not-move');
  writeFileSync(join(source, 'credentials.json'), '{"token":"no"}');

  const snapshot = createCodeSnapshot(source);
  assert.deepEqual(snapshot.files.map((x) => x.path), ['src/main.js']);
  assert.equal(snapshot.skipped, 2);

  const key = codeKeyInfo();
  const envelope = sealCodeSnapshot(snapshot, key.codePubkey, 'handoff-test');
  assert.equal(JSON.stringify(envelope).includes('safe'), false, 'relay payload is ciphertext');

  const result = await materializeCode(envelope, 'handoff-test', work);
  assert.equal(readFileSync(join(result.folder, 'src', 'main.js'), 'utf8'), 'console.log("safe")');
  assert.equal(result.files, 1);
  assert.equal(result.skipped, 2);
  assert.deepEqual(
    result.skippedEntries.map((e) => `${e.path}:${e.reason}`).sort(),
    ['.env:secret-name', 'credentials.json:secret-name'],
  );
});

test('tampering with an encrypted handoff is rejected', async () => {
  const { codeKeyInfo, sealCodeSnapshot, materializeCode } =
    await import('../packages/connect/src/code-transfer.js');
  const key = codeKeyInfo();
  const envelope = sealCodeSnapshot(
    honestSnapshot(),
    key.codePubkey, 'tamper-test',
  );
  envelope.data = `${envelope.data.startsWith('A') ? 'B' : 'A'}${envelope.data.slice(1)}`;
  await assert.rejects(() => materializeCode(envelope, 'tamper-test', join(work, 'tampered')), /authenticate|handoff/i);
});

test('the target proves it holds the code key, and only that key passes', async () => {
  const {
    codeKeyInfo, beginCodeKeyProof, answerCodeKeyProof, verifyCodeKeyProof,
  } = await import('../packages/connect/src/code-transfer.js');
  const key = codeKeyInfo();
  const { request, secret } = beginCodeKeyProof(key.codePubkey);
  const response = answerCodeKeyProof(request);
  assert.equal(response.codePubkey, key.codePubkey);
  assert.equal(verifyCodeKeyProof(key.codePubkey, secret, response), true);

  // A spent challenge cannot verify twice: the nonce is bound to the
  // secret it was minted with.
  assert.throws(() => verifyCodeKeyProof(key.codePubkey, secret, response), /challenge/);

  // An answer naming a different key than the pinned one is refused.
  const again = beginCodeKeyProof(key.codePubkey);
  assert.throws(
    () => verifyCodeKeyProof('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', again.secret, answerCodeKeyProof(again.request)),
    /roster pins/,
  );

  // A proof that is not the HMAC of this challenge is refused. The first
  // character is flipped - the last base64url char can differ only in
  // unused padding bits, which would decode to identical bytes.
  const third = beginCodeKeyProof(key.codePubkey);
  const forged = answerCodeKeyProof(third.request);
  forged.proof = `${forged.proof.startsWith('A') ? 'B' : 'A'}${forged.proof.slice(1)}`;
  assert.throws(() => verifyCodeKeyProof(key.codePubkey, third.secret, forged), /did not prove/);
});

const sealed = async (snapshot, handoffId) => {
  const { codeKeyInfo, sealCodeSnapshot } = await import('../packages/connect/src/code-transfer.js');
  return sealCodeSnapshot(
    { v: 1, rootName: 'x', ...snapshot },
    codeKeyInfo().codePubkey, handoffId,
  );
};

// The digest covers the whole artifact, not just the file list: same key
// order as the implementation's snapshotDigest.
const snapDigest = (s) => createHash('sha256').update(JSON.stringify({
  v: s.v, rootName: s.rootName, files: s.files,
  skipped: s.skipped, skippedEntries: s.skippedEntries, git: s.git ?? null,
})).digest('hex');

// A snapshot whose digest is honest about everything it claims.
const honestSnapshot = (fields = {}) => {
  const s = { v: 1, rootName: 'x', files: [], skipped: 0, skippedEntries: [], ...fields };
  return { ...s, digest: snapDigest(s) };
};

test('a snapshot whose digest does not match its files is refused', async () => {
  const { materializeCode } = await import('../packages/connect/src/code-transfer.js');
  const files = [{ path: 'a.txt', mode: 0o644, data: Buffer.from('x').toString('base64url') }];
  const envelope = await sealed({
    ...honestSnapshot({ files }),
    digest: snapDigest({ v: 1, rootName: 'x', files: [], skipped: 0, skippedEntries: [] }),
  }, 'digest-test');
  await assert.rejects(() => materializeCode(envelope, 'digest-test', join(work, 'digest')),
    /digest does not match/);
});

test('a snapshot carrying the same path twice is refused', async () => {
  const { materializeCode } = await import('../packages/connect/src/code-transfer.js');
  const files = [
    { path: 'a.txt', mode: 0o644, data: Buffer.from('one').toString('base64url') },
    { path: 'a.txt', mode: 0o644, data: Buffer.from('two').toString('base64url') },
  ];
  const envelope = await sealed(honestSnapshot({ files }), 'dupe-test');
  await assert.rejects(() => materializeCode(envelope, 'dupe-test', join(work, 'dupe')),
    /duplicate path/);
});

test('a rootName that is not what the sender claims is refused', async () => {
  const { materializeCode } = await import('../packages/connect/src/code-transfer.js');
  const envelope = await sealed(
    honestSnapshot({ rootName: 'has a space' }), 'rootname-test',
  );
  await assert.rejects(() => materializeCode(envelope, 'rootname-test', join(work, 'rootname')),
    /rootName/);
});

test('the digest binds the snapshot metadata, not only its files', async () => {
  const { materializeCode } = await import('../packages/connect/src/code-transfer.js');
  const files = [{ path: 'a.txt', mode: 0o644, data: Buffer.from('x').toString('base64url') }];
  const honest = honestSnapshot({
    files, skipped: 1,
    skippedEntries: [{ path: '.env', reason: 'secret-name' }],
    git: { commit: 'ab'.repeat(20), branch: 'main' },
  });
  // Each mutation keeps the digest of the snapshot it is no longer: the
  // signed request cannot swap name, manifest or provenance under it.
  const mutations = [
    { rootName: 'renamed' },
    { skipped: 0 },
    { skippedEntries: [] },
    { git: undefined },
    { git: { commit: 'cd'.repeat(20), branch: 'main' } },
    { files: [...files, { path: 'b.txt', mode: 0o644, data: files[0].data }] },
  ];
  for (const [i, change] of mutations.entries()) {
    const envelope = await sealed({ ...honest, ...change }, `meta-${i}`);
    await assert.rejects(
      () => materializeCode(envelope, `meta-${i}`, join(work, `meta-${i}`)),
      /digest does not match/,
    );
  }
});

test('a malformed manifest or provenance is refused, not trimmed', async () => {
  const { materializeCode } = await import('../packages/connect/src/code-transfer.js');
  const commit = 'ab'.repeat(20);
  // Every claim here is digested honestly - the fields themselves fail.
  const cases = [
    ['skip-count', { skipped: -1 }, /skipped/],
    ['skip-kind', { skippedEntries: [{ path: '.env', reason: 'invented' }] }, /skipped manifest/],
    ['skip-path', { skippedEntries: [{ path: 'bad\nname', reason: 'symlink' }] }, /skipped manifest/],
    ['skip-many', { skippedEntries: Array.from({ length: 201 }, () => ({ path: 'a', reason: 'symlink' })) }, /skipped manifest/],
    ['git-commit', { git: { commit: 'zzz' } }, /provenance/],
    ['git-remote', { git: { commit, remote: 'file:///tmp/x.git' } }, /provenance/],
    ['git-userinfo', { git: { commit, remote: 'https://token@github.com/o/r.git' } }, /provenance/],
    ['git-branch', { git: { commit, branch: '-D' } }, /provenance/],
  ];
  for (const [id, fields, pattern] of cases) {
    const envelope = await sealed(honestSnapshot(fields), id);
    await assert.rejects(() => materializeCode(envelope, id, join(work, id)), pattern);
  }
});

test('documented .env templates move; real secrets and sensitive dirs stay', async () => {
  const { createCodeSnapshot } = await import('../packages/connect/src/code-transfer.js');
  const source = join(helmDir, 'source-secrets');
  mkdirSync(join(source, 'src'), { recursive: true });
  writeFileSync(join(source, 'src', 'main.js'), 'safe');
  writeFileSync(join(source, '.env.example'), 'TOKEN=');
  writeFileSync(join(source, '.env.sample'), 'TOKEN=');
  writeFileSync(join(source, '.env.template'), 'TOKEN=');
  for (const [path, kind] of [
    ['.env', 'file'], ['.env.local', 'file'], ['.env.prod', 'file'],
    ['.pypirc', 'file'], ['id_rsa', 'file'], ['id_ed25519', 'file'],
    ['terraform.tfvars', 'file'], ['other.tfvars', 'file'], ['kubeconfig', 'file'],
    ['.kube/config', 'dir'], ['.docker/config.json', 'dir'],
    ['.gnupg/sec', 'dir'], ['.terraform/state', 'dir'],
  ]) {
    if (kind === 'dir') mkdirSync(join(source, path.split('/')[0]), { recursive: true });
    else writeFileSync(join(source, path), 'x');
  }
  symlinkSync('src/main.js', join(source, 'linked.js'));

  const snapshot = createCodeSnapshot(source);
  assert.deepEqual(
    snapshot.files.map((x) => x.path).sort(),
    ['.env.example', '.env.sample', '.env.template', 'src/main.js'],
  );
  const reasons = Object.fromEntries(snapshot.skippedEntries.map((e) => [e.path, e.reason]));
  assert.equal(reasons['.env'], 'secret-name');
  assert.equal(reasons['.pypirc'], 'secret-name');
  assert.equal(reasons['terraform.tfvars'], 'secret-name');
  assert.equal(reasons['kubeconfig'], 'secret-name');
  assert.equal(reasons['.kube'], 'secret-dir');
  assert.equal(reasons['.gnupg'], 'secret-dir');
  assert.equal(reasons['linked.js'], 'symlink');
  // 9 secret-named files + 4 secret dirs + 1 symlink; a skipped directory
  // counts once for itself, not per thing inside it.
  assert.equal(snapshot.skipped, 14);
  assert.equal(snapshot.skippedEntries.length, 14);
});

test('a materialized folder answers the same handoff again - and only that one', async () => {
  const { codeKeyInfo, createCodeSnapshot, sealCodeSnapshot, materializeCode } =
    await import('../packages/connect/src/code-transfer.js');
  const source = join(helmDir, 'source-marker');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'main.js'), 'x = 1');
  writeFileSync(join(source, '.env'), 'TOKEN=x');
  const snapshot = createCodeSnapshot(source);
  const key = codeKeyInfo();
  const destination = join(work, 'marker-dest');
  const envelope = sealCodeSnapshot(snapshot, key.codePubkey, 'repeat-id');

  const first = await materializeCode(envelope, 'repeat-id', destination);
  // The crash window: the folder landed but the caller never recorded the
  // receipt. The same request claims it by the marker it parked inside.
  const second = await materializeCode(envelope, 'repeat-id', destination);
  assert.deepEqual(second, first);
  const marker = JSON.parse(readFileSync(join(second.folder, '.helm', 'handoff.json'), 'utf8'));
  assert.equal(marker.handoffId, 'repeat-id');
  assert.equal(marker.folder, second.folder);
  assert.equal(marker.digest, snapshot.digest);
  assert.equal(lstatSync(join(second.folder, '.helm', 'handoff.json')).mode & 0o777, 0o600);

  // The same folder under a different handoff id, or different contents
  // under the same id, is a takeover the folder refuses.
  const otherId = sealCodeSnapshot(snapshot, key.codePubkey, 'other-id-1');
  await assert.rejects(() => materializeCode(otherId, 'other-id-1', destination), /already exists/);
  const changed = sealCodeSnapshot(
    createCodeSnapshot(join(helmDir, 'source')), key.codePubkey, 'repeat-id');
  await assert.rejects(() => materializeCode(changed, 'repeat-id', destination), /already exists/);
});

test('the skipped manifest is bounded while the count stays complete', async () => {
  const { createCodeSnapshot } = await import('../packages/connect/src/code-transfer.js');
  const source = join(helmDir, 'source-many-secrets');
  mkdirSync(source, { recursive: true });
  for (let i = 0; i < 210; i++) writeFileSync(join(source, `k${i}.key`), 'x');
  const snapshot = createCodeSnapshot(source);
  assert.equal(snapshot.skipped, 210);
  assert.equal(snapshot.skippedEntries.length, 200);
});

test('a handoff digest signs, verifies, and refuses what it did not sign', async () => {
  const { codeSigningInfo, signHandoffDigest, verifyHandoffSignature } =
    await import('../packages/connect/src/code-transfer.js');
  const digest = 'ab'.repeat(32);
  const sig = signHandoffDigest(digest);
  const { codeSignPubkey } = codeSigningInfo();
  assert.equal(verifyHandoffSignature(codeSignPubkey, digest, sig), true);
  // A different digest is not the request that was signed.
  assert.equal(verifyHandoffSignature(codeSignPubkey, 'cd'.repeat(32), sig), false);
  // Nor is a different machine's key the pinned one.
  const other = generateKeyPairSync('ed25519');
  const otherPub = other.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  assert.equal(verifyHandoffSignature(otherPub, digest, sig), false);
  // A flipped byte is not the signature. First char: the last base64url
  // char can differ only in unused padding bits.
  const forged = `${sig.startsWith('A') ? 'B' : 'A'}${sig.slice(1)}`;
  assert.equal(verifyHandoffSignature(codeSignPubkey, digest, forged), false);
  // Malformed input is 'not a signature', never an exception.
  for (const bad of [null, undefined, 42, '', '!!!not-base64!!!']) {
    assert.equal(verifyHandoffSignature(codeSignPubkey, digest, bad), false);
  }
  assert.equal(verifyHandoffSignature('bad-key', digest, sig), false);
  assert.equal(verifyHandoffSignature(codeSignPubkey, 'nothex', sig), false);
  // The key files are real and private.
  assert.equal(lstatSync(join(helmDir, 'code_ed25519')).mode & 0o777, 0o600);
});

test('a sealed envelope carries its compression, and only brotli opens', async () => {
  const { codeKeyInfo, createCodeSnapshot, sealCodeSnapshot, materializeCode } =
    await import('../packages/connect/src/code-transfer.js');
  const source = join(helmDir, 'source-zip');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'a.txt'), 'packed tight');
  const envelope = sealCodeSnapshot(createCodeSnapshot(source), codeKeyInfo().codePubkey, 'zip-test');
  assert.equal(envelope.zip, 'br');
  const out = await materializeCode(envelope, 'zip-test', join(work, 'zip-dest'));
  assert.equal(readFileSync(join(out.folder, 'a.txt'), 'utf8'), 'packed tight');
  // A pre-compression envelope, or one naming a packer we do not speak, is
  // not ours to open.
  await assert.rejects(
    materializeCode({ ...envelope, zip: undefined }, 'zip-test', join(work, 'zip-2')),
    /unsupported/,
  );
  await assert.rejects(
    materializeCode({ ...envelope, zip: 'gz' }, 'zip-test', join(work, 'zip-3')),
    /unsupported/,
  );
});

test('materializing a big workspace lets the event loop breathe', async () => {
  const { codeKeyInfo, sealCodeSnapshot, materializeCode } =
    await import('../packages/connect/src/code-transfer.js');
  const files = [];
  for (let i = 0; i < 600; i += 1) {
    files.push({
      path: `pkg${i % 24}/f${i}.js`,
      mode: i % 17 === 0 ? 0o755 : 0o644,
      data: Buffer.from(`// file ${i}\n`).toString('base64url'),
    });
  }
  const snapshot = honestSnapshot({ rootName: 'many', files });
  const envelope = sealCodeSnapshot(snapshot, codeKeyInfo().codePubkey, 'many-test');
  let timerFired = false;
  setTimeout(() => { timerFired = true; }, 0).unref();
  const out = await materializeCode(envelope, 'many-test', join(work, 'many-dest'));
  // A zero-delay timer can only fire while the materializer was awaiting
  // I/O - synchronous work would have finished first.
  assert.equal(timerFired, true, 'a zero-delay timer fired mid-materialization');
  assert.equal(out.files, 600);
  assert.equal(readFileSync(join(out.folder, 'pkg3', 'f123.js'), 'utf8'), '// file 123\n');
});

const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], {
  stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8',
}).trim();

test('a worktree root carries its provenance; unsafe remotes stay home', async () => {
  const { createCodeSnapshot } = await import('../packages/connect/src/code-transfer.js');
  const repo = join(work, 'git-src');
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 't@example.com']);
  git(repo, ['config', 'user.name', 'test']);
  writeFileSync(join(repo, 'a.js'), 'x = 1');
  git(repo, ['add', 'a.js']);
  git(repo, ['commit', '-m', 'init']);
  git(repo, ['remote', 'add', 'origin', 'git@github.com:owner/repo.git']);

  const snapshot = createCodeSnapshot(repo);
  assert.match(snapshot.git.commit, /^[a-f0-9]{40}$/);
  assert.equal(snapshot.git.branch, 'main');
  assert.equal(snapshot.git.remote, 'git@github.com:owner/repo.git');
  // The code still travels; the .git directory does not.
  assert.ok(snapshot.files.some((f) => f.path === 'a.js'));
  assert.ok(!snapshot.files.some((f) => f.path.startsWith('.git')));

  // A credential embedded in the URL - with or without a password - a
  // file: URL, a bare local path and a URL carrying query debris are none
  // of them fetchable remotes for the target.
  for (const remote of [
    'https://user:pass@github.com/o/r.git',
    'https://token@github.com/o/r.git',
    'ssh://git:secret@github.com/o/r.git',
    'file:///tmp/some-repo.git',
    '/tmp/some-repo.git',
    'git://github.com/o/r.git?x=1',
  ]) {
    git(repo, ['remote', 'set-url', 'origin', remote]);
    assert.equal(createCodeSnapshot(repo).git.remote, undefined, `dropped ${remote}`);
  }

  // An ssh URL may still name a user, and an SCP address travels as-is.
  for (const remote of ['ssh://git@github.com/o/r.git', 'git@github.com:o/r.git']) {
    git(repo, ['remote', 'set-url', 'origin', remote]);
    assert.equal(createCodeSnapshot(repo).git.remote, remote, `kept ${remote}`);
  }

  // A folder inside a repo is not the worktree root and claims nothing.
  const sub = join(repo, 'sub');
  mkdirSync(sub);
  writeFileSync(join(sub, 'b.js'), 'y');
  assert.equal(createCodeSnapshot(sub).git, undefined);
});

test('restoreGitMetadata runs the documented sequence for a remote', async () => {
  const { restoreGitMetadata } = await import('../packages/connect/src/code-transfer.js');
  const folder = join(work, 'restore-calls');
  mkdirSync(folder, { recursive: true });
  const calls = [];
  const exec = async (cmd, args) => { calls.push(`${cmd} ${args.join(' ')}`); return { stdout: '' }; };
  const commit = 'ab'.repeat(20);
  const r = await restoreGitMetadata(
    folder, { commit, branch: 'main', remote: 'git@github.com:o/r.git' }, { exec },
  );
  assert.equal(r.restored, true);
  assert.equal(r.fetched, true);
  assert.equal(r.commit, commit);
  assert.equal(r.branch, 'main');
  assert.deepEqual(calls, [
    `git -C ${folder} init`,
    `git -C ${folder} remote add origin git@github.com:o/r.git`,
    `git -C ${folder} fetch --depth=1 origin ${commit}`,
    `git -C ${folder} reset --mixed FETCH_HEAD`,
    `git -C ${folder} branch -M main`,
  ]);
});

test('a snapshot with no remote still becomes a repository', async () => {
  const { restoreGitMetadata } = await import('../packages/connect/src/code-transfer.js');
  const folder = join(work, 'restore-local');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'a.js'), 'x');
  const commit = 'cd'.repeat(20);
  const r = await restoreGitMetadata(folder, { commit, branch: 'work' });
  assert.equal(r.restored, true);
  assert.equal(r.fetched, false, 'no history is fabricated without a remote');
  assert.equal(r.commit, commit);
  assert.equal(r.branch, 'work');
  assert.equal(existsSync(join(folder, '.git')), true);
  // The workspace file is untouched.
  assert.equal(readFileSync(join(folder, 'a.js'), 'utf8'), 'x');
});

test('a failed restore removes only .git and reports, never throws', async () => {
  const { restoreGitMetadata } = await import('../packages/connect/src/code-transfer.js');
  const folder = join(work, 'restore-fail');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'keep.js'), 'precious');
  const exec = async (cmd, args) => {
    if (args.includes('init')) mkdirSync(join(folder, '.git'), { recursive: true });
    throw new Error('the remote exploded');
  };
  const r = await restoreGitMetadata(folder, { commit: 'ef'.repeat(20), remote: 'git@x:o/r.git' }, { exec });
  assert.equal(r.restored, false);
  assert.match(r.error, /the remote exploded/);
  assert.equal(existsSync(join(folder, '.git')), false, 'the half-made repo is gone');
  assert.equal(readFileSync(join(folder, 'keep.js'), 'utf8'), 'precious', 'workspace files stay');
  // Nothing to restore for missing or malformed provenance.
  assert.deepEqual(await restoreGitMetadata(folder, null), { restored: false });
  assert.deepEqual(await restoreGitMetadata(folder, { commit: 'zzz' }), { restored: false });
});

test('includeEnv carries every .env variant marked secret and writes them 0600', async () => {
  const { codeKeyInfo, createCodeSnapshot, sealCodeSnapshot, materializeCode } =
    await import('../packages/connect/src/code-transfer.js');
  const source = join(helmDir, 'source-env');
  mkdirSync(join(source, 'api'), { recursive: true });
  mkdirSync(join(source, '.docker'), { recursive: true });
  writeFileSync(join(source, '.env'), 'ROOT=1');
  writeFileSync(join(source, '.env.local'), 'LOCAL=1');
  writeFileSync(join(source, 'api', '.env.production'), 'PROD=1');
  writeFileSync(join(source, 'api', '.env.example'), 'EXAMPLE=');
  writeFileSync(join(source, 'api', 'index.js'), 'x = 1');
  writeFileSync(join(source, '.docker', '.env.runtime'), 'RUNTIME=1');
  writeFileSync(join(source, '.docker', 'config.json'), '{}');

  const snapshot = createCodeSnapshot(source, { includeEnv: true });
  assert.deepEqual(snapshot.files.map((x) => x.path).sort(), [
    '.docker/.env.runtime', '.env', '.env.local',
    'api/.env.example', 'api/.env.production', 'api/index.js',
  ]);
  for (const f of snapshot.files) {
    assert.equal(f.secret, f.path === 'api/index.js' ? undefined : true, f.path);
  }
  assert.deepEqual(
    snapshot.skippedEntries.filter((e) => e.path === '.docker'),
    [{ path: '.docker', reason: 'secret-dir' }],
  );
  assert.deepEqual(
    createCodeSnapshot(source).files.map((x) => x.path),
    ['api/.env.example', 'api/index.js'],
  );

  const key = codeKeyInfo();
  const destination = join(work, 'env-dest');
  const envelope = sealCodeSnapshot(snapshot, key.codePubkey, 'env-move');
  const result = await materializeCode(envelope, 'env-move', destination, { privateKey: key.privateKey });
  assert.equal(result.files, 6);
  assert.equal(readFileSync(join(result.folder, '.env'), 'utf8'), 'ROOT=1');
  assert.equal(readFileSync(join(result.folder, '.docker', '.env.runtime'), 'utf8'), 'RUNTIME=1');
  assert.equal(existsSync(join(result.folder, '.docker', 'config.json')), false);
  for (const p of ['.env', '.env.local', '.docker/.env.runtime', 'api/.env.production', 'api/.env.example']) {
    assert.equal(lstatSync(join(result.folder, p)).mode & 0o777, 0o600, `${p} is owner-only`);
  }
  assert.equal(lstatSync(join(result.folder, 'api', 'index.js')).mode & 0o777, 0o644);
});

test('a secret marker that is not exactly true refuses the file', async () => {
  const { materializeCode } = await import('../packages/connect/src/code-transfer.js');
  for (const [i, secret] of [false, 'yes', 1].entries()) {
    const files = [{
      path: 'a.txt', mode: 0o644, data: Buffer.from('x').toString('base64url'), secret,
    }];
    const envelope = await sealed(honestSnapshot({ files }), `secret-${i}`);
    await assert.rejects(
      () => materializeCode(envelope, `secret-${i}`, join(work, `secret-${i}`)),
      /invalid secret flag/,
    );
  }
});
