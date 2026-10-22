import { randomUUID } from "node:crypto";
import type { Comfy, Job, Progress, Workflow } from "@comfyorg/sdk";
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
    let sampled = false;
    try {
      for await (const event of job.events(streamAbort.signal)) {
        if (event.kind !== "progress" || managed.cancelRequested) continue;
        const stage = stageProgress(event, sampled);
        sampled ||= event.step != null;
        managed.snapshot.progress = stage.fraction === null ? null : (options.from ?? 0) + stage.fraction * ((options.to ?? 1) - (options.from ?? 0));
        managed.snapshot.message = stage.detail ? `${options.message} ${stage.detail}` : options.message;
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

/**
 * The proxy's `value` counts finished nodes, so it reaches ~95% as soon as the sampler (usually the last
 * heavy node) starts. Sampler steps are the real work: loading counts as the first 5%, steps fill the
 * middle, and anything after the sampler is finishing.
 */
export function stageProgress(event: Progress, sampled: boolean): { fraction: number | null; detail: string | null } {
  if (event.step != null && event.steps) {
    return { fraction: 0.05 + 0.9 * Math.min(1, event.step / event.steps), detail: `Step ${event.step} of ${event.steps}.` };
  }
  if (sampled) return { fraction: 0.95, detail: "Finishing…" };
  const value = Number.isFinite(event.value) ? Math.max(0, Math.min(1, event.value)) : null;
  return { fraction: value === null ? null : value * 0.05, detail: event.message };
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
