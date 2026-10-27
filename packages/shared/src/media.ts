import { z } from "zod";

export const FPS = 24;
export const MAX_VIDEO_UPLOAD_BYTES = 200 * 1024 * 1024;
export const CLIP_FRAMES = { 5: 124, 7: 175, 10: 243 } as const;
export interface FrameSize { width: number; height: number }
export interface Point { x: number; y: number }

export const frameSizeSchema = z.object({
  width: z.number().int().positive().multipleOf(32),
  height: z.number().int().positive().multipleOf(32),
});
/** Delivered video dimensions need encoder alignment, independently of the model's 32 px grid. */
export const videoDimensionSchema = z.number().int().min(32).max(4096).multipleOf(2);
export const frameCountSchema = z.union([z.literal(124), z.literal(175), z.literal(243)]);
export type FrameCount = z.infer<typeof frameCountSchema>;

/** Python's round uses ties-to-even; match ComfyUI's canvas rounding. */
export function pythonRound(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  return diff === 0.5 ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(value);
}

/** Short-edge resolutions offered for image animation: 480p, and H3's native 768p. */
export const VIDEO_TIERS = [480, 768] as const;
export type VideoTier = (typeof VIDEO_TIERS)[number];

/** MiniMax H3's fixed canvas area cap, the 768 × 1344 training canvas, at every short edge. */
export const H3_MAX_PIXELS = 768 * 1344;

/**
 * MiniMax H3's canonical canvas, as resolved by SGLang (`adapt_shape_v1`) and ComfyUI (`adapt_canvas`): the short
 * edge at `tier`, the area capped at 768 × 1344, then each axis rounded to the model's 32 px grid. 16:9 gives
 * 1344 × 768, matching MiniMax's reference outputs, and 864 × 480; the cap never applies at 480p.
 */
export function h3Canvas(source: FrameSize, tier = 480): FrameSize {
  if (![source.width, source.height, tier].every(v => Number.isFinite(v) && v > 0)) {
    throw new Error("Video dimensions and resolution must be positive.");
  }
  const ratio = source.width / source.height;
  let width = ratio >= 1 ? tier * ratio : tier, height = ratio >= 1 ? tier : tier / ratio;
  const scale = Math.min(1, Math.sqrt(H3_MAX_PIXELS / (width * height)));
  width *= scale; height *= scale;
  return { width: Math.max(32, pythonRound(width / 32) * 32), height: Math.max(32, pythonRound(height / 32) * 32) };
}

/** Generate on H3's canonical canvas, then stretch back to the source ratio at the tier's short edge. */
export function videoGeometry(source: FrameSize, tier = 480): { generation: FrameSize; output: FrameSize } {
  const generation = h3Canvas(source, tier);
  const ratio = source.width / source.height;
  const width = ratio >= 1 ? Math.max(1, pythonRound(tier * ratio)) : tier;
  const height = ratio >= 1 ? tier : Math.max(1, pythonRound(tier / ratio));
  // H.264/yuv420p needs even dimensions; round up as the encoder pads.
  return { generation, output: { width: Math.ceil(width / 2) * 2, height: Math.ceil(height / 2) * 2 } };
}
