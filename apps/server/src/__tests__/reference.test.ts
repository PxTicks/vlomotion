import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { Comfy } from "@comfyorg/sdk";
import type { Job } from "@comfyorg/sdk";
import { createApp } from "../app.js";
import { SessionStore } from "../sessions.js";
import { ISOLATE_OUTPUT, OBJECT_OUTPUT } from "../workflows/templates.js";
import type { ApiGraph } from "../workflows/templates.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const solid = (width: number, height: number, background: string) => sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();
/** A black mask with a white box. */
const boxMask = async (width: number, height: number, box = { left: 8, top: 8, width: 16, height: 16 }) =>
  sharp(await solid(width, height, "black")).composite([{ input: await solid(box.width, box.height, "white"), left: box.left, top: box.top }]).png().toBuffer();

async function setup(output: Buffer) {
  const root = await mkdtemp(join(tmpdir(), "h3m-reference-")); roots.push(root);
  const store = new SessionStore(root), client = new Comfy();
  const app = createApp({ store, client, health: async () => true });
  const cookie = (await app.request("/api/sessions", { method: "POST" })).headers.get("set-cookie")!.split(";")[0];
  const form = new FormData();
  form.set("video", new File([new Uint8Array(await readFile(new URL("./fixtures/black-480-124.mp4", import.meta.url)))], "clip.mp4", { type: "video/mp4" }));
  const video = await (await app.request("/api/videos", { method: "POST", headers: { cookie }, body: form })).json();
  const session = [...store.sessions.values()][0];
  const remote = { status: "succeeded", result: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined),
    async *events() { yield { kind: "progress", value: 0.5, step: 12, steps: 25 }; },
    getOutputs: vi.fn((id: string) => [OBJECT_OUTPUT, ISOLATE_OUTPUT].includes(id) ? [{ toBytes: async () => output }] : []),
  } as unknown as Job;
  const submit = vi.spyOn(client, "submit").mockResolvedValue(remote);
  const request = async (settings: object, files: { image?: Buffer; mask?: Buffer } = {}) => {
    const data = new FormData(); data.set("request", JSON.stringify({ videoId: video.id, ...settings }));
    if (files.image) data.set("image", new File([new Uint8Array(files.image)], "frame.png"));
    if (files.mask) data.set("mask", new File([new Uint8Array(files.mask)], "mask.png"));
    return app.request("/api/jobs/reference", { method: "POST", headers: { cookie }, body: data });
  };
  return { app, cookie, session, video, submit, request };
}

describe("inpaint reference images", () => {
  it("draws an object from its description with Qwen Image text-to-image", async () => {
    const { session, submit, request, video, app, cookie } = await setup(await solid(1024, 1024, "red"));
    expect((await request({ kind: "object", description: "a red paper lantern", seed: 3 })).status).toBe(202);
    await session.job!.done;
    const graph = submit.mock.calls[0][0].json as ApiGraph;
    expect(graph["6"].inputs).toMatchObject({ resolution: 1024, prompt: expect.stringMatching(/^A reference photo of a red paper lantern: /) });
    expect(Object.keys(graph["6"].inputs).filter(input => input.startsWith("images."))).toEqual([]);
    expect(graph["8"].inputs).toMatchObject({ seed: 3, latent_image: ["6", 2] });
    expect(session.job!.snapshot).toMatchObject({ status: "completed", stage: "reference",
      reference: { videoId: video.id, kind: "object", description: "a red paper lantern", frame: null, seed: 3, image: { width: 1024, height: 1024 } } });
    expect((await app.request(session.job!.snapshot.reference!.image.url, { headers: { cookie } })).status).toBe(200);
  });
  it("edits a frame inside its mask, placed by the highlighted frame as the second image", async () => {
    const { session, submit, request } = await setup(await solid(64, 48, "blue"));
    const files = { image: await solid(64, 48, "green"), mask: await boxMask(64, 48) };
    expect((await request({ kind: "frame", description: "a red umbrella", frame: 49, seed: 5 }, files)).status).toBe(202);
    await session.job!.done;
    const graph = submit.mock.calls[0][0].json as ApiGraph;
    expect(graph["6"].inputs).toMatchObject({ "images.image_1": ["11", 0], "images.image_2": ["highlight", 0],
      prompt: expect.stringMatching(/^In <image1>, make the area highlighted in yellow in <image2> show a red umbrella\./) });
    expect(graph.highlight.class_type).toBe("LoadImage");
    expect(graph["18"]).toMatchObject({ class_type: "ImageCompositeMasked", inputs: { destination: ["1", 0], source: ["12", 0], mask: ["17", 0] } });
    // Qwen edits on a canvas rounded to 32 px; the edit is scaled back to the frame before compositing.
    expect(graph["11"].inputs).toMatchObject({ width: 64, height: 64 });
    expect(session.job!.snapshot).toMatchObject({ status: "completed", reference: { kind: "frame", frame: 49, image: { width: 64, height: 48 } } });
  });
  it("rejects an edited frame that came back at another size", async () => {
    const { session, request } = await setup(await solid(32, 32, "blue"));
    expect((await request({ kind: "frame", description: "a cat", frame: 0 }, { image: await solid(64, 48, "green"), mask: await boxMask(64, 48) })).status).toBe(202);
    await session.job!.done;
    expect(session.job!.snapshot).toMatchObject({ status: "failed", error: expect.stringMatching(/doesn't match the video frame/) });
  });
  it("checks the frame, its mask and the source before submitting", async () => {
    const { request, submit, session } = await setup(await solid(8, 8, "red"));
    const image = await solid(64, 48, "green");
    expect((await request({ kind: "frame", description: "a cat", frame: 0 }, { image })).status).toBe(400);
    expect((await request({ kind: "frame", description: "a cat", frame: 0 }, { image, mask: await boxMask(32, 32) })).status).toBe(400);
    const empty = await request({ kind: "frame", description: "a cat", frame: 0 }, { image, mask: await solid(64, 48, "black") });
    expect(await empty.json()).toMatchObject({ error: expect.stringMatching(/outside the frame/) });
    expect((await request({ kind: "frame", description: "a cat", frame: 124 }, { image, mask: await boxMask(64, 48) })).status).toBe(400);
    expect((await request({ kind: "object", description: " " })).status).toBe(400);
    session.video = { ...session.video!, id: crypto.randomUUID() };
    expect((await request({ kind: "object", description: "a cat" })).status).toBe(409);
    expect(submit).not.toHaveBeenCalled();
  });
});
