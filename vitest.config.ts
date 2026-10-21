import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["apps/**/src/**/__tests__/*.test.ts", "packages/**/src/**/__tests__/*.test.ts", "scripts/**/__tests__/*.test.ts"] },
  resolve: { alias: { "@h3-motion/shared": new URL("./packages/shared/src/index.ts", import.meta.url).pathname } },
});
