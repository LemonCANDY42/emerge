import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/**/src/**/*.test.ts",
      "packages/**/src/**/*.test.tsx",
      "examples/**/src/**/*.test.ts",
    ],
    exclude: ["**/dist/**", "**/node_modules/**"],
    environment: "node",
    globals: false,
  },
});
