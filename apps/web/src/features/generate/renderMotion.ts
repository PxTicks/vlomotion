import type { FrameSize, SubjectMotion } from "@h3-motion/shared";
import type { RenderLayers } from "../motion";
import type { EncodeMessage, EncodeRequest } from "./encode.worker";

export interface MotionVideos { reference: Blob; mask: Blob; start: Blob; container: "mp4" | "webm" }

/** Renders and encodes the reference and mask videos in a worker, so the page stays responsive. */
export async function renderMotionVideos(layers: RenderLayers, motion: SubjectMotion, size: FrameSize,
  onProgress: (value: number) => void, signal: AbortSignal): Promise<MotionVideos> {
  signal.throwIfAborted();
  const bitmaps: ImageBitmap[] = [];
  let worker: Worker | undefined;
  let disposed = false;
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<MotionVideos>((resolve, reject) => {
      onAbort = () => reject(new DOMException("Rendering cancelled.", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
      void Promise.all([layers.photo, layers.plate, layers.cutout, layers.matte].map(async image => {
        const bitmap = await createImageBitmap(image);
        // Copies may finish after cancellation or another copy's failure.
        if (disposed) bitmap.close();
        else bitmaps.push(bitmap);
        return bitmap;
      })).then(([photo, plate, cutout, matte]) => {
        if (disposed) return;
        signal.throwIfAborted();
        worker = new Worker(new URL("./encode.worker.ts", import.meta.url), { type: "module" });
        worker.onmessage = (event: MessageEvent<EncodeMessage>) => {
          const message = event.data;
          if (message.kind === "progress") onProgress(message.value);
          else if (message.kind === "error") reject(new Error(message.message));
          else resolve(message);
        };
        worker.onerror = event => reject(new Error(event.message || "Could not encode the motion videos."));
        const request: EncodeRequest = { layers: { width: layers.width, height: layers.height, photo, plate, cutout, matte }, motion, size };
        worker.postMessage(request, [photo, plate, cutout, matte]);
      }).catch(reject);
    });
  } finally {
    disposed = true;
    if (onAbort) signal.removeEventListener("abort", onAbort);
    worker?.terminate();
    for (const bitmap of bitmaps) bitmap.close();
  }
}
