import { randomInt } from "node:crypto";
import type { Comfy } from "@comfyorg/sdk";
import type { InpaintRequest, InpaintResult } from "@h3-motion/shared";
import { videoGeometry } from "@h3-motion/shared";
import { SOL_ENABLED } from "../config.js";
import { inspectVideo } from "../media/video.js";
import type { Session, SessionStore } from "../sessions.js";
import { buildInpaintWorkflow, INPAINT_OUTPUT } from "../workflows/templates.js";
import { createManagedJob, failJob, runWorkflow, throwIfCancelled } from "./runtime.js";

export function startInpaint(client: Comfy, store: SessionStore, session: Session, request: InpaintRequest,
  inputs: { sourcePath: string; maskPath: string; referencePath?: string }, options: { sol?: boolean } = {}) {
  const video = session.video;
  if (!video || video.id !== request.videoId) throw new Error("Upload a video before inpainting.");
  const managed = createManagedJob("Preparing inpainting…");
  session.job = managed;
  managed.done = (async () => {
    try {
      const seed = request.seed ?? randomInt(0, 2 ** 48 - 1);
      const modelSize = videoGeometry(video!).generation;
      const workflow = await buildInpaintWorkflow(client, { ...inputs, ...request, size: request, modelSize, seed,
        sol: options.sol ?? SOL_ENABLED });
      const job = await runWorkflow(client, managed, workflow, { stage: "inpaint", message: "Inpainting with MiniMax H3…", to: 0.95 });
      const output = job.getOutputs(INPAINT_OUTPUT)[0];
      if (!output) throw new Error("Inpainting completed without a video. Try again.");
      managed.snapshot.message = "Downloading the video…";
      const bytes = await output.toBytes({ timeoutMs: 120_000 });
      const info = await inspectVideo(bytes).catch(() => { throw new Error("ComfyUI returned an unreadable video. Try again."); });
      if (info.width !== request.width || info.height !== request.height || info.frames !== request.frames) {
        throw new Error("The inpainted video has unexpected dimensions or frame count.");
      }
      throwIfCancelled(managed);
      if (session.video !== video) throw new Error("The source video changed during inpainting.");
      const file = await store.saveFile(session, bytes, info.container);
      throwIfCancelled(managed);
      const result: InpaintResult = { ...request, seed, video: { id: file.id, url: file.url } };
      session.inpainting = result;
      managed.snapshot = { ...managed.snapshot, status: "completed", progress: 1, message: "Your video is ready.", inpainting: result };
    } catch (error) { failJob(managed, error, "Inpainting"); }
  })();
  return managed;
}
