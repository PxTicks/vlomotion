import { execFile } from "node:child_process";
import { isIP } from "node:net";
import { promisify } from "node:util";
import { ComfyLow } from "@comfyorg/sdk/low";
import { z } from "zod";
// Source import lets the launcher run before the shared workspace is built.
import { DEFAULT_COMFY_URL } from "../../packages/shared/src/config.js";
export { DEFAULT_COMFY_URL, DEFAULT_PROXY_URL } from "../../packages/shared/src/config.js";

const execute = promisify(execFile);
const proxyHealthSchema = z.object({ status: z.enum(["healthy", "ok"]), upstream: z.string().optional() });
export type ProxyHealth = z.infer<typeof proxyHealthSchema>;
export type ComfyProbe = (url: string) => Promise<boolean>;

export function serviceUrl(value: string): string {
  const input = value.trim();
  const url = new URL(input.includes("://") ? input : `http://${input}`);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Use an HTTP(S) service URL without credentials, a query or a fragment.");
  }
  return url.href.replace(/\/+$/, "");
}

export async function probeComfy(url: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const client = new ComfyLow(url, undefined, { timeoutMs: 1500 });
    const response = await client.request("GET", `${serviceUrl(url)}/system_stats`, { signal });
    if (!response.ok) { await response.body?.cancel(); return false; }
    return z.object({ system: z.record(z.string(), z.unknown()), devices: z.array(z.unknown()) }).safeParse(await response.json()).success;
  } catch { return false; }
}

export async function probeProxy(url: string, apiKey?: string, signal?: AbortSignal): Promise<ProxyHealth | null> {
  try {
    const client = new ComfyLow(url, apiKey, { timeoutMs: 1500 });
    const response = await client.request("GET", "/api/v2/health", { signal });
    if (!response.ok) { await response.body?.cancel(); return null; }
    const parsed = proxyHealthSchema.safeParse(await response.json());
    return parsed.success ? { ...parsed.data, ...(parsed.data.upstream ? { upstream: serviceUrl(parsed.data.upstream) } : {}) } : null;
  } catch { return null; }
}

export function windowsGateway(routes: string): string | undefined {
  const host = routes.match(/^default\s+via\s+(\S+)/m)?.[1];
  return host && isIP(host) === 4 ? host : undefined;
}

export async function getWindowsGateway(): Promise<string | undefined> {
  if (!process.env.WSL_INTEROP && !process.env.WSL_DISTRO_NAME) return undefined;
  try {
    // Mirrored mode's default gateway can be the LAN router, rather than Windows.
    const mode = await execute("wslinfo", ["--networking-mode"], { timeout: 2000 });
    if (mode.stdout.trim() !== "nat") return undefined;
  } catch { /* Older WSL versions have NAT networking but no wslinfo command. */ }
  try {
    const routes = await execute("ip", ["-4", "route", "show", "default"], { timeout: 2000 });
    return windowsGateway(routes.stdout);
  } catch { return undefined; }
}

export async function findComfyUi(options: {
  explicitUrl?: string;
  probe?: ComfyProbe;
  gateway?: () => Promise<string | undefined>;
} = {}): Promise<string> {
  const probe = options.probe ?? probeComfy;
  const candidates = [serviceUrl(options.explicitUrl ?? DEFAULT_COMFY_URL)];
  if (await probe(candidates[0])) return candidates[0];
  if (!options.explicitUrl) {
    const gateway = await (options.gateway ?? getWindowsGateway)();
    if (gateway) {
      const url = `http://${gateway}:8188`;
      candidates.push(url);
      if (await probe(url)) return url;
    }
  }
  throw new Error(`No running ComfyUI found at ${candidates.join(" or ")}. Start ComfyUI on Windows, or set COMFY_UI_URL in .env to its reachable address. This launcher never starts ComfyUI.`);
}

export function localProxyAddress(value: string): { host: string; port: number } {
  const url = new URL(serviceUrl(value));
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/") {
    throw new Error("The configured COMFY_BASE_URL is not a running proxy. Automatic proxy startup supports local HTTP URLs only; start your remote proxy separately.");
  }
  return { host: "127.0.0.1", port: Number(url.port || 80) };
}

export function assertMatchingUpstream(explicitUrl: string | undefined, health: ProxyHealth): void {
  if (!explicitUrl || !health.upstream) return;
  const normalize = (value: string) => {
    const url = new URL(serviceUrl(value));
    if (url.hostname === "localhost") url.hostname = "127.0.0.1";
    return url.href;
  };
  if (normalize(explicitUrl) !== normalize(health.upstream)) {
    throw new Error("The existing proxy points at a different ComfyUI than COMFY_UI_URL. Correct the configuration or choose another local proxy port with COMFY_BASE_URL. The existing proxy has been left running.");
  }
}

export function assertProxyCanStart(apiKey: string | undefined): void {
  if (apiKey?.trim()) throw new Error("COMFY_API_KEY is set. Start your authenticated proxy separately, or unset the key to let the launcher start a local proxy.");
}

/** Shared by the launcher and environment checker so both inspect the same GPU. */
export async function resolveComfyUi(options: {
  proxyUrl: string;
  proxyHealth?: ProxyHealth | null;
  explicitUrl?: string;
  probe?: ComfyProbe;
  gateway?: () => Promise<string | undefined>;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  if (options.proxyHealth) assertMatchingUpstream(options.explicitUrl, options.proxyHealth);
  const local = ["localhost", "127.0.0.1"].includes(new URL(serviceUrl(options.proxyUrl)).hostname);
  // A remote proxy's loopback upstream belongs to its host, not this WSL instance.
  if (options.proxyHealth && !local && !options.explicitUrl) return undefined;
  return findComfyUi({
    explicitUrl: options.explicitUrl ?? (local ? options.proxyHealth?.upstream : undefined),
    probe: options.probe ?? (url => probeComfy(url, options.signal)),
    gateway: options.gateway,
  });
}
