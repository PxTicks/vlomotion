import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { assertProxyCanStart, DEFAULT_PROXY_URL, localProxyAddress, probeProxy, resolveComfyUi, serviceUrl } from "./lib/connection.js";
import { assertLauncherPlatform, installShutdownHandlers, ProcessSupervisor } from "./lib/processes.js";
import type { OwnedProcess } from "./lib/processes.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const abort = new AbortController();
let supervisor: ProcessSupervisor | undefined;
let removeSignalHandlers: (() => void) | undefined;

async function executable(name: string): Promise<string | undefined> {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const path = join(directory, name);
    try { await access(path, constants.X_OK); return path; } catch { /* Try the next PATH entry. */ }
  }
  return undefined;
}

async function portOccupied(host: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host, port });
    const finish = (occupied: boolean) => { socket.destroy(); resolve(occupied); };
    socket.setTimeout(750);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

async function waitForProxy(proxy: OwnedProcess, url: string) {
  const deadline = Date.now() + 120_000;
  while (!abort.signal.aborted && Date.now() < deadline) {
    if (proxy.result) throw new Error("The API proxy exited before becoming ready. See its output above.");
    if (await probeProxy(url, undefined, abort.signal)) {
      if (proxy.result) throw new Error("The API proxy exited during startup.");
      return;
    }
    await delay(500, undefined, { signal: abort.signal });
  }
  abort.signal.throwIfAborted();
  throw new Error("The API proxy did not become ready within two minutes. Check the installation/network output above.");
}

try {
  assertLauncherPlatform();
  supervisor = new ProcessSupervisor(root);
  removeSignalHandlers = installShutdownHandlers(abort, supervisor);
  const baseUrl = serviceUrl(process.env.COMFY_BASE_URL ?? DEFAULT_PROXY_URL);
  console.info("[h3-motion] Looking for an existing API proxy…");
  const existing = await probeProxy(baseUrl, process.env.COMFY_API_KEY, abort.signal);
  let comfyUrl: string | undefined;
  let startedProxy: OwnedProcess | undefined;
  if (existing) {
    comfyUrl = await resolveComfyUi({ proxyUrl: baseUrl, proxyHealth: existing, explicitUrl: process.env.COMFY_UI_URL, signal: abort.signal });
    console.info(`[h3-motion] Reusing API proxy: ${baseUrl}`);
  } else {
    assertProxyCanStart(process.env.COMFY_API_KEY);
    const address = localProxyAddress(baseUrl);
    if (await portOccupied(address.host, address.port)) {
      throw new Error("The proxy port is already occupied by a service that did not return a healthy Comfy API response. Free that port or change COMFY_BASE_URL. No existing process was stopped.");
    }
    console.info("[h3-motion] Looking for running ComfyUI (Windows/WSL)…");
    comfyUrl = await resolveComfyUi({ proxyUrl: baseUrl, explicitUrl: process.env.COMFY_UI_URL, signal: abort.signal });
    if (!comfyUrl) throw new Error("Set COMFY_UI_URL to a reachable ComfyUI address.");
    console.info(`[h3-motion] Found ComfyUI: ${comfyUrl}`);
    const installed = await executable("comfy-api-proxy");
    const uv = installed ? undefined : await executable("uv");
    if (!installed && !uv) throw new Error("Install uv or comfy-api-proxy in WSL, then rerun npm run dev. ComfyUI itself is already reachable.");
    abort.signal.throwIfAborted();
    console.info("[h3-motion] Starting local API proxy (uv downloads it on first use)…");
    startedProxy = supervisor.launch(installed ?? uv!, [
      ...(installed ? [] : ["tool", "run", "--from", "comfy-api-proxy==0.1.0", "comfy-api-proxy"]),
      "--comfyui", comfyUrl, "--host", address.host, "--port", String(address.port),
      "--max-upload-mb", "500",
    ]);
    await waitForProxy(startedProxy, baseUrl);
    console.info(`[h3-motion] API proxy ready: ${baseUrl}`);
  }
  abort.signal.throwIfAborted();
  const env = { ...process.env, COMFY_BASE_URL: baseUrl, ...(comfyUrl ? { COMFY_UI_URL: comfyUrl } : {}) };
  console.info("[h3-motion] Starting the app. Ctrl+C stops the app and any proxy started by this launcher.");
  const app = supervisor.launch("npm", ["run", "dev:app"], env);
  const result = await Promise.race([
    app.exited.then(exit => ({ source: "app", ...exit })),
    ...(startedProxy ? [startedProxy.exited.then(exit => ({ source: "proxy", ...exit }))] : []),
    new Promise<{ source: string; code: number }>(resolve => abort.signal.addEventListener("abort", () => resolve({ source: "signal", code: 0 }), { once: true })),
  ]);
  if (!abort.signal.aborted) {
    if (result.source === "proxy") throw new Error("The API proxy stopped unexpectedly. Stopping the app; ComfyUI is left running.");
    if ("error" in result && result.error) throw result.error;
    process.exitCode = result.code ?? 1;
  }
} catch (error) {
  if (!abort.signal.aborted) {
    console.error(`[h3-motion] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
} finally {
  await supervisor?.stop();
  removeSignalHandlers?.();
}
