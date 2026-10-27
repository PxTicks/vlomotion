import { QUALITY_HIGH, QUALITY_VERY_HIGH } from "mediabunny";
import { FPS, buildMotionCurve } from "@h3-motion/shared";
import type { FrameSize, SubjectMotion } from "@h3-motion/shared";
import { drawMask, drawReference, drawSceneMask, drawSceneReference } from "../motion/subjectLayers";
import type { RenderLayers } from "../motion/subjectLayers";
import { createVideoTrack, pickCodec } from "../../media/encode";

export interface EncodeRequest { layers: RenderLayers; motion: SubjectMotion; size: FrameSize }
export type EncodeMessage =
  | { kind: "progress"; value: number }
  | { kind: "done"; reference: Blob; mask: Blob; start: Blob; container: "mp4" | "webm" }
  | { kind: "error"; message: string };

const scope = globalThis as unknown as { postMessage(message: EncodeMessage): void; addEventListener(type: "message", listener: (event: MessageEvent<EncodeRequest>) => void): void };

function hasSubject(context: OffscreenCanvasRenderingContext2D) {
  const { data } = context.getImageData(0, 0, context.canvas.width, context.canvas.height);
  for (let i = 0; i < data.length; i += 4) if (data[i] >= 128) return true;
  return false;
}

/** Renders every frame on the 24 fps grid into a reference video and a mask video, encoding exactly `frames` frames. */
async function encode({ layers, motion, size }: EncodeRequest) {
  const codec = await pickCodec(size);
  const container = codec === "avc" ? "mp4" : "webm";
  const reference = createVideoTrack(size, codec, QUALITY_VERY_HIGH), mask = createVideoTrack(size, codec, QUALITY_HIGH);
  await Promise.all([reference.output.start(), mask.output.start()]);
  const curve = buildMotionCurve(motion);
  const subjects = layers.subjects?.map(subject => ({ ...subject, curve: buildMotionCurve(subject.motion) }));
  let start: Blob | undefined;
  for (let frame = 0; frame < motion.frames; frame++) {
    const offset = curve.offsetAt(frame);
    if (subjects?.length) {
      const positioned = subjects.map(subject => ({ layers: subject.layers, offset: subject.curve.offsetAt(frame) }));
      drawSceneReference(reference.context, layers, positioned, frame === 0);
      drawSceneMask(mask.context, positioned);
    } else {
      drawReference(reference.context, layers, offset);
      drawMask(mask.context, layers, offset);
    }
    // Frame 0 is the untouched photo, so the start frame matches the reference exactly before encoding.
    if (frame === 0) {
      start = await reference.canvas.convertToBlob({ type: "image/png" });
      // An empty mask makes Time-to-Move a no-op, so the model would ignore the path without any error.
      if (!hasSubject(mask.context)) throw new Error("The subject mask came out empty. Reload the page and try again.");
    }
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
