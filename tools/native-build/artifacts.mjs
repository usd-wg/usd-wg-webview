import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

export const filenames = ["usdWebViewBindingsModule.js", "usdWebViewBindingsModule.wasm"];
export const sha256 = data => createHash("sha256").update(data).digest("hex");

export function architectureOf(bytes) {
  if (bytes.length < 8 || bytes.readUInt32LE(0) !== 0x6d736100 || bytes.readUInt32LE(4) !== 1) {
    throw new Error("Invalid WASM header.");
  }
  let offset = 8;
  const uleb = () => {
    let result = 0, shift = 0, byte;
    do {
      if (offset >= bytes.length || shift > 28) throw new Error("Invalid WASM section encoding.");
      byte = bytes[offset++];
      result += (byte & 127) * 2 ** shift;
      shift += 7;
    } while (byte & 128);
    return result;
  };
  while (offset < bytes.length) {
    const section = bytes[offset++];
    const size = uleb();
    const end = offset + size;
    if (end > bytes.length) throw new Error("Truncated WASM section.");
    if (section === 5) {
      if (uleb() !== 1 || offset >= end) throw new Error("Expected one internal memory.");
      return uleb() & 4 ? "wasm64" : "wasm32";
    }
    offset = end;
  }
  throw new Error("No internal WASM memory declaration.");
}

export async function describePair(directory) {
  const artifacts = {};
  let architecture;
  for (const filename of filenames) {
    const bytes = await readFile(path.join(directory, filename));
    artifacts[filename] = { bytes: bytes.length, sha256: sha256(bytes) };
    if (filename.endsWith(".wasm")) architecture = architectureOf(bytes);
  }
  return { architecture, artifacts };
}

export async function verifyPair(directory, expectedArchitecture) {
  const recorded = JSON.parse(await readFile(path.join(directory, "build.json"), "utf8"));
  const actual = await describePair(directory);
  if (actual.architecture !== expectedArchitecture) throw new Error(`Expected ${expectedArchitecture} in ${directory}.`);
  for (const filename of filenames) {
    if (recorded.artifacts?.[filename]?.sha256 !== actual.artifacts[filename].sha256 ||
        recorded.artifacts?.[filename]?.bytes !== actual.artifacts[filename].bytes) {
      throw new Error(`Artifact mismatch: ${directory}/${filename}. Rebuild and stamp the pair.`);
    }
  }
  return actual;
}
