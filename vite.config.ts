import { defineConfig } from "vite";
// @ts-expect-error Build tooling is shared with Node-based artifact tests.
import { copyReleasePublic } from "./tools/native-build/public-assets.mjs";
import path from "node:path";

export default defineConfig({
  build: { copyPublicDir: false },
  plugins: [{
    name: "verified-runtime-public-assets",
    apply: "build",
    async closeBundle() {
      await copyReleasePublic(path.resolve("public"), path.resolve("dist"));
    },
  }],
  resolve: {
    alias: {
      "three/tsl": "three/src/Three.TSL.js",
    },
  },
  optimizeDeps: {
    exclude: ["@sparkjsdev/spark"],
  },
  server: {
    host: "127.0.0.1",
    port: 8000,
    strictPort: true,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 8000,
    strictPort: true,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  },
});
