// Record the exact experimental pair, without changing production cache IDs.
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

if (!process.argv[2]) throw new Error("Usage: node stamp-experiment.mjs <artifact-directory>");
const directory = path.resolve(process.argv[2]);
const artifacts = {};
for (const name of ["usdWebViewBindingsModule.js", "usdWebViewBindingsModule.wasm"]) {
  const data = await readFile(path.join(directory, name));
  artifacts[name] = {
    bytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
}
const digest = createHash("sha256").update(JSON.stringify(artifacts)).digest("hex");
const manifest = { buildId: `experiment-${digest.slice(0, 12)}`, artifacts };
await writeFile(path.join(directory, "build.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));
