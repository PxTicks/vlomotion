import { z } from "zod";
import { videoDimensionSchema } from "./media.js";
import type { FrameSize, Point } from "./media.js";
import { inpaintFramesSchema } from "./inpaint.js";
import { MAX_MOTION_KEYS, simplifyPath } from "./motion.js";
import type { Pose, Rect, SubjectMotion } from "./motion.js";

const rectSchema = z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().finite().nonnegative(), height: z.number().finite().nonnegative() });
/**
 * The tracked object on one frame, in the tracked video's pixels: its area, the median of its pixels and its
 * bounds. Null when SAM lost it.
 */
export const trackFrameSchema = z.object({ area: z.number().positive(), x: z.number().finite(), y: z.number().finite(), bounds: rectSchema }).nullable();
export type TrackFrame = z.infer<typeof trackFrameSchema>;
/**
 * Sent as the `request` field of a multipart upload with the prepared `source` video. The object is the union of the
 * subjects selected on `frameId`, the prepared video's first frame uploaded to /frames.
 */
export const trackRequestSchema = z.object({
  videoId: z.uuid(), width: videoDimensionSchema, height: videoDimensionSchema, frames: inpaintFramesSchema,
  frameId: z.uuid(), candidateIds: z.array(z.uuid()).min(1).max(16),
});
export type TrackRequest = z.infer<typeof trackRequestSchema>;
export const trackResultSchema = z.object({
  videoId: z.uuid(), width: videoDimensionSchema, height: videoDimensionSchema, frames: z.array(trackFrameSchema),
});
export type TrackResult = z.infer<typeof trackResultSchema>;

/** Where the object is on a frame and its linear size: the square root of its area. */
export interface TrackedPose extends Point { size: number }
export interface CleanTrack {
  poses: TrackedPose[];
  /** How many frames the object was lost or rejected on, and had its pose filled in from the frames around it. */
  filled: number;
}

/** Frames either side compared when rejecting a frame: a quarter of a second. */
const NEIGHBOURS = 6;
/** Smaller detections are noise, and their median jumps a pixel at a time. */
const MIN_AREA = 16;
/** How far a frame's area may stray from its neighbours' median before it is rejected. */
const AREA_RANGE = [0.5, 2] as const;
/** How far a frame's anchor may stray from its neighbours' median, as a fraction of the object's size. */
const MAX_JUMP = 0.35;
/** Gaussian width of the smoothing, in frames. */
const SMOOTHING = 2;
/** A lost object keeps moving at its last speed for this many frames, then holds. */
const COAST_FRAMES = 12;
/** Roughly how far the keyed path may stray from the smoothed track, as a fraction of the longer side of the frame. */
const KEY_TOLERANCE = 0.003;
/** A one-frame timing error counts as half the key tolerance, and a 2% size error as all of it. */
const KEY_TIME_WEIGHT = 0.5, KEY_SCALE_STEP = 0.02;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Zero-phase smoothing: each value is replaced by a quadratic fitted to its neighbourhood with Gaussian weights.
 * Unlike a plain blur it doesn't lag behind steady motion, and it keeps the ends of the clip where they are.
 */
export function smoothTrack(values: number[], sigma = SMOOTHING): number[] {
  const reach = Math.ceil(3 * sigma);
  return values.map((value, i) => {
    const s = [0, 0, 0, 0, 0], t = [0, 0, 0];
    for (let j = Math.max(0, i - reach); j <= Math.min(values.length - 1, i + reach); j++) {
      const d = j - i, w = Math.exp(-d * d / (2 * sigma * sigma));
      for (let k = 0; k < 5; k++) s[k] += w * d ** k;
      for (let k = 0; k < 3; k++) t[k] += w * d ** k * values[j];
    }
    // Cramer's rule for the intercept of the weighted least-squares quadratic.
    const det = s[0] * (s[2] * s[4] - s[3] * s[3]) - s[1] * (s[1] * s[4] - s[3] * s[2]) + s[2] * (s[1] * s[3] - s[2] * s[2]);
    if (Math.abs(det) < 1e-9) return value;
    return (t[0] * (s[2] * s[4] - s[3] * s[3]) - s[1] * (t[1] * s[4] - s[3] * t[2]) + s[2] * (t[1] * s[3] - s[2] * t[2])) / det;
  });
}

/**
 * Turns per-frame detections into a steady pose for every frame, or null if the object isn't on the first frame.
 * A frame is rejected when its area or anchor jumps away from its neighbours. While the object is clipped by the
 * frame edge, its size holds and its anchor keeps its distance from the side that is still visible. Gaps are
 * interpolated, the end coasts briefly at the last speed, and everything is smoothed without lag.
 */
export function cleanTrack(frames: TrackFrame[], size: FrameSize): CleanTrack | null {
  const found = frames.map(frame => frame && frame.area >= MIN_AREA ? frame : null);
  if (!found[0]) return null;
  const margin = { x: size.width * 0.002, y: size.height * 0.002 };
  const edges = found.map(frame => frame && {
    left: frame.bounds.x <= margin.x, right: frame.bounds.x + frame.bounds.width >= size.width - margin.x,
    top: frame.bounds.y <= margin.y, bottom: frame.bounds.y + frame.bounds.height >= size.height - margin.y,
  });
  const clipped = (i: number) => { const edge = edges[i]; return !!edge && (edge.left || edge.right || edge.top || edge.bottom); };
  /** Found frames either side of `i`, symmetric so that steady motion has its median at `i`, even near the ends. */
  const near = (i: number) => {
    const reach = Math.min(NEIGHBOURS, i, found.length - 1 - i), indices: number[] = [];
    for (let j = i - reach; j <= i + reach; j++) if (j !== i && found[j]) indices.push(j);
    return indices;
  };
  const good = found.map((frame, i) => {
    if (!frame) return false;
    const around = near(i);
    if (i === 0 || around.length < 3) return true;
    const whole = around.filter(j => !clipped(j));
    if (!clipped(i) && whole.length >= 3) {
      const ratio = frame.area / median(whole.map(j => found[j]!.area));
      if (ratio < AREA_RANGE[0] || ratio > AREA_RANGE[1]) return false;
    }
    const scale = Math.sqrt(median(around.map(j => found[j]!.area)));
    return Math.hypot(frame.x - median(around.map(j => found[j]!.x)), frame.y - median(around.map(j => found[j]!.y))) <= MAX_JUMP * scale + 2;
  });
  const whole = found.map((_, i) => good[i] && !clipped(i));
  /** The nearest accepted frame where the object is wholly in view. */
  const reference = (i: number) => {
    for (let d = 1; d < found.length; d++) {
      if (i - d >= 0 && whole[i - d]) return i - d;
      if (i + d < found.length && whole[i + d]) return i + d;
    }
    return null;
  };
  const measured: (TrackedPose | null)[] = found.map((frame, i) => {
    if (!frame || !good[i]) return null;
    const edge = edges[i]!, r = clipped(i) ? reference(i) : null;
    if (r === null) return { x: frame.x, y: frame.y, size: Math.sqrt(frame.area) };
    const ref = found[r]!, b = frame.bounds, rb = ref.bounds;
    // Clipped on both sides of an axis, neither side is reliable, so keep the median there.
    const x = edge.left === edge.right ? frame.x : edge.left ? b.x + b.width - (rb.x + rb.width - ref.x) : b.x + (ref.x - rb.x);
    const y = edge.top === edge.bottom ? frame.y : edge.top ? b.y + b.height - (rb.y + rb.height - ref.y) : b.y + (ref.y - rb.y);
    return { x, y, size: Math.sqrt(ref.area) };
  });
  const known = measured.flatMap((pose, i) => pose ? [i] : []);
  const poses = measured.map((pose, i): TrackedPose => {
    if (pose) return pose;
    const previous = known.filter(j => j < i).at(-1)!, next = known.find(j => j > i);
    const a = measured[previous]!;
    if (next !== undefined) {
      const b = measured[next]!, t = (i - previous) / (next - previous);
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, size: a.size * (b.size / a.size) ** t };
    }
    const from = known.find(j => j >= previous - NEIGHBOURS)!, span = previous - from, coast = Math.min(i - previous, COAST_FRAMES);
    const start = measured[from]!;
    return span ? { x: a.x + (a.x - start.x) / span * coast, y: a.y + (a.y - start.y) / span * coast, size: a.size } : { ...a };
  });
  const xs = smoothTrack(poses.map(pose => pose.x)), ys = smoothTrack(poses.map(pose => pose.y));
  const sizes = smoothTrack(poses.map(pose => Math.log(pose.size))).map(Math.exp);
  return { poses: poses.map((_, i) => ({ x: xs[i], y: ys[i], size: sizes[i] })), filled: good.filter(ok => !ok).length };
}

/**
 * Keys a mask to follow a tracked object: it keeps its first-frame offset from the object, and the offset and
 * the mask scale with the object. `size` is the frame the motion is drawn in; the track is scaled onto it.
 * The smoothed path is simplified into editable keys. Returns null if the object isn't on the first frame.
 */
export function followTrack<M extends SubjectMotion<number>>(motion: M, track: Pick<TrackResult, "width" | "height" | "frames">, size: FrameSize, newId: () => string): { motion: M; filled: number } | null {
  if (track.frames.length !== motion.frames) return null;
  const kx = size.width / track.width, ky = size.height / track.height;
  const frames = track.frames.map(frame => frame && { area: frame.area * kx * ky, x: frame.x * kx, y: frame.y * ky,
    bounds: { x: frame.bounds.x * kx, y: frame.bounds.y * ky, width: frame.bounds.width * kx, height: frame.bounds.height * ky } });
  const cleaned = cleanTrack(frames, size);
  if (!cleaned) return null;
  const [origin] = cleaned.poses, offset = { x: motion.anchor.x - origin.x, y: motion.anchor.y - origin.y };
  const poses = cleaned.poses.map((pose, frame): Pose & { frame: number } => {
    const scale = pose.size / origin.size;
    return { frame, sx: scale, sy: scale,
      x: clamp(pose.x + offset.x * scale, -size.width, size.width * 2), y: clamp(pose.y + offset.y * scale, -size.height, size.height * 2) };
  });
  const tolerance = Math.max(1, KEY_TOLERANCE * Math.max(size.width, size.height));
  const vector = ({ x, y, frame, sx }: Pose & { frame: number }) => [x, y, frame * tolerance * KEY_TIME_WEIGHT, Math.log(sx) * tolerance / KEY_SCALE_STEP];
  let epsilon = tolerance, kept = simplifyPath(poses, vector, epsilon);
  while (kept.length > MAX_MOTION_KEYS) kept = simplifyPath(poses, vector, epsilon *= 1.5);
  const keys = [motion.keys[0], ...kept.slice(1).map(({ frame, x, y, sx, sy }) => ({ id: newId(), frame, x, y, sx, sy }))];
  return { motion: { ...motion, keys }, filled: cleaned.filled };
}

/** The tracked object's bounds on a frame, scaled onto `size`, or null where it was lost. */
export function trackedBounds(track: Pick<TrackResult, "width" | "height" | "frames">, frame: number, size: FrameSize): Rect | null {
  const found = track.frames[frame];
  if (!found) return null;
  const kx = size.width / track.width, ky = size.height / track.height, b = found.bounds;
  return { x: b.x * kx, y: b.y * ky, width: b.width * kx, height: b.height * ky };
}
