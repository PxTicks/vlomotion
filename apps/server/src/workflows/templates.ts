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

export async function loadTemplate(name: "segment_text" | "segment_points" | "describe" | "isolate"): Promise<ApiGraph> {
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

export async function buildDescribeWorkflow(client: Comfy, highlightPath: string, userText: string): Promise<Workflow> {
  const graph = await loadTemplate("describe");
  assertBindings(graph, [...Object.values(DESCRIBE_BINDINGS), ...Object.values(DESCRIBE_OUTPUTS)]);
  const { highlight, phrase, caption } = DESCRIBE_BINDINGS;
  const captionPrompt = graph[caption.node].inputs[caption.input];
  const workflow = client.workflows.fromJson(graph);
  workflow.setInput(highlight.node, highlight.input, client.assets.fromFile(highlightPath));
  workflow.setInput(phrase.node, phrase.input, `The object or group highlighted in yellow is the selected subject. The user's short name is ${JSON.stringify(userText)}. Reply only with an unambiguous noun phrase of at most 8 words identifying all highlighted subjects. Do not mention the highlight.`);
  workflow.setInput(caption.node, caption.input, `${captionPrompt} The user's short name is ${JSON.stringify(userText)}. Use "moves" for motion_verb if no action is visible.`);
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
