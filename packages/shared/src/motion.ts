import type { FrameCount, FrameSize, Point } from "./media.js";

/** A position key. Frames sit on the 24 fps output grid; x/y are the subject anchor in working-image pixels. */
export interface MotionKey { id: string; frame: number; x: number; y: number }
export type MotionTiming = "smooth" | "linear";
/** keys[0] is the photo: frame 0 at the anchor, never moved, retimed or deleted. */
export interface SubjectMotion { anchor: Point; frames: FrameCount; timing: MotionTiming; keys: MotionKey[] }
export interface Rect { x: number; y: number; width: number; height: number }
/** A recorded pointer position; `time` is in milliseconds from the start of the drag. */
export interface TimedSample { time: number; x: number; y: number }

export const MAX_MOTION_KEYS = 32;
const START_KEY_ID = "start";
const ALPHA = 0.5;
const RECORD_TIME_SCALE = 2;
const RECORD_EPSILON = 4;
const RECORD_MOVE_EPSILON = 1;

const distance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
export const lastFrame = (motion: Pick<SubjectMotion, "frames">) => motion.frames - 1;

/** Centripetal Catmull-Rom between p1 and p2 (ported from vlo's catmullRomUtils). */
function catmullRom(p0: Point, p1: Point, p2: Point, p3: Point, u: number): Point {
  if (u <= 0) return { x: p1.x, y: p1.y };
  if (u >= 1) return { x: p2.x, y: p2.y };
  // The epsilon keeps coincident outer control points from dividing by zero.
  const knot = (a: Point, b: Point) => Math.max(1e-6, distance(a, b) ** ALPHA);
  const t1 = knot(p0, p1), t2 = t1 + knot(p1, p2), t3 = t2 + knot(p2, p3), t = t1 + u * (t2 - t1);
  const lerp = (a: Point, b: Point, ta: number, tb: number): Point =>
    ({ x: ((tb - t) * a.x + (t - ta) * b.x) / (tb - ta), y: ((tb - t) * a.y + (t - ta) * b.y) / (tb - ta) });
  const a1 = lerp(p0, p1, 0, t1), a2 = lerp(p1, p2, t1, t2), a3 = lerp(p2, p3, t2, t3);
  return lerp(lerp(a1, a2, 0, t2), lerp(a2, a3, t1, t3), t1, t2);
}

/** Open-path segment evaluation with mirrored virtual end points. */
function segmentPoint(points: Point[], i: number, u: number): Point {
  const p1 = points[i], p2 = points[i + 1];
  const p0 = i > 0 ? points[i - 1] : { x: 2 * p1.x - p2.x, y: 2 * p1.y - p2.y };
  const p3 = i < points.length - 2 ? points[i + 2] : { x: 2 * p2.x - p1.x, y: 2 * p2.y - p1.y };
  return catmullRom(p0, p1, p2, p3, u);
}

/** Fritsch-Carlson monotone cubic (ported from vlo's MonotoneCubicSpline). xs must be strictly increasing. */
function monotoneCubic(xs: number[], ys: number[]): (x: number) => number {
  const n = xs.length;
  if (n === 1) return () => ys[0];
  const secants = xs.slice(1).map((x, i) => (ys[i + 1] - ys[i]) / (x - xs[i]));
  const m = xs.map((_, i) => i === 0 ? secants[0] : i === n - 1 ? secants[n - 2] : (secants[i - 1] + secants[i]) / 2);
  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(secants[i]) < 1e-9) { m[i] = 0; m[i + 1] = 0; continue; }
    if (i > 0 && secants[i - 1] * secants[i] <= 0) m[i] = 0;
    const a = m[i] / secants[i], b = m[i + 1] / secants[i], r = Math.hypot(a, b);
    if (r > 3) { m[i] = a * 3 / r * secants[i]; m[i + 1] = b * 3 / r * secants[i]; }
  }
  return x => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x >= xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
    const y = (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
    return clamp(y, Math.min(ys[i], ys[i + 1]), Math.max(ys[i], ys[i + 1]));
  };
}

function piecewiseLinear(xs: number[], ys: number[]): (x: number) => number {
  return x => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
    let i = 0;
    while (x >= xs[i + 1]) i++;
    return ys[i] + (ys[i + 1] - ys[i]) * (x - xs[i]) / (xs[i + 1] - xs[i]);
  };
}

interface PathSample extends Point { segment: number; u: number; length: number }

export interface MotionCurve {
  motion: SubjectMotion;
  /** Dense arc-length samples along the path, for drawing and hit testing. */
  samples: PathSample[];
  /** Cumulative path length at each key. */
  keyLengths: number[];
  length: number;
  lengthAt(frame: number): number;
  /** The earliest (fractional) frame at which the subject has travelled `length`. */
  frameAtLength(length: number): number;
  pointAtLength(length: number): Point;
  positionAt(frame: number): Point;
  offsetAt(frame: number): Point;
  nearest(point: Point): { length: number; distance: number };
}

/**
 * Evaluates keys as a spatial curve plus a timing curve: the subject follows a centripetal
 * Catmull-Rom path through the key positions, and a monotone cubic through (frame, arc length)
 * decides how far along it is. The timing curve is flat at holds and never backtracks.
 */
export function buildMotionCurve(motion: SubjectMotion): MotionCurve {
  const { keys, anchor } = motion;
  const points: Point[] = [];
  const keyPoint: number[] = [];
  for (const key of keys) {
    const previous = points[points.length - 1];
    if (!previous || previous.x !== key.x || previous.y !== key.y) points.push({ x: key.x, y: key.y });
    keyPoint.push(points.length - 1);
  }
  // Power-of-two sample counts keep u exact at segment ends, so keys evaluate to their own positions.
  const samples: PathSample[] = [{ ...points[0], segment: 0, u: 0, length: 0 }];
  const pointLengths = [0];
  for (let i = 0; i < points.length - 1; i++) {
    const count = 2 ** Math.ceil(Math.log2(clamp(distance(points[i], points[i + 1]) / 4, 8, 256)));
    for (let s = 1; s <= count; s++) {
      const u = s / count, p = segmentPoint(points, i, u), previous = samples[samples.length - 1];
      samples.push({ ...p, segment: i, u, length: previous.length + distance(previous, p) });
    }
    pointLengths.push(samples[samples.length - 1].length);
  }
  const length = samples[samples.length - 1].length;
  const keyLengths = keyPoint.map(i => pointLengths[i]);
  const xs = keys.map(key => key.frame);
  const timing = motion.timing === "linear" ? piecewiseLinear(xs, keyLengths) : monotoneCubic(xs, keyLengths);
  const end = xs[xs.length - 1];

  function pointAtLength(target: number): Point {
    if (target <= 0 || samples.length === 1) return { ...points[0] };
    if (target >= length) return { ...points[points.length - 1] };
    let low = 1, high = samples.length - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (samples[mid].length < target) low = mid + 1; else high = mid;
    }
    const a = samples[low - 1], b = samples[low];
    const fraction = (target - a.length) / (b.length - a.length);
    const startU = a.segment === b.segment ? a.u : 0;
    return segmentPoint(points, b.segment, startU + fraction * (b.u - startU));
  }
  const lengthAt = (frame: number) => timing(clamp(frame, 0, end));
  const positionAt = (frame: number) => pointAtLength(lengthAt(frame));

  return {
    motion, samples, keyLengths, length, lengthAt, pointAtLength, positionAt,
    offsetAt: frame => { const p = positionAt(frame); return { x: p.x - anchor.x, y: p.y - anchor.y }; },
    frameAtLength: target => {
      let low = 0, high = end;
      for (let i = 0; i < 48; i++) {
        const mid = (low + high) / 2;
        if (lengthAt(mid) < target) low = mid; else high = mid;
      }
      return high;
    },
    nearest: point => {
      let best = { length: 0, distance: distance(point, samples[0]) };
      for (let i = 1; i < samples.length; i++) {
        const a = samples[i - 1], b = samples[i], dx = b.x - a.x, dy = b.y - a.y, span = dx * dx + dy * dy;
        const t = span ? clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / span, 0, 1) : 0;
        const d = distance(point, { x: a.x + t * dx, y: a.y + t * dy });
        if (d < best.distance) best = { length: a.length + t * (b.length - a.length), distance: d };
      }
      return best;
    },
  };
}

/** Rounds frames onto the grid and enforces key 0 at frame 0, at least one frame between keys, and the clip end. */
function spaceFrames(frames: number[], last: number): number[] {
  const out = frames.map(Math.round);
  out[0] = 0;
  for (let i = 1; i < out.length; i++) out[i] = Math.max(out[i], out[i - 1] + 1);
  for (let i = out.length - 1; i > 0; i--) out[i] = Math.min(out[i], i === out.length - 1 ? last : out[i + 1] - 1);
  return out;
}

const withFrames = (motion: SubjectMotion, frames: number[]): SubjectMotion =>
  ({ ...motion, keys: motion.keys.map((key, i) => ({ ...key, frame: frames[i] })) });

export function createMotion(anchor: Point, frames: FrameCount = 124, timing: MotionTiming = "smooth"): SubjectMotion {
  return { anchor: { ...anchor }, frames, timing, keys: [{ id: START_KEY_ID, frame: 0, x: anchor.x, y: anchor.y }] };
}

export const isStartKey = (motion: SubjectMotion, id: string) => motion.keys[0]?.id === id;

/** Sets the position at a frame: updates the key already there, or inserts one. Frame 0 is the photo and can't change. */
export function upsertKey(motion: SubjectMotion, frame: number, point: Point, id: string): { motion: SubjectMotion; id: string } | null {
  const at = Math.round(frame);
  if (at <= 0 || at > lastFrame(motion)) return null;
  const existing = motion.keys.find(key => key.frame === at);
  if (existing) return { motion: moveKey(motion, existing.id, point), id: existing.id };
  if (motion.keys.length >= MAX_MOTION_KEYS) return null;
  const keys = [...motion.keys, { id, frame: at, x: point.x, y: point.y }].sort((a, b) => a.frame - b.frame);
  return { motion: { ...motion, keys }, id };
}

export function moveKey(motion: SubjectMotion, id: string, point: Point): SubjectMotion {
  if (isStartKey(motion, id)) return motion;
  return { ...motion, keys: motion.keys.map(key => key.id === id ? { ...key, x: point.x, y: point.y } : key) };
}

/** Moves one key in time, clamped between its neighbours. Only the two adjacent segments change speed. */
export function retimeKey(motion: SubjectMotion, id: string, frame: number): SubjectMotion {
  const i = motion.keys.findIndex(key => key.id === id);
  if (i <= 0) return motion;
  const min = motion.keys[i - 1].frame + 1;
  const max = i < motion.keys.length - 1 ? motion.keys[i + 1].frame - 1 : lastFrame(motion);
  const at = clamp(Math.round(frame), min, max);
  return at === motion.keys[i].frame ? motion : { ...motion, keys: motion.keys.map(key => key.id === id ? { ...key, frame: at } : key) };
}

/** Inserts a key on the existing path at an arc length, timed where the subject currently passes that point. */
export function insertKeyAtLength(motion: SubjectMotion, length: number, id: string): { motion: SubjectMotion; id: string } | null {
  const curve = buildMotionCurve(motion);
  if (length <= 0 || length >= curve.length || motion.keys.length >= MAX_MOTION_KEYS) return null;
  const frame = Math.round(curve.frameAtLength(length));
  if (motion.keys.some(key => key.frame === frame)) return null;
  const point = curve.pointAtLength(length);
  const keys = [...motion.keys, { id, frame, x: point.x, y: point.y }].sort((a, b) => a.frame - b.frame);
  return { motion: { ...motion, keys }, id };
}

export function deleteKey(motion: SubjectMotion, id: string): SubjectMotion {
  if (isStartKey(motion, id)) return motion;
  return { ...motion, keys: motion.keys.filter(key => key.id !== id) };
}

/** Re-spaces keys for constant speed along the path between the first and last key. Holds keep their length. */
export function evenSpeed(motion: SubjectMotion): SubjectMotion {
  const { keys } = motion;
  if (keys.length < 3) return motion;
  const { keyLengths, length } = buildMotionCurve(motion);
  if (length === 0) return motion;
  const end = keys[keys.length - 1].frame;
  let held = 0;
  for (let i = 1; i < keys.length; i++) if (keyLengths[i] === keyLengths[i - 1]) held += keys[i].frame - keys[i - 1].frame;
  const moving = end - held;
  const frames = [0];
  let t = 0;
  for (let i = 1; i < keys.length; i++) {
    const span = keyLengths[i] - keyLengths[i - 1];
    t += span === 0 ? keys[i].frame - keys[i - 1].frame : moving * span / length;
    frames.push(i === keys.length - 1 ? end : t);
  }
  return withFrames(motion, spaceFrames(frames, end));
}

/** Changes the clip length. Keys that fit are kept; otherwise all keys are compressed to end on the last frame. */
export function setClipFrames(motion: SubjectMotion, frames: FrameCount): SubjectMotion {
  const next = { ...motion, frames };
  const end = motion.keys[motion.keys.length - 1].frame, last = lastFrame(next);
  if (end <= last) return next;
  return withFrames(next, spaceFrames(motion.keys.map(key => key.frame * last / end), last));
}

type FrameSample = Point & { frame: number; z: number };

function rdp(points: FrameSample[], epsilon: number): FrameSample[] {
  if (points.length <= 2) return points;
  const a = points[0], b = points[points.length - 1];
  const ab = [b.x - a.x, b.y - a.y, b.z - a.z], span = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
  let index = 0, max = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i], ap = [p.x - a.x, p.y - a.y, p.z - a.z];
    const t = span ? clamp((ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / span, 0, 1) : 0;
    const d = Math.hypot(ap[0] - t * ab[0], ap[1] - t * ab[1], ap[2] - t * ab[2]);
    if (d > max) { max = d; index = i; }
  }
  if (max <= epsilon) return [a, b];
  return [...rdp(points.slice(0, index + 1), epsilon).slice(0, -1), ...rdp(points.slice(index), epsilon)];
}

/**
 * Turns a recorded drag into keys from `startFrame` to the end of the clip, following vlo: the take's
 * timing is normalised to fill that span whatever time the drag took. Idle time before the first movement
 * and after the subject reaches its final position is dropped; pauses and speed changes in between keep
 * their proportions. Keys before `startFrame` are kept and everything after it is replaced.
 */
export function applyRecording(motion: SubjectMotion, samples: TimedSample[], startFrame: number, newId: () => string): SubjectMotion {
  const last = lastFrame(motion);
  const start = clamp(Math.round(startFrame), 0, last);
  if (samples.length < 2 || start >= last) return motion;
  const origin = samples[0], final = samples[samples.length - 1];
  const first = samples.findIndex(sample => distance(sample, origin) > RECORD_MOVE_EPSILON);
  if (first < 0) return motion;
  let end = samples.length - 1;
  while (end > first && distance(samples[end - 1], final) <= RECORD_MOVE_EPSILON) end--;
  const base = samples[first - 1].time, duration = samples[end].time - base;
  if (duration <= 0) return motion;
  const toFrame = (time: number) => start + (time - base) / duration * (last - start);
  const timed = [{ ...origin, time: base }, ...samples.slice(first, end), { ...final, time: samples[end].time }]
    .map(({ x, y, time }) => ({ x, y, frame: toFrame(time), z: toFrame(time) * RECORD_TIME_SCALE }));
  const coarse = [timed[0]];
  for (const sample of timed.slice(1, -1)) {
    const previous = coarse[coarse.length - 1];
    if (Math.hypot(sample.x - previous.x, sample.y - previous.y, sample.z - previous.z) >= 1) coarse.push(sample);
  }
  coarse.push(timed[timed.length - 1]);
  const kept = motion.keys.filter((key, i) => i === 0 || key.frame < start);
  let epsilon = RECORD_EPSILON, simplified = rdp(coarse, epsilon);
  while (kept.length + simplified.length > MAX_MOTION_KEYS) simplified = rdp(coarse, epsilon *= 1.5);
  const recorded: MotionKey[] = [];
  for (const sample of simplified) {
    const frame = Math.round(sample.frame), previous = recorded[recorded.length - 1];
    // Later samples win a shared frame, so the take always ends exactly where the drag was released.
    if (previous?.frame === frame) { previous.x = sample.x; previous.y = sample.y; continue; }
    if (frame === 0 || frame <= (previous ?? kept[kept.length - 1]).frame) continue;
    recorded.push({ id: newId(), frame, x: sample.x, y: sample.y });
  }
  return { ...motion, keys: [...kept, ...recorded] };
}

export function validateMotion(motion: SubjectMotion): string[] {
  const errors: string[] = [];
  const [first] = motion.keys;
  if (!first || first.frame !== 0 || first.x !== motion.anchor.x || first.y !== motion.anchor.y) errors.push("The first key must be the photo position at 0 s.");
  if (motion.keys.length > MAX_MOTION_KEYS) errors.push(`Use at most ${MAX_MOTION_KEYS} keys.`);
  motion.keys.forEach((key, i) => {
    if (!Number.isInteger(key.frame) || key.frame < 0 || key.frame > lastFrame(motion)) errors.push("Keys must sit on frames inside the clip.");
    else if (i > 0 && key.frame <= motion.keys[i - 1].frame) errors.push("Key times must strictly increase.");
    if (!Number.isFinite(key.x) || !Number.isFinite(key.y)) errors.push("Key positions must be finite.");
  });
  return [...new Set(errors)];
}

/** First frame at which the subject's bounds lie entirely outside the image, or null. */
export function firstFrameOutside(curve: MotionCurve, bounds: Rect, size: FrameSize): number | null {
  for (let frame = 0; frame <= lastFrame(curve.motion); frame++) {
    const { x, y } = curve.offsetAt(frame);
    if (bounds.x + x >= size.width || bounds.x + bounds.width + x <= 0 || bounds.y + y >= size.height || bounds.y + bounds.height + y <= 0) return frame;
  }
  return null;
}
