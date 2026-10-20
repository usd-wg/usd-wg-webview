import { spawn } from "node:child_process";
import { verifyDist } from "./verify-dist.mjs";

const mode = process.argv[2] ?? "smoke";
if (!["smoke", "32", "64"].includes(mode)) throw new Error("Usage: test-dist.mjs [smoke|32|64]");
await verifyDist();
const port = process.env.USD_TEST_PORT ?? "8010";
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "preview", "--port", port, "--strictPort"], { stdio: "inherit" });
const run = args => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { stdio: "inherit" });
  child.on("error", reject);
  child.on("exit", code => code === 0 ? resolve() : reject(new Error(`${args[0]} exited ${code}`)));
});
try {
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (server.exitCode !== null) throw new Error("Preview server exited before testing.");
    try { ready = (await fetch(base)).ok; } catch { /* startup */ }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error("Timed out waiting for production preview.");
  if (mode === "smoke") {
    await run(["tools/native-build/test-runtime-selection.mjs", base]);
    await run(["tools/native-build/test-stats.mjs", base]);
  } else {
    await run(["tests/regression/run.mjs", "--base-url", base, "--wasm", mode]);
  }
} finally { server.kill("SIGTERM"); }
