import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Comfy, Workflow } from "@comfyorg/sdk";
import type { SegmentRequest } from "@h3-motion/shared";
import { pythonRound } from "@h3-motion/shared";
import type { FrameSize } from "@h3-motion/shared";
import { REPO_ROOT } from "../config.js";

const graphSchema = z.record(z.string(), z.object({ class_type: z.string(), inputs: z.record(z.string(), z.unknown()) }));
export type ApiGraph = z.infer<typeof graphSchema>;
export interface Binding { node: string; input: string; classType: string }
export const SEGMENT_BINDINGS = {
  image: { node: "2", input: "image", classType: "LoadImage" },
  text: { node: "3", input: "text", classType: "CLIPTextEncode" },
  positive: { node: "4", input: "positive_coords", classType: "SAM3_Detect" },
  negative: { node: "4", input: "negative_coords", classType: "SAM3_Detect" },
} satisfies Record<string, Binding>;
export const SEGMENT_OUTPUT = "6";

export async function loadTemplate(name: "segment_text" | "segment_points" | "describe" | "isolate" | "animate"): Promise<ApiGraph> {
  return graphSchema.parse(JSON.parse(await readFile(join(REPO_ROOT, "workflows/api", `h3m_${name}.api.json`), "utf8")));
}

export const DESCRIBE_BINDINGS = {
  highlight: { node: "2", input: "image", classType: "LoadImage" },
  phrase: { node: "3", input: "prompt", classType: "TextGenerate" },
  caption: { node: "4", input: "prompt", classType: "TextGenerate" },
} satisfies Record<string, Binding>;
export const DESCRIBE_OUTPUTS = {
  phrase: { node: "5", input: "text", classType: "SaveText" },
  caption: { node: "6", input: "text", classType: "SaveText" },
} satisfies Record<string, Binding>;
export const ISOLATE_BINDINGS = {
  image: { node: "1", input: "image", classType: "LoadImage" },
  mask: { node: "2", input: "image", classType: "LoadImage" },
  instruction: { node: "6", input: "prompt", classType: "TextEncodeQwenImage21" },
  seed: { node: "8", input: "seed", classType: "KSampler" },
  width: { node: "11", input: "width", classType: "ImageScale" },
  height: { node: "11", input: "height", classType: "ImageScale" },
  grow: { node: "14", input: "expand", classType: "GrowMask" },
  feather: { node: "16", input: "blur_radius", classType: "ImageBlur" },
  sigma: { node: "16", input: "sigma", classType: "ImageBlur" },
} satisfies Record<string, Binding>;
export const ISOLATE_OUTPUT = "19";

export const ANIMATE_BINDINGS = {
  start: { node: "5", input: "image", classType: "LoadImage" },
  reference: { node: "6", input: "file", classType: "LoadVideo" },
  mask: { node: "7", input: "file", classType: "LoadVideo" },
  grow: { node: "13", input: "expand", classType: "GrowMask" },
  prompt: { node: "14", input: "prompt", classType: "MiniMaxH3ImageToVideo" },
  width: { node: "14", input: "width", classType: "MiniMaxH3ImageToVideo" },
  height: { node: "14", input: "height", classType: "MiniMaxH3ImageToVideo" },
  length: { node: "14", input: "length", classType: "MiniMaxH3ImageToVideo" },
  lockIn: { node: "16", input: "end_step", classType: "vloTimeToMove" },
  seed: { node: "20", input: "noise_seed", classType: "RandomNoise" },
} satisfies Record<string, Binding>;
/** The model chain Spectrum is spliced into: attention backend → (Spectrum) → TTM and the scheduler. */
export const ANIMATE_MODEL = {
  base: { node: "15", input: "model", classType: "ModelAttentionBackend" },
  ttm: { node: "16", input: "model", classType: "vloTimeToMove" },
  scheduler: { node: "18", input: "model", classType: "BasicScheduler" },
} satisfies Record<string, Binding>;
export const ANIMATE_OUTPUT = "25";

export async function buildDescribeWorkflow(client: Comfy, highlightPath: string, userText: string): Promise<Workflow> {
  const graph = await loadTemplate("describe");
  assertBindings(graph, [...Object.values(DESCRIBE_BINDINGS), ...Object.values(DESCRIBE_OUTPUTS)]);
  const { highlight, phrase, caption } = DESCRIBE_BINDINGS;
  const captionPrompt = graph[caption.node].inputs[caption.input];
  const hint = userText ? ` The user's search hint is ${JSON.stringify(userText)}; use it only if it matches the highlighted subject.` : "";
  const workflow = client.workflows.fromJson(graph);
  workflow.setInput(highlight.node, highlight.input, client.assets.fromFile(highlightPath));
  workflow.setInput(phrase.node, phrase.input, `Identify the subject from the highlighted region. The yellow highlight marks the selected object or group.${hint} Reply only with an unambiguous noun phrase of at most 8 words identifying all highlighted subjects. Do not mention the highlight.`);
  workflow.setInput(caption.node, caption.input, `${captionPrompt} Identify the subject from the highlighted region.${hint} Use "moves" for motion_verb if no action is visible.`);
  return workflow;
}

export function isolationGeometry(size: FrameSize) {
  const short = Math.min(size.width, size.height);
  const feather = Math.max(1, Math.min(31, short - 1, Math.round(short * 0.01)));
  return { width: Math.max(32, pythonRound(size.width / 32) * 32), height: Math.max(32, pythonRound(size.height / 32) * 32),
    grow: Math.max(1, Math.round(short * 0.02)), feather, sigma: Math.max(0.1, Math.min(10, feather / 3)) };
}

export async function buildIsolateWorkflow(client: Comfy, options: {
  imagePath: string; maskPath: string; size: FrameSize; instruction: string; seed: number;
}): Promise<Workflow> {
  const graph = await loadTemplate("isolate");
  assertBindings(graph, Object.values(ISOLATE_BINDINGS));
  const workflow = client.workflows.fromJson(graph);
  const geometry = isolationGeometry(options.size);
  for (const [key, binding] of Object.entries(ISOLATE_BINDINGS)) {
    const value = key === "image" ? client.assets.fromFile(options.imagePath)
      : key === "mask" ? client.assets.fromFile(options.maskPath)
      : key === "instruction" ? options.instruction : key === "seed" ? options.seed
      : geometry[key as keyof typeof geometry];
    workflow.setInput(binding.node, binding.input, value);
  }
  return workflow;
}

/** The held region is dilated by vlo's 15 px at 480p, scaled with the short edge. */
export const animationGrow = (size: FrameSize) => Math.max(1, Math.round(15 * Math.min(size.width, size.height) / 480));

export async function buildAnimateWorkflow(client: Comfy, options: {
  startPath: string; referencePath: string; maskPath: string; size: FrameSize; frames: number;
  prompt: string; lockIn: number; seed: number; spectrum?: boolean;
}): Promise<Workflow> {
  const graph = await loadTemplate("animate");
  assertBindings(graph, [...Object.values(ANIMATE_BINDINGS), ...Object.values(ANIMATE_MODEL)]);
  if (options.spectrum) {
    // vlo's Spectrum settings are the node's defaults; only storage and bootstrap are optional inputs.
    graph.spectrum = { class_type: "SpectrumApplyMiniMaxH3", inputs: { model: [ANIMATE_MODEL.base.node, 0], enabled: true, blend_weight: 0.5,
      degree: 1, ridge_lambda: 0.1, window_size: 2, flex_window: 0.75, warmup_steps: 1, tail_actual_steps: 1, max_history: 8, debug: false,
      history_storage: "system_ram", bootstrap_first_forecast: true } };
    graph[ANIMATE_MODEL.ttm.node].inputs.model = ["spectrum", 0];
    graph[ANIMATE_MODEL.scheduler.node].inputs.model = ["spectrum", 0];
  }
  const workflow = client.workflows.fromJson(graph);
  const values: Record<keyof typeof ANIMATE_BINDINGS, unknown> = {
    start: client.assets.fromFile(options.startPath), reference: client.assets.fromFile(options.referencePath),
    mask: client.assets.fromFile(options.maskPath), grow: animationGrow(options.size), prompt: options.prompt,
    width: options.size.width, height: options.size.height, length: options.frames, lockIn: options.lockIn, seed: options.seed,
  };
  for (const [key, binding] of Object.entries(ANIMATE_BINDINGS)) workflow.setInput(binding.node, binding.input, values[key as keyof typeof values]);
  return workflow;
}

export function assertBindings(graph: ApiGraph, bindings: Binding[]): void {
  for (const binding of bindings) {
    const node = graph[binding.node];
    if (!node || node.class_type !== binding.classType || !(binding.input in node.inputs)) {
      throw new Error(`Workflow binding changed: ${binding.classType} ${binding.node}.${binding.input}`);
    }
  }
}

/** SAM parses commas and :N as syntax. Treat the UI field as one subject name. */
export function samText(text: string): string {
  const subject = text.replace(/[,:()]/g, " ").replace(/\s+/g, " ").trim();
  if (!subject) throw new Error("Enter a short subject name, such as dog or red car.");
  return `${subject}:4`;
}

export async function buildSegmentWorkflow(client: Comfy, request: SegmentRequest, imagePath: string): Promise<Workflow> {
  const template = await loadTemplate(request.mode === "text" ? "segment_text" : "segment_points");
  const bindings = request.mode === "text"
    ? [SEGMENT_BINDINGS.image, SEGMENT_BINDINGS.text]
    : [SEGMENT_BINDINGS.image, SEGMENT_BINDINGS.positive, SEGMENT_BINDINGS.negative];
  assertBindings(template, bindings);
  const workflow = client.workflows.fromJson(template);
  const { image, text, positive, negative } = SEGMENT_BINDINGS;
  workflow.setInput(image.node, image.input, client.assets.fromFile(imagePath));
  if (request.mode === "text") workflow.setInput(text.node, text.input, samText(request.text));
  else {
    workflow.setInput(positive.node, positive.input, JSON.stringify(request.positive));
    workflow.setInput(negative.node, negative.input, JSON.stringify(request.negative));
  }
  return workflow;
}
