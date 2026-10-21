import { describe, expect, it } from "vitest";
import { Comfy } from "@comfyorg/sdk";
import { assertBindings, buildSegmentWorkflow, loadTemplate, samText, SEGMENT_BINDINGS, SEGMENT_OUTPUT } from "../templates.js";

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
  it("clones templates before binding SDK assets and primitives", async () => {
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
    expect(graph["5"]).toMatchObject({ class_type: "SaveText", inputs: { format: "json", text: ["3", 0] } });
    expect(graph["6"]).toMatchObject({ class_type: "SaveText", inputs: { format: "json", text: ["4", 0] } });
    expect(graph["3"].inputs).toMatchObject({ sampling_mode: "off", thinking: false });
  });
});
