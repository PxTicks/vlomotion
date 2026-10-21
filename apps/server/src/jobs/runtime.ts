import { randomUUID } from "node:crypto";
import type { Comfy, Job, Workflow } from "@comfyorg/sdk";
import type { JobSnapshot } from "@h3-motion/shared";

export interface ManagedJob {
  snapshot: JobSnapshot;
  cancelRequested: boolean;
  remote?: Job;
  done: Promise<void>;
}
export class JobCancelled extends Error {}
export function throwIfCancelled(job: ManagedJob): void { if (job.cancelRequested) throw new JobCancelled(); }

export function createManagedJob(message: string): ManagedJob {
  return { snapshot: { id: randomUUID(), status: "queued", message, progress: null, candidates: [], error: null },
    cancelRequested: false, done: Promise.resolve() };
}

export async function runWorkflow(client: Comfy, managed: ManagedJob, workflow: Workflow, options: {
  stage: NonNullable<JobSnapshot["stage"]>; message: string; from?: number; to?: number;
}): Promise<Job> {
  throwIfCancelled(managed);
  managed.snapshot.stage = options.stage;
  managed.snapshot.message = options.message;
  managed.snapshot.progress = options.from ?? null;
  const job = await client.submit(workflow);
  managed.remote = job;
  const streamAbort = new AbortController();
  const events = (async () => {
    try {
      for await (const event of job.events(streamAbort.signal)) {
        if (event.kind !== "progress" || managed.cancelRequested) continue;
        const progress = Number.isFinite(event.value) ? Math.max(0, Math.min(1, event.value)) : null;
        managed.snapshot.progress = progress === null ? null : (options.from ?? 0) + progress * ((options.to ?? 1) - (options.from ?? 0));
        managed.snapshot.message = event.message ? `${options.message} ${event.message}` : options.message;
      }
    } catch { /* Polling remains authoritative when SSE drops. */ }
  })();
  try {
    if (managed.cancelRequested) await job.cancel();
    managed.snapshot.status = "running";
    await job.result();
    throwIfCancelled(managed);
    return job;
  } catch (error) {
    if (job.status === "canceled") throw new JobCancelled();
    throw error;
  } finally {
    streamAbort.abort();
    await events;
    managed.remote = undefined;
  }
}

export function failJob(managed: ManagedJob, error: unknown, operation: string): void {
  if (managed.cancelRequested || error instanceof JobCancelled) {
    managed.snapshot.status = "cancelled";
    managed.snapshot.error = null;
    managed.snapshot.message = `${operation} cancelled.`;
  } else {
    managed.snapshot.status = "failed";
    managed.snapshot.error = error instanceof TypeError && error.message === "fetch failed"
      ? "ComfyUI is unavailable. Start ComfyUI and the API proxy, then try again."
      : error instanceof Error ? error.message : `${operation} failed.`;
    managed.snapshot.message = `Could not complete ${operation.toLowerCase()}. Check ComfyUI and try again.`;
  }
}

export async function cancelJob(job: ManagedJob): Promise<void> {
  job.cancelRequested = true;
  job.snapshot.message = "Cancelling job…";
  // Submission isn't aborted: its eventual handle is needed to cancel an accepted remote job.
  if (job.remote) await job.remote.cancel();
}
