import { afterEach, describe, expect, it, vi } from "vitest";
import { createMotion } from "@h3-motion/shared";
import type { RenderLayers } from "../../motion";
import { renderMotionVideos } from "../renderMotion";
import type { EncodeMessage } from "../encode.worker";

const layers = { width: 864, height: 480, photo: {}, plate: {}, cutout: {}, matte: {} } as RenderLayers;
const size = { width: 864, height: 480 };
const motion = createMotion({ x: 400, y: 240 });
const bitmap = () => ({ close: vi.fn() }) as unknown as ImageBitmap;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

class EncoderWorker {
  static instances: EncoderWorker[] = [];
  onmessage?: (event: { data: EncodeMessage }) => void;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { EncoderWorker.instances.push(this); }
}

afterEach(() => { vi.unstubAllGlobals(); EncoderWorker.instances = []; });

describe("motion rendering cancellation", () => {
  it("cancels during bitmap preparation immediately and closes copies that finish later", async () => {
    const copies = Array.from({ length: 4 }, () => deferred<ImageBitmap>());
    const bitmaps = copies.map(() => bitmap());
    let index = 0;
    vi.stubGlobal("createImageBitmap", vi.fn(() => copies[index++].promise));
    vi.stubGlobal("Worker", EncoderWorker);
    const controller = new AbortController();
    const rendering = renderMotionVideos(layers, motion, size, vi.fn(), controller.signal);
    copies[0].resolve(bitmaps[0]);
    await Promise.resolve();
    controller.abort();
    await expect(rendering).rejects.toMatchObject({ name: "AbortError" });
    expect(bitmaps[0].close).toHaveBeenCalledOnce();
    for (let i = 1; i < copies.length; i++) copies[i].resolve(bitmaps[i]);
    await Promise.resolve();
    for (const copy of bitmaps) expect(copy.close).toHaveBeenCalledOnce();
    expect(EncoderWorker.instances).toHaveLength(0);
  });
  it("terminates an active encoder on cancellation", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn(async () => bitmap()));
    vi.stubGlobal("Worker", EncoderWorker);
    const controller = new AbortController();
    const rendering = renderMotionVideos(layers, motion, size, vi.fn(), controller.signal);
    await vi.waitFor(() => expect(EncoderWorker.instances).toHaveLength(1));
    const worker = EncoderWorker.instances[0];
    expect(worker.postMessage).toHaveBeenCalledOnce();
    controller.abort();
    await expect(rendering).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it("releases the other copies if bitmap preparation fails", async () => {
    const copies = Array.from({ length: 4 }, () => deferred<ImageBitmap>());
    const bitmaps = copies.map(() => bitmap());
    let index = 0;
    vi.stubGlobal("createImageBitmap", vi.fn(() => copies[index++].promise));
    vi.stubGlobal("Worker", EncoderWorker);
    const rendering = renderMotionVideos(layers, motion, size, vi.fn(), new AbortController().signal);
    copies[0].reject(new Error("Could not copy image"));
    await expect(rendering).rejects.toThrow("Could not copy image");
    for (let i = 1; i < copies.length; i++) copies[i].resolve(bitmaps[i]);
    await Promise.resolve();
    for (const copy of bitmaps.slice(1)) expect(copy.close).toHaveBeenCalledOnce();
    expect(EncoderWorker.instances).toHaveLength(0);
  });
  it("still forwards encoder progress and the completed videos", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn(async () => bitmap()));
    vi.stubGlobal("Worker", EncoderWorker);
    const controller = new AbortController(), progress = vi.fn();
    const rendering = renderMotionVideos(layers, motion, size, progress, controller.signal);
    await vi.waitFor(() => expect(EncoderWorker.instances).toHaveLength(1));
    const worker = EncoderWorker.instances[0];
    worker.onmessage!({ data: { kind: "progress", value: 0.5 } });
    expect(progress).toHaveBeenCalledWith(0.5);
    const done: EncodeMessage = { kind: "done", reference: new Blob(), mask: new Blob(), start: new Blob(), container: "mp4" };
    worker.onmessage!({ data: done });
    await expect(rendering).resolves.toBe(done);
    expect(worker.terminate).toHaveBeenCalledOnce();
    controller.abort();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
