import type { Comfy } from "@comfyorg/sdk";
import type { SegmentRequest } from "@h3-motion/shared";
import { buildSegmentWorkflow, SEGMENT_OUTPUT } from "../workflows/templates.js";
import { decodeMask, encodeMask } from "../media/masks.js";
import type { Session, SessionStore } from "../sessions.js";
import { createManagedJob, failJob, runWorkflow, throwIfCancelled } from "./runtime.js";
import type { ManagedJob } from "./runtime.js";

export function startSegment(client: Comfy, store: SessionStore, session: Session, request: SegmentRequest): ManagedJob {
  const image = session.image;
  if (!image || image.id !== request.imageId) throw new Error("Upload a photo before selecting a subject.");
  const managed = createManagedJob("Preparing subject selection…");
  session.job = managed;
  managed.done = execute();
  return managed;

  async function execute() {
    try {
      const workflow = await buildSegmentWorkflow(client, request, image!.path);
      const job = await runWorkflow(client, managed, workflow, { stage: "segment", message: "Finding your subject…" });
      const candidates = [];
      for (const output of job.getOutputs(SEGMENT_OUTPUT)) {
        const { pixels, bounds } = await decodeMask(await output.toBytes({ timeoutMs: 30_000 }), image!.width, image!.height);
        throwIfCancelled(managed);
        if (!bounds) continue;
        const file = await store.savePng(session, await encodeMask(pixels, image!.width, image!.height));
        const candidate = { ...file, bounds, imageId: image!.id };
        session.candidates.set(candidate.id, candidate);
        candidates.push({ id: candidate.id, url: candidate.url, bounds });
      }
      throwIfCancelled(managed);
      managed.snapshot = { ...managed.snapshot, status: "completed", progress: 1, candidates,
        message: candidates.length ? "Choose the subjects you want to move." : "Nothing found. Try another word, or click on the subject." };
    } catch (error) { failJob(managed, error, "Selection"); }
  }
}
