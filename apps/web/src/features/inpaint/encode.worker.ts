import { BlobSource, CanvasSink, Input, MP4, QUALITY_HIGH, QUALITY_VERY_HIGH, WEBM } from "mediabunny";
import { FPS, maskAt } from "@h3-motion/shared";
import type { FrameSize, MaskKeyframe, MaskShape } from "@h3-motion/shared";
import { createVideoTrack, pickCodec } from "../../media/encode";

export interface EncodeInpaintRequest { source: File; size: FrameSize; frames: number; keys: MaskKeyframe[]; shape: MaskShape }
export type EncodeInpaintMessage = { kind: "progress"; value: number }
  | { kind: "done"; source: Blob; mask: Blob; container: "mp4" | "webm" } | { kind: "error"; message: string };
const scope = globalThis as unknown as {
  postMessage(message: EncodeInpaintMessage): void;
  addEventListener(type: "message", listener: (event: MessageEvent<EncodeInpaintRequest>) => void): void;
};

async function encode(request: EncodeInpaintRequest) {
  const { size, frames, keys, shape } = request;
  const codec = await pickCodec(size);
  const container = codec === "avc" ? "mp4" : "webm";
  const source = createVideoTrack(size, codec, QUALITY_VERY_HIGH), mask = createVideoTrack(size, codec, QUALITY_HIGH);
  const input = new Input({ source: new BlobSource(request.source), formats: [MP4, WEBM] });
  try {
    const video = await input.getPrimaryVideoTrack();
    if (!video || !await video.canDecode()) throw new Error("This browser can't decode this video. Try an H.264 MP4.");
    const sink = new CanvasSink(video, { width: size.width, height: size.height, fit: "fill", poolSize: 2 });
    await Promise.all([source.output.start(), mask.output.start()]);
    const start = Math.max(0, await video.getFirstTimestamp());
    let frame = 0;
    for await (const sample of sink.canvasesAtTimestamps(Array.from({ length: frames }, (_, i) => start + i / FPS))) {
      if (!sample) throw new Error("Could not read a frame from the source video.");
      source.context.drawImage(sample.canvas, 0, 0, size.width, size.height);
      mask.context.fillStyle = "black";
      mask.context.fillRect(0, 0, size.width, size.height);
      const box = maskAt(keys, frame);
      if (!box) throw new Error("Draw a mask before generating.");
      const x = box.x * size.width, y = box.y * size.height, w = box.width * size.width, h = box.height * size.height;
      mask.context.fillStyle = "white";
      if (shape === "ellipse") {
        mask.context.beginPath(); mask.context.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); mask.context.fill();
      } else mask.context.fillRect(x, y, w, h);
      await Promise.all([source.source.add(frame / FPS, 1 / FPS), mask.source.add(frame / FPS, 1 / FPS)]);
      scope.postMessage({ kind: "progress", value: ++frame / frames });
    }
    source.source.close(); mask.source.close();
    await Promise.all([source.output.finalize(), mask.output.finalize()]);
    const type = container === "mp4" ? "video/mp4" : "video/webm";
    scope.postMessage({ kind: "done", source: new Blob([source.output.target.buffer!], { type }),
      mask: new Blob([mask.output.target.buffer!], { type }), container });
  } finally { input.dispose(); }
}
scope.addEventListener("message", event => {
  void encode(event.data).catch(error => scope.postMessage({ kind: "error", message: error instanceof Error ? error.message : "Could not prepare the video." }));
});
