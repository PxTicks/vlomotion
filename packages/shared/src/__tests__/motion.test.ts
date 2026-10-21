import { describe, expect, it } from "vitest";
import {
  MAX_MOTION_KEYS, applyRecording, buildMotionCurve, createMotion, deleteKey, evenSpeed, firstFrameOutside,
  insertKeyAtLength, moveKey, retimeKey, setClipFrames, upsertKey, validateMotion,
} from "../motion.js";
import type { SubjectMotion } from "../motion.js";

let counter = 0;
const id = () => `k${++counter}`;
const anchor = { x: 100, y: 200 };

function motionWith(...keys: [number, number, number][]): SubjectMotion {
  let motion = createMotion(anchor);
  for (const [frame, x, y] of keys) motion = upsertKey(motion, frame, { x, y }, id())!.motion;
  return motion;
}

describe("motion curve", () => {
  it("passes exactly through every key at its frame and clamps outside the keyed range", () => {
    const motion = motionWith([24, 300, 200], [48, 300, 400], [96, 500, 100]);
    const curve = buildMotionCurve(motion);
    for (const key of motion.keys) expect(curve.positionAt(key.frame)).toEqual({ x: key.x, y: key.y });
    expect(curve.positionAt(-5)).toEqual(anchor);
    expect(curve.positionAt(123)).toEqual({ x: 500, y: 100 });
    expect(curve.offsetAt(24)).toEqual({ x: 200, y: 0 });
  });
  it("never backtracks along the path", () => {
    for (const timing of ["smooth", "linear"] as const) {
      const curve = buildMotionCurve({ ...motionWith([10, 400, 200], [60, 420, 210], [70, 100, 600]), timing });
      let previous = -1;
      for (let frame = 0; frame <= 123; frame += 0.25) {
        const length = curve.lengthAt(frame);
        expect(length).toBeGreaterThanOrEqual(previous);
        previous = length;
      }
    }
  });
  it("holds still between two keys at the same position", () => {
    const curve = buildMotionCurve(motionWith([24, 300, 200], [72, 300, 200], [96, 300, 400]));
    for (const frame of [24, 30, 50, 72]) expect(curve.positionAt(frame)).toEqual({ x: 300, y: 200 });
    expect(curve.positionAt(84).y).toBeGreaterThan(200);
  });
  it("keeps a single-key motion at the anchor", () => {
    const curve = buildMotionCurve(createMotion(anchor));
    expect(curve.length).toBe(0);
    expect(curve.positionAt(50)).toEqual(anchor);
    expect(curve.frameAtLength(10)).toBe(0);
  });
  it("finds the nearest path point and the frame at which it is reached", () => {
    const curve = buildMotionCurve({ ...motionWith([100, 300, 200]), timing: "linear" });
    const hit = curve.nearest({ x: 150, y: 210 });
    expect(hit.length).toBeCloseTo(50, 1);
    expect(hit.distance).toBeCloseTo(10, 1);
    expect(curve.frameAtLength(50)).toBeCloseTo(25, 1);
  });
});

describe("motion editing", () => {
  it("never changes the photo key", () => {
    const motion = motionWith([24, 300, 200]);
    const start = motion.keys[0].id;
    expect(upsertKey(motion, 0, { x: 1, y: 1 }, id())).toBeNull();
    expect(moveKey(motion, start, { x: 1, y: 1 })).toBe(motion);
    expect(retimeKey(motion, start, 10)).toBe(motion);
    expect(deleteKey(motion, start)).toBe(motion);
  });
  it("updates an existing key instead of duplicating its frame", () => {
    const motion = motionWith([24, 300, 200]);
    const result = upsertKey(motion, 24.2, { x: 10, y: 20 }, id())!;
    expect(result.id).toBe(motion.keys[1].id);
    expect(result.motion.keys).toHaveLength(2);
    expect(result.motion.keys[1]).toMatchObject({ frame: 24, x: 10, y: 20 });
    expect(upsertKey(motion, 124, { x: 0, y: 0 }, id())).toBeNull();
  });
  it("retimes only the dragged key, clamped one frame inside its neighbours and the clip", () => {
    const motion = motionWith([24, 300, 200], [48, 300, 400]);
    const [, middle, last] = motion.keys;
    expect(retimeKey(motion, middle.id, 60).keys.map(key => key.frame)).toEqual([0, 47, 48]);
    expect(retimeKey(motion, middle.id, -3).keys.map(key => key.frame)).toEqual([0, 1, 48]);
    expect(retimeKey(motion, last.id, 500).keys.map(key => key.frame)).toEqual([0, 24, 123]);
  });
  it("inserts a key on the path with an interpolated time", () => {
    const motion = { ...motionWith([100, 300, 200]), timing: "linear" as const };
    const result = insertKeyAtLength(motion, 50, "mid")!;
    expect(result.motion.keys.map(key => key.id)).toEqual(["start", "mid", motion.keys[1].id]);
    const inserted = result.motion.keys[1];
    expect(inserted).toMatchObject({ id: "mid", frame: 25 });
    expect(inserted.x).toBeCloseTo(150, 0);
    expect(inserted.y).toBeCloseTo(200, 6);
    expect(insertKeyAtLength(motion, 0, "x")).toBeNull();
    expect(insertKeyAtLength(result.motion, 50, "again")).toBeNull();
  });
  it("evens speed across moving segments and preserves holds", () => {
    const motion = { ...motionWith([10, 200, 200], [20, 200, 200], [100, 500, 200]), timing: "linear" as const };
    const even = evenSpeed(motion);
    // 400 px travelled over 90 moving frames: 100 px takes 22.5, then the 10-frame hold, then 300 px.
    expect(even.keys.map(key => key.frame)).toEqual([0, 23, 33, 100]);
    expect(validateMotion(even)).toEqual([]);
    const single = motionWith([50, 300, 200]);
    expect(evenSpeed(single)).toBe(single);
  });
  it("compresses keys only when a shorter clip would cut them off", () => {
    const long = setClipFrames(motionWith([60, 300, 200], [120, 300, 400]), 243);
    expect(long.keys.map(key => key.frame)).toEqual([0, 60, 120]);
    const short = setClipFrames({ ...long, keys: long.keys.map((key, i) => i === 2 ? { ...key, frame: 240 } : key) }, 124);
    expect(short.keys.map(key => key.frame)).toEqual([0, 31, 123]);
    expect(validateMotion(short)).toEqual([]);
  });
  it("caps the number of keys", () => {
    let motion = createMotion(anchor);
    for (let frame = 1; frame < MAX_MOTION_KEYS; frame++) motion = upsertKey(motion, frame, { x: frame, y: 0 }, id())!.motion;
    expect(motion.keys).toHaveLength(MAX_MOTION_KEYS);
    expect(upsertKey(motion, 100, { x: 0, y: 0 }, id())).toBeNull();
  });
});

describe("recording", () => {
  it("simplifies a live drag into keys that keep pauses and replace later keys", () => {
    const motion = motionWith([20, 120, 200], [100, 900, 900]);
    const samples = [];
    for (let frame = 20; frame <= 40; frame += 0.5) samples.push({ frame, x: 120 + (frame - 20) * 10, y: 200 });
    for (let frame = 40.5; frame <= 70; frame += 0.5) samples.push({ frame, x: 320, y: 200 });
    for (let frame = 70.5; frame <= 80; frame += 0.5) samples.push({ frame, x: 320, y: 200 + (frame - 70) * 10 });
    const recorded = applyRecording(motion, samples, id);
    expect(validateMotion(recorded)).toEqual([]);
    expect(recorded.keys.map(key => [key.frame, Math.round(key.x), Math.round(key.y)])).toEqual([
      [0, 100, 200], [20, 120, 200], [40, 320, 200], [70, 320, 200], [80, 320, 300],
    ]);
  });
  it("ignores a recording too short to describe motion", () => {
    const motion = motionWith([20, 120, 200]);
    expect(applyRecording(motion, [{ frame: 5, x: 0, y: 0 }], id)).toBe(motion);
  });
});

describe("validation and framing", () => {
  it("rejects keys out of order, off the grid or moved away from the photo", () => {
    const motion = motionWith([24, 300, 200]);
    expect(validateMotion(motion)).toEqual([]);
    expect(validateMotion({ ...motion, keys: [{ ...motion.keys[0], x: 1 }, motion.keys[1]] })).toHaveLength(1);
    expect(validateMotion({ ...motion, keys: [motion.keys[0], { ...motion.keys[1], frame: 0 }] })).toEqual(["Key times must strictly increase."]);
    expect(validateMotion({ ...motion, keys: [motion.keys[0], { ...motion.keys[1], frame: 1.5 }] })).toEqual(["Keys must sit on frames inside the clip."]);
  });
  it("reports the first frame at which the subject has completely left the image", () => {
    const curve = buildMotionCurve({ ...motionWith([100, 1100, 200]), timing: "linear" });
    const bounds = { x: 80, y: 180, width: 40, height: 40 };
    expect(firstFrameOutside(curve, bounds, { width: 1000, height: 500 })).toBe(92);
    expect(firstFrameOutside(curve, bounds, { width: 2000, height: 500 })).toBeNull();
  });
});
