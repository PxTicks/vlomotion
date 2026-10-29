import { describe, expect, it } from "vitest";
import { composeInpaintPrompt, formatTimestamp, frameInstruction, objectInstruction, parseInpaintPrompt, referenceDefinition } from "../reference.js";
import type { ReferenceRole } from "../reference.js";
import type { InpaintAudioMode } from "../inpaint.js";

const keyframe = { kind: "frame" as const, frame: 49, frames: 124 };

describe("inpaint reference prompts", () => {
  it("formats timestamps as the guide's MM:SS.mmm", () => {
    expect(formatTimestamp(0)).toBe("00:00.000");
    expect(formatTimestamp(49)).toBe("00:02.042");
    expect(formatTimestamp(24 * 75)).toBe("01:15.000");
  });
  it("defines an object as a subject cited from the picture, and an edited frame as its own picture", () => {
    expect(referenceDefinition({ kind: "object" }, "A red paper lantern.")).toBe("<Subject 1> is the red paper lantern in <Picture 1>.");
    expect(referenceDefinition({ kind: "object" })).toBe("<Subject 1> is the object in <Picture 1>.");
    expect(referenceDefinition(keyframe, "A red umbrella")).toBe("<Picture 1> is the edited keyframe of [Shot 1] at 00:02.042, showing a red umbrella.");
    expect(referenceDefinition({ ...keyframe, frame: 0 })).toBe("<Picture 1> is the edited first frame of [Shot 1].");
    expect(referenceDefinition({ ...keyframe, frame: 123 }, "Big Ben")).toBe("<Picture 1> is the edited last frame of [Shot 1], showing Big Ben.");
  });
  it("sends the prompt as written without a reference, or when it is already laid out", () => {
    expect(composeInpaintPrompt("  A bird flies.  ")).toBe("A bird flies.");
    const written = "subject_definitions:\n<Subject 1> is a bird in <Picture 1>.\n\ndetailed_description:\n[Shot 1] It flies.";
    expect(composeInpaintPrompt(written, { role: { kind: "object" }, definition: "ignored" })).toBe(written);
  });
  it("lays out an object reference as reference generation in an edited video", () => {
    expect(composeInpaintPrompt("A red lantern sways in the breeze.", { role: { kind: "object" }, definition: "<Subject 1> is the red lantern in <Picture 1>." })).toBe([
      "subject_definitions:\n<Subject 1> is the red lantern in <Picture 1>.",
      "summary:\n[video editing + reference generation] The target video is an edited version of the source video in which <Subject 1> appears.",
      "retention_analysis:\n<Subject 1> (appears in [Shot 1]): fully_preserved - the appearance of <Subject 1> from <Picture 1> is retained.",
      "detailed_description:\n[Shot 1] A red lantern sways in the breeze.",
    ].join("\n\n"));
  });
  it("lays out an edited frame as keyframe completion, anchoring the shot to it", () => {
    const prompt = composeInpaintPrompt("Rain falls on an open umbrella.", { role: keyframe, definition: " " });
    expect(prompt).toContain("subject_definitions:\n<Picture 1> is the edited keyframe of [Shot 1] at 00:02.042.");
    expect(prompt).toContain("summary:\n[video editing + keyframe completion] The target video is an edited version of the source video, with <Picture 1> as the edited keyframe of [Shot 1] at 00:02.042.");
    expect(prompt).toContain("retention_analysis:\n<Picture 1> ([Shot 1] keyframe at 00:02.042): fully_preserved - the edited frame is retained.");
    expect(prompt).toContain("detailed_description:\n[Shot 1] Rain falls on an open umbrella. At 00:02.042, the shot's keyframe corresponds to <Picture 1>.");
    expect(composeInpaintPrompt("[Shot 1] It opens.", { role: { ...keyframe, frame: 0 }, definition: "d" }))
      .toContain("detailed_description:\n[Shot 1] It opens. The shot begins from <Picture 1>.");
    expect(composeInpaintPrompt("It closes.", { role: { ...keyframe, frame: 123 }, definition: "d" })).toContain("The shot ends on <Picture 1>.");
  });
  it("closes the prompt with the filled sound sections, in either layout", () => {
    expect(composeInpaintPrompt("A bird flies.", undefined, { soundEffects: "", music: " " })).toBe("A bird flies.");
    expect(composeInpaintPrompt("A bird flies.", undefined, { soundEffects: "", music: "Soft strings." }))
      .toBe("A bird flies.\n\nnon_diegetic_music:\nSoft strings.");
    expect(composeInpaintPrompt("A lantern sways.", { role: { kind: "object" }, definition: "d" }, { soundEffects: "Wind.", music: "Piano." }))
      .toMatch(/detailed_description:\n\[Shot 1\] A lantern sways\.\n\noverall_soundscape:\nWind\.\n\nnon_diegetic_music:\nPiano\.$/);
    const written = "A bird flies.\n\noverall_soundscape:\nBirdsong.";
    expect(composeInpaintPrompt(written, undefined, { soundEffects: "Wind.", music: "Piano." })).toBe(written);
  });
  it("defines the source's sound as <Audio 1> when H3 hears it", () => {
    expect(composeInpaintPrompt("A bird flies.", undefined, { soundEffects: "Wings flap.", music: "Piano.", mode: "reference" })).toBe([
      "subject_definitions:\n<Audio 1> is the original audio track of the source video.",
      "summary:\n[video editing + audio reference] The target video is an edited version of the source video.",
      "retention_analysis:\n<Audio 1>: reference - its ambience, sound texture and music style guide the target video's audio without copying the original signal.",
      "detailed_description:\n[Shot 1] A bird flies.",
      "overall_soundscape:\nThe ambience and sound texture of <Audio 1> carry on throughout the target video. Wings flap.",
      "non_diegetic_music:\nPiano.",
    ].join("\n\n"));
    const kept = composeInpaintPrompt("A lantern sways.", { role: { kind: "object" }, definition: "d" }, { soundEffects: "Wind.", music: "Piano.", mode: "preserve" });
    expect(kept).toContain("subject_definitions:\nd\n<Audio 1> is the original audio track of the source video.");
    expect(kept).toContain("summary:\n[video editing + reference generation + audio reuse] The target video is an edited version of the source video in which <Subject 1> appears.");
    expect(kept).toContain("fully_preserved - the appearance of <Subject 1> from <Picture 1> is retained.\n<Audio 1>: fully_copy - ");
    // Kept unchanged, the source's sound is the whole track, so the sound fields are left out.
    expect(kept).toMatch(/\n\noverall_soundscape:\n<Audio 1> is reused unchanged as the complete audio track of the target video\.$/);
    expect(composeInpaintPrompt("A bird flies.", undefined, { soundEffects: "", music: "", mode: "replace" })).toBe("A bird flies.");
  });
  it("asks Qwen Image for a clean object, or for an edit placed by the highlight", () => {
    expect(objectInstruction("a red lantern.")).toMatch(/^A reference photo of a red lantern: .*plain white background/);
    expect(frameInstruction("a red umbrella")).toMatch(/^In <image1>, make the area highlighted in yellow in <image2> show a red umbrella\. /);
  });
  it.each([
    ["no reference", undefined, "replace"], ["no sound mode", undefined, undefined], ["an object", { kind: "object" }, "replace"],
    ["a keyframe", keyframe, "replace"], ["a first frame", { ...keyframe, frame: 0 }, undefined],
    ["a referenced sound", undefined, "reference"], ["an object and a referenced sound", { kind: "object" }, "reference"],
    ["a keyframe and a preserved sound", keyframe, "preserve"],
  ] as [string, ReferenceRole | undefined, InpaintAudioMode | undefined][])("reads the fields back from a raw prompt with %s", (_, role, mode) => {
    const fields = { prompt: "A lantern sways.\n\nIt glows.", definition: role ? "<Subject 1> is the lantern in <Picture 1>." : "", soundEffects: "Wind.", music: "Piano." };
    const prompt = composeInpaintPrompt(fields.prompt, role && { role, definition: fields.definition }, { ...fields, mode });
    expect(parseInpaintPrompt(prompt, role, mode)).toEqual(mode === "preserve" ? { prompt: fields.prompt, definition: fields.definition } : fields);
  });
  it("reads back blank sound fields, shots the user wrote, and a default definition", () => {
    expect(parseInpaintPrompt("A bird flies.", undefined, "replace")).toEqual({ prompt: "A bird flies.", definition: "", soundEffects: "", music: "" });
    const shots = "[Shot 1] It opens.\n[Shot 2] It closes.";
    expect(parseInpaintPrompt(composeInpaintPrompt(shots, { role: keyframe, definition: "" }), keyframe)?.prompt).toBe(shots);
    expect(parseInpaintPrompt(composeInpaintPrompt("It sways.", { role: { kind: "object" }, definition: "" }), { kind: "object" })?.definition)
      .toBe(referenceDefinition({ kind: "object" }));
  });
  it.each([
    ["a removed section", (prompt: string) => prompt.replace(/summary:\n.*\n\n/, "")],
    ["an edited summary", (prompt: string) => prompt.replace("+ reference generation", "+ inpainting")],
    ["an edited soundscape opening", (prompt: string) => prompt.replace("carry on throughout", "fade out over")],
    ["a removed soundscape", (prompt: string) => prompt.replace(/\n\noverall_soundscape:[\s\S]*$/, "")],
    ["a blank description", (prompt: string) => prompt.replace("[Shot 1] A lantern sways.", "[Shot 1]")],
  ])("can't read the fields back from a raw prompt with %s", (_, edit) => {
    const role = { kind: "object" } as const;
    const prompt = composeInpaintPrompt("A lantern sways.", { role, definition: "d" }, { soundEffects: "Wind.", music: "", mode: "reference" });
    expect(parseInpaintPrompt(prompt, role, "reference")).not.toBeNull();
    expect(parseInpaintPrompt(edit(prompt), role, "reference")).toBeNull();
  });
  it("can't read a prompt laid out for a reference that has since been removed", () => {
    const prompt = composeInpaintPrompt("A lantern sways.", { role: { kind: "object" }, definition: "d" });
    expect(parseInpaintPrompt(prompt, keyframe)).toBeNull();
  });
});
