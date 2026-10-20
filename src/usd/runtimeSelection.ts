export type RuntimeArchitecture = "wasm32" | "wasm64";
export type RuntimePreference = "auto" | "32" | "64";
export type RuntimeVariant = {
  architecture: RuntimeArchitecture;
  buildId: string;
  moduleUrl: string;
  wasmUrl: string;
};
export type RuntimeManifest = {
  version: 1;
  wasm32: RuntimeVariant;
  wasm64?: RuntimeVariant;
};

// Zero-page Memory64 module: validation needs no download or large allocation.
export function supportsMemory64(): boolean {
  try {
    return WebAssembly.validate(new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 4, 0,
    ]));
  } catch {
    return false;
  }
}

export function runtimePreference(search: string): RuntimePreference {
  const value = new URLSearchParams(search).get("wasm");
  if (value === null || value === "auto") return "auto";
  if (value === "32" || value === "64") return value;
  throw new Error(`Invalid wasm selection "${value}": use auto, 32, or 64.`);
}

export function parseRuntimeManifest(value: unknown): RuntimeManifest {
  const record = value as Partial<RuntimeManifest> | null;
  if (!record || record.version !== 1) throw new Error("Unsupported runtime manifest.");
  const validate = (variant: RuntimeVariant | undefined, arch: RuntimeArchitecture) => {
    if (!variant || variant.architecture !== arch ||
        typeof variant.buildId !== "string" || !/^[a-z0-9-]+$/.test(variant.buildId)) {
      throw new Error(`Invalid ${arch} runtime identity.`);
    }
    for (const url of [variant.moduleUrl, variant.wasmUrl]) {
      if (typeof url !== "string" || !url.startsWith("/usd-webview-bindings/") ||
          !new URL(url, "https://runtime.invalid").pathname.startsWith("/usd-webview-bindings/")) {
        throw new Error(`Invalid ${arch} runtime URL.`);
      }
    }
    return variant;
  };
  return {
    version: 1,
    wasm32: validate(record.wasm32, "wasm32"),
    ...(record.wasm64 ? { wasm64: validate(record.wasm64, "wasm64") } : {}),
  };
}

export async function loadSelectedRuntime<T>(
  manifest: RuntimeManifest,
  preference: RuntimePreference,
  create: (variant: RuntimeVariant) => Promise<T>,
  detectMemory64: () => boolean = supportsMemory64,
): Promise<{ runtime: T; variant: RuntimeVariant; fallbackReason?: string }> {
  // Forced 32-bit mode intentionally bypasses capability probing.
  const capable = preference !== "32" && detectMemory64();
  if (preference === "64" && (!capable || !manifest.wasm64)) {
    throw new Error(!capable ? "Memory64 is unavailable in this browser." : "WASM64 is not packaged.");
  }
  const selected = capable && manifest.wasm64 ? manifest.wasm64 : manifest.wasm32;
  try {
    return { runtime: await create(selected), variant: selected };
  } catch (error) {
    // Only automatic startup can downgrade. Never retry a stage load or replay
    // edits on another runtime, and never hide failures in forced test modes.
    if (preference !== "auto" || selected.architecture !== "wasm64") throw error;
    const fallbackReason = error instanceof Error ? error.message : String(error);
    console.warn("[USD WebView] WASM64 startup failed; trying WASM32.", error);
    return { runtime: await create(manifest.wasm32), variant: manifest.wasm32, fallbackReason };
  }
}
