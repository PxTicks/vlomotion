import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { Comfy } from "@comfyorg/sdk";
import type { Job } from "@comfyorg/sdk";
import { DEFAULT_CAPTION } from "@h3-motion/shared";
import type { AnimateRequest } from "@h3-motion/shared";
import { createApp } from "../app.js";
import { SessionStore } from "../sessions.js";
import { encodeMask } from "../media/masks.js";
import { ANIMATE_BINDINGS, ANIMATE_MODEL, ANIMATE_OUTPUT } from "../workflows/templates.js";
import { stageProgress } from "../jobs/runtime.js";
import type { ApiGraph } from "../workflows/templates.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = (frames: 123 | 124) => readFile(new URL(`./fixtures/black-480-${frames}.mp4`, import.meta.url));

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "h3m-animate-")); roots.push(root);
  const store = new SessionStore(root), client = new Comfy();
  const app = createApp({ store, client, health: async () => true });
  const response = await app.request("/api/sessions", { method: "POST" });
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  const session = [...store.sessions.values()][0];
  const png = await encodeMask(Uint8Array.from([0, 255, 0, 0]), 2, 2);
  session.image = { ...await store.savePng(session, png), width: 2, height: 2 };
  session.selection = { ...await store.savePng(session, png), width: 2, height: 2 };
  const plate = await store.savePng(session, png);
  session.isolation = { imageId: session.image.id, maskId: session.selection.id, plate: { id: plate.id, url: plate.url, width: 2, height: 2 },
    phrase: "the brown dog", caption: DEFAULT_CAPTION, descriptionSource: "model", instructionSource: "model", instruction: "Remove it.", seed: 1 };
  const request: AnimateRequest = { imageId: session.image.id, maskId: session.selection.id, plateId: plate.id,
    width: 480, height: 480, frames: 124, prompt: "A dog runs.", lockIn: 6, seed: 7 };
  return { app, client, session, cookie, request };
}

async function upload(app: ReturnType<typeof createApp>, cookie: string, request: unknown,
  files: { reference?: Uint8Array; mask?: Uint8Array; start?: Uint8Array } = {}) {
  const form = new FormData();
  form.set("request", JSON.stringify(request));
  const reference = files.reference ?? await fixture(124);
  form.set("reference", new File([new Uint8Array(reference)], "reference.mp4", { type: "video/mp4" }));
  form.set("mask", new File([new Uint8Array(files.mask ?? reference)], "mask.mp4", { type: "video/mp4" }));
  const start = files.start ?? await sharp({ create: { width: 480, height: 480, channels: 3, background: "#000" } }).png().toBuffer();
  form.set("start", new File([new Uint8Array(start)], "start.png", { type: "image/png" }));
  return app.request("/api/jobs/animate", { method: "POST", headers: { cookie }, body: form });
}

function remote(video: Uint8Array): Job {
  return { status: "succeeded", result: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined),
    async *events() { yield { kind: "progress", value: 0.5, message: "Sampling" }; },
    getOutputs: vi.fn((id: string) => id === ANIMATE_OUTPUT ? [{ toBytes: async () => video }] : []),
  } as unknown as Job;
}

describe("animate job", () => {
  it("accepts an arbitrary photo ratio, generates on a strided canvas and delivers the restored dimensions", async () => {
    const { app, client, session, cookie, request } = await setup();
    session.image = { ...session.image!, width: 1000, height: 701 };
    const video = new Uint8Array(await readFile(new URL("./fixtures/black-686x480-124.mp4", import.meta.url)));
    const submit = vi.spyOn(client, "submit").mockResolvedValue(remote(video));
    const start = await sharp({ create: { width: 686, height: 480, channels: 3, background: "#000" } }).png().toBuffer();
    expect((await upload(app, cookie, { ...request, width: 686 }, { reference: video, mask: video, start })).status).toBe(202);
    await session.job!.done;
    const graph = submit.mock.calls[0][0].json as ApiGraph;
    expect(graph["14"].inputs).toMatchObject({ width: 672, height: 480 });
    expect(graph["29"].inputs).toMatchObject({ width: 686, height: 480, crop: "disabled" });
    expect(session.job!.snapshot).toMatchObject({ status: "completed", animation: { width: 686, height: 480 } });
  });
  it.each([2, 6, 8, 15])("submits lock-in %i with the request's settings and serves the generated video with byte ranges", async lockIn => {
    const { app, client, session, cookie, request } = await setup();
    const video = new Uint8Array(await fixture(124));
    const submit = vi.spyOn(client, "submit").mockResolvedValue(remote(video));
    const response = await upload(app, cookie, { ...request, lockIn });
    expect(response.status).toBe(202);
    await session.job!.done;
    const json = submit.mock.calls[0][0].json as ApiGraph;
    expect(json[ANIMATE_BINDINGS.prompt.node].inputs).toMatchObject({ prompt: "A dog runs.", width: 480, height: 480, length: 124 });
    expect(json[ANIMATE_BINDINGS.lockIn.node].inputs).toMatchObject({ start_step: 1, end_step: lockIn });
    expect(json[ANIMATE_MODEL.scheduler.node].inputs.steps).toBe(25);
    expect(json[ANIMATE_BINDINGS.seed.node].inputs.noise_seed).toBe(7);
    expect(json[ANIMATE_BINDINGS.grow.node].inputs.expand).toBe(-16);
    expect(session.job!.snapshot).toMatchObject({ status: "completed", stage: "animate", animation: { seed: 7, frames: 124, lockIn } });
    const { url } = session.animation!.video;
    const full = await app.request(url, { headers: { cookie } });
    expect(full.headers.get("content-type")).toBe("video/mp4");
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(video);
    const partial = await app.request(url, { headers: { cookie, Range: "bytes=10-19" } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe(`bytes 10-19/${video.length}`);
    expect(new Uint8Array(await partial.arrayBuffer())).toEqual(video.subarray(10, 20));
  });
  it("rejects lock-in values outside 2–15 or fractional steps before submitting", async () => {
    const { app, client, cookie, request } = await setup();
    const submit = vi.spyOn(client, "submit");
    for (const lockIn of [1, 8.5, 16]) {
      expect((await upload(app, cookie, { ...request, lockIn })).status).toBe(400);
    }
    expect(submit).not.toHaveBeenCalled();
  });
  it("rejects videos without exactly the requested frames before submitting", async () => {
    const { app, client, cookie, request } = await setup();
    const submit = vi.spyOn(client, "submit");
    const response = await upload(app, cookie, request, { mask: new Uint8Array(await fixture(123)) });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/mask video must be 480 × 480 with exactly 124 frames; it is 480 × 480 with 123/);
    expect(submit).not.toHaveBeenCalled();
  });
  it("rejects sizes the app can't produce, mismatched start frames and unreadable videos", async () => {
    const { app, cookie, request } = await setup();
    expect((await upload(app, cookie, { ...request, width: 512, height: 512 })).status).toBe(400);
    expect((await upload(app, cookie, { ...request, width: 864, height: 480 })).status).toBe(400);
    const small = await sharp({ create: { width: 32, height: 32, channels: 3, background: "#000" } }).png().toBuffer();
    expect((await (await upload(app, cookie, request, { start: small })).json()).error).toMatch(/start frame must be a 480 × 480 PNG/);
    expect((await (await upload(app, cookie, request, { reference: new Uint8Array([1, 2, 3]) })).json()).error).toMatch(/reference video can't be read/);
  });
  it("answers a request that isn't a form with a clear error", async () => {
    const { app, cookie } = await setup();
    const response = await app.request("/api/jobs/animate", { method: "POST", headers: { cookie } });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/multipart form/);
  });
  it("refuses a background that is no longer current", async () => {
    const { app, cookie, request } = await setup();
    const response = await upload(app, cookie, { ...request, plateId: "4d4f3a2e-5d61-4c38-9a59-5a5ad5f6a1b2" });
    expect(response.status).toBe(409);
  });
  it("reports a failed generation as a terminal job", async () => {
    const { app, client, session, cookie, request } = await setup();
    vi.spyOn(client, "submit").mockResolvedValue({ ...remote(new Uint8Array()), getOutputs: vi.fn(() => []) } as unknown as Job);
    expect((await upload(app, cookie, request)).status).toBe(202);
    await session.job!.done;
    expect(session.job!.snapshot).toMatchObject({ status: "failed", error: "Generation completed without a video. Try again." });
    expect(session.animation).toBeUndefined();
  });
  it("reports sampler steps rather than the proxy's finished-node fraction", () => {
    // Observed on a real H3 run: 20 of 21 nodes are done (value 0.95) when sampling starts.
    const base = { kind: "progress" as const, message: null, nodesDone: 20, nodesTotal: 21, currentNode: "21", currentNodeClass: null };
    expect(stageProgress({ ...base, value: 0.4, step: null, steps: null }, false)).toEqual({ fraction: expect.closeTo(0.02), detail: null });
    expect(stageProgress({ ...base, value: 0.95, step: 1, steps: 20 }, false)).toEqual({ fraction: 0.05 + 0.9 / 20, detail: "Step 1 of 20." });
    expect(stageProgress({ ...base, value: 0.95, step: 20, steps: 20 }, true).fraction).toBeCloseTo(0.95);
    expect(stageProgress({ ...base, value: 1, step: null, steps: null }, true)).toEqual({ fraction: 0.95, detail: "Finishing…" });
  });
});
