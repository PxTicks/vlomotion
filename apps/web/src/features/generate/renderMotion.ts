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
      const subjects = layers.subjects ?? [];
      const images = [layers.photo, layers.plate, layers.cutout, layers.matte, ...subjects.flatMap(subject => [subject.layers.cutout, subject.layers.matte])];
      void Promise.all(images.map(async image => {
        const bitmap = await createImageBitmap(image);
        // Copies may finish after cancellation or another copy's failure.
        if (disposed) bitmap.close();
        else bitmaps.push(bitmap);
        return bitmap;
      })).then(copies => {
        if (disposed) return;
        const [photo, plate, cutout, matte] = copies;
        signal.throwIfAborted();
        worker = new Worker(new URL("./encode.worker.ts", import.meta.url), { type: "module" });
        worker.onmessage = (event: MessageEvent<EncodeMessage>) => {
          const message = event.data;
          if (message.kind === "progress") onProgress(message.value);
          else if (message.kind === "error") reject(new Error(message.message));
          else resolve(message);
        };
        worker.onerror = event => reject(new Error(event.message || "Could not encode the motion videos."));
        const request: EncodeRequest = { layers: { width: layers.width, height: layers.height, photo, plate, cutout, matte,
          ...(subjects.length ? { subjects: subjects.map((subject, index) => ({ motion: subject.motion,
            layers: { width: subject.layers.width, height: subject.layers.height, photo, plate, cutout: copies[4 + index * 2], matte: copies[5 + index * 2] } })) } : {}) }, motion, size };
        worker.postMessage(request, copies);
      }).catch(reject);
    });
  } finally {
    disposed = true;
    if (onAbort) signal.removeEventListener("abort", onAbort);
    worker?.terminate();
    for (const bitmap of bitmaps) bitmap.close();
  }
}
