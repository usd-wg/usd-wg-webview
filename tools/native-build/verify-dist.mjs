import { readFile, readdir, access } from "node:fs/promises";
import path from "node:path";
import { sha256, architectureOf } from "./artifacts.mjs";

export async function verifyDist(root = path.resolve("dist")) {
  const manifest = JSON.parse(await readFile(path.join(root, "usd-webview-bindings/runtimes.json"), "utf8"));
  const expected64 = [];
  for (const arch of ["wasm32", "wasm64"]) {
    const entry = manifest[arch];
    if (manifest.version !== 1 || entry?.architecture !== arch || !entry.buildId?.startsWith(`${arch}-`)) {
      throw new Error(`Missing/invalid ${arch} deployment identity.`);
    }
    for (const url of [entry.moduleUrl, entry.wasmUrl]) {
      const pathname = new URL(url, "https://package.invalid").pathname;
      if (!url.startsWith("/usd-webview-bindings/") || !pathname.startsWith("/usd-webview-bindings/")) {
        throw new Error("Invalid packaged runtime path.");
      }
      const bytes = await readFile(path.join(root, pathname.slice(1)));
      const name = path.basename(pathname);
      if (sha256(bytes) !== entry.artifacts?.[name]?.sha256 || bytes.length !== entry.artifacts?.[name]?.bytes) {
        throw new Error(`Deployed artifact mismatch: ${pathname}`);
      }
      if (name.endsWith(".wasm") && architectureOf(bytes) !== arch) throw new Error(`Wrong memory architecture: ${pathname}`);
      if (arch === "wasm64") expected64.push(pathname.slice("/usd-webview-bindings/wasm64/".length));
    }
  }
  const actual64 = await readdir(path.join(root, "usd-webview-bindings/wasm64"), { recursive: true, withFileTypes: true });
  if (actual64.filter(entry => entry.isFile()).length !== expected64.length) throw new Error("Obsolete/extra WASM64 artifacts in dist.");
  for (const local of ["localAssets", "testAssets"]) {
    try { await access(path.join(root, local)); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    throw new Error(`Local-only assets leaked into dist/${local}`);
  }
  console.log(`Verified deployment: ${manifest.wasm32.buildId}, ${manifest.wasm64.buildId}`);
}
if (import.meta.url === `file://${process.argv[1]}`) await verifyDist();
