// Package checked-in pairs without a native toolchain or network access.
// An explicit source directory imports a freshly built WASM64 pair into the
// canonical native/artifacts directory. No arguments packages that saved pair.
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { filenames, sha256, verifyPair } from "./artifacts.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const assets = path.join(root, "public/usd-webview-bindings");
const canonical64 = path.join(root, "native/artifacts/wasm64");
const checkOnly = process.argv.includes("--check");
const source64 = process.argv[2] && !checkOnly ? path.resolve(process.argv[2]) : canonical64;
const pair32 = await verifyPair(assets, "wasm32");
const pair64 = await verifyPair(source64, "wasm64");
const wrapper = await readFile(path.join(assets, "usdWebViewBindings.js"), "utf8");
const wrapperLines = wrapper.split("\n");
// Match stamp-build's byte sequence, without silently repairing stale stamps.
const digest32 = createHash("sha256")
  .update(await readFile(path.join(assets, filenames[1])))
  .update(await readFile(path.join(assets, filenames[0])))
  .update(wrapperLines.slice(2).join("\n")).digest("hex").slice(0, 12);
const build32 = `wasm32-${digest32}`;
const generated = await readFile(path.join(root, "src/usd/generated/buildId.ts"), "utf8");
if (!wrapperLines[0]?.includes(`"${build32}"`) || !wrapperLines[1]?.includes(`"${build32}"`) ||
    !generated.includes(`"${build32}"`)) {
  throw new Error("Stale runtime stamp. Run npm run native:stamp after rebuilding or editing the wrapper.");
}
const digest64 = sha256(JSON.stringify(pair64.artifacts)).slice(0, 16);
const destination = path.join(assets, "wasm64", digest64);
const manifest = {
  version: 1,
  wasm32: {
    architecture: "wasm32", buildId: build32,
    moduleUrl: `/usd-webview-bindings/${filenames[0]}?v=${build32}`,
    wasmUrl: `/usd-webview-bindings/${filenames[1]}?v=${build32}`,
    artifacts: pair32.artifacts,
  },
  wasm64: {
    architecture: "wasm64", buildId: `wasm64-${digest64}`,
    moduleUrl: `/usd-webview-bindings/wasm64/${digest64}/${filenames[0]}`,
    wasmUrl: `/usd-webview-bindings/wasm64/${digest64}/${filenames[1]}`,
    artifacts: pair64.artifacts,
  },
};
const manifestPath = path.join(assets, "runtimes.json");
if (checkOnly) {
  if (JSON.stringify(JSON.parse(await readFile(manifestPath, "utf8"))) !== JSON.stringify(manifest)) {
    throw new Error("Packaged runtime manifest is stale. Run npm run native:package.");
  }
  for (const name of filenames) {
    if (sha256(await readFile(path.join(destination, name))) !== pair64.artifacts[name].sha256) {
      throw new Error(`Packaged WASM64 artifact mismatch: ${name}`);
    }
  }
  console.log("Verified both source pairs, cache stamps, and packaged runtime hashes.");
} else {
  if (source64 !== canonical64) {
    await mkdir(canonical64, { recursive: true });
    for (const name of [...filenames, "build.json"]) await copyFile(path.join(source64, name), path.join(canonical64, name));
  }
  await mkdir(destination, { recursive: true });
  for (const name of filenames) await copyFile(path.join(canonical64, name), path.join(destination, name));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Packaged ${manifest.wasm32.buildId} + ${manifest.wasm64.buildId}`);
}
