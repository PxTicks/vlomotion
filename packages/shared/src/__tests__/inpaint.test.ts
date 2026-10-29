import { describe, expect, it } from "vitest";
import { clampMask, createMaskMotion, fitMask, inpaintFrames, inpaintFramesSchema, inpaintSize, maskBoxes, rebaseMask, toMaskBox } from "../inpaint.js";
import type { MaskBox } from "../inpaint.js";

describe("inpainting geometry", () => {
  const size = { width: 1000, height: 500 };
  const bounds = { x: 100, y: 100, width: 200, height: 100 };
  const still = createMaskMotion(bounds, 124);
  const moving = { ...still, keys: [...still.keys, { id: "end", frame: 123, x: 700, y: 250, sx: 2, sy: 0.5 }] };
  const close = (box: MaskBox) => Object.fromEntries(Object.entries(box).map(([key, value]) => [key, expect.closeTo(value, 9)]));
  it("anchors the mask motion at the centre of the drawn box", () => {
    expect(still.anchor).toEqual({ x: 200, y: 150 });
    expect(still.keys).toEqual([{ id: "start", frame: 0, x: 200, y: 150 }]);
  });
  it("places the drawn mask on every frame, sized relative to the drawn box", () => {
    const boxes = maskBoxes(bounds, moving, size);
    expect(boxes).toHaveLength(124);
    expect(boxes[0]).toEqual(close({ x: 0.1, y: 0.2, width: 0.2, height: 0.2 }));
    expect(boxes[123]).toEqual(close({ x: 0.5, y: 0.45, width: 0.4, height: 0.1 }));
    expect(maskBoxes(bounds, still, size).every(box => box.x === 0.1 && box.width === 0.2)).toBe(true);
  });
  it("keeps later keys on screen when the first mask is redrawn", () => {
    const to = { x: 400, y: 200, width: 100, height: 50 };
    const rebased = rebaseMask(moving, bounds, to);
    expect(rebased.anchor).toEqual({ x: 450, y: 225 });
    expect(rebased.keys[0]).toMatchObject({ x: 450, y: 225 });
    const before = maskBoxes(bounds, moving, size), after = maskBoxes(to, rebased, size);
    expect(after[0]).toEqual(close(toMaskBox(to, size)));
    expect(after[123]).toEqual(close(before[123]));
  });
  it("keeps the first-frame mask inside the frame", () => {
    expect(clampMask({ x: -0.5, y: 2, width: 0.2, height: 0.3 })).toEqual({ x: 0, y: 0.7, width: 0.2, height: 0.3 });
    expect(clampMask({ x: 0.5, y: 0.5, width: 2, height: 0 })).toEqual({ x: 0, y: 0.5, width: 1, height: 0.01 });
    expect(fitMask({ x: -50, y: 450, width: 100, height: 100 }, size)).toEqual({ x: 0, y: 400, width: 100, height: 100 });
  });
  it("prepares source and mask at the delivered ratio before ComfyUI stretches them", () => {
    expect(inpaintSize(1920, 1080)).toEqual({ width: 854, height: 480 });
    expect(inpaintSize(1080, 1920)).toEqual({ width: 480, height: 854 });
    expect(inpaintSize(400, 400)).toEqual({ width: 480, height: 480 });
    expect(inpaintSize(1920, 1080, 768)).toEqual({ width: 1366, height: 768 });
    expect(inpaintSize(1080, 1920, 768)).toEqual({ width: 768, height: 1366 });
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
