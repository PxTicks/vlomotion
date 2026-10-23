import { z } from "zod";
import { captionSchema } from "./description.js";
import { frameCountSchema } from "./media.js";

export const pointSchema = z.object({ x: z.number().finite().nonnegative(), y: z.number().finite().nonnegative() });
const idSchema = z.uuid();
export function canApplyPointPrompt(hasPrior: boolean, positive: readonly unknown[], negative: readonly unknown[]): boolean {
  return positive.length > 0 || (hasPrior && negative.length > 0);
}
export const segmentRequestSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("text"), text: z.string().trim().min(1).max(160), imageId: idSchema }),
  z.object({ mode: z.literal("points"), imageId: idSchema, candidateId: idSchema.optional(),
    positive: z.array(pointSchema).max(64), negative: z.array(pointSchema).max(64) })
    .refine(request => canApplyPointPrompt(!!request.candidateId, request.positive, request.negative),
      { message: "New subjects need an include point; mask edits need at least one include or exclude point." }),
]);
export type SegmentRequest = z.infer<typeof segmentRequestSchema>;

export const imageAssetSchema = z.object({
  id: idSchema, url: z.string(), width: z.number().int().positive(), height: z.number().int().positive(),
});
export type ImageAsset = z.infer<typeof imageAssetSchema>;
export const maskCandidateSchema = z.object({
  id: idSchema, url: z.string(),
  bounds: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
});
export type MaskCandidate = z.infer<typeof maskCandidateSchema>;
export const isolateRequestSchema = z.object({
  imageId: idSchema, maskId: idSchema,
  userText: z.string().trim().max(160).default(""),
  instruction: z.string().trim().min(1).max(2000).optional(),
  seed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
});
export type IsolateRequest = z.infer<typeof isolateRequestSchema>;
export const isolationResultSchema = z.object({
  imageId: idSchema, maskId: idSchema, plate: imageAssetSchema,
  phrase: z.string(), caption: captionSchema, instruction: z.string(),
  descriptionSource: z.enum(["model", "fallback"]),
  instructionSource: z.enum(["model", "custom"]),
  seed: z.number().int().nonnegative(),
});
export type IsolationResult = z.infer<typeof isolationResultSchema>;
export const LOCK_IN = { min: 3, max: 15, step: 3, default: 6 } as const;
const dimensionSchema = z.number().int().min(32).max(2048).multipleOf(32);
const seedSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** Sent as the `request` field of a multipart upload alongside the reference, mask and start-frame files. */
export const animateRequestSchema = z.object({
  imageId: idSchema, maskId: idSchema, plateId: idSchema,
  width: dimensionSchema, height: dimensionSchema, frames: frameCountSchema,
  prompt: z.string().trim().min(1).max(4000),
  lockIn: z.number().int().min(LOCK_IN.min).max(LOCK_IN.max).multipleOf(LOCK_IN.step),
  seed: seedSchema.optional(),
});
export type AnimateRequest = z.infer<typeof animateRequestSchema>;
export const animationResultSchema = z.object({
  imageId: idSchema, maskId: idSchema, plateId: idSchema,
  video: z.object({ id: idSchema, url: z.string() }),
  width: dimensionSchema, height: dimensionSchema, frames: frameCountSchema,
  prompt: z.string(), lockIn: z.number().int(), seed: seedSchema,
});
export type AnimationResult = z.infer<typeof animationResultSchema>;
export const jobSnapshotSchema = z.object({
  id: idSchema,
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  message: z.string(), progress: z.number().min(0).max(1).nullable(),
  candidates: z.array(maskCandidateSchema), error: z.string().nullable(),
  stage: z.enum(["segment", "describe", "isolate", "animate"]).optional(),
  isolation: isolationResultSchema.optional(),
  animation: animationResultSchema.optional(),
  imageId: idSchema.optional(), maskId: idSchema.optional(),
});
export type JobSnapshot = z.infer<typeof jobSnapshotSchema>;
export const selectionRequestSchema = z.object({
  imageId: idSchema, candidateIds: z.array(idSchema).min(1).max(16),
});
export const selectionResultSchema = z.object({ mask: imageAssetSchema });
export const healthSchema = z.object({ server: z.literal("ok"), comfy: z.enum(["ok", "unavailable"]) });
