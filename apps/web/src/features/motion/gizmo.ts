import { MAX_SCALE } from "@h3-motion/shared";
import type { Point, Pose, Rect } from "@h3-motion/shared";

/** A box handle by side: -1 is left/top, 1 is right/bottom, 0 is the middle of that axis. */
export interface Handle { hx: -1 | 0 | 1; hy: -1 | 0 | 1 }
export type ResizeCursor = "ew-resize" | "ns-resize" | "nwse-resize" | "nesw-resize";
export interface DragOptions {
  /** Corners scale both axes by the same factor unless this frees them. */
  free: boolean;
  /** Scales about the subject's centre instead of pinning the opposite side. */
  centred: boolean;
}

export const HANDLES: Handle[] = ([-1, 0, 1] as const).flatMap(hy => ([-1, 0, 1] as const).map(hx => ({ hx, hy })))
  .filter(({ hx, hy }) => hx || hy);

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const side = (min: number, size: number, h: -1 | 0 | 1) => min + size * (h + 1) / 2;

/** The handle's offset from the anchor on the unscaled subject. */
function local(bounds: Rect, anchor: Point, { hx, hy }: Handle): Point {
  return { x: side(bounds.x, bounds.width, hx) - anchor.x, y: side(bounds.y, bounds.height, hy) - anchor.y };
}

const world = (point: Point, pose: Pose): Point => ({ x: pose.x + point.x * pose.sx, y: pose.y + point.y * pose.sy });

/** Where a handle sits for a subject at `pose`. */
export const handlePoint = (bounds: Rect, anchor: Point, pose: Pose, handle: Handle) => world(local(bounds, anchor, handle), pose);

/** The handle closest to `point` within `radius`. On a small box the zones overlap, so the closest wins. */
export function nearestHandle(bounds: Rect, anchor: Point, pose: Pose, point: Point, radius: number): Handle | null {
  let nearest: Handle | null = null, best = radius;
  for (const handle of HANDLES) {
    const at = handlePoint(bounds, anchor, pose, handle), distance = Math.hypot(point.x - at.x, point.y - at.y);
    if (distance <= best) { nearest = handle; best = distance; }
  }
  return nearest;
}

/** The resize cursor matching the direction the handle faces on screen, which a flip reverses. */
export function handleCursor(handle: Handle, pose: Pose): ResizeCursor {
  if (!handle.hy) return "ew-resize";
  if (!handle.hx) return "ns-resize";
  return handle.hx * handle.hy * Math.sign(pose.sx * pose.sy || 1) > 0 ? "nwse-resize" : "nesw-resize";
}

/**
 * The pose after dragging `handle` by `delta` from `start`. Edges change one axis, corners both. The opposite
 * side stays put unless `centred`, so the subject's position changes too. Dragging past the pinned side
 * mirrors that axis. Scales are kept within ±MAX_SCALE.
 */
export function dragHandle(bounds: Rect, anchor: Point, start: Pose, handle: Handle, delta: Point, { free, centred }: DragOptions): Pose {
  const grabbed = local(bounds, anchor, handle);
  const pinned = centred ? { x: 0, y: 0 } : local(bounds, anchor, { hx: -handle.hx as Handle["hx"], hy: -handle.hy as Handle["hy"] });
  const from = world(grabbed, start), pin = world(pinned, start), to = { x: from.x + delta.x, y: from.y + delta.y };
  let sx = start.sx, sy = start.sy;
  const span = { x: from.x - pin.x, y: from.y - pin.y }, length = span.x ** 2 + span.y ** 2;
  if (handle.hx && handle.hy && !free && length > 0) {
    // Project the drag onto the diagonal, so the aspect ratio holds wherever the pointer strays.
    const largest = Math.max(Math.abs(sx), Math.abs(sy));
    const factor = clamp(((to.x - pin.x) * span.x + (to.y - pin.y) * span.y) / length, -MAX_SCALE / largest, MAX_SCALE / largest);
    sx *= factor; sy *= factor;
  } else {
    if (handle.hx) sx = clamp((to.x - pin.x) / (grabbed.x - pinned.x), -MAX_SCALE, MAX_SCALE);
    if (handle.hy) sy = clamp((to.y - pin.y) / (grabbed.y - pinned.y), -MAX_SCALE, MAX_SCALE);
  }
  return { x: pin.x - pinned.x * sx, y: pin.y - pinned.y * sy, sx, sy };
}
