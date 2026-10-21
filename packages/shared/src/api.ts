import { z } from "zod";
import { captionSchema } from "./description.js";

export const pointSchema = z.object({ x: z.number().finite().nonnegative(), y: z.number().finite().nonnegative() });
const idSchema = z.uuid();
export const segmentRequestSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("text"), text: z.string().trim().min(1).max(160), imageId: idSchema }),
  z.object({ mode: z.literal("points"), imageId: idSchema,
    positive: z.array(pointSchema).min(1).max(64), negative: z.array(pointSchema).max(64) }),
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
export const jobSnapshotSchema = z.object({
  id: idSchema,
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  message: z.string(), progress: z.number().min(0).max(1).nullable(),
  candidates: z.array(maskCandidateSchema), error: z.string().nullable(),
  stage: z.enum(["segment", "describe", "isolate"]).optional(),
  isolation: isolationResultSchema.optional(),
  imageId: idSchema.optional(), maskId: idSchema.optional(),
});
export type JobSnapshot = z.infer<typeof jobSnapshotSchema>;
export const selectionRequestSchema = z.object({
  imageId: idSchema, candidateIds: z.array(idSchema).min(1).max(16),
});
export const selectionResultSchema = z.object({ mask: imageAssetSchema });
export const healthSchema = z.object({ server: z.literal("ok"), comfy: z.enum(["ok", "unavailable"]) });
