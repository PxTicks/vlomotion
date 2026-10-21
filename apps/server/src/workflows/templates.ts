import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Comfy, Workflow } from "@comfyorg/sdk";
import type { SegmentRequest } from "@h3-motion/shared";
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

export async function loadTemplate(name: "segment_text" | "segment_points" | "describe"): Promise<ApiGraph> {
  return graphSchema.parse(JSON.parse(await readFile(join(REPO_ROOT, "workflows/api", `h3m_${name}.api.json`), "utf8")));
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
  const workflow = client.workflows.fromJson(structuredClone(template));
  workflow.setInput("2", "image", client.assets.fromFile(imagePath));
  if (request.mode === "text") workflow.setInput("3", "text", samText(request.text));
  else {
    workflow.setInput("4", "positive_coords", JSON.stringify(request.positive));
    workflow.setInput("4", "negative_coords", JSON.stringify(request.negative));
  }
  return workflow;
}
