import { BufferTarget, CanvasSource, Mp4OutputFormat, Output, QUALITY_VERY_HIGH, WebMOutputFormat, canEncodeVideo } from "mediabunny";
import type { Quality, VideoCodec } from "mediabunny";
import { FPS } from "@h3-motion/shared";
import type { FrameSize } from "@h3-motion/shared";

export async function pickCodec(size: FrameSize): Promise<VideoCodec> {
  for (const codec of ["avc", "vp9"] as const) {
    if (await canEncodeVideo(codec, { ...size, quality: QUALITY_VERY_HIGH, frameRate: FPS })) return codec;
  }
  throw new Error("This browser can't encode video. Use a recent version of Chrome, Edge or Firefox.");
}

export function createVideoTrack(size: FrameSize, codec: VideoCodec, quality: Quality) {
  const canvas = new OffscreenCanvas(size.width, size.height);
  const context = canvas.getContext("2d", { alpha: false })!;
  context.imageSmoothingQuality = "high";
  const container = codec === "avc" ? "mp4" : "webm";
  const output = new Output({ target: new BufferTarget(), format: container === "mp4" ? new Mp4OutputFormat({ fastStart: "in-memory" }) : new WebMOutputFormat() });
  // prefer-hardware fails closed on some machines.
  const source = new CanvasSource(canvas, { codec, quality, hardwareAcceleration: "no-preference" });
  output.addVideoTrack(source, { frameRate: FPS });
  return { canvas, context, output, source };
}
