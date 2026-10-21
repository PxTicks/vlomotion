import { describe, expect, it } from "vitest";
import { CLIP_FRAMES, FPS, centerCrop, findBestStridedDimensions, frameCountSchema, frameSizeSchema, generationSize, pythonRound } from "../media.js";

describe("H3 media conventions", () => {
  it("uses the trained 17k+5 frame grid at 24 fps", () => {
    expect(FPS).toBe(24);
    for (const count of Object.values(CLIP_FRAMES)) {
      expect((count - 5) % 17).toBe(0);
      expect(frameCountSchema.parse(count)).toBe(count);
    }
    expect(frameCountSchema.safeParse(120).success).toBe(false);
  });
  it("matches Python round at positive and negative half ties", () => {
    expect([0.5, 1.5, 2.5, -0.5, -1.5, -2.5].map(pythonRound)).toEqual([0, 2, 2, 0, -2, -2]);
  });
  it("produces strided landscape, portrait and square dimensions", () => {
    expect(generationSize("16:9")).toEqual({ width: 864, height: 480 });
    expect(generationSize("9:16")).toEqual({ width: 480, height: 864 });
    expect(generationSize("1:1")).toEqual({ width: 480, height: 480 });
    for (const ratio of ["16:9", "9:16", "1:1"] as const) {
      expect(frameSizeSchema.safeParse(generationSize(ratio, 720)).success).toBe(true);
    }
    expect(frameSizeSchema.safeParse({ width: 848, height: 480 }).success).toBe(false);
  });
  it("crops from the centre without changing aspect ratio", () => {
    expect(centerCrop({ width: 1000, height: 1000 }, { width: 864, height: 480 }))
      .toEqual({ x: 0, y: (1000 - 480 / 0.864) / 2, width: 1000, height: 480 / 0.864 });
    expect(() => findBestStridedDimensions(0, 480)).toThrow();
    expect(() => centerCrop({ width: 0, height: 1 }, { width: 1, height: 1 })).toThrow();
  });
});
