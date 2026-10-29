import { AudioSample, AudioSampleSink, AudioSampleSource, BlobSource, CanvasSink, Input, MP4, QUALITY_HIGH, QUALITY_VERY_HIGH, WEBM, getFirstEncodableAudioCodec } from "mediabunny";
import type { InputAudioTrack, Output } from "mediabunny";
import { FPS } from "@h3-motion/shared";
import type { FrameSize, MaskBox, MaskShape } from "@h3-motion/shared";
import { createVideoTrack, pickCodec } from "../../media/encode";
import { drawMask } from "./drawMask";

/**
 * `boxes` holds the mask on each frame, as fractions of the frame, grown by `grow` pixels of `size`; without them only the
 * source is prepared, for tracking. With `audio`, the prepared source keeps the original's sound over the same frames.
 */
export interface EncodeInpaintRequest { source: File; size: FrameSize; frames: number; boxes: MaskBox[] | null; shape: MaskShape; grow?: number; audio?: boolean }
export type EncodeInpaintMessage = { kind: "progress"; value: number }
  | { kind: "done"; source: Blob; mask: Blob | null; container: "mp4" | "webm" } | { kind: "error"; message: string };
const scope = globalThis as unknown as {
  postMessage(message: EncodeInpaintMessage): void;
  addEventListener(type: "message", listener: (event: MessageEvent<EncodeInpaintRequest>) => void): void;
};

/** Adds a track for `track`'s sound to `output`, before it starts; the returned function then copies the sound from `start` to `end`. */
async function addSound(output: Output, track: InputAudioTrack) {
  if (!await track.canDecode()) throw new Error("This browser can't decode this video's sound. Choose Replace under Advanced.");
  const { numberOfChannels, sampleRate } = track;
  // AAC or Opus, which ComfyUI reads in either container; the formats list the ones they hold.
  const codecs = output.format.getSupportedAudioCodecs().filter(codec => codec === "aac" || codec === "opus");
  const codec = await getFirstEncodableAudioCodec(codecs, { numberOfChannels, sampleRate, quality: QUALITY_HIGH });
  if (!codec) throw new Error("This browser can't encode sound. Choose Replace under Advanced.");
  const source = new AudioSampleSource({ codec, quality: QUALITY_HIGH });
  output.addAudioTrack(source);
  // ComfyUI joins the decoded sound end to end, ignoring timestamps, so any time without sound is written as silence:
  // before the first sample, between samples and after the last. The track then spans the clip from 0 s.
  let covered = 0, layout = { numberOfChannels, sampleRate };
  const silence = async (until: number) => {
    const frames = Math.round((until - covered) * layout.sampleRate);
    if (frames <= 0) return;
    const gap = new AudioSample({ data: new Float32Array(frames * layout.numberOfChannels), format: "f32", ...layout, timestamp: covered });
    await source.add(gap);
    gap.close();
  };
  return async (start: number, end: number) => {
    for await (const sample of new AudioSampleSink(track).samples(start, end)) {
      // The samples straddling either end are cut to the clip, which starts at 0 s like its frames.
      const from = Math.max(0, Math.round((start - sample.timestamp) * sample.sampleRate));
      const to = Math.min(sample.numberOfFrames, Math.round((end - sample.timestamp) * sample.sampleRate));
      if (to > from) {
        const part = sample.trim(from, to);
        part.setTimestamp(part.timestamp - start);
        layout = { numberOfChannels: part.numberOfChannels, sampleRate: part.sampleRate };
        await silence(part.timestamp);
        await source.add(part);
        covered = part.timestamp + part.duration;
        part.close();
      }
      sample.close();
    }
    await silence(end - start);
    source.close();
  };
}

async function encode(request: EncodeInpaintRequest) {
  const { size, frames, boxes, shape, grow = 0 } = request;
  const codec = await pickCodec(size);
  const container = codec === "avc" ? "mp4" : "webm";
  const source = createVideoTrack(size, codec, QUALITY_VERY_HIGH), mask = boxes && createVideoTrack(size, codec, QUALITY_HIGH);
  const input = new Input({ source: new BlobSource(request.source), formats: [MP4, WEBM] });
  try {
    const video = await input.getPrimaryVideoTrack();
    if (!video || !await video.canDecode()) throw new Error("This browser can't decode this video. Try an H.264 MP4.");
    const audio = request.audio ? await input.getPrimaryAudioTrack() : null;
    if (request.audio && !audio) throw new Error("This video has no sound to keep or reference.");
    const copySound = audio && await addSound(source.output, audio);
    const sink = new CanvasSink(video, { width: size.width, height: size.height, fit: "fill", poolSize: 2 });
    await Promise.all([source.output.start(), mask?.output.start()]);
    const start = Math.max(0, await video.getFirstTimestamp());
    // The sound is copied alongside the frames, so the muxer can interleave the two tracks as they arrive.
    const sound = copySound?.(start, start + frames / FPS);
    // Awaited after the frames; until then a failure mustn't go unhandled if the frames fail first.
    sound?.catch(() => undefined);
    let frame = 0;
    for await (const sample of sink.canvasesAtTimestamps(Array.from({ length: frames }, (_, i) => start + i / FPS))) {
      if (!sample) throw new Error("Could not read a frame from the source video.");
      source.context.drawImage(sample.canvas, 0, 0, size.width, size.height);
      if (mask) {
        const box = boxes![frame];
        if (!box) throw new Error("Draw a mask before generating.");
        drawMask(mask.context, size, box, shape, grow);
      }
      await Promise.all([source.source.add(frame / FPS, 1 / FPS), mask?.source.add(frame / FPS, 1 / FPS)]);
      scope.postMessage({ kind: "progress", value: ++frame / frames });
    }
    source.source.close(); mask?.source.close();
    await sound;
    await Promise.all([source.output.finalize(), mask?.output.finalize()]);
    const type = container === "mp4" ? "video/mp4" : "video/webm";
    scope.postMessage({ kind: "done", source: new Blob([source.output.target.buffer!], { type }),
      mask: mask && new Blob([mask.output.target.buffer!], { type }), container });
  } finally { input.dispose(); }
}
scope.addEventListener("message", event => {
  void encode(event.data).catch(error => scope.postMessage({ kind: "error", message: error instanceof Error ? error.message : "Could not prepare the video." }));
});
