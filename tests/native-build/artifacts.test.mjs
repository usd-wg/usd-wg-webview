import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { architectureOf, describePair, verifyPair, filenames } from "../../tools/native-build/artifacts.mjs";
import { copyReleasePublic } from "../../tools/native-build/public-assets.mjs";
import { verifyDist } from "../../tools/native-build/verify-dist.mjs";

const binary = arch => Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, arch === "wasm64" ? 4 : 0, 0]);
async function pair(directory, arch) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, filenames[0]), "export default function () {}");
  await writeFile(path.join(directory, filenames[1]), binary(arch));
  const description = await describePair(directory);
  await writeFile(path.join(directory, "build.json"), JSON.stringify(description));
  return description;
}
async function temporary(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "usd-artifact-test-"));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("recognizes both memory architectures and rejects invalid binaries", () => {
  assert.equal(architectureOf(binary("wasm32")), "wasm32");
  assert.equal(architectureOf(binary("wasm64")), "wasm64");
  assert.throws(() => architectureOf(Buffer.from("not wasm")));
  assert.throws(() => architectureOf(binary("wasm64").subarray(0, 12)));
});
test("checks both generated files, not just the WASM hash", () => temporary(async root => {
  await pair(root, "wasm64");
  await verifyPair(root, "wasm64");
  await assert.rejects(verifyPair(root, "wasm32"), /Expected wasm32/);
  await writeFile(path.join(root, filenames[0]), "mismatched glue");
  await assert.rejects(verifyPair(root, "wasm64"), /Artifact mismatch/);
}));
test("rejects a stale binary and missing stamp", () => temporary(async root => {
  await pair(root, "wasm32");
  await writeFile(path.join(root, filenames[1]), Buffer.concat([binary("wasm32"), Buffer.from([0, 0])]));
  await assert.rejects(verifyPair(root, "wasm32"), /Artifact mismatch/);
  await rm(path.join(root, "build.json"));
  await assert.rejects(verifyPair(root, "wasm32"), /ENOENT/);
}));
test("release copy excludes local scenes and all unselected 64-bit pairs; dist hashes detect corruption", () => temporary(async root => {
  const publicRoot = path.join(root, "public");
  const assets = path.join(publicRoot, "usd-webview-bindings");
  const pair32 = await pair(assets, "wasm32");
  const pair64 = await pair(path.join(assets, "wasm64/current"), "wasm64");
  await pair(path.join(assets, "wasm64/obsolete"), "wasm64");
  for (const local of ["localAssets/private-scene", "testAssets/large-scene"]) {
    await mkdir(path.join(publicRoot, local), { recursive: true });
    await writeFile(path.join(publicRoot, local, "scene.usda"), "local");
  }
  const manifest = { version: 1 };
  for (const [arch, description, prefix] of [
    ["wasm32", pair32, "/usd-webview-bindings/"],
    ["wasm64", pair64, "/usd-webview-bindings/wasm64/current/"],
  ]) {
    manifest[arch] = { ...description, buildId: `${arch}-test`, moduleUrl: prefix + filenames[0], wasmUrl: prefix + filenames[1] };
  }
  await writeFile(path.join(assets, "runtimes.json"), JSON.stringify(manifest));
  const dist = path.join(root, "dist");
  await copyReleasePublic(publicRoot, dist);
  await verifyDist(dist);
  await assert.rejects(access(path.join(dist, "localAssets")), /ENOENT/);
  await assert.rejects(access(path.join(dist, "testAssets")), /ENOENT/);
  await assert.rejects(access(path.join(dist, "usd-webview-bindings/wasm64/obsolete")), /ENOENT/);
  assert.equal((await readFile(path.join(dist, "usd-webview-bindings/wasm64/current", filenames[1]))).length, 13);
  await writeFile(path.join(dist, "usd-webview-bindings/wasm64/current", filenames[0]), "corrupt");
  await assert.rejects(verifyDist(dist), /artifact mismatch/);
}));
