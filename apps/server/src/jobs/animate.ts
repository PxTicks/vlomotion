import { randomInt } from "node:crypto";
import type { Comfy } from "@comfyorg/sdk";
import type { AnimateRequest, AnimationResult } from "@h3-motion/shared";
import { videoGeometry } from "@h3-motion/shared";
import { SPECTRUM_ENABLED } from "../config.js";
import { inspectVideo } from "../media/video.js";
import { ANIMATE_OUTPUT, buildAnimateWorkflow } from "../workflows/templates.js";
import type { Session, SessionStore } from "../sessions.js";
import { createManagedJob, failJob, runWorkflow, throwIfCancelled } from "./runtime.js";
import type { ManagedJob } from "./runtime.js";

export interface AnimateInputs { startPath: string; referencePath: string; maskPath: string }

export function startAnimate(client: Comfy, store: SessionStore, session: Session, request: AnimateRequest, inputs: AnimateInputs,
  options: { spectrum?: boolean } = {}): ManagedJob {
  const { image, selection, isolation } = session;
  if (!image || !selection || !isolation || image.id !== request.imageId || selection.id !== request.maskId || isolation.plate.id !== request.plateId) {
    throw new Error("Isolate the current subject before generating.");
  }
  const managed = createManagedJob("Preparing video generation…");
  managed.snapshot.imageId = image.id;
  managed.snapshot.maskId = selection.id;
  session.job = managed;
  managed.done = execute();
  return managed;

  async function execute() {
    try {
      const seed = request.seed ?? randomInt(0, 2 ** 48 - 1);
      const size = { width: request.width, height: request.height };
      const modelSize = videoGeometry(image!, Math.min(size.width, size.height)).generation;
      const workflow = await buildAnimateWorkflow(client, { ...inputs, size, modelSize, frames: request.frames, prompt: request.prompt,
        lockIn: request.lockIn, seed, spectrum: options.spectrum ?? SPECTRUM_ENABLED });
      const job = await runWorkflow(client, managed, workflow, { stage: "animate", message: "Animating with MiniMax H3…", from: 0, to: 0.95 });
      const output = job.getOutputs(ANIMATE_OUTPUT)[0];
      if (!output) throw new Error("Generation completed without a video. Try again.");
      managed.snapshot.message = "Downloading the video…";
      const bytes = await output.toBytes({ timeoutMs: 120_000 });
      const info = await inspectVideo(bytes).catch(() => { throw new Error("ComfyUI returned an unreadable video. Try again."); });
      if (info.width !== size.width || info.height !== size.height) throw new Error("The generated video has unexpected dimensions.");
      const file = await store.saveFile(session, bytes, info.container);
      throwIfCancelled(managed);
      if (session.image !== image || session.selection !== selection || session.isolation !== isolation) throw new Error("The subject changed during generation. Generate again.");
      const result: AnimationResult = { imageId: image!.id, maskId: selection!.id, plateId: isolation!.plate.id,
        video: { id: file.id, url: file.url }, width: size.width, height: size.height, frames: request.frames,
        prompt: request.prompt, lockIn: request.lockIn, seed };
      session.animation = result;
      managed.snapshot = { ...managed.snapshot, status: "completed", progress: 1, message: "Your video is ready.", animation: result };
    } catch (error) { failJob(managed, error, "Generation"); }
  }
}
