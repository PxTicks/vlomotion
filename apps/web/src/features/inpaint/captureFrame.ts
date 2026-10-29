import { BlobSource, CanvasSink, Input, MP4, WEBM } from "mediabunny";
import { FPS } from "@h3-motion/shared";
import type { FrameSize, MaskBox, MaskShape } from "@h3-motion/shared";
import { drawMask } from "./drawMask";

/** Qwen Image edits up to 2K; larger frames are scaled down to this longest side. */
const MAX_SIDE = 2048;

export function referenceFrameSize({ width, height }: FrameSize): FrameSize {
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  return { width: Math.max(2, Math.round(width * scale)), height: Math.max(2, Math.round(height * scale)) };
}

const png = (canvas: HTMLCanvasElement | OffscreenCanvas) => canvas instanceof OffscreenCanvas ? canvas.convertToBlob({ type: "image/png" })
  : new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Could not capture the frame.")), "image/png"));

/**
 * The source frame at `frame` and the mask on it, as PNGs of `size`. The frame is read at the same time as the
 * prepared video reads it, so the reference shows exactly the frame the inpainting sees.
 */
export async function captureFrame(request: { source: File; frame: number; size: FrameSize; box: MaskBox; shape: MaskShape }) {
  const { source, frame, size, box, shape } = request;
  const input = new Input({ source: new BlobSource(source), formats: [MP4, WEBM] });
  try {
    const video = await input.getPrimaryVideoTrack();
    if (!video || !await video.canDecode()) throw new Error("This browser can't decode this video. Try an H.264 MP4.");
    const sink = new CanvasSink(video, { width: size.width, height: size.height, fit: "fill" });
    const sample = await sink.getCanvas(Math.max(0, await video.getFirstTimestamp()) + frame / FPS);
    if (!sample) throw new Error("Could not read that frame from the video.");
    const mask = new OffscreenCanvas(size.width, size.height);
    drawMask(mask.getContext("2d")!, size, box, shape);
    return { image: await png(sample.canvas), mask: await mask.convertToBlob({ type: "image/png" }) };
  } finally { input.dispose(); }
}
