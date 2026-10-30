import { afterEach, describe, expect, it, vi } from "vitest";
import { assertMatchingUpstream, assertProxyCanStart, DEFAULT_COMFY_URL, findComfyUi, isLocalService, localProxyAddress, probeComfy, probeProxy, resolveComfyUi, serviceUrl, windowsGateway } from "../lib/connection.js";

afterEach(() => vi.unstubAllGlobals());

describe("automatic ComfyUI connection", () => {
  it("uses Windows localhost in mirrored mode without querying a NAT gateway", async () => {
    const probe = vi.fn(async () => true);
    const gateway = vi.fn(async () => "172.22.0.1");
    expect(await findComfyUi({ probe, gateway })).toBe(DEFAULT_COMFY_URL);
    expect(gateway).not.toHaveBeenCalled();
  });
  it("tries the Windows NAT gateway only when localhost is unreachable", async () => {
    const probe = vi.fn(async (url: string) => url === "http://172.22.0.1:8188");
    expect(await findComfyUi({ probe, gateway: async () => "172.22.0.1" })).toBe("http://172.22.0.1:8188");
    expect(probe.mock.calls.map(([url]) => url)).toEqual([DEFAULT_COMFY_URL, "http://172.22.0.1:8188"]);
  });
  it("honours an explicit URL and never silently connects to another instance", async () => {
    const gateway = vi.fn(async () => "172.22.0.1");
    const probe = vi.fn(async () => false);
    await expect(findComfyUi({ explicitUrl: "http://windows-box:8000/", probe, gateway })).rejects.toThrow("This launcher never starts ComfyUI");
    expect(probe).toHaveBeenCalledExactlyOnceWith("http://windows-box:8000");
    expect(gateway).not.toHaveBeenCalled();
  });
  it("reports a stopped ComfyUI with an actionable message", async () => {
    await expect(findComfyUi({ probe: async () => false, gateway: async () => undefined })).rejects.toThrow("Start ComfyUI on Windows");
  });
  it("ignores mirrored routes without via and parses a NAT gateway", () => {
    expect(windowsGateway("default dev eth2 proto kernel\ndefault via 172.22.0.1 dev eth0")).toBe("172.22.0.1");
    expect(windowsGateway("default dev eth2 proto kernel")).toBeUndefined();
    expect(windowsGateway("default via not-an-address dev eth0")).toBeUndefined();
  });
  it("treats only loopback services as local", () => {
    expect(isLocalService("http://127.0.0.1:8189")).toBe(true);
    expect(isLocalService("localhost:8191")).toBe(true);
    expect(isLocalService("https://my-deployment.run.comfy.app")).toBe(false);
  });
  it("starts proxies only on a local HTTP address and supports a custom port", () => {
    expect(localProxyAddress("http://localhost:8191")).toEqual({ host: "127.0.0.1", port: 8191 });
    expect(() => localProxyAddress("https://remote.example:8189")).toThrow("local HTTP");
    expect(() => localProxyAddress("http://127.0.0.1:8189/prefix")).toThrow("local HTTP");
    expect(() => serviceUrl("http://user:secret@localhost:8189")).toThrow("without credentials");
  });
  it("leaves a mismatched existing proxy alone", () => {
    expect(() => assertMatchingUpstream("http://127.0.0.1:8188", { status: "healthy", upstream: "http://localhost:8188/" })).not.toThrow();
    expect(() => assertMatchingUpstream("http://127.0.0.1:8188", { status: "healthy", upstream: "http://elsewhere:8188" })).toThrow("left running");
  });
  it("normalizes scheme-less upstreams, loopback aliases and default HTTP ports", async () => {
    expect(serviceUrl("127.0.0.1:8188")).toBe(DEFAULT_COMFY_URL);
    expect(() => assertMatchingUpstream("http://127.0.0.1", { status: "healthy", upstream: "http://localhost:80/" })).not.toThrow();
    expect(() => assertMatchingUpstream(DEFAULT_COMFY_URL, { status: "healthy", upstream: "localhost:8188" })).not.toThrow();
    expect(() => assertMatchingUpstream(DEFAULT_COMFY_URL, { status: "healthy", upstream: "http://localhost" })).toThrow("different ComfyUI");
    const fetch = vi.fn(async () => Response.json({ status: "healthy", upstream: "127.0.0.1:8188" }));
    vi.stubGlobal("fetch", fetch);
    expect(await probeProxy("http://127.0.0.1:8189")).toMatchObject({ upstream: DEFAULT_COMFY_URL });
  });
  it("shares gateway discovery with the environment checker, even without a proxy", async () => {
    const probe = vi.fn(async (url: string) => url === "http://172.22.0.1:8188");
    expect(await resolveComfyUi({ proxyUrl: "http://127.0.0.1:8189", proxyHealth: null,
      probe, gateway: async () => "172.22.0.1" })).toBe("http://172.22.0.1:8188");
  });
  it("inspects an existing local proxy's actual upstream instead of a second default instance", async () => {
    const probe = vi.fn(async () => true);
    expect(await resolveComfyUi({ proxyUrl: "http://127.0.0.1:8189",
      proxyHealth: { status: "healthy", upstream: "127.0.0.1:8000" }, probe })).toBe("http://127.0.0.1:8000");
    expect(probe).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:8000");
  });
  it("does not inspect local inventory for a remote proxy without an override", async () => {
    const probe = vi.fn(async () => true);
    expect(await resolveComfyUi({ proxyUrl: "https://remote.example", proxyHealth: { status: "healthy", upstream: DEFAULT_COMFY_URL }, probe })).toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });
  it("rejects authenticated proxy autostart before discovery is attempted", () => {
    expect(() => assertProxyCanStart("private-test-key")).toThrow("Start your authenticated proxy separately");
    expect(() => assertProxyCanStart(" ")).not.toThrow();
  });
  it("probes the native ComfyUI endpoint without an SDK /api/v2 prefix", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ system: { comfyui_version: "test" }, devices: [] }));
    vi.stubGlobal("fetch", fetch);
    expect(await probeComfy(DEFAULT_COMFY_URL)).toBe(true);
    expect(fetch.mock.calls[0]?.[0]).toBe("http://127.0.0.1:8188/system_stats");
  });
  it("checks proxy health contents and does not mistake an unrelated service for Comfy", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ status: "healthy", upstream: DEFAULT_COMFY_URL }))
      .mockResolvedValueOnce(Response.json({ unrelated: true }))
      .mockResolvedValueOnce(new Response("<html>Some other server</html>"));
    vi.stubGlobal("fetch", fetch);
    expect(await probeProxy("http://127.0.0.1:8189")).toEqual({ status: "healthy", upstream: DEFAULT_COMFY_URL });
    expect(fetch.mock.calls[0]?.[0]).toBe("http://127.0.0.1:8189/api/v2/health");
    expect(await probeProxy("http://127.0.0.1:8189")).toBeNull();
    expect(await probeComfy(DEFAULT_COMFY_URL)).toBe(false);
  });
});
