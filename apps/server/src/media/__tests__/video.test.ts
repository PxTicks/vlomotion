import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { BufferSource, BufferTarget, EncodedPacketSink, EncodedVideoPacketSource, Input, MP4, Mp4OutputFormat, Output } from "mediabunny";
import { inpaintFrames } from "@h3-motion/shared";
import { inspectVideo } from "../video.js";

describe("video timeline metadata", () => {
  it.each([0, 0.5, 2])("measures elapsed duration for a video starting at %s seconds", async offset => {
    const bytes = await readFile(new URL("../../__tests__/fixtures/black-480-124.mp4", import.meta.url));
    const input = new Input({ source: new BufferSource(bytes), formats: [MP4] });
    try {
      const track = (await input.getPrimaryVideoTrack())!;
      const source = new EncodedVideoPacketSource((await track.getCodec())!);
      const output = new Output({ target: new BufferTarget(), format: new Mp4OutputFormat({ fastStart: "fragmented" }) });
      output.addVideoTrack(source);
      await output.start();
      const decoderConfig = (await track.getDecoderConfig())!;
      for await (const packet of new EncodedPacketSink(track).packets()) {
        await source.add(packet.clone({ timestamp: packet.timestamp + offset }), { decoderConfig });
      }
      source.close();
      await output.finalize();
      const info = await inspectVideo(new Uint8Array(output.target.buffer!));
      expect(info).toMatchObject({ startTime: offset, duration: expect.closeTo(124 / 24), frames: 124, width: 480, height: 480 });
      expect(inpaintFrames(info.duration)).toBe(124);
      expect(info.startTime + (inpaintFrames(info.duration) - 1) / 24).toBeLessThan(offset + 124 / 24);
    } finally { input.dispose(); }
  });
});
