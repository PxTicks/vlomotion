import { randomInt } from "node:crypto";
import sharp from "sharp";
import type { Comfy } from "@comfyorg/sdk";
import { frameInstruction, objectInstruction } from "@h3-motion/shared";
import type { FrameSize, ReferenceRequest, ReferenceResult } from "@h3-motion/shared";
import { highlightSubject } from "../media/highlight.js";
import type { Session, SessionStore } from "../sessions.js";
import { buildIsolateWorkflow, buildObjectWorkflow, ISOLATE_OUTPUT, OBJECT_OUTPUT } from "../workflows/templates.js";
import { createManagedJob, failJob, runWorkflow, throwIfCancelled } from "./runtime.js";
import type { ManagedJob } from "./runtime.js";

/** A frame of the source video and the mask on it, both PNGs of `size`. */
export interface ReferenceFrame extends FrameSize { imagePath: string; maskPath: string }

export function startReference(client: Comfy, store: SessionStore, session: Session, request: ReferenceRequest, frame?: ReferenceFrame): ManagedJob {
  const video = session.video;
  if (!video || video.id !== request.videoId) throw new Error("Upload a video before creating a reference.");
  if (request.kind === "frame" && !frame) throw new Error("The frame to edit is missing.");
  const object = request.kind === "object";
  const managed = createManagedJob(object ? "Preparing the object…" : "Preparing the frame…");
  session.job = managed;
  managed.done = (async () => {
    try {
      const seed = request.seed ?? randomInt(0, 2 ** 48 - 1);
      let workflow;
      if (object) workflow = await buildObjectWorkflow(client, { prompt: objectInstruction(request.description), seed });
      else {
        const { imagePath, maskPath, width, height } = frame!;
        const highlight = await store.savePng(session, await highlightSubject(imagePath, maskPath, width, height));
        throwIfCancelled(managed);
        workflow = await buildIsolateWorkflow(client, { imagePath, maskPath, size: frame!, instruction: frameInstruction(request.description),
          seed, highlightPath: highlight.path });
      }
      const job = await runWorkflow(client, managed, workflow, { stage: "reference",
        message: object ? "Creating the object…" : "Editing the frame…", to: 0.95 });
      const output = job.getOutputs(object ? OBJECT_OUTPUT : ISOLATE_OUTPUT)[0];
      if (!output) throw new Error("Qwen Image completed without an image. Try again.");
      const decoded = sharp(await output.toBytes({ timeoutMs: 60_000 }), { limitInputPixels: 16_000_000 });
      const { width, height } = await decoded.metadata();
      if (!width || !height || (frame && (width !== frame.width || height !== frame.height))) {
        throw new Error("The edited frame doesn't match the video frame's dimensions.");
      }
      const file = await store.savePng(session, await decoded.removeAlpha().png().toBuffer());
      throwIfCancelled(managed);
      if (session.video !== video) throw new Error("The source video changed while creating the reference.");
      const result: ReferenceResult = { videoId: video.id, kind: request.kind, description: request.description,
        frame: request.kind === "frame" ? request.frame : null, image: { id: file.id, url: file.url, width, height }, seed };
      managed.snapshot = { ...managed.snapshot, status: "completed", progress: 1,
        message: object ? "Your object is ready." : "Your frame is ready.", reference: result };
    } catch (error) { failJob(managed, error, "Reference creation"); }
  })();
  return managed;
}
