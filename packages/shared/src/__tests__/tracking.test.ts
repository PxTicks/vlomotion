import { describe, expect, it } from "vitest";
import { MAX_MOTION_KEYS, buildMotionCurve, validateMotion } from "../motion.js";
import { createMaskMotion } from "../inpaint.js";
import { cleanTrack, followTrack, smoothTrack, trackedBounds } from "../tracking.js";
import type { TrackFrame } from "../tracking.js";

const size = { width: 1000, height: 500 };
/** A square object of side `side` centred on (x, y), clipped to the frame like a real mask. */
function square(x: number, y: number, side = 40): TrackFrame {
  const left = Math.max(0, x - side / 2), right = Math.min(size.width, x + side / 2);
  const top = Math.max(0, y - side / 2), bottom = Math.min(size.height, y + side / 2);
  if (right <= left || bottom <= top) return null;
  return { area: (right - left) * (bottom - top), x: (left + right) / 2, y: (top + bottom) / 2, bounds: { x: left, y: top, width: right - left, height: bottom - top } };
}
const moving = (frames: number, at: (i: number) => [number, number, number?]) => Array.from({ length: frames }, (_, i) => square(...at(i)));
let id = 0;
const newId = () => `key-${++id}`;

describe("track smoothing", () => {
  it("keeps steady and accelerating motion exactly, including at the ends of the clip", () => {
    const line = Array.from({ length: 30 }, (_, i) => 3 + 2 * i), curve = line.map((_, i) => 0.5 * i * i - i);
    smoothTrack(line).forEach((value, i) => expect(value).toBeCloseTo(line[i], 9));
    smoothTrack(curve).forEach((value, i) => expect(value).toBeCloseTo(curve[i], 9));
  });
  it("damps jitter", () => {
    const jitter = Array.from({ length: 40 }, (_, i) => 100 + (i % 2 ? 2 : -2));
    expect(Math.max(...smoothTrack(jitter).slice(5, -5).map(value => Math.abs(value - 100)))).toBeLessThan(0.5);
  });
});

describe("track cleaning", () => {
  it("needs the object on the first frame", () => {
    expect(cleanTrack([null, square(100, 100)], size)).toBeNull();
  });
  it("rejects a frame whose anchor or area jumps, and fills it from its neighbours", () => {
    const frames = moving(40, i => [100 + 5 * i, 200]);
    frames[20] = square(600, 400);
    frames[25] = square(225, 200, 120);
    const cleaned = cleanTrack(frames, size)!;
    expect(cleaned.filled).toBe(2);
    for (const i of [20, 25]) {
      expect(cleaned.poses[i].x).toBeCloseTo(100 + 5 * i, 6);
      expect(cleaned.poses[i].size).toBeCloseTo(40, 6);
    }
  });
  it("interpolates a short loss, then coasts at the last speed before holding", () => {
    const frames = moving(60, i => [100 + 4 * i, 250]);
    for (let i = 10; i < 14; i++) frames[i] = null;
    for (let i = 30; i < 60; i++) frames[i] = null;
    const { poses, filled } = cleanTrack(frames, size)!;
    expect(filled).toBe(34);
    expect(poses[12].x).toBeCloseTo(148, 6);
    // Lost after frame 29, it coasts for 12 frames to frame 41 and holds there.
    expect(poses[35].x).toBeCloseTo(100 + 4 * 35, 6);
    expect(poses[50].x).toBeCloseTo(100 + 4 * 41, 6);
    expect(poses[59].x).toBeCloseTo(100 + 4 * 41, 6);
  });
  it("holds the size and follows the visible side while the object leaves the frame", () => {
    const frames = moving(40, i => [900 + 5 * i, 250]);
    const { poses } = cleanTrack(frames, size)!;
    // Clipped from frame 16 and gone from frame 24, when it coasts on.
    for (const i of [18, 22, 28]) {
      expect(poses[i].x).toBeCloseTo(900 + 5 * i, 6);
      expect(poses[i].size).toBeCloseTo(40, 6);
    }
  });
});

describe("following a track", () => {
  const bounds = { x: 80, y: 100, width: 40, height: 20 };
  it("keeps the mask's offset from the object and scales it with the object", () => {
    // The object starts 100 px below the mask and doubles in size while moving right.
    const motion = createMaskMotion(bounds, 124);
    const track = { width: 500, height: 250, frames: moving(124, i => [50 + 2 * i, 105, 20 * 2 ** (i / 123)]) };
    const result = followTrack(motion, track, size, newId)!;
    expect(result.filled).toBe(0);
    const { keys } = result.motion;
    expect(keys[0]).toEqual(motion.keys[0]);
    expect(keys.length).toBeLessThanOrEqual(MAX_MOTION_KEYS);
    expect(keys.at(-1)).toMatchObject({ frame: 123, sx: expect.closeTo(2, 3), sy: expect.closeTo(2, 3) });
    // The object ends at (592, 210) at twice the size, so the mask sits 200 px above it.
    expect(keys.at(-1)!.x).toBeCloseTo(592, 0);
    expect(keys.at(-1)!.y).toBeCloseTo(10, 0);
    expect(validateMotion(result.motion)).toEqual([]);
    const curve = buildMotionCurve(result.motion), middle = curve.positionAt(62);
    expect(middle.x).toBeCloseTo(100 + 4 * 62, -1);
  });
  it("refuses a track of the wrong length or one that misses the first frame", () => {
    const motion = createMaskMotion(bounds, 124);
    expect(followTrack(motion, { width: 1000, height: 500, frames: moving(107, i => [100 + i, 100]) }, size, newId)).toBeNull();
    expect(followTrack(motion, { width: 1000, height: 500, frames: [null, ...moving(123, i => [100 + i, 100])] }, size, newId)).toBeNull();
  });
  it("scales tracked bounds onto the motion frame", () => {
    const track = { width: 500, height: 250, frames: [square(100, 50), null] };
    expect(trackedBounds(track, 0, size)).toEqual({ x: 160, y: 60, width: 80, height: 80 });
    expect(trackedBounds(track, 1, size)).toBeNull();
  });
});
