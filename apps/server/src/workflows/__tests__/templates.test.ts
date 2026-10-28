import { describe, expect, it } from "vitest";
import { Comfy } from "@comfyorg/sdk";
import { videoGeometry } from "@h3-motion/shared";
import { ANIMATE_BINDINGS, ANIMATE_MODEL, ANIMATE_OUTPUT, assertBindings, buildAnimateWorkflow, buildDescribeWorkflow, buildIsolateWorkflow, buildSegmentWorkflow, DESCRIBE_BINDINGS, DESCRIBE_OUTPUTS, ISOLATE_BINDINGS, ISOLATE_OUTPUT, isolationGeometry, loadTemplate, samText, REFINE_BINDINGS, SEGMENT_BINDINGS, SEGMENT_OUTPUT } from "../templates.js";
import type { ApiGraph } from "../templates.js";
import { INPAINT_BINDINGS, INPAINT_MODEL, INPAINT_OUTPUT, buildInpaintWorkflow } from "../templates.js";

describe("workflow contracts", () => {
  it("stretches all animation inputs onto one model canvas and restores the delivered ratio before encoding", async () => {
    const { output: size, generation: modelSize } = videoGeometry({ width: 1000, height: 701 });
    const graph = (await buildAnimateWorkflow(new Comfy(), { startPath: "/tmp/start.png", referencePath: "/tmp/reference.mp4",
      maskPath: "/tmp/mask.mp4", size, modelSize, frames: 124, prompt: "A bird flies.", lockIn: 6, edgeFreedom: 16, seed: 42 })).json as ApiGraph;
    expect(graph["14"].inputs).toMatchObject({ ...modelSize, first_frame: ["26", 0] });
    for (const [node, image] of [["26", "5"], ["27", "8"], ["28", "9"]]) {
      expect(graph[node]).toMatchObject({ class_type: "ImageScale", inputs: { ...modelSize, image: [image, 0], crop: "disabled" } });
    }
    expect(graph["10"].inputs.pixels).toEqual(["27", 0]);
    expect(graph["11"].inputs.image).toEqual(["28", 0]);
    expect(graph["29"]).toMatchObject({ class_type: "ImageScale", inputs: { ...size, image: ["22", 0], crop: "disabled" } });
    expect(graph["24"].inputs).toMatchObject({ images: ["29", 0], audio: ["23", 0] });
    expect(graph[ANIMATE_OUTPUT].inputs.video).toEqual(["24", 0]);
  });
  it("restores inpainted pixels before compositing into the source at its original ratio", async () => {
    const { output: size, generation: modelSize } = videoGeometry({ width: 701, height: 1000 });
    const graph = (await buildInpaintWorkflow(new Comfy(), { sourcePath: "/tmp/source.mp4", maskPath: "/tmp/mask.mp4",
      size, modelSize, frames: 124, prompt: "A bird flies.", seed: 42 })).json as ApiGraph;
    expect(graph["14"].inputs).toMatchObject(modelSize);
    expect(graph["30"]).toMatchObject({ class_type: "ImageScale", inputs: { ...modelSize, image: ["6", 0], crop: "disabled" } });
    expect(graph["31"]).toMatchObject({ class_type: "ImageScale", inputs: { ...modelSize, image: ["8", 0], crop: "disabled", upscale_method: "nearest-exact" } });
    expect(graph["13"].inputs.pixels).toEqual(["30", 0]);
    expect(graph["32"].inputs.image).toEqual(["31", 0]);
    expect(graph["33"].inputs.mask).toEqual(["32", 0]);
    expect(graph["17"].inputs.masks).toEqual(["33", 0]);
    expect(graph["34"]).toMatchObject({ class_type: "ImageScale", inputs: { ...size, image: ["25", 0], crop: "disabled" } });
    expect(graph["27"].inputs).toMatchObject({ destination: ["6", 0], source: ["34", 0], mask: ["10", 0], resize_source: false });
    expect(graph["28"].inputs.images).toEqual(["27", 0]);
    expect(graph[INPAINT_OUTPUT].inputs.video).toEqual(["28", 0]);
  });
  it("validates inpaint bindings and rejects changed node ids, classes and inputs", async () => {
    const graph = await loadTemplate("inpaint");
    assertBindings(graph, Object.values(INPAINT_BINDINGS));
    expect(graph[INPAINT_OUTPUT].class_type).toBe("SaveVideo");
    for (const binding of Object.values(INPAINT_BINDINGS)) {
      const missingNode = structuredClone(graph);
      delete missingNode[binding.node];
      expect(() => assertBindings(missingNode, [binding])).toThrow("Workflow binding changed:");
      const changedClass = structuredClone(graph);
      changedClass[binding.node].class_type = "DifferentNode";
      expect(() => assertBindings(changedClass, [binding])).toThrow("Workflow binding changed:");
      const missingInput = structuredClone(graph);
      delete missingInput[binding.node].inputs[binding.input];
      expect(() => assertBindings(missingInput, [binding])).toThrow("Workflow binding changed:");
    }
    const workflow = await buildInpaintWorkflow(new Comfy(), { sourcePath: "/tmp/source.mp4", maskPath: "/tmp/mask.mp4",
      size: { width: 480, height: 864 }, modelSize: { width: 480, height: 864 }, frames: 107, prompt: "A bird flies.", seed: 42 });
    expect(workflow.json["13"]).toMatchObject({ inputs: { pixels: ["30", 0] } });
    expect(Object.values(workflow.json as ApiGraph).some(node => node.class_type === "EmptyImage")).toBe(false);
    expect(workflow.json["14"]).toMatchObject({ inputs: { width: 480, height: 864, length: 107, prompt: "A bird flies." } });
    expect(workflow.json["23"]).toMatchObject({ inputs: { noise_seed: 42 } });
  });
  it("encodes original source pixels and composites only after generation", async () => {
    const workflow = await buildInpaintWorkflow(new Comfy(), { sourcePath: "/tmp/source.mp4", maskPath: "/tmp/mask.mp4",
      size: { width: 480, height: 864 }, modelSize: { width: 480, height: 864 }, frames: 107, prompt: "A bird flies.", seed: 42 });
    const graph = workflow.json as ApiGraph;
    expect(graph["13"].inputs.pixels).toEqual(["30", 0]);
    expect(Object.values(graph).some(node => node.class_type === "EmptyImage")).toBe(false);
    expect(Object.values(graph).filter(node => node.class_type === "ImageCompositeMasked")).toHaveLength(1);
    expect(graph["27"].inputs).toMatchObject({ destination: ["6", 0], source: ["34", 0], mask: ["10", 0] });
    expect((await loadTemplate("inpaint"))["13"].inputs.pixels).toEqual(["30", 0]);
    for (const node of Object.values(graph)) {
      for (const value of Object.values(node.inputs)) if (Array.isArray(value)) expect(graph).toHaveProperty(String(value[0]));
    }
  });
  it("binds text and points variants to the correct classes", async () => {
    const text = await loadTemplate("segment_text");
    const points = await loadTemplate("segment_points");
    assertBindings(text, [SEGMENT_BINDINGS.image, SEGMENT_BINDINGS.text]);
    assertBindings(points, [SEGMENT_BINDINGS.image, SEGMENT_BINDINGS.positive, SEGMENT_BINDINGS.negative]);
    expect(text[SEGMENT_OUTPUT].class_type).toBe("SaveImage");
    expect(points["4"].inputs).not.toHaveProperty("conditioning");
    expect(points["4"].inputs).not.toHaveProperty("mask");
    expect(points["4"].inputs).toMatchObject({ mask_selection: "reference", refine_iterations: 1, if_core_changed: "native" });
    expect(text["4"].inputs).not.toHaveProperty("positive_coords");
    expect(text["4"].class_type).toBe("SAM3_Detect");
    expect(text["4"].inputs.individual_masks).toBe(true);
    expect(() => assertBindings({ ...text, "2": text["1"] }, [SEGMENT_BINDINGS.image])).toThrow("binding changed");
  });
  it("keeps SDK asset and primitive bindings independent between workflow builds", async () => {
    const client = new Comfy();
    const request = { mode: "text" as const, imageId: "47c2d1ce-ef77-4f21-8d59-dedfe2c08489", text: "red car" };
    const first = await buildSegmentWorkflow(client, request, "/tmp/photo.png");
    const second = await buildSegmentWorkflow(client, { ...request, text: "dog" }, "/tmp/another.png");
    expect(first.json["3"]).toMatchObject({ inputs: { text: "red car:4" } });
    expect(second.json["3"]).toMatchObject({ inputs: { text: "dog:4" } });
    expect((await loadTemplate("segment_text"))["2"].inputs.image).toBe("original.png");
  });
  it("loads the edited subject mask and points into the mask-conditioned decoder workflow", async () => {
    const client = new Comfy();
    const request = { mode: "points" as const, imageId: crypto.randomUUID(), positive: [], negative: [{ x: 20, y: 30 }] };
    const workflow = await buildSegmentWorkflow(client, request, "/tmp/photo.png", { path: "/tmp/subject.png" });
    assertBindings(workflow.json as ApiGraph, Object.values(REFINE_BINDINGS));
    expect(workflow.json["4"]).toMatchObject({ class_type: "vloSAM3RefineMask", inputs: {
      mask: ["8", 0], positive_coords: "[]", negative_coords: '[{"x":20,"y":30}]',
      mask_selection: "reference", refine_iterations: 1, if_core_changed: "native",
    } });
    expect(workflow.json["8"]).toMatchObject({ class_type: "ImageToMask", inputs: { image: ["7", 0], channel: "red" } });
    expect((workflow.json as ApiGraph)["7"].inputs.image).not.toBe("subject-mask.png");
    const fresh = await buildSegmentWorkflow(client, { mode: "points", imageId: request.imageId, positive: [{ x: 1, y: 1 }], negative: [] }, "/tmp/photo.png");
    expect(fresh.json["4"]).toMatchObject({ class_type: "vloSAM3RefineMask", inputs: {
      positive_coords: '[{"x":1,"y":1}]', negative_coords: "[]",
    } });
    expect((fresh.json as ApiGraph)["4"].inputs).not.toHaveProperty("mask");
    expect(fresh.json).not.toHaveProperty("7");
    expect((await loadTemplate("segment_refine"))["7"].inputs.image).toBe("subject-mask.png");
  });
  it("does not let prompt syntax multiply SAM candidate counts", () => {
    expect(samText("dog:100,cat:500")).toBe("dog 100 cat 500:4");
    expect(() => samText("(, :) ")).toThrow("subject name");
  });
  it("uses file outputs for both VLM results", async () => {
    const graph = await loadTemplate("describe");
    const outputs = Object.values(DESCRIBE_OUTPUTS);
    assertBindings(graph, outputs);
    expect(graph[DESCRIBE_OUTPUTS.phrase.node]).toMatchObject({ class_type: "SaveText", inputs: { format: "json", text: [DESCRIBE_BINDINGS.phrase.node, 0] } });
    expect(graph[DESCRIBE_OUTPUTS.caption.node]).toMatchObject({ class_type: "SaveText", inputs: { format: "json", text: [DESCRIBE_BINDINGS.caption.node, 0] } });
    expect(() => assertBindings({ ...graph, [DESCRIBE_OUTPUTS.phrase.node]: graph["1"] }, outputs)).toThrow("binding changed");
    expect(graph["3"].inputs).toMatchObject({ sampling_mode: "off", thinking: false });
  });
  it("binds description prompts and the highlighted image without mutating templates", async () => {
    assertBindings(await loadTemplate("describe"), Object.values(DESCRIBE_BINDINGS));
    const workflow = await buildDescribeWorkflow(new Comfy(), "/tmp/highlight.png", "red car");
    expect(workflow.json["3"]).toMatchObject({ inputs: { prompt: expect.stringContaining('"red car"') } });
    expect((await loadTemplate("describe"))["2"].inputs.image).toBe("highlight.png");
  });
  it("uses the highlighted region as the subject source and omits empty search hints", async () => {
    for (const hint of ["", "dog"]) {
      const workflow = await buildDescribeWorkflow(new Comfy(), "/tmp/highlight.png", hint);
      for (const binding of [DESCRIBE_BINDINGS.phrase, DESCRIBE_BINDINGS.caption]) {
        const node = workflow.json[binding.node];
        expect(node).toMatchObject({ inputs: { [binding.input]: expect.stringContaining("Identify the subject from the highlighted region.") } });
        expect(node).toMatchObject({ inputs: { [binding.input]: hint
          ? expect.stringContaining("use it only if it matches the highlighted subject")
          : expect.not.stringContaining("search hint") } });
      }
    }
  });
  it("keeps the edit latent aligned to its rounded reference image and composites over the original", async () => {
    const graph = await loadTemplate("isolate");
    assertBindings(graph, Object.values(ISOLATE_BINDINGS));
    expect(graph[ISOLATE_OUTPUT].class_type).toBe("SaveImage");
    expect(graph["6"].inputs).toMatchObject({ "images.image_1": ["11", 0], resolution: 0 });
    expect(graph["8"].inputs).toMatchObject({ latent_image: ["6", 2], steps: 25, cfg: 1 });
    expect(graph["18"].inputs).toMatchObject({ destination: ["1", 0], source: ["12", 0], mask: ["17", 0] });
    expect(graph["12"].inputs).toMatchObject({ width: ["10", 0], height: ["10", 1] });
    const workflow = await buildIsolateWorkflow(new Comfy(), { imagePath: "/tmp/original.png", maskPath: "/tmp/mask.png",
      size: { width: 1000, height: 701 }, instruction: "Remove the car.", seed: 42 });
    expect(workflow.json["11"]).toMatchObject({ inputs: { width: 992, height: 704 } });
    expect(workflow.json["6"]).toMatchObject({ inputs: { prompt: "Remove the car." } });
    expect(workflow.json["8"]).toMatchObject({ inputs: { seed: 42 } });
    expect(isolationGeometry({ width: 1728, height: 960 })).toMatchObject({ grow: 19, feather: 10 });
    expect(isolationGeometry({ width: 2560, height: 2560 }).sigma).toBeLessThanOrEqual(10);
  });
  it("drives H3 through TTM with an eroded subject mask and the photo as the first frame", async () => {
    const graph = await loadTemplate("animate");
    assertBindings(graph, [...Object.values(ANIMATE_BINDINGS), ...Object.values(ANIMATE_MODEL)]);
    expect(graph[ANIMATE_OUTPUT]).toMatchObject({ class_type: "SaveVideo", inputs: { format: "mp4" } });
    expect(graph["14"].inputs.first_frame).toEqual(["26", 0]);
    expect(graph["26"].inputs.image).toEqual([ANIMATE_BINDINGS.start.node, 0]);
    expect(graph["11"].inputs).toMatchObject({ channel: "red" });
    expect(graph["12"]).toMatchObject({ class_type: "ThresholdMask", inputs: { value: 0.5 } });
    expect(graph["13"]).toMatchObject({ class_type: "GrowMask", inputs: { mask: ["12", 0], expand: -16, tapered_corners: true } });
    expect(graph["16"].inputs).toMatchObject({ start_step: 1, end_step: 6, mask: ["13", 0] });
    expect(graph["18"].inputs).toMatchObject({ scheduler: "simple", steps: 25 });
    expect(graph["21"].inputs.latent_image).toEqual(["14", 1]);
    // Core resize nodes preserve the whole frame; frame counts still come from the app.
    expect(Object.values(graph).filter(node => node.class_type === "ImageScale")).toHaveLength(4);
    for (const node of Object.values(graph)) {
      for (const value of Object.values(node.inputs)) if (Array.isArray(value)) expect(graph).toHaveProperty(String(value[0]));
    }
  });
  it("binds animate inputs and splices Spectrum only when asked", async () => {
    const options = { startPath: "/tmp/start.png", referencePath: "/tmp/reference.mp4", maskPath: "/tmp/mask.mp4",
      size: { width: 1248, height: 704 }, modelSize: { width: 1248, height: 704 }, frames: 175, prompt: "A dog runs.", lockIn: 15, edgeFreedom: 16, seed: 9 };
    const plain = (await buildAnimateWorkflow(new Comfy(), options)).json as ApiGraph;
    expect(plain["14"].inputs).toMatchObject({ width: 1248, height: 704, length: 175, prompt: "A dog runs." });
    expect(plain[ANIMATE_BINDINGS.grow.node].inputs.expand).toBe(-16);
    expect(plain["16"].inputs).toMatchObject({ end_step: 15, model: ["30", 0] });
    expect(plain).not.toHaveProperty("spectrum");
    const fast = (await buildAnimateWorkflow(new Comfy(), { ...options, spectrum: true })).json as ApiGraph;
    expect(fast.spectrum).toMatchObject({ class_type: "SpectrumApplyMiniMaxH3", inputs: { model: ["30", 0], enabled: true, offline_smoothing_replay: false } });
    expect(fast["16"].inputs.model).toEqual(["spectrum", 0]);
    expect(fast["18"].inputs.model).toEqual(["spectrum", 0]);
    expect((await loadTemplate("animate"))["16"].inputs.model).toEqual(["30", 0]);
  });
  it("layers sol-attn over Kitchen attention, beneath Spectrum, unless bypassed", async () => {
    const graph = await loadTemplate("animate");
    expect(graph["15"].inputs.attention).toBe("comfy kitchen attention");
    expect(graph["30"]).toMatchObject({ class_type: "BlockSparseAttention",
      inputs: { model: ["15", 0], selection: "sol-attn", "selection.tau": 1.3, start_percent: 0.2, end_percent: 1 } });
    expect(graph["18"].inputs.model).toEqual(["30", 0]);
    const options = { startPath: "/tmp/start.png", referencePath: "/tmp/reference.mp4", maskPath: "/tmp/mask.mp4",
      size: { width: 864, height: 480 }, modelSize: { width: 864, height: 480 }, frames: 124, prompt: "A dog runs.", lockIn: 6, edgeFreedom: 16, seed: 9 };
    const dense = (await buildAnimateWorkflow(new Comfy(), { ...options, sol: false })).json as ApiGraph;
    expect(dense).not.toHaveProperty("30");
    expect(dense["16"].inputs.model).toEqual(["15", 0]);
    expect(dense["18"].inputs.model).toEqual(["15", 0]);
    const denseSpectrum = (await buildAnimateWorkflow(new Comfy(), { ...options, sol: false, spectrum: true })).json as ApiGraph;
    expect(denseSpectrum.spectrum.inputs.model).toEqual(["15", 0]);
    expect(denseSpectrum["18"].inputs.model).toEqual(["spectrum", 0]);
  });
  it("layers sol-attn over Kitchen attention in inpainting unless bypassed", async () => {
    const graph = await loadTemplate("inpaint");
    expect(graph["19"].inputs.attention).toBe("comfy kitchen attention");
    expect(graph["35"]).toMatchObject({ class_type: "BlockSparseAttention", inputs: { model: ["19", 0], selection: "sol-attn" } });
    const options = { sourcePath: "/tmp/source.mp4", maskPath: "/tmp/mask.mp4",
      size: { width: 864, height: 480 }, modelSize: { width: 864, height: 480 }, frames: 124, prompt: "A bird flies.", seed: 42 };
    const sol = (await buildInpaintWorkflow(new Comfy(), options)).json as ApiGraph;
    expect(sol[INPAINT_MODEL.guider.node].inputs.model).toEqual(["35", 0]);
    expect(sol[INPAINT_MODEL.scheduler.node].inputs.model).toEqual(["35", 0]);
    const dense = (await buildInpaintWorkflow(new Comfy(), { ...options, sol: false })).json as ApiGraph;
    expect(dense).not.toHaveProperty("35");
    expect(dense[INPAINT_MODEL.guider.node].inputs.model).toEqual(["19", 0]);
    expect(dense[INPAINT_MODEL.scheduler.node].inputs.model).toEqual(["19", 0]);
    for (const node of Object.values(dense)) {
      for (const value of Object.values(node.inputs)) if (Array.isArray(value)) expect(dense).toHaveProperty(String(value[0]));
    }
  });
});
