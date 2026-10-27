import { describe, expect, it } from "vitest";
import { clampMask, inpaintFrames, inpaintFramesSchema, inpaintSize, maskAt } from "../inpaint.js";

describe("inpainting geometry", () => {
  const start = { frame: 0, x: 0.1, y: 0.2, width: 0.2, height: 0.4 };
  const end = { frame: 100, x: 0.6, y: 0.4, width: 0.4, height: 0.2 };
  it("interpolates position and size, holds endpoints, and accepts unsorted keys", () => {
    expect(maskAt([end, start], 50)).toEqual({ x: 0.35, y: expect.closeTo(0.3), width: expect.closeTo(0.3), height: expect.closeTo(0.3) });
    expect(maskAt([start, end], -1)).toEqual({ x: start.x, y: start.y, width: start.width, height: start.height });
    expect(maskAt([start, end], 200)).toEqual({ x: end.x, y: end.y, width: end.width, height: end.height });
    expect(maskAt([], 0)).toBeNull();
  });
  it("keeps drawing, translation and resize inside the frame", () => {
    expect(clampMask({ x: -0.5, y: 2, width: 0.2, height: 0.3 })).toEqual({ x: 0, y: 0.7, width: 0.2, height: 0.3 });
    expect(clampMask({ x: 0.5, y: 0.5, width: 2, height: 0 })).toEqual({ x: 0, y: 0.5, width: 1, height: 0.01 });
  });
  it("prepares source and mask at the delivered ratio before ComfyUI stretches them", () => {
    expect(inpaintSize(1920, 1080)).toEqual({ width: 854, height: 480 });
    expect(inpaintSize(1080, 1920)).toEqual({ width: 480, height: 854 });
    expect(inpaintSize(400, 400)).toEqual({ width: 480, height: 480 });
  });
  it("uses a complete 17k+5 frame sequence without extending the source", () => {
    for (const seconds of [0.21, 1, 2, 5, 5.1666666, 7.3, 10, 90]) {
      const frames = inpaintFrames(seconds);
      expect(inpaintFramesSchema.safeParse(frames).success).toBe(true);
      expect(frames).toBeLessThanOrEqual(Math.floor(seconds * 24 + 0.001));
    }
    expect(inpaintFrames(5)).toBe(107);
    expect(inpaintFrames(124 / 24)).toBe(124);
    expect(inpaintFrames(60)).toBe(243);
  });
});
