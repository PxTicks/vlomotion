import { describe, expect, it } from "vitest";
import { dragHandle, handleCursor, handlePoint, nearestHandle } from "../gizmo";

const bounds = { x: 80, y: 180, width: 40, height: 40 };
const anchor = { x: 100, y: 200 };
const rest = { ...anchor, sx: 1, sy: 1 };
const pinned = { free: false, centred: false };

describe("scale gizmo", () => {
  it("places handles on the scaled, moved box", () => {
    expect(handlePoint(bounds, anchor, rest, { hx: 1, hy: 1 })).toEqual({ x: 120, y: 220 });
    expect(handlePoint(bounds, anchor, { x: 300, y: 200, sx: 2, sy: -1 }, { hx: 1, hy: 1 })).toEqual({ x: 340, y: 180 });
    expect(handlePoint(bounds, anchor, rest, { hx: 0, hy: -1 })).toEqual({ x: 100, y: 180 });
  });
  it("scales evenly from a corner about the opposite corner, whichever way the pointer strays", () => {
    const pose = dragHandle(bounds, anchor, rest, { hx: 1, hy: 1 }, { x: 40, y: 0 }, pinned);
    expect(pose).toEqual({ x: 110, y: 210, sx: 1.5, sy: 1.5 });
    expect(handlePoint(bounds, anchor, pose, { hx: -1, hy: -1 })).toEqual({ x: 80, y: 180 });
  });
  it("frees the aspect ratio with Shift and scales about the centre with Alt", () => {
    expect(dragHandle(bounds, anchor, rest, { hx: 1, hy: 1 }, { x: 40, y: 0 }, { free: true, centred: false })).toEqual({ x: 120, y: 200, sx: 2, sy: 1 });
    expect(dragHandle(bounds, anchor, rest, { hx: 1, hy: 1 }, { x: 20, y: 20 }, { free: false, centred: true })).toEqual({ x: 100, y: 200, sx: 2, sy: 2 });
  });
  it("stretches one axis from an edge and flips it when dragged past the opposite edge", () => {
    expect(dragHandle(bounds, anchor, rest, { hx: 0, hy: -1 }, { x: 15, y: -40 }, pinned)).toEqual({ x: 100, y: 180, sx: 1, sy: 2 });
    const flipped = dragHandle(bounds, anchor, rest, { hx: 1, hy: 0 }, { x: -80, y: 0 }, pinned);
    expect(flipped).toEqual({ x: 60, y: 200, sx: -1, sy: 1 });
    expect(handleCursor({ hx: 1, hy: 1 }, rest)).toBe("nwse-resize");
    expect(handleCursor({ hx: 1, hy: 1 }, flipped)).toBe("nesw-resize");
  });
  it("picks the closest handle when a small box's handle zones overlap", () => {
    const small = { x: 95, y: 195, width: 10, height: 10 };
    expect(nearestHandle(small, anchor, rest, { x: 105, y: 205 }, 9)).toEqual({ hx: 1, hy: 1 });
    expect(nearestHandle(small, anchor, rest, { x: 106, y: 200 }, 9)).toEqual({ hx: 1, hy: 0 });
    expect(nearestHandle(small, anchor, rest, { x: 130, y: 200 }, 9)).toBeNull();
  });
  it("keeps scales within 400%", () => {
    expect(dragHandle(bounds, anchor, rest, { hx: 1, hy: 0 }, { x: 1000, y: 0 }, pinned).sx).toBe(4);
    const corner = dragHandle(bounds, anchor, { ...rest, sy: 2 }, { hx: 1, hy: 1 }, { x: 1000, y: 1000 }, pinned);
    expect([corner.sx, corner.sy]).toEqual([2, 4]);
  });
});
