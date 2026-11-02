// Compare the actual shipped viewers on one machine. Asset bytes stay local;
// scene timings begin at openStage, after import into the WASM filesystem.
// node tools/benchmarks/splats.mjs --url URL --label NAME --assets FOLDER
//   [--trial 1] [--seconds 20] [--width 1920] [--height 1080]
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const args = process.argv.slice(2);
const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const base = option("--url", "http://127.0.0.1:8002");
const label = option("--label", "local");
const trial = Number(option("--trial", "1"));
const seconds = Number(option("--seconds", "20"));
const width = Number(option("--width", "1920"));
const height = Number(option("--height", "1080"));
const assets = option("--assets", null);
assert(assets, "--assets must name a local ALabSplat folder");
const output = path.resolve("test-results/alab-benchmark");
await mkdir(output, { recursive: true });
const prefix = `${label}-${trial}`;
const files = await Promise.all((await readdir(assets)).filter(name => /\.(usd[acz]?)$/i.test(name))
  .sort().map(async name => ({ name, path: path.join(assets, name), bytes: (await stat(path.join(assets, name))).size })));
const html = await (await fetch(base)).text();
const asset = html.match(/src="([^"]+\.js)"/)[1];
const scriptUrl = new URL(asset, base).href;
const js = await (await fetch(scriptUrl)).text();
// Expose existing objects only. Fail explicitly if a future build changes its
// shape, rather than silently benchmarking a different or reconstructed app.
const symbols = js.match(/const (\w+)=new \w+(?:\(\))?,(\w+)=\{viewport:/);
assert(symbols, "Cannot locate the shipped viewer's state/runtime");
const [, runtimeName, stateName] = symbols;
const loadIndex = js.indexOf(`++${stateName}.stageLoadSerial`);
assert(loadIndex > 0);
const loadName = [...js.slice(0, loadIndex).matchAll(/async function (\w+)\(/g)].at(-1)[1];
const instrumented = `${js}\nwindow.__SPLAT_BENCH__={state:${stateName},runtime:${runtimeName},loadFiles:${loadName}};`;
const browser = await chromium.launch({ channel: process.env.USD_WEBVIEW_BROWSER_CHANNEL || "msedge", headless: true,
  args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding"] });
const errors = [];
const warnings = [];
const report = { label, trial, base, generatedAt: new Date().toISOString(), seconds, width, height,
  measurement: "normal browser RAF, camera-to-sorted-frame latency, and actual detail-control clicks", browser: browser.version(), files,
  script: { url: scriptUrl, bytes: Buffer.byteLength(js), sha256: createHash("sha256").update(js).digest("hex") },
  errors, warnings };
try {
  const session = await browser.newBrowserCDPSession();
  const system = await session.send("SystemInfo.getInfo");
  report.gpu = system.gpu;
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(180_000);
  page.on("pageerror", error => { errors.push(error.message); console.warn("Browser error:", error.message); });
  page.on("console", message => { if (["error", "warning"].includes(message.type())) warnings.push(message.text()); });
  await page.route(scriptUrl, route => route.fulfill({ body: instrumented, contentType: "text/javascript" }));
  const url = new URL(base);
  url.searchParams.set("automation", "1");
  url.searchParams.set("wasm", "64");
  await page.goto(url.href);
  await page.waitForFunction(() => window.__SPLAT_BENCH__ && window.__USD_WEBVIEW_AUTOMATION__);
  await page.evaluate(() => window.__USD_WEBVIEW_AUTOMATION__.waitForReady(180_000));
  console.log(`[${prefix}] application ready`);
  await page.evaluate(() => {
    const b = window.__SPLAT_BENCH__;
    b.timings = {};
    b.sortSamples = [];
    b.firstFrame = new Promise(resolve => { b.resolveFirstFrame = resolve; });
    const bindings = b.runtime.bindings;
    const open = bindings.openStage;
    bindings.openStage = function (...args) {
      b.timings.openStart = performance.now();
      return open.apply(this, args);
    };
    const loadStage = b.runtime.loadStage;
    b.runtime.loadStage = function (request) {
      request.rootFile = request.files.find(file => file.name === "alab_splat.usda");
      if (!request.rootFile) throw new Error("ALab root missing");
      return loadStage.call(this, request);
    };
    const proto = Object.getPrototypeOf(b.state.viewport);
    const renderSplats = proto.renderGaussianSplats;
    proto.renderGaussianSplats = function (splats) {
      b.sources = splats.map(s => ({ path: s.path, count: s.count, shDegree: s.shDegree,
        matrix: s.matrix, inputBytes: [s.positions, s.scales, s.orientations, s.opacities, s.shCoeffs]
          .reduce((sum, array) => sum + (array?.byteLength || 0), 0) }));
      b.timings.splatPrepareStart = performance.now();
      const result = renderSplats.call(this, splats);
      b.timings.splatPrepareEnd = performance.now();
      const adapter = this.splatRenderer;
      const renderer = this.ctx.renderer;
      if (adapter.spark) {
        const drive = adapter.spark.driveSort;
        adapter.spark.driveSort = function (...args) {
          const starts = !this.sorting && this.sortDirty;
          const start = performance.now();
          const result = drive.apply(this, args);
          if (starts) result.then(() => b.sortSamples.push({ start, end: performance.now() }));
          return result;
        };
      }
      const render = renderer.render;
      const finalScene = adapter.splatScene || this.ctx.scene;
      renderer.render = function (scene, ...args) {
        const result = render.call(this, scene, ...args);
        if (scene === finalScene && this.info.render.triangles > 100 &&
            (!adapter.spark || adapter.spark.activeSplats > 0)) {
          renderer.render = render;
          b.timings.firstSubmitted = performance.now();
          const done = () => {
            b.timings.firstCompleted = performance.now();
            b.resolveFirstFrame();
          };
          const device = renderer.backend?.device;
          if (device) device.queue.onSubmittedWorkDone().then(done);
          else {
            const gl = renderer.getContext();
            const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
            gl.flush();
            const poll = () => {
              const status = gl.clientWaitSync(fence, 0, 0);
              if (status === gl.TIMEOUT_EXPIRED) setTimeout(poll, 1);
              else { gl.deleteSync(fence); done(); }
            };
            poll();
          }
        }
        return result;
      };
      return result;
    };
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.id = "benchmarkFiles";
    input.hidden = true;
    document.body.append(input);
  });
  await page.locator("#benchmarkFiles").setInputFiles(files.map(f => f.path));
  console.log(`[${prefix}] importing ALab (excluded from scene-load timer)`);
  report.load = await page.evaluate(async () => {
    const b = window.__SPLAT_BENCH__;
    await b.loadFiles(Array.from(document.querySelector("#benchmarkFiles").files));
    const ready = performance.now();
    await Promise.race([b.firstFrame, new Promise((_, reject) => setTimeout(() => reject(new Error("No splat frame completed")), 60_000))]);
    const v = b.state.viewport;
    const gl = v.ctx.renderer.getContext?.();
    const debug = gl?.getExtension?.("WEBGL_debug_renderer_info");
    return { postImportReadyMs: ready - b.timings.openStart,
      firstFrameAfterImportMs: b.timings.firstCompleted - b.timings.openStart,
      firstFrameAfterPreparationMs: b.timings.firstCompleted - b.timings.splatPrepareEnd,
      loadExcludingImportMs: b.state.stageLoadElapsedMs - b.runtime.loadMetrics.importMs,
      splatPrepareMs: b.timings.splatPrepareEnd - b.timings.splatPrepareStart,
      phases: b.runtime.loadMetrics, appLoadMsIncludingImport: b.state.stageLoadElapsedMs,
      runtime: b.runtime.status, sources: b.sources,
      webglDevice: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
      resourceStats: v.getResourceStats(), splatStats: v.getSplatStats?.(),
      camera: { position: v.ctx.camera.position.toArray(), target: v.ctx.controls.target.toArray(),
        fov: v.ctx.camera.fov, near: v.ctx.camera.near, far: v.ctx.camera.far } };
  });
  console.log(`[${prefix}] scene ready: ${report.load.postImportReadyMs.toFixed(1)} ms after import; ${report.load.sources.reduce((s, x) => s + x.count, 0)} splats`);
  assert(report.load.runtime.architecture === "wasm64");
  assert(report.load.sources.length > 0);
  await page.waitForTimeout(5000);
  report.inspect = await page.evaluate(() => {
    const v = window.__SPLAT_BENCH__.state.viewport;
    const s = v.splatRenderer;
    const spark = s.spark;
    return { sparkKeys: spark ? Object.keys(spark) : null,
      sparkNumbers: spark ? Object.fromEntries(Object.entries(spark).filter(([, v]) => typeof v === "number")) : null,
      sparkUniforms: spark?.uniforms ? Object.fromEntries(Object.entries(spark.uniforms)
        .filter(([, v]) => typeof v?.value === "number").map(([k, v]) => [k, v.value])) : null,
      dimensions: [v.ctx.renderer.domElement.width, v.ctx.renderer.domElement.height] };
  });
  assert.deepEqual(report.inspect.dimensions, [width, height]);
  report.runs = [];
  const workloads = ["orbit", "look"].map(mode => ({ mode, kind: "interactive" }));
  for (const { mode, kind } of workloads) {
    console.log(`[${prefix}] measuring ${kind} ${mode}, ${seconds}s`);
    const result = await page.evaluate(async ({ mode, kind, seconds }) => {
      const { state } = window.__SPLAT_BENCH__;
      const v = state.viewport;
      v.navigation.cancelFrameAnim();
      const { camera, controls } = v.ctx;
      const renderer = v.ctx.renderer;
      const drain = async () => {
        if (renderer.backend?.device) await renderer.backend.device.queue.onSubmittedWorkDone();
        else renderer.getContext().finish();
      };
      // Same fixed overview and 30-degree sweep in every build/trial.
      const target = [68.63612747192383, 139.93829154968262, 112.14171981811523];
      const radius = 1000;
      const pose = angle => {
        if (mode === "interior" || mode === "look") {
          // Position/orientation from camera.usda frame 1; use the viewer's
          // 50-degree lens in both builds. No USD camera integration is added.
          camera.position.set(152.0358123779297, 50, 378.8997497558594);
          const yaw = Math.atan2(0.8048032169716208, -0.5935417272206986) + angle - Math.PI / 4;
          controls.target.set(camera.position.x + Math.sin(yaw) * 100, 50, camera.position.z + Math.cos(yaw) * 100);
        } else {
          camera.position.set(target[0] + radius * Math.sin(angle), target[1] + 460, target[2] + radius * Math.cos(angle));
          controls.target.fromArray(target);
        }
        camera.fov = 50; camera.near = 1; camera.far = 100000;
        camera.updateProjectionMatrix(); camera.lookAt(controls.target);
        controls.update();
      };
      pose(Math.PI / 4);
      await new Promise(resolve => setTimeout(resolve, 2000));
      await drain();
      const frames = [];
      const longTasks = [];
      const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(e => e.duration)));
      observer.observe({ type: "longtask", buffered: false });
      const started = performance.now();
      let previous;
      const motion = elapsed => {
        if (mode === "orbit" || mode === "look") pose(Math.PI / 4 + Math.sin(elapsed / 1000 * Math.PI / 10) * Math.PI / 12);
      };
      await new Promise(resolve => {
        const step = () => {
          const now = performance.now();
          if (previous !== undefined) frames.push(now - previous);
          previous = now;
          const elapsed = now - started;
          motion(elapsed);
          if (elapsed < seconds * 1000) requestAnimationFrame(step); else resolve();
        };
        requestAnimationFrame(step);
      });
      observer.disconnect();
      const ended = performance.now();
      await drain();
      const drainMs = performance.now() - ended;
      const elapsedMs = frames.reduce((a, b) => a + b, 0);
      const sorted = [...frames].sort((a, b) => a - b);
      const p = q => sorted[Math.floor((sorted.length - 1) * q)];
      const memory = performance.memory;
      const sorts = window.__SPLAT_BENCH__.sortSamples.filter(s => s.start >= started && s.end <= ended);
      return { mode, kind, elapsedMs, samples: frames.length, fps: frames.length * 1000 / elapsedMs,
        medianMs: p(.5), p95Ms: p(.95), p99Ms: p(.99), worstMs: sorted.at(-1),
        over33Ms: frames.filter(x => x > 33.34).length, over50Ms: frames.filter(x => x > 50).length,
        longTasks, frameIntervalsMs: frames, drainMs,
        workerSorts: { count: sorts.length, perSecond: sorts.length * 1000 / (ended - started),
          durationsMs: sorts.map(s => s.end - s.start), allSamples: window.__SPLAT_BENCH__.sortSamples },
        sparkState: v.splatRenderer.spark ? { lastFrame: v.splatRenderer.spark.lastFrame,
          lastSortTime: v.splatRenderer.spark.lastSortTime, sorting: v.splatRenderer.spark.sorting,
          sortDirty: v.splatRenderer.spark.sortDirty, activeSplats: v.splatRenderer.spark.activeSplats } : null,
        resources: v.getResourceStats(), nativeMemory: window.__SPLAT_BENCH__.runtime.getMemoryStats(),
        jsHeap: memory ? { used: memory.usedJSHeapSize, total: memory.totalJSHeapSize, limit: memory.jsHeapSizeLimit } : null };
    }, { mode, kind, seconds });
    report.runs.push(result);
    console.log(`[${prefix}] ${kind} ${mode}: ${result.fps.toFixed(2)} FPS; p95 ${result.p95Ms.toFixed(2)} ms; worker sorts ${result.workerSorts.perSecond.toFixed(2)}/s`);
    await page.screenshot({ path: path.join(output, `${prefix}-${mode}.png`) });
  }
  console.log(`[${prefix}] measuring camera response and detail-control blocking`);
  report.interaction = await page.evaluate(async () => {
    const b = window.__SPLAT_BENCH__;
    const v = b.state.viewport;
    const renderer = v.ctx.renderer;
    const adapter = v.splatRenderer;
    const finalScene = adapter.splatScene || v.ctx.scene;
    const finish = () => {
      if (renderer.backend?.device) return renderer.backend.device.queue.onSubmittedWorkDone();
      const gl = renderer.getContext();
      const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      return new Promise((resolve, reject) => {
        const poll = () => {
          const status = gl.clientWaitSync(fence, 0, 0);
          if (status === gl.TIMEOUT_EXPIRED) setTimeout(poll, 1);
          else {
            gl.deleteSync(fence);
            if (status === gl.WAIT_FAILED) reject(new Error("GPU fence failed")); else resolve();
          }
        };
        poll();
      });
    };
    const pose = sign => {
      const angle = Math.PI / 4 + sign * Math.PI / 12;
      v.navigation.setCameraPose({ position: [68.63612747192383 + 1000 * Math.sin(angle), 599.9382915496826,
        112.14171981811523 + 1000 * Math.cos(angle)], target: [68.63612747192383, 139.93829154968262, 112.14171981811523],
        fov: 50, near: 1, far: 100000 });
    };
    pose(-1);
    await new Promise(resolve => setTimeout(resolve, 1000));
    const cameraSteps = [];
    for (let step = 0; step < 6; step++) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const original = renderer.render;
      const start = performance.now();
      const completed = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { renderer.render = original; reject(new Error("Camera sort did not finish")); }, 10_000);
        renderer.render = function (scene, ...args) {
          const result = original.call(this, scene, ...args);
          const fresh = !adapter.spark || b.sortSamples.some(s => s.start >= start);
          if (scene === finalScene && fresh) {
            renderer.render = original;
            clearTimeout(timeout);
            finish().then(() => resolve(performance.now() - start), reject);
          }
          return result;
        };
      });
      pose(step % 2 ? -1 : 1);
      cameraSteps.push(await completed);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    const detailClicks = [];
    for (const index of [2, 0, 1]) {
      const button = document.querySelector(`[data-splat-detail="${index}"]`);
      if (!button) throw new Error("Detail menu button missing");
      const start = performance.now();
      button.click();
      detailClicks.push({ label: button.textContent.trim(), index, blockingMs: performance.now() - start });
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return { cameraStepsMs: cameraSteps, detailClicks };
  });
  console.log(`[${prefix}] interaction: ${JSON.stringify(report.interaction)}`);
  assert.deepEqual(errors, []);
} catch (error) {
  report.failure = { message: String(error), stack: error.stack };
  process.exitCode = 1;
  console.error(report.failure.message);
} finally {
  await writeFile(path.join(output, `${prefix}.json`), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}
