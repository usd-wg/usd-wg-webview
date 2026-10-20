import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:8001";
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  // Same-origin blank document, without booting the viewer's USD module.
  const documentUrl = new URL("/localAssets/wasm64-probe/index.html", baseUrl).href;
  await page.route(documentUrl, route => route.fulfill({
    contentType: "text/html", body: "<!doctype html><title>Memory64 probe</title>",
  }));
  await page.goto(documentUrl);
  const result = await page.evaluate(async () => {
    const supported = WebAssembly.validate(new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 4, 0,
    ]));
    if (!supported) return { supported };
    const { default: createModule } = await import("/localAssets/wasm64-probe/probe.mjs");
    const runtime = await createModule();
    const result = runtime.probeMemory64();
    return { supported, ...result, copy: result.copy ? [...result.copy] : null };
  });
  console.log(JSON.stringify({ browser: browser.version(), ...result }, null, 2));
  assert.equal(result.supported, true, "Browser lacks Memory64");
  assert.equal(result.error, undefined);
  assert.equal(result.pointerBytes, 8);
  assert.ok(BigInt(result.highAddress) > 4294967296n);
  assert.equal(result.sentinelsMatch, true);
  assert.equal(result.sparseReadsMatch, true);
  assert.equal(result.grew, true);
  assert.ok(result.heapAfter > result.heapBefore);
  assert.deepEqual(result.copy, [100, 101, 102, 103, 104, 105, 106, 107]);
} finally {
  await browser.close();
}
