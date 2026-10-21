import { describe, expect, it } from "vitest";
import { Comfy } from "@comfyorg/sdk";
import { assertBindings, buildDescribeWorkflow, buildIsolateWorkflow, buildSegmentWorkflow, DESCRIBE_BINDINGS, DESCRIBE_OUTPUTS, ISOLATE_BINDINGS, ISOLATE_OUTPUT, isolationGeometry, loadTemplate, samText, SEGMENT_BINDINGS, SEGMENT_OUTPUT } from "../templates.js";

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
});
