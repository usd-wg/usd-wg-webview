// Requires a Vite development server; this exercises the real adapter directly.
// node tests/splats/run.mjs http://127.0.0.1:8000 webgpu|webgl2
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://127.0.0.1:8000";
const backend = process.argv[3] ?? "webgl2";
assert(["webgpu", "webgl2"].includes(backend));
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-webgpu"],
  ...((process.env.USD_WEBVIEW_BROWSER_CHANNEL || backend === "webgpu")
    ? { channel: process.env.USD_WEBVIEW_BROWSER_CHANNEL || "chromium" } : {}) });
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(90_000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const url = new URL("/tests/splats/smoke.html", base);
  url.searchParams.set(backend === "webgpu" ? "gpu" : "forceWebGL", backend === "webgpu" ? "webgpu" : "1");
  await page.goto(url.href);
  await page.waitForFunction(() => window.splatSmoke !== undefined);
  const result = await page.evaluate(() => window.splatSmoke);
  console.log(JSON.stringify({ backend, ...result, errors }, null, 2));
  assert(result.pass, result.error);
  assert.equal(result.sortMode, backend === "webgpu" ? "gpu" : "cpu");
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
