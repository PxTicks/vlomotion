import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";

export function readAppPorts(env = process.env, envFile = fileURLToPath(new URL("../../.env", import.meta.url))) {
  let file: Record<string, string | undefined> = {};
  try { file = parseEnv(readFileSync(envFile, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  // Match the server's Node --env-file precedence and its exact root .env file.
  return { web: Number(env.WEB_PORT ?? file.WEB_PORT ?? 5180), api: Number(env.PORT ?? file.PORT ?? 8790) };
}

export default defineConfig(() => {
  const ports = readAppPorts();
  return {
    plugins: [react()],
    server: { port: ports.web, proxy: { "/api": `http://127.0.0.1:${ports.api}` } },
    // The encoder worker is the only importer; pre-bundling it avoids a full reload on the first generation.
    optimizeDeps: { include: ["mediabunny"] },
  };
});
