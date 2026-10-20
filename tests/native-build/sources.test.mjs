import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceLock, verifySource, prepareSources } from '../../tools/native-build/prepare-sources.mjs';

const git = (directory, ...args) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' });
function fixture(dependency, run) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'usd-source-test-'));
  try {
    const patch = dependency.patch && readFileSync(new URL(`../../tools/native-build/patches/${dependency.patch}`, import.meta.url), 'utf8');
    const filename = patch ? patch.match(/^--- a\/(.+)$/m)[1] : 'source.txt';
    const sourceFile = path.join(directory, filename);
    mkdirSync(path.dirname(sourceFile), { recursive: true });
    // Reconstruct the old side of the actual checked-in patch as a tiny fixture.
    const original = patch ? patch.split('\n').filter(line => /^[ -]/.test(line) && !line.startsWith('---')).map(line => line.slice(1)).join('\n') + '\n' : 'original\n';
    writeFileSync(sourceFile, original);
    git(directory, 'init', '--quiet');
    git(directory, 'add', '.');
    git(directory, '-c', 'user.name=Source Test', '-c', 'user.email=source-test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture');
    const spec = { ...dependency, revision: git(directory, 'rev-parse', 'HEAD').trim() };
    run({ directory, spec, sourceFile, original });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const dependency of sourceLock.dependencies.filter(item => item.patch)) {
  test(`${dependency.directory}: patch application is idempotent and check-only does not apply it`, () => fixture(dependency, ({ directory, spec, sourceFile, original }) => {
    assert.throws(() => verifySource(directory, spec), /missing source patch/);
    assert.equal(readFileSync(sourceFile, 'utf8'), original);
    verifySource(directory, spec, true);
    const patched = readFileSync(sourceFile, 'utf8');
    verifySource(directory, spec, true);
    verifySource(directory, spec);
    assert.equal(readFileSync(sourceFile, 'utf8'), patched);
    writeFileSync(sourceFile, patched + '// user change\n');
    assert.throws(() => verifySource(directory, spec, true), /Unexpected or missing source patch/);
    assert.equal(readFileSync(sourceFile, 'utf8'), patched + '// user change\n');
  }));
}

test('revision mismatches, tracked edits, and untracked sources fail without resetting work', () => fixture({}, ({ directory, spec, sourceFile, original }) => {
  verifySource(directory, spec);
  assert.throws(() => verifySource(directory, { ...spec, revision: '0'.repeat(40) }, true), /Wrong revision/);
  writeFileSync(sourceFile, 'user change\n');
  assert.throws(() => verifySource(directory, spec, true), /Unexpected or missing source patch/);
  assert.equal(readFileSync(sourceFile, 'utf8'), 'user change\n');
  writeFileSync(sourceFile, original);
  writeFileSync(path.join(directory, 'untracked.txt'), 'keep me');
  assert.throws(() => verifySource(directory, spec, true), /Unexpected untracked/);
  assert.equal(readFileSync(path.join(directory, 'untracked.txt'), 'utf8'), 'keep me');
}));

test('missing sources fail in check-only mode without fetching or creating directories', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'usd-source-check-'));
  try {
    assert.throws(() => prepareSources(root, true), /Not a prepared Git checkout/);
    assert.throws(() => readFileSync(path.join(root, 'sources')), /ENOENT/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the source-build entry point rejects invalid arguments before bootstrap', () => {
  const script = fileURLToPath(new URL('../../tools/native-build/build-from-source.sh', import.meta.url));
  for (const args of [['invalid'], ['both', 'extra']]) {
    const result = spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { ...process.env, EMSDK_ROOT: '' } });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /Usage:/);
  }
});

test('a missing compiler gets an actionable error before source downloads', () => {
  const script = fileURLToPath(new URL('../../tools/native-build/build-from-source.sh', import.meta.url));
  const result = spawnSync('bash', [script], { encoding: 'utf8', env: { ...process.env, EMSDK_ROOT: '' } });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Install\/activate Emscripten 6\.0\.0/);
});
