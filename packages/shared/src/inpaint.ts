import { z } from "zod";
import { CLIP_FRAMES, FPS, videoDimensionSchema, videoGeometry } from "./media.js";
import type { FrameSize } from "./media.js";
import { buildMotionCurve, createMotion, placeRect, scaleOf } from "./motion.js";
import type { Rect, SubjectMotion } from "./motion.js";

export const maskShapeSchema = z.enum(["rectangle", "ellipse"]);
export type MaskShape = z.infer<typeof maskShapeSchema>;
export interface MaskBox { x: number; y: number; width: number; height: number }
/** Videos share the image clips' 15 s cap. */
export const MAX_VIDEO_SECONDS = Math.floor(CLIP_FRAMES.max / FPS);
export const inpaintFramesSchema = z.number().int().min(5).max(CLIP_FRAMES.max).refine(n => (n - 5) % 17 === 0, "Invalid H3 frame count.");
export const videoAssetSchema = z.object({
  id: z.uuid(), url: z.string(), width: z.number().int().positive(), height: z.number().int().positive(),
  startTime: z.number().finite().nonnegative().default(0),
  duration: z.number().finite().positive(), frames: z.number().int().positive(),
  /** Whether the video has a sound track. */
  audio: z.boolean().default(false),
});
export type VideoAsset = z.infer<typeof videoAssetSchema>;

/** The prepared and delivered size at `tier`'s short edge, keeping the source's ratio. */
export function inpaintSize(width: number, height: number, tier = 480) {
  return videoGeometry({ width, height }, tier).output;
}
export function inpaintFrames(duration: number) {
  const available = Math.min(CLIP_FRAMES.max, Math.floor(duration * FPS + 0.001));
  return Math.max(5, available - ((available - 5) % 17));
}
export function clampMask(box: MaskBox): MaskBox {
  const width = Math.max(0.01, Math.min(1, box.width)), height = Math.max(0.01, Math.min(1, box.height));
  return { x: Math.max(0, Math.min(1 - width, box.x)), y: Math.max(0, Math.min(1 - height, box.y)), width, height };
}
/** A box in video pixels as fractions of the frame. */
export const toMaskBox = ({ x, y, width, height }: Rect, size: FrameSize): MaskBox =>
  ({ x: x / size.width, y: y / size.height, width: width / size.width, height: height / size.height });
/** A first-frame mask in video pixels, kept inside the frame and at least 1% of it on each side. */
export function fitMask(rect: Rect, size: FrameSize): Rect {
  const { x, y, width, height } = clampMask(toMaskBox(rect, size));
  return { x: x * size.width, y: y * size.height, width: width * size.width, height: height * size.height };
}
const centreOf = ({ x, y, width, height }: Rect) => ({ x: x + width / 2, y: y + height / 2 });
/**
 * A still mask: `bounds` is the box drawn on the first frame in video pixels, and its motion is anchored at the
 * box's centre, so keys hold the centre's position and the size relative to that box.
 */
export const createMaskMotion = (bounds: Rect, frames: number) => createMotion(centreOf(bounds), frames);
/** Where the mask sits on every frame of the clip, as fractions of the frame, for the mask video. */
export function maskBoxes(bounds: Rect, motion: SubjectMotion<number>, size: FrameSize): MaskBox[] {
  const curve = buildMotionCurve(motion);
  return Array.from({ length: motion.frames }, (_, frame) => toMaskBox(placeRect(bounds, curve.placementAt(frame)), size));
}
/** Moves the first-frame mask from `from` to `to`; every later key keeps its position and size on screen. */
export function rebaseMask(motion: SubjectMotion<number>, from: Rect, to: Rect): SubjectMotion<number> {
  const anchor = centreOf(to), [start, ...rest] = motion.keys;
  return { ...motion, anchor, keys: [{ ...start, ...anchor }, ...rest.map(key => {
    const { sx, sy } = scaleOf(key);
    return { ...key, sx: sx * from.width / to.width, sy: sy * from.height / to.height };
  })] };
}
/**
 * The one range shared by mask grow and feather, in delivered-video pixels, so their sliders read alike.
 */
const MASK_EDGE = { min: 0, max: 32, step: 2 } as const;
/** How far the drawn mask is grown before generation and compositing. */
export const MASK_GROW = { ...MASK_EDGE, default: 24 } as const;
/** The blur radius softening the composite's edge: the patch fades in over this distance on each side of the grown edge. */
export const MASK_FEATHER = { ...MASK_EDGE, default: 16 } as const;
/**
 * What happens to the source's sound: H3 hears it as `<Audio 1>` and generates new sound like it (`reference`), or
 * hears it and the delivered video keeps it unchanged (`preserve`); with `replace` it is left out of the source video,
 * so H3 never hears it and generates sound from the prompt alone. A source without sound can only be `replace`d.
 */
export const inpaintAudioModeSchema = z.enum(["reference", "preserve", "replace"]);
export type InpaintAudioMode = z.infer<typeof inpaintAudioModeSchema>;
export const inpaintRequestSchema = z.object({
  videoId: z.uuid(), width: videoDimensionSchema, height: videoDimensionSchema, frames: inpaintFramesSchema,
  prompt: z.string().trim().min(1).max(8000),
  feather: z.number().int().min(MASK_FEATHER.min).max(MASK_FEATHER.max).multipleOf(MASK_FEATHER.step),
  audio: inpaintAudioModeSchema.default("reference"), seed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
});
export type InpaintRequest = z.infer<typeof inpaintRequestSchema>;
export const inpaintResultSchema = inpaintRequestSchema.extend({
  video: z.object({ id: z.uuid(), url: z.string() }), seed: z.number().int().nonnegative(),
});
export type InpaintResult = z.infer<typeof inpaintResultSchema>;
