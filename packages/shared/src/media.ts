import { z } from "zod";

export const FPS = 24;
export const CLIP_FRAMES = { 5: 124, 7: 175, 10: 243 } as const;
export const aspectRatioSchema = z.enum(["16:9", "9:16", "1:1"]);
export type AspectRatio = z.infer<typeof aspectRatioSchema>;
export interface FrameSize { width: number; height: number }
export interface Point { x: number; y: number }

export const frameSizeSchema = z.object({
  width: z.number().int().positive().multipleOf(32),
  height: z.number().int().positive().multipleOf(32),
});
export const frameCountSchema = z.union([z.literal(124), z.literal(175), z.literal(243)]);

/** Python's round uses ties-to-even; match vlo's dimension search. */
export function pythonRound(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  return diff === 0.5 ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(value);
}

/** Port of vlo's findBestStridedDimensions, preserving its stable tie order. */
export function findBestStridedDimensions(
  targetWidth: number, targetHeight: number, stride = 32, searchSteps = 2,
): FrameSize {
  if (![targetWidth, targetHeight, stride, searchSteps].every(Number.isFinite)
    || targetWidth <= 0 || targetHeight <= 0 || stride <= 0
    || !Number.isInteger(stride) || !Number.isInteger(searchSteps) || searchSteps < 0) {
    throw new Error("Dimensions and stride must be positive; search steps must be non-negative integers.");
  }
  const ratio = targetWidth / targetHeight;
  const candidates: (FrameSize & { error: number; area: number; delta: number })[] = [];
  const seen = new Set<string>();
  const add = (width: number, height: number) => {
    const id = `${width}x${height}`;
    if (width <= 0 || height <= 0 || seen.has(id)) return;
    seen.add(id);
    candidates.push({ width, height, error: Math.abs(1 - (width / height) / ratio),
      area: Math.abs(width * height - targetWidth * targetHeight),
      delta: Math.abs(width - targetWidth) + Math.abs(height - targetHeight) });
  };
  for (let step = -searchSteps; step <= searchSteps; step++) {
    const width = (pythonRound(targetWidth / stride) + step) * stride;
    add(width, Math.floor(width / ratio / stride) * stride);
    add(width, Math.ceil(width / ratio / stride) * stride);
  }
  for (let step = -searchSteps; step <= searchSteps; step++) {
    const height = (pythonRound(targetHeight / stride) + step) * stride;
    add(Math.floor(height * ratio / stride) * stride, height);
    add(Math.ceil(height * ratio / stride) * stride, height);
  }
  candidates.sort((a, b) => a.error - b.error || a.area - b.area || a.delta - b.delta);
  const best = candidates[0];
  if (!best) throw new Error("No strided dimensions found.");
  return { width: best.width, height: best.height };
}

export function generationSize(aspectRatio: AspectRatio, tier: 480 | 720 = 480): FrameSize {
  const [w, h] = aspectRatio.split(":").map(Number);
  // Keep the selected tier: a wider aspect search otherwise picks 800×448 for 480p.
  return findBestStridedDimensions(tier * Math.max(1, w / h), tier * Math.max(1, h / w), 32, 0);
}

export function centerCrop(source: FrameSize, target: FrameSize) {
  if (![source.width, source.height, target.width, target.height].every(v => Number.isFinite(v) && v > 0)) {
    throw new Error("Crop dimensions must be positive.");
  }
  const scale = Math.max(target.width / source.width, target.height / source.height);
  const width = target.width / scale;
  const height = target.height / scale;
  return { x: (source.width - width) / 2, y: (source.height - height) / 2, width, height };
}
