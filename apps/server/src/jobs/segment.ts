import { randomUUID } from "node:crypto";
import type { Comfy, Job } from "@comfyorg/sdk";
import type { JobSnapshot, SegmentRequest } from "@h3-motion/shared";
import { buildSegmentWorkflow, SEGMENT_OUTPUT } from "../workflows/templates.js";
import { decodeMask, encodeMask } from "../media/masks.js";
import type { Session, SessionStore } from "../sessions.js";

export interface ManagedJob {
  snapshot: JobSnapshot;
  cancelRequested: boolean;
  remote?: Job;
  done: Promise<void>;
}

export function startSegment(client: Comfy, store: SessionStore, session: Session, request: SegmentRequest): ManagedJob {
  const image = session.image;
  if (!image || image.id !== request.imageId) throw new Error("Upload a photo before selecting a subject.");
  const managed: ManagedJob = {
    snapshot: { id: randomUUID(), status: "queued", message: "Preparing subject selection…", progress: null, candidates: [], error: null },
    cancelRequested: false, done: Promise.resolve(),
  };
  session.job = managed;
  managed.done = execute();
  return managed;

  async function execute() {
    const streamAbort = new AbortController();
    let events: Promise<void> | undefined;
    try {
      const workflow = await buildSegmentWorkflow(client, request, image!.path);
      if (managed.cancelRequested) { managed.snapshot.status = "cancelled"; managed.snapshot.message = "Selection cancelled."; return; }
      const job = await client.submit(workflow);
      managed.remote = job;
      if (managed.cancelRequested) await job.cancel();
      managed.snapshot.status = "running";
      managed.snapshot.message = "Finding your subject…";
      events = (async () => {
        try {
          for await (const event of job.events(streamAbort.signal)) {
            if (event.kind === "progress") {
              managed.snapshot.progress = Number.isFinite(event.value) ? Math.max(0, Math.min(1, event.value)) : null;
              managed.snapshot.message = event.message ?? "Finding your subject…";
            }
          }
        } catch {
          // Completion is polled independently, so a dropped SSE stream cannot strand the job.
        }
      })();
      await job.result();
      if (managed.cancelRequested) {
        managed.snapshot.status = "cancelled";
        managed.snapshot.message = "Selection cancelled.";
        return;
      }
      const candidates = [];
      for (const output of job.getOutputs(SEGMENT_OUTPUT)) {
        const { pixels, bounds } = await decodeMask(await output.toBytes({ timeoutMs: 30_000 }), image!.width, image!.height);
        if (!bounds) continue;
        const file = await store.savePng(session, await encodeMask(pixels, image!.width, image!.height));
        const candidate = { ...file, bounds, imageId: image!.id };
        session.candidates.set(candidate.id, candidate);
        candidates.push({ id: candidate.id, url: candidate.url, bounds });
      }
      managed.snapshot = { ...managed.snapshot, status: "completed", progress: 1, candidates,
        message: candidates.length ? "Choose the subjects you want to move." : "Nothing found. Try another word, or click on the subject." };
    } catch (error) {
      if (managed.remote?.status === "canceled") {
        managed.snapshot.status = "cancelled";
        managed.snapshot.message = "Selection cancelled.";
      } else {
        managed.snapshot.status = "failed";
        managed.snapshot.error = error instanceof TypeError && error.message === "fetch failed"
          ? "ComfyUI is unavailable. Start ComfyUI and the API proxy, then try again."
          : error instanceof Error ? error.message : "Subject selection failed.";
        managed.snapshot.message = "Could not select the subject. Check ComfyUI and try again.";
      }
    } finally {
      streamAbort.abort();
      await events;
    }
  }
}

export async function cancelSegment(job: ManagedJob): Promise<void> {
  job.cancelRequested = true;
  job.snapshot.message = "Cancelling selection…";
  // If submit is still in flight, execute cancels the returned handle as soon as it arrives.
  if (job.remote) await job.remote.cancel();
}
