import { BufferTarget, CanvasSource, Mp4OutputFormat, Output, QUALITY_HIGH, QUALITY_VERY_HIGH, WebMOutputFormat, canEncodeVideo } from "mediabunny";
import type { Quality, VideoCodec } from "mediabunny";
import { FPS, buildMotionCurve } from "@h3-motion/shared";
import type { FrameSize, SubjectMotion } from "@h3-motion/shared";
import { drawMask, drawReference } from "../motion/subjectLayers";
import type { RenderLayers } from "../motion/subjectLayers";

export interface EncodeRequest { layers: RenderLayers; motion: SubjectMotion; size: FrameSize }
export type EncodeMessage =
  | { kind: "progress"; value: number }
  | { kind: "done"; reference: Blob; mask: Blob; start: Blob; container: "mp4" | "webm" }
  | { kind: "error"; message: string };

const scope = globalThis as unknown as { postMessage(message: EncodeMessage): void; addEventListener(type: "message", listener: (event: MessageEvent<EncodeRequest>) => void): void };

async function pickCodec(size: FrameSize): Promise<VideoCodec> {
  for (const codec of ["avc", "vp9"] as const) {
    if (await canEncodeVideo(codec, { ...size, quality: QUALITY_VERY_HIGH, frameRate: FPS })) return codec;
  }
  throw new Error("This browser can't encode video. Use a recent version of Chrome, Edge or Firefox.");
}

/** Renders every frame on the 24 fps grid into a reference video and a mask video, encoding exactly `frames` frames. */
async function encode({ layers, motion, size }: EncodeRequest) {
  const codec = await pickCodec(size);
  const container = codec === "avc" ? "mp4" : "webm";
  const track = (quality: Quality) => {
    const canvas = new OffscreenCanvas(size.width, size.height);
    const context = canvas.getContext("2d", { alpha: false })!;
    context.imageSmoothingQuality = "high";
    const output = new Output({ format: container === "mp4" ? new Mp4OutputFormat({ fastStart: "in-memory" }) : new WebMOutputFormat(), target: new BufferTarget() });
    // vlo found that prefer-hardware fails closed on some machines.
    const source = new CanvasSource(canvas, { codec, quality, hardwareAcceleration: "no-preference" });
    output.addVideoTrack(source, { frameRate: FPS });
    return { canvas, context, output, source };
  };
  const reference = track(QUALITY_VERY_HIGH), mask = track(QUALITY_HIGH);
  await Promise.all([reference.output.start(), mask.output.start()]);
  const curve = buildMotionCurve(motion);
  let start: Blob | undefined;
  for (let frame = 0; frame < motion.frames; frame++) {
    const offset = curve.offsetAt(frame);
    drawReference(reference.context, layers, offset);
    drawMask(mask.context, layers, offset);
    // Frame 0 is the untouched photo, so the start frame matches the reference exactly before encoding.
    if (frame === 0) start = await reference.canvas.convertToBlob({ type: "image/png" });
    await Promise.all([reference.source.add(frame / FPS, 1 / FPS), mask.source.add(frame / FPS, 1 / FPS)]);
    scope.postMessage({ kind: "progress", value: (frame + 1) / motion.frames });
  }
  reference.source.close(); mask.source.close();
  await Promise.all([reference.output.finalize(), mask.output.finalize()]);
  const type = container === "mp4" ? "video/mp4" : "video/webm";
  scope.postMessage({ kind: "done", container, start: start!,
    reference: new Blob([reference.output.target.buffer!], { type }), mask: new Blob([mask.output.target.buffer!], { type }) });
}

scope.addEventListener("message", event => {
  encode(event.data).catch(error => scope.postMessage({ kind: "error", message: error instanceof Error ? error.message : "Could not encode the motion videos." }));
});
