import { randomInt } from "node:crypto";
import sharp from "sharp";
import type { Comfy, Job } from "@comfyorg/sdk";
import { defaultDescription, parseDescription, removalInstruction } from "@h3-motion/shared";
import type { IsolateRequest, IsolationResult } from "@h3-motion/shared";
import { buildDescribeWorkflow, buildIsolateWorkflow, DESCRIBE_OUTPUTS, ISOLATE_OUTPUT } from "../workflows/templates.js";
import { highlightSubject } from "../media/highlight.js";
import type { Session, SessionStore } from "../sessions.js";
import { createManagedJob, failJob, runWorkflow, throwIfCancelled } from "./runtime.js";
import type { ManagedJob } from "./runtime.js";

async function textOutput(job: Job, nodeId: string): Promise<string> {
  const output = job.getOutputs(nodeId)[0];
  if (!output) return "";
  return new TextDecoder().decode(await output.toBytes({ timeoutMs: 30_000 }));
}

export function startIsolate(client: Comfy, store: SessionStore, session: Session, request: IsolateRequest): ManagedJob {
  const image = session.image;
  const selection = session.selection;
  if (!image || !selection || image.id !== request.imageId || selection.id !== request.maskId) {
    throw new Error("Confirm the current subject selection before isolating it.");
  }
  const managed = createManagedJob("Preparing background removal…");
  session.job = managed;
  managed.done = execute();
  return managed;

  async function execute() {
    try {
      const cached = session.description;
      const userText = request.userText.trim();
      let description = cached?.imageId === image!.id && cached.maskId === selection!.id && cached.userText === userText ? cached : undefined;
      if (!description && !request.instruction) {
        managed.snapshot.stage = "describe";
        managed.snapshot.message = "Identifying the selected subject…";
        const highlight = await store.savePng(session, await highlightSubject(image!.path, selection!.path, image!.width, image!.height));
        throwIfCancelled(managed);
        const workflow = await buildDescribeWorkflow(client, highlight.path, userText);
        const job = await runWorkflow(client, managed, workflow, { stage: "describe", message: "Describing your subject…", from: 0, to: 0.2 });
        const phrase = await textOutput(job, DESCRIBE_OUTPUTS.phrase.node);
        throwIfCancelled(managed);
        const caption = await textOutput(job, DESCRIBE_OUTPUTS.caption.node);
        throwIfCancelled(managed);
        description = { ...parseDescription(phrase, caption, userText), imageId: image!.id, maskId: selection!.id, userText };
        session.description = description;
      }
      const descriptionSource = description ? "model" : "fallback";
      const subject = description ?? defaultDescription(userText);
      throwIfCancelled(managed);
      const instruction = request.instruction ?? removalInstruction(subject.phrase);
      const seed = request.seed ?? randomInt(0, 2 ** 48 - 1);
      const workflow = await buildIsolateWorkflow(client, { imagePath: image!.path, maskPath: selection!.path,
        size: image!, instruction, seed });
      const job = await runWorkflow(client, managed, workflow, { stage: "isolate", message: "Removing the subject and filling the background…", from: 0.2, to: 0.95 });
      const output = job.getOutputs(ISOLATE_OUTPUT)[0];
      if (!output) throw new Error("Background removal completed without an output image. Try again.");
      const bytes = await output.toBytes({ timeoutMs: 60_000 });
      const decoded = sharp(bytes, { limitInputPixels: 8_000_000 });
      const metadata = await decoded.metadata();
      if (metadata.width !== image!.width || metadata.height !== image!.height) throw new Error("Background dimensions do not match the working photo.");
      const file = await store.savePng(session, await decoded.removeAlpha().png().toBuffer());
      throwIfCancelled(managed);
      if (session.image !== image || session.selection !== selection) throw new Error("Selection changed. Confirm it and isolate again.");
      const result: IsolationResult = { imageId: image!.id, maskId: selection!.id,
        plate: { id: file.id, url: file.url, width: image!.width, height: image!.height },
        phrase: subject.phrase, caption: subject.caption, descriptionSource, instruction, seed };
      session.isolation = result;
      managed.snapshot = { ...managed.snapshot, status: "completed", progress: 1,
        message: "Background ready. Hold the preview to compare with the original.", isolation: result };
    } catch (error) { failJob(managed, error, "Isolation"); }
  }
}
