import { describe, expect, it } from "vitest";
import { CLIP_FRAMES, FPS, frameCountSchema, frameSizeSchema, h3Canvas, videoDimensionSchema, videoGeometry, pythonRound } from "../media.js";

describe("H3 media conventions", () => {
  it("uses the trained 17k+5 frame grid at 24 fps", () => {
    expect(FPS).toBe(24);
    for (let count = CLIP_FRAMES.min; count <= CLIP_FRAMES.max; count += CLIP_FRAMES.step) {
      expect((count - 5) % 17).toBe(0);
      expect(frameCountSchema.parse(count)).toBe(count);
    }
    expect([CLIP_FRAMES.min / FPS, CLIP_FRAMES.max / FPS].map(Math.round)).toEqual([3, 15]);
    // The slider's larger keyboard steps clamp at either end, which must then be on the grid too.
    expect((CLIP_FRAMES.max - CLIP_FRAMES.min) % CLIP_FRAMES.step).toBe(0);
    expect(frameCountSchema.parse(CLIP_FRAMES.default)).toBe(124);
    for (const count of [120, 56, 379]) expect(frameCountSchema.safeParse(count).success).toBe(false);
  });
  it("matches Python round at positive and negative half ties", () => {
    expect([0.5, 1.5, 2.5, -0.5, -1.5, -2.5].map(pythonRound)).toEqual([0, 2, 2, 0, -2, -2]);
  });
  // Golden sizes from SGLang's adapt_shape_v1 / ComfyUI's adapt_canvas; MiniMax's 16:9 768p outputs are 1344 × 768.
  it.each([
    [16, 9, 480, 864, 480, 854, 480], [9, 16, 480, 480, 864, 480, 854],
    [16, 9, 768, 1344, 768, 1366, 768], [9, 16, 768, 768, 1344, 768, 1366],
    [1, 1, 480, 480, 480, 480, 480], [1, 1, 768, 768, 768, 768, 768],
    [4, 3, 480, 640, 480, 640, 480], [4, 3, 768, 1024, 768, 1024, 768],
    [21, 9, 480, 1120, 480, 1120, 480], [21, 9, 768, 1536, 672, 1792, 768],
    [4, 1, 768, 2016, 512, 3072, 768],
  ])("uses H3's canonical canvas for %s:%s at %sp", (width, height, tier, modelWidth, modelHeight, outputWidth, outputHeight) => {
    const size = videoGeometry({ width, height }, tier);
    expect(size).toEqual({ generation: { width: modelWidth, height: modelHeight }, output: { width: outputWidth, height: outputHeight } });
    expect(frameSizeSchema.safeParse(size.generation).success).toBe(true);
    expect(videoDimensionSchema.safeParse(size.output.width).success).toBe(true);
    expect(videoDimensionSchema.safeParse(size.output.height).success).toBe(true);
  });
  it("keeps arbitrary input ratios and only rounds delivery up for the encoder", () => {
    for (const source of [{ width: 1000, height: 701 }, { width: 701, height: 1000 }, { width: 1437, height: 1001 }]) {
      const { output } = videoGeometry(source);
      expect(Math.min(output.width, output.height)).toBe(480);
      expect(Math.abs(output.width / output.height - source.width / source.height)).toBeLessThan(2 / 480);
    }
    expect(videoDimensionSchema.safeParse(853).success).toBe(false);
    expect(() => h3Canvas({ width: 1, height: 1 }, 0)).toThrow();
    expect(() => videoGeometry({ width: 0, height: 1 })).toThrow();
  });
});
