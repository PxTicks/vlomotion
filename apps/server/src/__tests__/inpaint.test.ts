import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { Comfy } from "@comfyorg/sdk";
import type { Job } from "@comfyorg/sdk";
import { createApp } from "../app.js";
import { SessionStore } from "../sessions.js";
import { createManagedJob } from "../jobs/runtime.js";
import { INPAINT_OUTPUT } from "../workflows/templates.js";
import type { ApiGraph } from "../workflows/templates.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = (frames = 124) => readFile(new URL(`./fixtures/black-480-${frames}.mp4`, import.meta.url));
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "h3m-inpaint-")); roots.push(root);
  const store = new SessionStore(root), client = new Comfy();
  const app = createApp({ store, client, health: async () => true });
  const sessionResponse = await app.request("/api/sessions", { method: "POST" });
  const cookie = sessionResponse.headers.get("set-cookie")!.split(";")[0];
  const bytes = new Uint8Array(await fixture());
  const form = new FormData(); form.set("video", new File([bytes], "clip.mp4", { type: "video/mp4" }));
  const response = await app.request("/api/videos", { method: "POST", headers: { cookie }, body: form });
  expect(response.status).toBe(201);
  const video = await response.json();
  const session = [...store.sessions.values()][0];
  const request = { videoId: video.id, width: 480, height: 480, frames: 124, prompt: "A red balloon follows the moving area.", seed: 7 };
  const remote = { status: "succeeded", result: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined),
    async *events() { yield { kind: "progress", value: 0.5, step: 10, steps: 20 }; },
    getOutputs: vi.fn((id: string) => id === INPAINT_OUTPUT ? [{ toBytes: async () => bytes }] : []),
  } as unknown as Job;
  const submit = vi.spyOn(client, "submit").mockResolvedValue(remote);
  const upload = async (settings: unknown = request, options: { mask?: Uint8Array; reference?: Uint8Array; signal?: AbortSignal } = {}) => {
    const data = new FormData(); data.set("request", JSON.stringify(settings));
    data.set("source", new File([bytes], "source.mp4"));
    data.set("mask", new File([new Uint8Array(options.mask ?? bytes)], "mask.mp4"));
    if (options.reference) data.set("reference", new File([new Uint8Array(options.reference)], "reference.png"));
    return app.request("/api/jobs/inpaint", { method: "POST", headers: { cookie }, body: data, signal: options.signal });
  };
  return { app, cookie, session, store, bytes, request, upload, submit, remote };
}

describe("video inpainting", () => {
  it("uploads video metadata and runs one masked-latent sampling pass without a reference", async () => {
    const { session, request, upload, submit, app, cookie } = await setup();
    expect(session.video).toMatchObject({ width: 480, height: 480, frames: 124, duration: expect.closeTo(124 / 24) });
    expect((await upload()).status).toBe(202);
    await session.job!.done;
    const graph = submit.mock.calls[0][0].json as ApiGraph;
    expect(Object.values(graph).filter(n => n.class_type === "SamplerCustomAdvanced")).toHaveLength(1);
    expect(graph["1"].inputs.unet_name).toBe("minimax_h3_ref2va_pruned_int8_convrot.safetensors");
    expect(graph["14"].inputs).toMatchObject({ width: 480, height: 480, length: 124, prompt: request.prompt });
    expect(graph["14"].inputs).not.toHaveProperty("ref_images.ref_image_1");
    expect(graph["17"]).toMatchObject({ class_type: "vloMaskToLatentMask", inputs: { masks: ["10", 0], latent: ["16", 0], pooling_method: "max" } });
    expect(graph["24"].inputs.latent_image).toEqual(["18", 0]);
    expect(graph["27"]).toMatchObject({ class_type: "ImageCompositeMasked", inputs: { destination: ["6", 0], source: ["25", 0], mask: ["10", 0] } });
    expect(session.job!.snapshot).toMatchObject({ status: "completed", stage: "inpaint", inpainting: { videoId: request.videoId, seed: 7, frames: 124 } });
    expect((await app.request(session.inpainting!.video.url, { headers: { cookie, Range: "bytes=0-9" } })).status).toBe(206);
  });
  it("normalizes and binds the optional image as Picture 1", async () => {
    const { upload, session, submit } = await setup();
    const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: "red" } }).png().toBuffer();
    expect((await upload(undefined, { reference: png })).status).toBe(202);
    await session.job!.done;
    const graph = submit.mock.calls[0][0].json as ApiGraph;
    expect(graph.reference.class_type).toBe("LoadImage");
    expect(graph["14"].inputs["ref_images.ref_image_1"]).toEqual(["reference", 0]);
    expect(session.job!.snapshot.status).toBe("completed");
  });
  it("rejects a stale source, changed canvas and mismatched frame counts before submission", async () => {
    const { request, upload, submit } = await setup();
    expect((await upload({ ...request, videoId: crypto.randomUUID() })).status).toBe(409);
    expect((await upload({ ...request, width: 864 })).status).toBe(400);
    expect((await upload({ ...request, frames: 107 })).status).toBe(400);
    expect((await upload(undefined, { mask: new Uint8Array(await fixture(123)) })).status).toBe(400);
    expect(submit).not.toHaveBeenCalled();
  });
  it("rejects unreadable media, empty prompts and concurrent jobs", async () => {
    const { request, upload, submit, session, app, cookie } = await setup();
    expect((await upload({ ...request, prompt: " " })).status).toBe(400);
    expect((await upload(undefined, { reference: new Uint8Array([1, 2]) })).status).toBe(400);
    const data = new FormData(); data.set("video", new File([new Uint8Array([1, 2])], "bad.mp4"));
    expect((await app.request("/api/videos", { method: "POST", headers: { cookie }, body: data })).status).toBe(400);
    session.job = createManagedJob("Busy");
    expect((await upload()).status).toBe(409);
    expect(submit).not.toHaveBeenCalled();
  });
  it("keeps the source session scoped and clears it when switching to the image workflow", async () => {
    const { app, cookie, session, store, request, upload, submit } = await setup();
    const other = store.create();
    expect((await app.request(session.video!.url, { headers: { cookie: `h3m_session=${other.id}` } })).status).toBe(404);
    const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: "red" } }).png().toBuffer();
    const data = new FormData(); data.set("image", new File([new Uint8Array(png)], "photo.png"));
    expect((await app.request("/api/images", { method: "POST", headers: { cookie }, body: data })).status).toBe(201);
    expect(session.video).toBeUndefined();
    expect((await upload(request)).status).toBe(409);
    expect(submit).not.toHaveBeenCalled();
  });
  it("reports missing output and honours cancellation before publishing a result", async () => {
    const { remote, upload, session } = await setup();
    vi.mocked(remote.getOutputs).mockReturnValue([]);
    expect((await upload()).status).toBe(202);
    await session.job!.done;
    expect(session.job!.snapshot).toMatchObject({ status: "failed", error: expect.stringContaining("without a video") });
    expect(session.inpainting).toBeUndefined();
    expect((await upload()).status).toBe(202);
    session.job!.cancelRequested = true;
    await session.job!.done;
    expect(session.job!.snapshot.status).toBe("cancelled");
    expect(session.inpainting).toBeUndefined();
  });
  it("reports unreadable output without exposing decoder errors", async () => {
    const { remote, upload, session } = await setup();
    vi.mocked(remote.getOutputs).mockReturnValue([{ toBytes: async () => new Uint8Array([1, 2, 3]) }] as ReturnType<Job["getOutputs"]>);
    expect((await upload()).status).toBe(202);
    await session.job!.done;
    expect(session.job!.snapshot).toMatchObject({ status: "failed", error: "ComfyUI returned an unreadable video. Try again." });
    expect(session.inpainting).toBeUndefined();
  });
  it("does not submit a GPU job if the upload is aborted during file saving", async () => {
    const { store, upload, submit } = await setup();
    const controller = new AbortController();
    const saveFile = store.saveFile.bind(store);
    vi.spyOn(store, "saveFile").mockImplementation(async (...args) => {
      controller.abort();
      return saveFile(...args);
    });
    const response = await upload(undefined, { signal: controller.signal });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("Inpainting cancelled.");
    expect(submit).not.toHaveBeenCalled();
  });
  it("cancels an eventual GPU handle if the connection is aborted during submission", async () => {
    const { upload, submit, session, remote } = await setup();
    const controller = new AbortController();
    let accepted!: (job: Job) => void;
    submit.mockImplementation(() => new Promise(resolve => { accepted = resolve; }));
    expect((await upload(undefined, { signal: controller.signal })).status).toBe(202);
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
    controller.abort();
    accepted(remote);
    await session.job!.done;
    expect(remote.cancel).toHaveBeenCalledOnce();
    expect(session.job!.snapshot.status).toBe("cancelled");
    expect(session.inpainting).toBeUndefined();
  });
});
