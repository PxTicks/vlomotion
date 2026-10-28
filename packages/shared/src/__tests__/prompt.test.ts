import { describe, expect, it } from "vitest";
import { DEFAULT_CAPTION } from "../description.js";
import { createMotion, upsertKey } from "../motion.js";
import type { SubjectMotion } from "../motion.js";
import { buildH3Prompt, buildH3PromptFields, composeH3Prompt, describeMotion } from "../prompt.js";

const size = { width: 1000, height: 500 };
let counter = 0;
function motionWith(...keys: [number, number, number][]): SubjectMotion {
  let motion = createMotion({ x: 100, y: 200 });
  for (const [frame, x, y] of keys) motion = upsertKey(motion, frame, { x, y }, `k${++counter}`)!.motion;
  return motion;
}

describe("motion description", () => {
  it("describes direction and extent in screen terms", () => {
    expect(describeMotion(motionWith([100, 900, 200]), size, "runs")).toBe("runs to the right across the frame");
    expect(describeMotion(motionWith([3, 60, 160]), size)).toBe("moves quickly toward the upper left a short way");
    expect(describeMotion(motionWith([96, 100, 350]), size)).toBe("moves slowly downward");
  });
  it("stays still when the subject doesn't travel", () => {
    expect(describeMotion(createMotion({ x: 100, y: 200 }), size)).toBe("stays still");
    expect(describeMotion(motionWith([50, 102, 201]), size)).toBe("stays still");
  });
  it("mentions pauses, a delayed start and pauses too short to matter", () => {
    expect(describeMotion(motionWith([30, 500, 200], [60, 500, 200], [90, 500, 400]), size))
      .toBe("moves to the right, pauses, then moves downward");
    expect(describeMotion(motionWith([30, 300, 200], [34, 300, 200], [64, 300, 350]), size))
      .toBe("moves toward the lower right in a wide arc");
    expect(describeMotion(motionWith([24, 100, 200], [72, 400, 200]), size)).toBe("waits a moment, then moves to the right");
  });
  it("describes arcs, returns and changes of speed", () => {
    expect(describeMotion(motionWith([40, 300, 20], [80, 500, 200]), size)).toMatch(/^moves to the right .*in a wide arc$/);
    expect(describeMotion(motionWith([40, 500, 200], [80, 110, 205]), size)).toBe("moves to the right and back");
    expect(describeMotion({ ...motionWith([60, 150, 200], [90, 700, 200]), timing: "linear" }, size)).toBe("moves to the right across the frame, speeding up");
  });
  it("notes an exit and falls back for busy paths", () => {
    const bounds = { x: 80, y: 180, width: 40, height: 40 };
    expect(describeMotion(motionWith([100, 1100, 200]), size, "moves", bounds)).toBe("moves to the right across the frame and leaves the frame");
    expect(describeMotion(motionWith([10, 300, 200], [30, 300, 200], [40, 300, 400], [60, 300, 400], [70, 100, 400], [90, 100, 400], [100, 100, 100]), size, "hops"))
      .toBe("hops around the frame, pausing along the way");
  });
  it("describes flips and the final size, with or without travel", () => {
    const grow = upsertKey(createMotion({ x: 100, y: 200 }), 100, { x: 100, y: 200, sx: -1.5, sy: 1.5 }, "grow")!.motion;
    expect(describeMotion(grow, size)).toBe("turns around and grows larger");
    const shrink = upsertKey(motionWith([100, 900, 200]), 100, { x: 900, y: 200, sx: .5, sy: .5 }, "shrink")!.motion;
    expect(describeMotion(shrink, size, "runs")).toBe("runs to the right across the frame while shrinking");
    let pulse = upsertKey(createMotion({ x: 100, y: 200 }), 50, { x: 100, y: 200, sx: 2, sy: 2 }, "big")!.motion;
    pulse = upsertKey(pulse, 100, { x: 100, y: 200, sx: 1, sy: 1 }, "back")!.motion;
    expect(describeMotion(pulse, size)).toBe("grows and shrinks back");
    const spin = upsertKey(upsertKey(createMotion({ x: 100, y: 200 }), 50, { x: 100, y: 200, sx: -1, sy: 1 }, "away")!.motion,
      100, { x: 100, y: 200, sx: 1, sy: 1 }, "home")!.motion;
    expect(describeMotion(spin, size)).toBe("turns around and back");
  });
});

describe("H3 prompt", () => {
  it("provides separate editable fields without the model's section labels", () => {
    const fields = buildH3PromptFields(DEFAULT_CAPTION, "moves to the right");
    expect(fields.mainPrompt).toContain("the selected subject in <Picture 1> moves to the right");
    expect(fields.mainPrompt).not.toContain("integrated_multimodal_description");
    expect(fields.mainPrompt).not.toContain("For the target video");
    expect(fields.mainPrompt).not.toContain("[Shot 1]");
    expect(fields.mainPrompt).not.toContain("overall_soundscape");
    expect(fields.mainPrompt).not.toContain("non_diegetic_music");
    expect(fields.soundEffects).toBe(DEFAULT_CAPTION.soundscape);
    expect(fields.music).toBe("");
    expect(composeH3Prompt(fields)).toBe(buildH3Prompt(DEFAULT_CAPTION, "moves to the right"));
  });
  it("places optional audio in its own sections and treats blank fields as N/A", () => {
    const fields = { mainPrompt: "A ball rolls.", soundEffects: "  Rolling on gravel.  ", music: "  Upbeat piano.  " };
    const prompt = composeH3Prompt(fields);
    expect(prompt).toContain("overall_soundscape: Rolling on gravel.");
    expect(prompt).toContain("non_diegetic_music: Upbeat piano.");
    expect(composeH3Prompt({ ...fields, soundEffects: " ", music: "" })).toContain("overall_soundscape: N/A\n\nnon_diegetic_music: N/A");
    expect(composeH3Prompt({ mainPrompt: "a".repeat(3000), soundEffects: "b".repeat(500), music: "c".repeat(250) }).length).toBeLessThanOrEqual(4000);
  });
  it.each(["silent", " Silence. ", "none", "N/A", "No sound.", "No audio", "No audible sounds.", "   "])("replaces an automatic silent soundscape with ambient sound: %s", soundscape => {
    const fields = buildH3PromptFields({ ...DEFAULT_CAPTION, soundscape }, "moves to the right");
    expect(fields.soundEffects).toBe(DEFAULT_CAPTION.soundscape);
    expect(composeH3Prompt(fields)).toContain(`overall_soundscape: ${DEFAULT_CAPTION.soundscape}`);
    expect(composeH3Prompt(fields)).toContain("non_diegetic_music: N/A");
  });
  it("preserves explicit silence edits and scene sounds that mention silence", () => {
    expect(composeH3Prompt({ mainPrompt: "A ball rolls.", soundEffects: "Silent.", music: "" }))
      .toContain("overall_soundscape: Silent.");
    expect(buildH3PromptFields({ ...DEFAULT_CAPTION, soundscape: "Birdsong breaks the silence." }, "moves").soundEffects)
      .toBe("Birdsong breaks the silence.");
  });
  it("fills the I2VA template without doubled punctuation", () => {
    expect(buildH3Prompt({ ...DEFAULT_CAPTION, subject: "the brown dog", scene: "on a sunlit lawn.", soundscape: "Paws thud on grass." },
      "runs to the right across the frame")).toBe([
      "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.",
      "integrated_multimodal_description: [Shot 1] Live-action, cinematic, the brown dog in <Picture 1> runs to the right across the frame, on a sunlit lawn. The camera stays still.",
      "overall_soundscape: Paws thud on grass.",
      "non_diegetic_music: N/A",
    ].join("\n\n"));
  });
});
