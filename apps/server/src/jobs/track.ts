import type { Comfy, Output } from "@comfyorg/sdk";
import type { TrackFrame, TrackRequest, TrackResult } from "@h3-motion/shared";
import { measureMask } from "../media/masks.js";
import type { Session } from "../sessions.js";
import { buildTrackWorkflow, TRACK_OUTPUT } from "../workflows/templates.js";
import { createManagedJob, failJob, runWorkflow, throwIfCancelled } from "./runtime.js";
import type { ManagedJob } from "./runtime.js";

/** Frame masks are small, so a few download at once to hide the round trips to ComfyUI. */
const DOWNLOADS = 8;

/** Tracks the object in `maskPath`, on the prepared video's first frame, through the prepared video at `sourcePath`. */
export function startTrack(client: Comfy, session: Session, request: TrackRequest, paths: { sourcePath: string; maskPath: string }): ManagedJob {
  const video = session.video;
  if (!video || video.id !== request.videoId) throw new Error("Upload a video before tracking.");
  const managed = createManagedJob("Preparing tracking…");
  session.job = managed;
  managed.done = (async () => {
    try {
      const workflow = await buildTrackWorkflow(client, paths);
      const job = await runWorkflow(client, managed, workflow, { stage: "track", message: "Tracking the object…", to: 0.9 });
      const outputs = frameOrder(job.getOutputs(TRACK_OUTPUT));
      if (outputs.length !== request.frames) throw new Error(`Tracking returned ${outputs.length} frames instead of ${request.frames}. Try again.`);
      managed.snapshot.message = "Measuring the tracked object…";
      const frames = await measureAll(outputs, request, managed);
      if (!frames[0]) throw new Error("SAM couldn't find the selected object on the first frame. Select it again.");
      throwIfCancelled(managed);
      if (session.video !== video) throw new Error("The source video changed during tracking.");
      const tracking: TrackResult = { videoId: request.videoId, width: request.width, height: request.height, frames };
      const lost = frames.filter(frame => !frame).length;
      managed.snapshot = { ...managed.snapshot, status: "completed", progress: 1, tracking,
        message: lost ? `Tracked the object. It was out of view for ${lost} of ${frames.length} frames.` : "Tracked the object." };
    } catch (error) { failJob(managed, error, "Tracking"); }
  })();
  return managed;
}

/** SaveImage numbers a batch in order (`track_00001_.png`, …); without those counters, ComfyUI's own order stands. */
export function frameOrder(outputs: Output[]): Output[] {
  const counters = outputs.map(output => /_(\d+)_?\.png$/.exec(output.name)?.[1]);
  if (counters.some(counter => counter === undefined)) return outputs;
  return outputs.map((output, i) => ({ output, counter: Number(counters[i]) })).sort((a, b) => a.counter - b.counter).map(({ output }) => output);
}

async function measureAll(outputs: Output[], request: TrackRequest, managed: ManagedJob): Promise<TrackFrame[]> {
  const frames: TrackFrame[] = new Array(outputs.length).fill(null);
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: Math.min(DOWNLOADS, outputs.length) }, async () => {
    while (next < outputs.length) {
      const index = next++;
      throwIfCancelled(managed);
      frames[index] = await measureMask(await outputs[index].toBytes({ timeoutMs: 30_000 }), request.width, request.height);
      managed.snapshot.progress = 0.9 + 0.1 * ++done / outputs.length;
    }
  }));
  return frames;
}
