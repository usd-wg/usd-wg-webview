// Visual regression runner: renders every corpus case through the real app
// (vite dev server + headless Chromium + the window.__USD_WEBVIEW_AUTOMATION__
// API) and gates screenshots against committed baselines.
//
// Usage:
//   node tests/regression/run.mjs                  # run + gate
//   node tests/regression/run.mjs --update-baselines
//   node tests/regression/run.mjs --case variants --case payload-toggle
//   node tests/regression/run.mjs --base-url http://127.0.0.1:8000

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import { diffAgainstBaseline } from "./compare.mjs";
import { evaluateGate, resolveGate } from "./gate.mjs";

const REGRESSION_ROOT = path.dirname(new URL(import.meta.url).pathname);
const CASES_ROOT = path.join(REGRESSION_ROOT, "cases");
const OUTPUT_ROOT = path.resolve(REGRESSION_ROOT, "..", "..", "test-results", "regression");
const GENERATED_ROOT = path.join(OUTPUT_ROOT, "generated");
const RESULTS_ROOT = path.join(OUTPUT_ROOT, "results");

const CAPTURE = {
  viewportWidth: 800,
  viewportHeight: 600,
  timeoutMs: 90000,
  settleFrames: 8,
};

export async function listCases() {
  const entries = await fs.readdir(CASES_ROOT, { withFileTypes: true });
  const cases = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const caseDir = path.join(CASES_ROOT, entry.name);
    const casePath = path.join(caseDir, "case.json");
    const spec = JSON.parse(await fs.readFile(casePath, "utf8"));
    const files = (await listFilesRecursive(caseDir))
      .filter((filePath) => {
        const relativePath = path.relative(caseDir, filePath);
        return path.basename(filePath) !== "case.json" &&
          !relativePath.startsWith(`baselines${path.sep}`);
      })
      .map((filePath) => ({
        path: toPosixPath(path.relative(caseDir, filePath)),
        absolutePath: filePath,
      }));
    cases.push({ ...spec, caseDir, files });
  }
  return cases;
}

async function captureCase(page, baseUrl, caseSpec, { forceWebGL = false } = {}) {
  const manifest = {
    caseId: caseSpec.id,
    rootFile: caseSpec.rootFile,
    files: caseSpec.files,
  };
  const manifestPath = path.join(GENERATED_ROOT, caseSpec.id, "manifest.json");
  await ensureDir(path.dirname(manifestPath));
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const caseUrl = new URL("/", baseUrl);
  caseUrl.searchParams.set("automation", "1");
  caseUrl.searchParams.set("automationManifest", `/@fs/${toPosixPath(manifestPath)}`);
  caseUrl.searchParams.set("settleFrames", String(CAPTURE.settleFrames));
  if (forceWebGL) {
    caseUrl.searchParams.set("forceWebGL", "1");
  }

  await page.goto(caseUrl.toString(), {
    waitUntil: "networkidle",
    timeout: CAPTURE.timeoutMs,
  });

  await page.evaluate(async ({ timeoutMs }) => {
    const api = window.__USD_WEBVIEW_AUTOMATION__;
    if (!api) throw new Error("USD Web View automation API is unavailable.");
    await api.waitForReady(timeoutMs);
  }, { timeoutMs: CAPTURE.timeoutMs });

  const captured = [];
  for (const capture of caseSpec.captures ?? [{ name: "default" }]) {
    const cameraPose = await page.evaluate(async (ops) => {
      const api = window.__USD_WEBVIEW_AUTOMATION__;
      for (const selection of ops.variantSelections ?? []) {
        await api.setVariantSelection(
          selection.primPath,
          selection.variantSet,
          selection.selection
        );
      }
      for (const payloadOp of ops.payloadOps ?? []) {
        await api.setPayloadLoaded(payloadOp.primPath, payloadOp.loaded);
      }
      if (typeof ops.timeCode === "number") {
        await api.setTime(ops.timeCode);
      }
      await api.settle();
      return api.getCameraPose();
    }, {
      variantSelections: capture.variantSelections,
      payloadOps: capture.payloadOps,
      timeCode: capture.timeCode,
    });
    console.log(`CAMERA ${caseSpec.id}--${capture.name} ${JSON.stringify(cameraPose)}`);

    const screenshotPath = path.join(RESULTS_ROOT, `${caseSpec.id}--${capture.name}.png`);
    await page.locator(".viewport canvas").last().screenshot({ path: screenshotPath });
    captured.push({ captureName: capture.name, screenshotPath });
  }
  return captured;
}

export async function runRegression({
  updateBaselines = false,
  caseFilter = [],
  baseUrl = null,
} = {}) {
  await fs.rm(RESULTS_ROOT, { recursive: true, force: true });
  await ensureDir(RESULTS_ROOT);

  let cases = await listCases();
  if (caseFilter.length) {
    const wanted = new Set(caseFilter);
    cases = cases.filter((caseSpec) => wanted.has(caseSpec.id));
    const missing = caseFilter.filter((id) => !cases.some((c) => c.id === id));
    if (missing.length) {
      throw new Error(`Unknown corpus case(s): ${missing.join(", ")}`);
    }
  }

  const actualBaseUrl = baseUrl ?? "http://127.0.0.1:8000";
  const server = baseUrl ? null : startViteServer();

  const browser = await chromium.launch({
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });

  const entries = [];
  try {
    if (server) {
      await waitForHttpReady(actualBaseUrl, CAPTURE.timeoutMs);
    }
    const page = await browser.newPage({
      viewport: { width: CAPTURE.viewportWidth, height: CAPTURE.viewportHeight },
      deviceScaleFactor: 1,
    });
    page.on("pageerror", (error) => {
      console.warn(`[page error] ${error.message}`);
    });

    for (const caseSpec of cases) {
      // Headless Chromium cannot present real-WebGPU canvases (blank output),
      // so WebGPU-dependent cases run the app's WebGPURenderer on its WebGL2
      // backend via ?forceWebGL=1. The MaterialX/TSL node path is identical.
      const forceWebGL = caseSpec.tags?.includes("requiresWebGpu") ?? false;
      const gate = resolveGate(caseSpec.gate);
      let captured;
      try {
        captured = await captureCase(page, actualBaseUrl, caseSpec, { forceWebGL });
      } catch (error) {
        for (const capture of caseSpec.captures ?? [{ name: "default" }]) {
          entries.push({
            caseId: caseSpec.id,
            captureName: capture.name,
            status: "capture-error",
            detail: error instanceof Error ? error.message : String(error),
            gate,
          });
        }
        continue;
      }

      for (const { captureName, screenshotPath } of captured) {
        const baselinePath = path.join(caseSpec.caseDir, "baselines", `${captureName}.png`);
        if (updateBaselines) {
          await ensureDir(path.dirname(baselinePath));
          await fs.copyFile(screenshotPath, baselinePath);
          entries.push({ caseId: caseSpec.id, captureName, status: "blessed", gate });
          continue;
        }

        let baselinePng;
        try {
          baselinePng = PNG.sync.read(await fs.readFile(baselinePath));
        } catch {
          entries.push({
            caseId: caseSpec.id,
            captureName,
            status: "missing-baseline",
            detail: baselinePath,
            gate,
          });
          continue;
        }

        const resultPng = PNG.sync.read(await fs.readFile(screenshotPath));
        const diffPath = path.join(RESULTS_ROOT, `${caseSpec.id}--${captureName}.diff.png`);
        const diff = diffAgainstBaseline(baselinePng, resultPng, gate, diffPath);
        if (diff.status === "compared") {
          if (diff.mismatchRatio > gate.maxMismatchRatio) {
            await fs.writeFile(diffPath, PNG.sync.write(diff.diffPng));
          }
          entries.push({
            caseId: caseSpec.id,
            captureName,
            status: "compared",
            mismatchRatio: diff.mismatchRatio,
            gate,
          });
        } else {
          entries.push({ caseId: caseSpec.id, captureName, ...diff, gate });
        }
      }
    }
  } finally {
    await browser.close();
    if (server?.pid) {
      // The dev server is spawned via npm in its own process group; kill the
      // whole group so vite itself does not linger holding the strict port.
      try {
        process.kill(-server.pid, "SIGTERM");
      } catch {
        server.kill("SIGTERM");
      }
    }
  }

  const verdict = evaluateGate(entries);
  const report = {
    generatedAt: new Date().toISOString(),
    updateBaselines,
    pass: verdict.pass,
    entries,
    failures: verdict.failures,
  };
  await fs.writeFile(
    path.join(RESULTS_ROOT, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8"
  );
  return report;
}

function startViteServer() {
  return spawn("npm", ["run", "dev"], { stdio: "ignore", detached: true });
}

async function waitForHttpReady(baseUrl, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // keep polling until timeout
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for Vite server at ${baseUrl}`);
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function listFilesRecursive(rootDir) {
  const results = [];
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await listFilesRecursive(fullPath)));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

function toPosixPath(filePath) {
  return filePath.split(path.sep).join("/");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const updateBaselines = args.includes("--update-baselines");
  const caseFilter = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--case" && args[i + 1]) caseFilter.push(args[++i]);
  }
  const baseUrlIndex = args.indexOf("--base-url");
  const baseUrl = baseUrlIndex >= 0 ? args[baseUrlIndex + 1] : null;

  const report = await runRegression({ updateBaselines, caseFilter, baseUrl });
  for (const entry of report.entries) {
    const label = `${entry.caseId}--${entry.captureName}`;
    if (entry.status === "compared") {
      const ok = entry.mismatchRatio <= entry.gate.maxMismatchRatio;
      console.log(
        `${ok ? "PASS" : "FAIL"} ${label} mismatchRatio=${entry.mismatchRatio.toFixed(6)}`
      );
    } else {
      const prefix =
        entry.status === "blessed" ? "BLESS" : entry.status === "skipped" ? "SKIP" : "FAIL";
      console.log(`${prefix} ${label} (${entry.status}${entry.detail ? `: ${entry.detail}` : ""})`);
    }
  }
  console.log(report.pass ? "Regression gate: PASS" : "Regression gate: FAIL");
  process.exitCode = report.pass ? 0 : 1;
}
