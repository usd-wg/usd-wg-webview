import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://127.0.0.1:8001";
const scene = await readFile(new URL("../../tests/regression/cases/static-preview-surface/scene.usda", import.meta.url), "utf8");
const browser = await chromium.launch({ headless: true });
try {
  for (const architecture of ["32", "64"]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await page.goto(`${base}/?wasm=${architecture}&automation=1`);
      await page.waitForFunction(() => window.__USD_WEBVIEW_AUTOMATION__);
      await page.evaluate(() => window.__USD_WEBVIEW_AUTOMATION__.waitForReady(90000));
      await page.locator("#filePicker").setInputFiles({ name: "scene.usda", mimeType: "application/octet-stream", buffer: Buffer.from(scene) });
      await page.evaluate(() => window.__USD_WEBVIEW_AUTOMATION__.waitForReady(90000));
      await page.evaluate(() => {
        document.documentElement.classList.remove("automation-mode");
        document.querySelector("#menuStats").click();
      });
      const panel = page.locator("#statsPanel");
      assert.equal(await page.locator("#statsPanel").count(), 1);
      assert.equal(await panel.isVisible(), true);
      await page.waitForFunction(() => document.querySelector("#loadMetrics").textContent.includes("complete"));
      const data = await page.evaluate(() => {
        const rows = id => Object.fromEntries([...document.querySelectorAll(`#${id} dt`)].map(el => [el.textContent, el.nextElementSibling.textContent]));
        return { memory: window.__USD_WEBVIEW_MODULE__.GetMemoryStats(), load: rows("loadMetrics"), files: rows("memoryMetrics"), resources: rows("resourceMetrics") };
      });
      assert.equal(data.load["input files"], "1");
      assert.equal(data.files["original file copies"], data.load["input total"]);
      assert.equal(data.files["VFS logical bytes"], data.load["input total"]);
      assert.equal(data.files["imported VFS files"], "1");
      assert(data.memory.allocatedBytes > 0);
      assert(data.memory.capacityBytes >= data.memory.allocatedBytes);
      assert.equal(data.memory.maximumBytes, (architecture === "64" ? 8 : 2) * 1024 ** 3);
      assert.notEqual(data.files["native peak (sampled)"], "Unavailable");
      assert.notEqual(data.resources["geometry buffers (CPU)"], "0 B");
      assert.notEqual(data.load["USD open"], "—");
      await page.screenshot({ path: `/tmp/usd-stats-wasm${architecture}.png` });
      // Replacement must reset input and retained-copy counts rather than accumulating.
      const replacement = '#usda 1.0\n\ndef Xform "Empty" {}\n';
      await page.locator("#filePicker").setInputFiles({ name: "replacement.usda", mimeType: "application/octet-stream", buffer: Buffer.from(replacement) });
      await page.evaluate(() => window.__USD_WEBVIEW_AUTOMATION__.waitForReady(90000));
      await page.waitForFunction(bytes => {
        const text = document.querySelector("#loadMetrics").textContent;
        return text.includes(`${bytes} B`) && text.includes("complete");
      }, Buffer.byteLength(replacement));
      const after = await page.evaluate(() => {
        const rows = id => Object.fromEntries([...document.querySelectorAll(`#${id} dt`)].map(el => [el.textContent, el.nextElementSibling.textContent]));
        return { memory: rows("memoryMetrics"), load: rows("loadMetrics"), resources: rows("resourceMetrics") };
      });
      assert.equal(after.load["input total"], `${Buffer.byteLength(replacement)} B`);
      assert.equal(after.memory["original file copies"], after.load["input total"]);
      assert.equal(after.memory["imported VFS files"], "1");
      assert.equal(after.resources["geometry buffers (CPU)"], "0 B");
      await page.evaluate(() => Object.defineProperty(performance, "memory", { value: undefined, configurable: true }));
      await page.waitForFunction(() => {
        const labels = [...document.querySelectorAll("#memoryMetrics dt")];
        return labels.find(el => el.textContent === "JS heap used (approx.)")?.nextElementSibling.textContent === "Unavailable";
      });
      await page.setViewportSize({ width: 390, height: 844 });
      const bounds = await panel.boundingBox();
      assert(bounds.x >= 0 && bounds.x + bounds.width <= 390);
      await page.locator("#statsClose").click();
      assert.equal(await panel.isVisible(), false);
      console.log(JSON.stringify({ architecture, ...data, replacement: after.load, panel: "PASS" }));
    } finally { await page.close(); }
  }
} finally { await browser.close(); }
