import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Comfy, Workflow } from "@comfyorg/sdk";
import type { SegmentRequest } from "@h3-motion/shared";
import { pythonRound } from "@h3-motion/shared";
import type { FrameSize, InpaintAudioMode } from "@h3-motion/shared";
import { REPO_ROOT } from "../config.js";

const graphSchema = z.record(z.string(), z.object({ class_type: z.string(), inputs: z.record(z.string(), z.unknown()) }));
export type ApiGraph = z.infer<typeof graphSchema>;
export interface Binding { node: string; input: string; classType: string }
export const SEGMENT_BINDINGS = {
  image: { node: "2", input: "image", classType: "LoadImage" },
  text: { node: "3", input: "text", classType: "CLIPTextEncode" },
  positive: { node: "4", input: "positive_coords", classType: "vloSAM3RefineMask" },
  negative: { node: "4", input: "negative_coords", classType: "vloSAM3RefineMask" },
} satisfies Record<string, Binding>;
export const REFINE_BINDINGS = {
  image: SEGMENT_BINDINGS.image,
  mask: { node: "7", input: "image", classType: "LoadImage" },
  positive: SEGMENT_BINDINGS.positive,
  negative: SEGMENT_BINDINGS.negative,
} satisfies Record<string, Binding>;
export const SEGMENT_OUTPUT = "6";

export async function loadTemplate(name: "segment_text" | "segment_points" | "segment_refine" | "describe" | "isolate" | "object" | "animate" | "inpaint" | "track"): Promise<ApiGraph> {
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
/** Qwen Image text-to-image on a square canvas: without reference images, the encoder's latent is resolution × resolution. */
export const OBJECT_BINDINGS = {
  prompt: { node: "6", input: "prompt", classType: "TextEncodeQwenImage21" },
  seed: { node: "8", input: "seed", classType: "KSampler" },
} satisfies Record<string, Binding>;
export const OBJECT_OUTPUT = "10";

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
/** The animate model chain: Kitchen attention → sol-attn → (Spectrum) → TTM and the scheduler. */
export const ANIMATE_MODEL = {
  base: { node: "15", input: "model", classType: "ModelAttentionBackend" },
  sol: { node: "30", input: "model", classType: "BlockSparseAttention" },
  ttm: { node: "16", input: "model", classType: "vloTimeToMove" },
  scheduler: { node: "18", input: "model", classType: "BasicScheduler" },
} satisfies Record<string, Binding>;
/** The inpaint model chain: Kitchen attention → sol-attn → guider and scheduler. */
export const INPAINT_MODEL = {
  base: { node: "19", input: "model", classType: "ModelAttentionBackend" },
  sol: { node: "35", input: "model", classType: "BlockSparseAttention" },
  guider: { node: "20", input: "model", classType: "BasicGuider" },
  scheduler: { node: "21", input: "model", classType: "BasicScheduler" },
} satisfies Record<string, Binding>;
export const ANIMATE_OUTPUT = "25";

export const INPAINT_BINDINGS = {
  source: { node: "5", input: "file", classType: "LoadVideo" },
  mask: { node: "7", input: "file", classType: "LoadVideo" },
  encode: { node: "13", input: "pixels", classType: "VAEEncode" },
  width: { node: "14", input: "width", classType: "MiniMaxH3ReferenceToVideo" },
  height: { node: "14", input: "height", classType: "MiniMaxH3ReferenceToVideo" },
  length: { node: "14", input: "length", classType: "MiniMaxH3ReferenceToVideo" },
  prompt: { node: "14", input: "prompt", classType: "MiniMaxH3ReferenceToVideo" },
  seed: { node: "23", input: "noise_seed", classType: "RandomNoise" },
} satisfies Record<string, Binding>;
export const INPAINT_OUTPUT = "29";
/** The composite's mask, a hard threshold of the mask video at the delivered size, which feathering softens. */
export const INPAINT_COMPOSITE = { node: "27", input: "mask", classType: "ImageCompositeMasked" } satisfies Binding;
/** The source video's frames and sound. */
const INPAINT_SOURCE_COMPONENTS = "6";
/** The delivered video's sound, the generated sound unless the source's is kept. */
const INPAINT_VIDEO = { node: "28", input: "audio", classType: "CreateVideo" } satisfies Binding;

/** SAM's video tracker follows the subjects selected on the first frame, given as one mask, through the clip. */
export const TRACK_BINDINGS = {
  source: { node: "2", input: "file", classType: "LoadVideo" },
  mask: { node: "4", input: "image", classType: "LoadImage" },
  initial: { node: "6", input: "initial_mask", classType: "SAM3_VideoTrack" },
} satisfies Record<string, Binding>;
/** One mask image per frame, in frame order. */
export const TRACK_OUTPUT = "9";

export async function buildTrackWorkflow(client: Comfy, options: { sourcePath: string; maskPath: string }): Promise<Workflow> {
  const graph = await loadTemplate("track");
  assertBindings(graph, [...Object.values(TRACK_BINDINGS), { node: TRACK_OUTPUT, input: "images", classType: "SaveImage" }]);
  const workflow = client.workflows.fromJson(graph);
  const { source, mask } = TRACK_BINDINGS;
  workflow.setInput(source.node, source.input, client.assets.fromFile(options.sourcePath));
  workflow.setInput(mask.node, mask.input, client.assets.fromFile(options.maskPath));
  return workflow;
}

/** Drive core resize nodes around inference; every input stretches onto one canvas without cropping. */
function setVideoGeometry(graph: ApiGraph, inputs: string[], output: string, modelSize: FrameSize, outputSize: FrameSize) {
  for (const id of [...inputs, output]) {
    assertBindings(graph, ["image", "width", "height", "crop"].map(input => ({ node: id, input, classType: "ImageScale" })));
    graph[id].inputs.width = id === output ? outputSize.width : modelSize.width;
    graph[id].inputs.height = id === output ? outputSize.height : modelSize.height;
    graph[id].inputs.crop = "disabled";
  }
}

/** Drop the sol-attn node and feed its consumers straight from Kitchen attention. */
function bypassSol(graph: ApiGraph, chain: { base: Binding; sol: Binding }, consumers: Binding[]) {
  delete graph[chain.sol.node];
  for (const consumer of consumers) graph[consumer.node].inputs[consumer.input] = [chain.base.node, 0];
}

export async function buildInpaintWorkflow(client: Comfy, options: {
  sourcePath: string; maskPath: string; referencePath?: string; size: FrameSize; modelSize: FrameSize; frames: number; prompt: string; seed: number;
  /** The composite's blur radius in delivered pixels; 0 keeps a hard edge. */
  feather: number; sol?: boolean;
  /** What happens to the source's sound; it is only in the source video when it is kept or referenced. */
  audio: InpaintAudioMode;
}): Promise<Workflow> {
  const graph = await loadTemplate("inpaint");
  assertBindings(graph, [...Object.values(INPAINT_BINDINGS), ...Object.values(INPAINT_MODEL), INPAINT_COMPOSITE, INPAINT_VIDEO,
    { node: INPAINT_SOURCE_COMPONENTS, input: "video", classType: "GetVideoComponents" }, { node: INPAINT_OUTPUT, input: "video", classType: "SaveVideo" }]);
  setVideoGeometry(graph, ["30", "31"], "34", options.modelSize, options.size);
  if (options.sol === false) bypassSol(graph, INPAINT_MODEL, [INPAINT_MODEL.guider, INPAINT_MODEL.scheduler]);
  if (options.feather > 0) {
    // Blurs the hard composite mask, as isolation feathers its plate, so the patch fades into the source.
    const { feather } = options, mask = graph[INPAINT_COMPOSITE.node].inputs[INPAINT_COMPOSITE.input];
    graph.feather_image = { class_type: "MaskToImage", inputs: { mask } };
    // ComfyUI caps ImageBlur's radius at 31 and sigma at 10, including for the slider's 32 px setting.
    graph.feather_blur = { class_type: "ImageBlur", inputs: { image: ["feather_image", 0], blur_radius: Math.min(31, feather), sigma: Math.min(10, feather / 3) } };
    graph.feather_mask = { class_type: "ImageToMask", inputs: { image: ["feather_blur", 0], channel: "red" } };
    graph[INPAINT_COMPOSITE.node].inputs[INPAINT_COMPOSITE.input] = ["feather_mask", 0];
  }
  if (options.audio !== "replace") {
    // H3 hears the source's sound as <Audio 1>; kept, it also replaces the generated sound in the delivered video.
    graph[INPAINT_BINDINGS.prompt.node].inputs["ref_audios.ref_audio_1"] = [INPAINT_SOURCE_COMPONENTS, 1];
    if (options.audio === "preserve") graph[INPAINT_VIDEO.node].inputs[INPAINT_VIDEO.input] = [INPAINT_SOURCE_COMPONENTS, 1];
  }
  if (options.referencePath) {
    graph.reference = { class_type: "LoadImage", inputs: { image: "reference.png" } };
    graph[INPAINT_BINDINGS.prompt.node].inputs["ref_images.ref_image_1"] = ["reference", 0];
  }
  const workflow = client.workflows.fromJson(graph);
  const values: Record<keyof typeof INPAINT_BINDINGS, unknown> = {
    source: client.assets.fromFile(options.sourcePath), mask: client.assets.fromFile(options.maskPath),
    encode: ["30", 0], width: options.modelSize.width, height: options.modelSize.height,
    length: options.frames, prompt: options.prompt, seed: options.seed,
  };
  for (const [key, binding] of Object.entries(INPAINT_BINDINGS)) workflow.setInput(binding.node, binding.input, values[key as keyof typeof values]);
  if (options.referencePath) workflow.setInput("reference", "image", client.assets.fromFile(options.referencePath));
  return workflow;
}

export async function buildDescribeWorkflow(client: Comfy, highlightPath: string, userText: string): Promise<Workflow> {
  const graph = await loadTemplate("describe");
  assertBindings(graph, [...Object.values(DESCRIBE_BINDINGS), ...Object.values(DESCRIBE_OUTPUTS)]);
  const { highlight, phrase, caption } = DESCRIBE_BINDINGS;
  const captionPrompt = graph[caption.node].inputs[caption.input];
  const hint = userText ? ` The user's search hint is ${JSON.stringify(userText)}; use it only if it matches the highlighted subject.` : "";
  const workflow = client.workflows.fromJson(graph);
  workflow.setInput(highlight.node, highlight.input, client.assets.fromFile(highlightPath));
  workflow.setInput(phrase.node, phrase.input, `Identify the subject from the highlighted region. The yellow highlight marks the selected object or group.${hint} Reply only with an unambiguous noun phrase of at most 8 words identifying all highlighted subjects. Do not mention the highlight.`);
  workflow.setInput(caption.node, caption.input, `${captionPrompt} Identify the subject from the highlighted region.${hint} Use "moves" (or "move" for several subjects) for motion_verb if no action is visible.`);
  return workflow;
}

export function isolationGeometry(size: FrameSize) {
  const short = Math.min(size.width, size.height);
  const feather = Math.max(1, Math.min(31, short - 1, Math.round(short * 0.01)));
  return { width: Math.max(32, pythonRound(size.width / 32) * 32), height: Math.max(32, pythonRound(size.height / 32) * 32),
    grow: Math.max(1, Math.round(short * 0.02)), feather, sigma: Math.max(0.1, Math.min(10, feather / 3)) };
}

/**
 * Edits the image with Qwen and composites the edit back through the grown, feathered mask. `highlightPath` adds the
 * image with the mask highlighted as `<image2>`, for an instruction that has to say where the edit goes.
 */
export async function buildIsolateWorkflow(client: Comfy, options: {
  imagePath: string; maskPath: string; size: FrameSize; instruction: string; seed: number; highlightPath?: string;
}): Promise<Workflow> {
  const graph = await loadTemplate("isolate");
  assertBindings(graph, Object.values(ISOLATE_BINDINGS));
  if (options.highlightPath) {
    graph.highlight = { class_type: "LoadImage", inputs: { image: "highlight.png" } };
    graph[ISOLATE_BINDINGS.instruction.node].inputs["images.image_2"] = ["highlight", 0];
  }
  const workflow = client.workflows.fromJson(graph);
  if (options.highlightPath) workflow.setInput("highlight", "image", client.assets.fromFile(options.highlightPath));
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

export async function buildObjectWorkflow(client: Comfy, options: { prompt: string; seed: number }): Promise<Workflow> {
  const graph = await loadTemplate("object");
  assertBindings(graph, [...Object.values(OBJECT_BINDINGS), { node: OBJECT_OUTPUT, input: "images", classType: "SaveImage" }]);
  const workflow = client.workflows.fromJson(graph);
  workflow.setInput(OBJECT_BINDINGS.prompt.node, OBJECT_BINDINGS.prompt.input, options.prompt);
  workflow.setInput(OBJECT_BINDINGS.seed.node, OBJECT_BINDINGS.seed.input, options.seed);
  return workflow;
}

export async function buildAnimateWorkflow(client: Comfy, options: {
  startPath: string; referencePath: string; maskPath: string; size: FrameSize; modelSize: FrameSize; frames: number;
  prompt: string; lockIn: number; edgeFreedom: number; seed: number; spectrum?: boolean; sol?: boolean;
}): Promise<Workflow> {
  const graph = await loadTemplate("animate");
  assertBindings(graph, [...Object.values(ANIMATE_BINDINGS), ...Object.values(ANIMATE_MODEL)]);
  setVideoGeometry(graph, ["26", "27", "28"], "29", options.modelSize, options.size);
  if (options.sol === false) bypassSol(graph, ANIMATE_MODEL, [ANIMATE_MODEL.ttm, ANIMATE_MODEL.scheduler]);
  if (options.spectrum) {
    // vlo's Spectrum settings are the node's defaults; offline smoothing replay is opted out of explicitly.
    // It wraps whatever TTM reads (sol-attn unless bypassed); Spectrum v0.2.27+ audits core sparse attention beneath it.
    graph.spectrum = { class_type: "SpectrumApplyMiniMaxH3", inputs: { model: graph[ANIMATE_MODEL.ttm.node].inputs.model, enabled: true, blend_weight: 0.5,
      degree: 1, ridge_lambda: 0.1, window_size: 2, flex_window: 0.75, warmup_steps: 1, tail_actual_steps: 1, max_history: 8, debug: false,
      history_storage: "system_ram", bootstrap_first_forecast: true, offline_smoothing_replay: false } };
    graph[ANIMATE_MODEL.ttm.node].inputs.model = ["spectrum", 0];
    graph[ANIMATE_MODEL.scheduler.node].inputs.model = ["spectrum", 0];
  }
  const workflow = client.workflows.fromJson(graph);
  const values: Record<keyof typeof ANIMATE_BINDINGS, unknown> = {
    start: client.assets.fromFile(options.startPath), reference: client.assets.fromFile(options.referencePath),
    mask: client.assets.fromFile(options.maskPath), grow: -options.edgeFreedom, prompt: options.prompt,
    width: options.modelSize.width, height: options.modelSize.height, length: options.frames, lockIn: options.lockIn, seed: options.seed,
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

type SegmentWorkflowRequest = Extract<SegmentRequest, { mode: "text" }> | Omit<Extract<SegmentRequest, { mode: "points" }>, "candidateId">;
export interface SegmentPrior { path: string }

export async function buildSegmentWorkflow(client: Comfy, request: SegmentWorkflowRequest, imagePath: string, prior?: SegmentPrior): Promise<Workflow> {
  const editing = request.mode === "points" && !!prior;
  const template = await loadTemplate(request.mode === "text" ? "segment_text" : editing ? "segment_refine" : "segment_points");
  const pointBindings = editing ? REFINE_BINDINGS : SEGMENT_BINDINGS;
  assertBindings(template, request.mode === "text" ? [SEGMENT_BINDINGS.image, SEGMENT_BINDINGS.text]
    : editing ? Object.values(REFINE_BINDINGS) : [SEGMENT_BINDINGS.image, SEGMENT_BINDINGS.positive, SEGMENT_BINDINGS.negative]);
  const workflow = client.workflows.fromJson(template);
  const { image, text } = SEGMENT_BINDINGS;
  workflow.setInput(image.node, image.input, client.assets.fromFile(imagePath));
  if (request.mode === "text") workflow.setInput(text.node, text.input, samText(request.text));
  else {
    workflow.setInput(pointBindings.positive.node, pointBindings.positive.input, JSON.stringify(request.positive));
    workflow.setInput(pointBindings.negative.node, pointBindings.negative.input, JSON.stringify(request.negative));
    if (request.mode === "points" && prior) workflow.setInput(REFINE_BINDINGS.mask.node, REFINE_BINDINGS.mask.input, client.assets.fromFile(prior.path));
  }
  return workflow;
}
