import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { InvalidWorkflow } from "@comfyorg/sdk";
import type { Comfy, Job, Progress, Workflow } from "@comfyorg/sdk";
import type { JobSnapshot } from "@h3-motion/shared";
import { z } from "zod";
import { comfyLow } from "../comfy.js";

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
  /** The node whose steps are the run's real work, usually the sampler. Without one, progress counts finished nodes. */
  sampler?: string;
}): Promise<Job> {
  throwIfCancelled(managed);
  managed.snapshot.stage = options.stage;
  managed.snapshot.message = options.message;
  managed.snapshot.progress = options.from ?? null;
  const run = { sampler: options.sampler, nodes: Object.keys(workflow.json).length };
  const job = await client.submit(workflow);
  managed.remote = job;
  const streamAbort = new AbortController();
  const events = (async () => {
    let sampled = false;
    for await (const event of progressFrames(job, streamAbort.signal)) {
      if (managed.cancelRequested) continue;
      const stage = stageProgress(event, run, sampled);
      sampled ||= stage.sampling;
      // The proxy's frames interleave two progress sources, so the bar only moves forwards.
      const progress = (options.from ?? 0) + stage.fraction * ((options.to ?? 1) - (options.from ?? 0));
      managed.snapshot.progress = Math.max(managed.snapshot.progress ?? 0, progress);
      managed.snapshot.message = stage.detail ? `${options.message} ${stage.detail}` : options.message;
    }
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
 * The job's progress frames, read off its event stream directly. `job.events()` drops any frame whose `value` is below the
 * last one, but the proxy's value only counts nodes that have started: it reads 1 whenever the running node finishes, so every
 * later sampler step looked like a regression and was dropped. The proxy can also end a stream cleanly mid-job (an upstream
 * outage), so it reconnects until a terminal status arrives or `signal` aborts; polling stays authoritative for the result.
 */
async function* progressFrames(job: Job, signal: AbortSignal): AsyncGenerator<Progress> {
  while (!signal.aborted) {
    try {
      for await (const raw of comfyLow.getJobEvents(job.urls.events || job.id, { signal })) {
        if (raw.event === "progress") yield progressFrame(raw.data);
        if (raw.event === "status" && TERMINAL_STATUSES.has(String(raw.data.status))) return;
      }
    } catch { /* Reconnect below. */ }
    await sleep(1_000, undefined, { signal }).catch(() => undefined);
  }
}
/** The SDK's terminal job states, which it doesn't export. */
const TERMINAL_STATUSES = new Set(["succeeded", "canceled", "failed", "expired"]);

const progressFrameSchema = z.object({
  value: z.number().catch(0), message: z.string().nullish().catch(null), nodes_done: z.number().nullish().catch(null),
  nodes_total: z.number().nullish().catch(null), current_node: z.string().nullish().catch(null),
  step: z.number().nullish().catch(null), steps: z.number().nullish().catch(null),
});

function progressFrame(data: Record<string, unknown>): Progress {
  const frame = progressFrameSchema.parse(data);
  return { kind: "progress", value: frame.value, message: frame.message ?? null, nodesDone: frame.nodes_done ?? null,
    nodesTotal: frame.nodes_total ?? null, currentNode: frame.current_node ?? null, currentNodeClass: null,
    step: frame.step ?? null, steps: frame.steps ?? null };
}

/**
 * Where a frame puts the stage, from 0 to 1. Sampler steps are the real work: the nodes before the sampler count as the first
 * 5%, its steps fill the middle, and anything after it is finishing. Other nodes can report steps too (video decoders do), so
 * only the sampler's count. The proxy's `value` and `nodes_total` only cover nodes that have started, so finished nodes are
 * measured against the whole graph instead.
 */
export function stageProgress(event: Progress, run: { sampler?: string; nodes: number }, sampled: boolean):
  { fraction: number; detail: string | null; sampling: boolean } {
  if (run.sampler !== undefined && event.currentNode === run.sampler && event.step != null && event.steps) {
    return { fraction: 0.05 + 0.9 * Math.min(1, event.step / event.steps), detail: `Step ${event.step} of ${event.steps}.`, sampling: true };
  }
  if (sampled) return { fraction: 0.95, detail: "Finishing…", sampling: false };
  const done = run.nodes ? Math.min(1, (event.nodesDone ?? 0) / run.nodes) : 0;
  return { fraction: run.sampler === undefined ? done : done * 0.05, detail: event.message, sampling: false };
}

const validationNodeSchema = z.object({
  class_type: z.string().optional(),
  errors: z.array(z.object({ message: z.string(), details: z.string().optional() })),
});

function jobErrorMessage(error: unknown, operation: string): string {
  if (error instanceof TypeError && error.message === "fetch failed") {
    return "ComfyUI is unavailable. Start ComfyUI and the API proxy, then try again.";
  }
  if (error instanceof InvalidWorkflow) {
    const nodes = z.record(z.string(), z.unknown()).safeParse(error.details?.node_errors);
    const details = nodes.success ? Object.entries(nodes.data).flatMap(([id, value]) => {
      const node = validationNodeSchema.safeParse(value);
      if (!node.success) return [];
      const label = node.data.class_type ? `${node.data.class_type} (node ${id})` : `Node ${id}`;
      return node.data.errors.map(issue => `${label}: ${issue.message}${issue.details ? `: ${issue.details}` : ""}`);
    }) : [];
    return [error.message, ...details].join("\n");
  }
  return error instanceof Error ? error.message : `${operation} failed.`;
}

export function failJob(managed: ManagedJob, error: unknown, operation: string): void {
  if (managed.cancelRequested || error instanceof JobCancelled) {
    managed.snapshot.status = "cancelled";
    managed.snapshot.error = null;
    managed.snapshot.message = `${operation} cancelled.`;
  } else {
    managed.snapshot.status = "failed";
    managed.snapshot.error = jobErrorMessage(error, operation);
    managed.snapshot.message = `Could not complete ${operation.toLowerCase()}. Check ComfyUI and try again.`;
  }
}

export async function cancelJob(job: ManagedJob): Promise<void> {
  job.cancelRequested = true;
  job.snapshot.message = "Cancelling job…";
  // Submission isn't aborted: its eventual handle is needed to cancel an accepted remote job.
  if (job.remote) await job.remote.cancel();
}
