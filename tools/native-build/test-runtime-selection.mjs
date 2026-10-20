import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:8001";
const browser = await chromium.launch({ headless: true });
const scene = await readFile(new URL("../../tests/regression/cases/static-preview-surface/scene.usda", import.meta.url));
try {
  for (const test of [
    { name: "automatic64", mode: "auto", expected: "wasm64" },
    { name: "forced32", mode: "32", expected: "wasm32" },
    { name: "forced64", mode: "64", expected: "wasm64" },
    { name: "no-memory64", mode: "auto", expected: "wasm32", unsupported: true },
    { name: "mobile-emulation", mode: "auto", expected: "wasm64", mobile: true },
    { name: "64-download-failure", mode: "auto", expected: "wasm32", blocked: true },
    { name: "32-only-package", mode: "auto", expected: "wasm32", noManifest: true },
  ]) {
    const context = await browser.newContext({
      viewport: test.mobile ? {width: 390, height: 844} : {width: 800, height: 600},
      isMobile: !!test.mobile, hasTouch: !!test.mobile,
    });
    try {
      if (test.unsupported) await context.addInitScript(() => {
        const validate = WebAssembly.validate.bind(WebAssembly);
        WebAssembly.validate = bytes => {
          // Simulate only the selector's capability probe, not the loaded module.
          if (bytes.byteLength === 13) return false;
          return validate(bytes);
        };
      });
      const page = await context.newPage();
      const requests = [];
      page.on("request", r => {
        if (/usdWebViewBindingsModule\.(js|wasm)(\?|$)/.test(r.url())) requests.push(new URL(r.url()).pathname);
      });
      if (test.blocked) await page.route("**/wasm64/**/*.js", route => route.abort("failed"));
      if (test.noManifest) await page.route("**/runtimes.json", route => route.fulfill({status: 404}));
      const manifestUrl = new URL("/__runtime-selection-manifest.json", baseUrl).href;
      await page.route(manifestUrl, route => route.fulfill({json: {
        rootFile: "scene.usda", files: [{path: "scene.usda", url: "/__runtime-selection-scene.usda"}],
      }}));
      await page.route(new URL("/__runtime-selection-scene.usda", baseUrl).href, route => route.fulfill({
        body: scene, contentType: "application/octet-stream",
      }));
      const url = new URL("/", baseUrl);
      url.searchParams.set("wasm", test.mode);
      url.searchParams.set("automation", "1");
      url.searchParams.set("automationManifest", manifestUrl);
      await page.goto(url.href);
      await page.waitForFunction(() => !!window.__USD_WEBVIEW_AUTOMATION__);
      await page.evaluate(() => window.__USD_WEBVIEW_AUTOMATION__.waitForReady(90000));
      const badge = page.locator("#runtimeArchitectureLabel");
      assert.equal(await badge.getAttribute("data-architecture"), test.expected, test.name);
      const buildId = await badge.getAttribute("data-build-id");
      assert.match(buildId, new RegExp(`^${test.expected}-[a-f0-9]+$`));
      assert.equal(await badge.textContent(), buildId);
      const files64 = requests.filter(url => url.includes("/wasm64/"));
      const files32 = requests.filter(url => !url.includes("/wasm64/"));
      if (test.blocked) {
        assert.equal(files64.length, 1, "Only the failed 64-bit glue request should be attempted");
        assert.equal(files32.length, 2);
        assert.match(await badge.getAttribute("title"), /fallback:/);
      } else {
        assert.equal(test.expected === "wasm64" ? files64.length : files32.length, 2);
        assert.equal(test.expected === "wasm64" ? files32.length : files64.length, 0);
      }
      console.log(JSON.stringify({ test: test.name, architecture: test.expected, requests, browser: browser.version() }));
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
