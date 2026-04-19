import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Vite config for the browser client bundle.
// Run: pnpm --filter @lwrf42/emerge-dashboard build:client
// Output: dist/client/ (served as static assets by the Node HTTP server)
//
// This build is intentionally NOT part of the default `pnpm build` chain because
// it pulls in React + Tailwind + CSS transforms which add ~5s to the build.
// CI should run `pnpm --filter @lwrf42/emerge-dashboard build:client` separately
// after the TypeScript compile step.

export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname, "src/client"),
  build: {
    outDir: resolve(__dirname, "dist/client"),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, "src/client/index.html"),
    },
  },
  resolve: {
    alias: {
      // Allow the client to import from @lwrf42/emerge-tui/state via the built dist.
      // During development (vite dev), TypeScript source is used instead.
    },
  },
});
