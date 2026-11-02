// Repack the published release without changing its runtime files. Upstream
// 0.0.1 accidentally requires macOS-only fsevents on every platform.
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const url = "https://registry.npmjs.org/@sparkjsdev/radix/-/radix-0.0.1.tgz";
const integrity = "9eFB/D+A0okR08a9UhMsw6efRqc7r41vjmcIAJ63zQn1u8HsCJNJi8xjSbXfw9cClLmRo9axxLoD57ue+hOH7A==";
const destination = path.resolve("vendor/radix-0.0.1-portable.tgz");
const scratch = await mkdtemp(path.join(tmpdir(), "usd-radix-"));
try {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Radix download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha512").update(bytes).digest("base64") !== integrity) {
    throw new Error("Radix upstream integrity mismatch");
  }
  await writeFile(path.join(scratch, "upstream.tgz"), bytes);
  execFileSync("tar", ["-xzf", "upstream.tgz"], { cwd: scratch });
  const manifestPath = path.join(scratch, "package/package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.optionalDependencies = { ...manifest.optionalDependencies, fsevents: manifest.dependencies.fsevents };
  delete manifest.dependencies.fsevents;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await mkdir(path.dirname(destination), { recursive: true });
  // GNU tar: deterministic ordering, metadata and gzip header for byte-identical output.
  execFileSync("tar", ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "-czf", destination, "package"], { cwd: scratch });
  console.log(`Wrote ${destination}; only package.json differs from upstream`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
