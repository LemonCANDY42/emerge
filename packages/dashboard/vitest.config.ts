/**
 * Dashboard-specific vitest configuration.
 *
 * The root vitest.config.ts uses environment:"node" which is correct for all
 * other packages. The dashboard client tests require jsdom for DOM APIs.
 *
 * This config is used by: pnpm --filter @lwrf42/emerge-dashboard test
 * The root config picks up server tests (*.test.ts) which run in node environment.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/client/**/*.test.tsx", "src/client/**/*.test.ts"],
    environment: "jsdom",
    globals: false,
  },
});
