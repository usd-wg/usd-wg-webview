import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, mkdtempSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
export const sourceLock = JSON.parse(readFileSync(path.join(toolDirectory, 'sources.json'), 'utf8'));
const viewerRoot = path.resolve(toolDirectory, '../..');
export const sdkRoot = path.resolve(process.env.USD_WASM_LAB_ROOT || path.join(viewerRoot, 'build/wasm-sdk'));
const git = (directory, ...args) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' });
const normalizeDiff = diff => diff.split('\n').filter(line => /^[+-]|^(old|new) mode /.test(line)).join('\n');

// Refuse to reset someone else's checkout or hide edits beneath an expected patch.
export function verifySource(directory, dependency, applyPatch = false) {
  if (!existsSync(path.join(directory, '.git'))) throw new Error(`Not a prepared Git checkout: ${directory}`);
  if (git(directory, 'rev-parse', 'HEAD').trim() !== dependency.revision) {
    throw new Error(`Wrong revision in ${directory}; expected ${dependency.revision}. Use a new USD_WASM_LAB_ROOT.`);
  }
  if (git(directory, 'ls-files', '--others', '--exclude-standard').trim()) {
    throw new Error(`Unexpected untracked files in ${directory}; preserve/move your work before continuing.`);
  }
  const patchFile = dependency.patch && path.join(toolDirectory, 'patches', dependency.patch);
  const expected = patchFile ? normalizeDiff(readFileSync(patchFile, 'utf8')) : '';
  let actual = normalizeDiff(git(directory, 'diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD'));
  if (!actual && patchFile && applyPatch) {
    git(directory, 'apply', '--check', patchFile);
    git(directory, 'apply', patchFile);
    actual = normalizeDiff(git(directory, 'diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD'));
  }
  if (actual !== expected) throw new Error(`Unexpected or missing source patch in ${directory}. No edits were discarded.`);
  if (patchFile) git(directory, 'apply', '--reverse', '--check', patchFile);
}

export function prepareSources(root = sdkRoot, checkOnly = false) {
  const sources = path.join(root, 'sources');
  if (!checkOnly) mkdirSync(sources, { recursive: true });
  for (const dependency of sourceLock.dependencies) {
    const directory = path.join(sources, dependency.directory);
    if (!existsSync(directory) && !checkOnly) {
      // Publish only a complete checkout. Failed downloads leave a named temporary
      // directory for diagnosis, never a partially populated canonical source.
      const temporary = mkdtempSync(path.join(sources, `.fetch-${dependency.directory}-`));
      console.log(`Fetching ${dependency.directory} @ ${dependency.revision}`);
      git(temporary, 'init', '--quiet');
      git(temporary, 'remote', 'add', 'origin', dependency.url);
      git(temporary, 'fetch', '--depth', '1', 'origin', dependency.revision);
      git(temporary, 'checkout', '--quiet', '--detach', 'FETCH_HEAD');
      verifySource(temporary, dependency, true);
      renameSync(temporary, directory);
    }
    verifySource(directory, dependency, !checkOnly);
    console.log(`Verified ${dependency.directory}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).some(arg => arg !== '--check')) throw new Error('Usage: node prepare-sources.mjs [--check]');
    prepareSources(sdkRoot, process.argv.includes('--check'));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
