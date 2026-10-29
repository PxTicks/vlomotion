import { describe, expect, it } from "vitest";
import { composeInpaintPrompt, formatTimestamp, frameInstruction, objectInstruction, referenceDefinition } from "../reference.js";

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
  it("asks Qwen Image for a clean object, or for an edit placed by the highlight", () => {
    expect(objectInstruction("a red lantern.")).toMatch(/^A reference photo of a red lantern: .*plain white background/);
    expect(frameInstruction("a red umbrella")).toMatch(/^In <image1>, make the area highlighted in yellow in <image2> show a red umbrella\. /);
  });
});
