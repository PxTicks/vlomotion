import { z } from "zod";

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
export const jobSnapshotSchema = z.object({
  id: idSchema,
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  message: z.string(), progress: z.number().min(0).max(1).nullable(),
  candidates: z.array(maskCandidateSchema), error: z.string().nullable(),
});
export type JobSnapshot = z.infer<typeof jobSnapshotSchema>;
export const selectionRequestSchema = z.object({
  imageId: idSchema, candidateIds: z.array(idSchema).min(1).max(16),
});
export const selectionResultSchema = z.object({ mask: imageAssetSchema });
export const healthSchema = z.object({ server: z.literal("ok"), comfy: z.enum(["ok", "unavailable"]) });
