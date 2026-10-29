import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { Comfy } from "@comfyorg/sdk";
import type { Job, Output } from "@comfyorg/sdk";
import { createApp } from "../app.js";
import { SessionStore } from "../sessions.js";
import { createManagedJob } from "../jobs/runtime.js";
import { frameOrder } from "../jobs/track.js";
import { measureMask } from "../media/masks.js";
import { TRACK_OUTPUT } from "../workflows/templates.js";
import type { ApiGraph } from "../workflows/templates.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const size = 480;
/** A white square mask on black, as SAM3_TrackToMask → MaskToImage saves it; side 0 is an empty frame. */
async function maskPng(x: number, y: number, side: number) {
  const pixels = Buffer.alloc(size * size * 3);
  for (let row = y; row < y + side; row++) for (let column = x; column < x + side; column++) pixels.fill(255, (row * size + column) * 3, (row * size + column) * 3 + 3);
  return sharp(pixels, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer();
}
const output = (name: string, bytes: Uint8Array) => ({ name, toBytes: async () => bytes }) as unknown as Output;

async function setup(masks?: Output[]) {
  const root = await mkdtemp(join(tmpdir(), "h3m-track-")); roots.push(root);
  const store = new SessionStore(root), client = new Comfy();
  const app = createApp({ store, client, health: async () => true });
  const cookie = (await app.request("/api/sessions", { method: "POST" })).headers.get("set-cookie")!.split(";")[0];
  const bytes = new Uint8Array(await readFile(new URL("./fixtures/black-480-124.mp4", import.meta.url)));
  const form = new FormData(); form.set("video", new File([bytes], "clip.mp4", { type: "video/mp4" }));
  const video = await (await app.request("/api/videos", { method: "POST", headers: { cookie }, body: form })).json();
  const session = [...store.sessions.values()][0];
  const request = { videoId: video.id, width: 480, height: 480, frames: 124, positive: [{ x: 100.4, y: 120.6 }] };
  // The object moves right two pixels a frame and is lost on frame 60. Names are deliberately out of order.
  const frames = masks ?? await Promise.all(Array.from({ length: 124 }, async (_, i) =>
    output(`track_${String(i + 1).padStart(5, "0")}_.png`, await maskPng(80 + 2 * i, 100, i === 60 ? 0 : 40))));
  const remote = { status: "succeeded", result: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined),
    async *events() { yield { kind: "progress", value: 0.5, step: 10, steps: 124 }; },
    getOutputs: vi.fn((id: string) => id === TRACK_OUTPUT ? [...frames].reverse() : []),
  } as unknown as Job;
  const submit = vi.spyOn(client, "submit").mockResolvedValue(remote);
  const upload = async (settings: unknown = request, source: Uint8Array = bytes, signal?: AbortSignal) => {
    const data = new FormData(); data.set("request", JSON.stringify(settings));
    data.set("source", new File([new Uint8Array(source)], "source.mp4"));
    return app.request("/api/jobs/track", { method: "POST", headers: { cookie }, body: data, signal });
  };
  return { session, store, request, upload, submit, remote };
}

describe("object tracking", () => {
  it("segments the clicked object on the first frame and tracks it through the prepared video", async () => {
    const { session, upload, submit } = await setup();
    expect((await upload()).status).toBe(202);
    await session.job!.done;
    const graph = submit.mock.calls[0][0].json as ApiGraph;
    expect(graph["5"].inputs).toMatchObject({ positive_coords: JSON.stringify([{ x: 100, y: 121 }]), negative_coords: "[]", image: ["4", 0] });
    expect(graph["6"].inputs).toMatchObject({ images: ["3", 0], initial_mask: ["5", 0], max_objects: 1 });
    expect(graph["7"].inputs.object_indices).toBe("0");
    const { snapshot } = session.job!;
    expect(snapshot).toMatchObject({ status: "completed", stage: "track", progress: 1, message: "Tracked the object. It was out of view for 1 of 124 frames." });
    const frames = snapshot.tracking!.frames;
    expect(frames).toHaveLength(124);
    expect(frames[0]).toEqual({ area: 1600, x: 100, y: 120, bounds: { x: 80, y: 100, width: 40, height: 40 } });
    expect(frames[123]).toMatchObject({ x: 100 + 2 * 123 });
    expect(frames[60]).toBeNull();
  });
  it("fails when SAM can't find the object on the first frame, or returns the wrong number of frames", async () => {
    const empty = output("track_00001_.png", await maskPng(0, 0, 0)), square = await maskPng(10, 10, 20);
    const missing = await setup([empty, ...Array.from({ length: 123 }, (_, i) => output(`track_${String(i + 2).padStart(5, "0")}_.png`, square))]);
    await missing.upload(); await missing.session.job!.done;
    expect(missing.session.job!.snapshot).toMatchObject({ status: "failed", error: "SAM couldn't find the object on the first frame. Click on it again." });
    const short = await setup([output("track_00001_.png", square)]);
    await short.upload(); await short.session.job!.done;
    expect(short.session.job!.snapshot).toMatchObject({ status: "failed", error: "Tracking returned 1 frames instead of 124. Try again." });
  });
  it("rejects stale videos, mismatched preparation, out-of-frame points and concurrent jobs before submission", async () => {
    const { request, upload, submit, session } = await setup();
    expect((await upload({ ...request, videoId: crypto.randomUUID() })).status).toBe(409);
    expect((await upload({ ...request, frames: 107 })).status).toBe(400);
    expect((await upload({ ...request, positive: [{ x: 480, y: 10 }] })).status).toBe(400);
    expect((await upload({ ...request, positive: [] })).status).toBe(400);
    expect((await upload(undefined, new Uint8Array(await readFile(new URL("./fixtures/black-480-123.mp4", import.meta.url))))).status).toBe(400);
    session.job = createManagedJob("Busy");
    expect((await upload()).status).toBe(409);
    expect(submit).not.toHaveBeenCalled();
  });
  it("does not submit a GPU job if the upload is aborted during file saving", async () => {
    const { store, upload, submit, session } = await setup();
    const controller = new AbortController();
    const saveFile = store.saveFile.bind(store);
    vi.spyOn(store, "saveFile").mockImplementation(async (...args) => { controller.abort(); return saveFile(...args); });
    const response = await upload(undefined, undefined, controller.signal);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("Tracking cancelled.");
    expect(submit).not.toHaveBeenCalled();
    expect(session.job).toBeUndefined();
  });
  it("cancels an eventual GPU handle if the connection is aborted during submission", async () => {
    const { upload, submit, session, remote } = await setup();
    const controller = new AbortController();
    let accepted!: (job: Job) => void;
    submit.mockImplementation(() => new Promise(resolve => { accepted = resolve; }));
    expect((await upload(undefined, undefined, controller.signal)).status).toBe(202);
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
    controller.abort();
    accepted(remote);
    await session.job!.done;
    expect(remote.cancel).toHaveBeenCalledOnce();
    expect(session.job!.snapshot).toMatchObject({ status: "cancelled", message: "Tracking cancelled." });
    expect(session.job!.snapshot.tracking).toBeUndefined();
  });
});

describe("tracked mask measurement", () => {
  it("measures the area, pixel median and bounds of a mask, and nothing for an empty one", async () => {
    const pixels = Buffer.alloc(size * size * 3);
    // An L shape: a 10 × 30 bar with a 30 × 10 foot, so the median sits off the bounding box centre.
    for (let row = 0; row < 30; row++) for (let column = 0; column < 10; column++) pixels.fill(255, (row * size + column) * 3, (row * size + column) * 3 + 3);
    for (let row = 20; row < 30; row++) for (let column = 10; column < 30; column++) pixels.fill(255, (row * size + column) * 3, (row * size + column) * 3 + 3);
    const png = await sharp(pixels, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer();
    expect(await measureMask(png, size, size)).toEqual({ area: 500, x: 8.5, y: 21.5, bounds: { x: 0, y: 0, width: 30, height: 30 } });
    expect(await measureMask(await maskPng(0, 0, 0), size, size)).toBeNull();
  });
  it("orders frames by SaveImage's counter, and keeps ComfyUI's order without one", () => {
    const named = ["track_00010_.png", "track_00002_.png", "track_00001_.png"].map(name => output(name, new Uint8Array()));
    expect(frameOrder(named).map(frame => frame.name)).toEqual(["track_00001_.png", "track_00002_.png", "track_00010_.png"]);
    const unnamed = ["b.png", "a.png"].map(name => output(name, new Uint8Array()));
    expect(frameOrder(unnamed).map(frame => frame.name)).toEqual(["b.png", "a.png"]);
  });
});
