import { describe, expect, it } from "vitest";
import { DEFAULT_CAPTION, parseDescription, removalInstruction } from "../description.js";

describe("subject description fallbacks", () => {
  it("parses plain phrases and fenced caption JSON", () => {
    expect(parseDescription("the brown dog on the left", '```json\n{"subject":"the brown dog","scene":"on a lawn"}\n```'))
      .toEqual({ phrase: "the brown dog on the left", caption: { ...DEFAULT_CAPTION, subject: "the brown dog", scene: "on a lawn" } });
  });
  it("falls back field by field without losing valid caption fields", () => {
    const description = parseDescription('"the red car"', '{"style":null,"motion_verb":"","scene":"on the road","soundscape":42}');
    expect(description.phrase).toBe("the red car");
    expect(description.caption).toEqual({ ...DEFAULT_CAPTION, subject: "the red car", scene: "on the road" });
  });
  it.each(["", "A long answer that contains far more than eight words about a picture.", "The subject is\non the left"])("uses the model's caption subject when the phrase is invalid: %s", phrase => {
    const description = parseDescription(phrase, '{"subject":"the black cat"}');
    expect(description.phrase).toBe("the black cat");
    expect(() => parseDescription(phrase, "not JSON")).toThrow("write a removal instruction");
  });
  it.each(["{}", '{"subject":null}', '{"subject":""}', "not JSON"])("uses the available subject for incomplete caption %s", caption => {
    expect(parseDescription("the brown dog", caption).caption.subject).toBe("the brown dog");
    expect(() => parseDescription("", caption)).toThrow("Could not identify");
  });
  it("uses Qwen's image reference syntax in the removal instruction", () => {
    expect(removalInstruction("the red car")).toBe("Remove the red car from <image1>, including its shadow and reflection. Fill the area with the background that would naturally be behind it. Keep everything else exactly the same.");
  });
});
