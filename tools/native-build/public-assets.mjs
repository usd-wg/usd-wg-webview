import { cp, readFile } from "node:fs/promises";
import path from "node:path";

// Vite's default public copy also ships ignored local scenes and obsolete
// experimental runtimes. Package only release assets and the selected 64 pair.
export async function copyReleasePublic(publicRoot, outputRoot) {
  const manifest = JSON.parse(await readFile(path.join(publicRoot, "usd-webview-bindings/runtimes.json"), "utf8"));
  const selected64 = new Set([manifest.wasm64.moduleUrl, manifest.wasm64.wasmUrl]
    .map(url => new URL(url, "https://package.invalid").pathname.slice(1)));
  await cp(publicRoot, outputRoot, {
    recursive: true,
    filter: source => {
      const relative = path.relative(publicRoot, source).split(path.sep).join("/");
      if (/^(localAssets|testAssets)(\/|$)/.test(relative)) return false;
      const prefix = "usd-webview-bindings/wasm64/";
      if (!relative.startsWith(prefix)) return true;
      return [...selected64].some(file => file === relative || file.startsWith(`${relative}/`));
    },
  });
}
