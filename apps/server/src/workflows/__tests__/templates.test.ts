import { describe, expect, it } from "vitest";
import { Comfy } from "@comfyorg/sdk";
import { ANIMATE_BINDINGS, ANIMATE_MODEL, ANIMATE_OUTPUT, assertBindings, buildAnimateWorkflow, buildDescribeWorkflow, buildIsolateWorkflow, buildSegmentWorkflow, DESCRIBE_BINDINGS, DESCRIBE_OUTPUTS, ISOLATE_BINDINGS, ISOLATE_OUTPUT, isolationGeometry, loadTemplate, samText, SEGMENT_BINDINGS, SEGMENT_OUTPUT } from "../templates.js";
import type { ApiGraph } from "../templates.js";

describe("workflow contracts", () => {
  it("binds text and points variants to the correct classes", async () => {
    const text = await loadTemplate("segment_text");
    const points = await loadTemplate("segment_points");
    assertBindings(text, [SEGMENT_BINDINGS.image, SEGMENT_BINDINGS.text]);
    assertBindings(points, [SEGMENT_BINDINGS.image, SEGMENT_BINDINGS.positive, SEGMENT_BINDINGS.negative]);
    expect(text[SEGMENT_OUTPUT].class_type).toBe("SaveImage");
    expect(points["4"].inputs).not.toHaveProperty("conditioning");
    expect(text["4"].inputs).not.toHaveProperty("positive_coords");
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
    expect(graph["14"].inputs.first_frame).toEqual([ANIMATE_BINDINGS.start.node, 0]);
    expect(graph["11"].inputs).toMatchObject({ channel: "red" });
    expect(graph["12"]).toMatchObject({ class_type: "ThresholdMask", inputs: { value: 0.5 } });
    expect(graph["13"]).toMatchObject({ class_type: "GrowMask", inputs: { mask: ["12", 0], expand: -16, tapered_corners: true } });
    expect(graph["16"].inputs).toMatchObject({ start_step: 1, mask: ["13", 0] });
    expect(graph["21"].inputs.latent_image).toEqual(["14", 1]);
    // No resize, frame trimming, KJNodes or end-frame nodes: the app sends exact sizes and frame counts.
    expect(Object.values(graph).map(node => node.class_type)).not.toEqual(expect.arrayContaining(["ResizeImageMaskNode"]));
    for (const node of Object.values(graph)) {
      for (const value of Object.values(node.inputs)) if (Array.isArray(value)) expect(graph).toHaveProperty(String(value[0]));
    }
  });
  it("binds animate inputs and splices Spectrum only when asked", async () => {
    const options = { startPath: "/tmp/start.png", referencePath: "/tmp/reference.mp4", maskPath: "/tmp/mask.mp4",
      size: { width: 1248, height: 704 }, frames: 175, prompt: "A dog runs.", lockIn: 5, seed: 9 };
    const plain = (await buildAnimateWorkflow(new Comfy(), options)).json as ApiGraph;
    expect(plain["14"].inputs).toMatchObject({ width: 1248, height: 704, length: 175, prompt: "A dog runs." });
    expect(plain[ANIMATE_BINDINGS.grow.node].inputs.expand).toBe(-16);
    expect(plain["16"].inputs).toMatchObject({ end_step: 5, model: ["15", 0] });
    expect(plain).not.toHaveProperty("spectrum");
    const fast = (await buildAnimateWorkflow(new Comfy(), { ...options, spectrum: true })).json as ApiGraph;
    expect(fast.spectrum).toMatchObject({ class_type: "SpectrumApplyMiniMaxH3", inputs: { model: ["15", 0], enabled: true } });
    expect(fast["16"].inputs.model).toEqual(["spectrum", 0]);
    expect(fast["18"].inputs.model).toEqual(["spectrum", 0]);
    expect((await loadTemplate("animate"))["16"].inputs.model).toEqual(["15", 0]);
  });
});
