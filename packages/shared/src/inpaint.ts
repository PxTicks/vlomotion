import { z } from "zod";
import { FPS, findBestStridedDimensions } from "./media.js";

export const maskShapeSchema = z.enum(["rectangle", "ellipse"]);
export type MaskShape = z.infer<typeof maskShapeSchema>;
export interface MaskBox { x: number; y: number; width: number; height: number }
export interface MaskKeyframe extends MaskBox { frame: number }
export const inpaintFramesSchema = z.number().int().min(5).max(243).refine(n => (n - 5) % 17 === 0, "Invalid H3 frame count.");
export const videoAssetSchema = z.object({
  id: z.uuid(), url: z.string(), width: z.number().int().positive(), height: z.number().int().positive(),
  startTime: z.number().finite().nonnegative().default(0),
  duration: z.number().finite().positive(), frames: z.number().int().positive(),
});
export type VideoAsset = z.infer<typeof videoAssetSchema>;

export function inpaintSize(width: number, height: number) {
  const scale = 480 / Math.min(width, height);
  return findBestStridedDimensions(width * scale, height * scale, 32, 0);
}
export function inpaintFrames(duration: number) {
  const available = Math.min(243, Math.floor(duration * FPS + 0.001));
  return Math.max(5, available - ((available - 5) % 17));
}
export function maskAt(keys: readonly MaskKeyframe[], frame: number): MaskBox | null {
  if (!keys.length) return null;
  const sorted = [...keys].sort((a, b) => a.frame - b.frame);
  const left = [...sorted].reverse().find(key => key.frame <= frame) ?? sorted[0];
  const right = sorted.find(key => key.frame > frame) ?? left;
  const t = right.frame === left.frame ? 0 : Math.max(0, Math.min(1, (frame - left.frame) / (right.frame - left.frame)));
  return { x: left.x + (right.x - left.x) * t, y: left.y + (right.y - left.y) * t,
    width: left.width + (right.width - left.width) * t, height: left.height + (right.height - left.height) * t };
}
export function clampMask(box: MaskBox): MaskBox {
  const width = Math.max(0.01, Math.min(1, box.width)), height = Math.max(0.01, Math.min(1, box.height));
  return { x: Math.max(0, Math.min(1 - width, box.x)), y: Math.max(0, Math.min(1 - height, box.y)), width, height };
}
export const inpaintRequestSchema = z.object({
  videoId: z.uuid(), width: z.number().int().min(32).max(2048).multipleOf(32),
  height: z.number().int().min(32).max(2048).multipleOf(32), frames: inpaintFramesSchema,
  prompt: z.string().trim().min(1).max(4000), seed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
});
export type InpaintRequest = z.infer<typeof inpaintRequestSchema>;
export const inpaintResultSchema = inpaintRequestSchema.extend({
  video: z.object({ id: z.uuid(), url: z.string() }), seed: z.number().int().nonnegative(),
});
export type InpaintResult = z.infer<typeof inpaintResultSchema>;
