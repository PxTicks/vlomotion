import { describe, expect, it } from "vitest";
import { DEFAULT_CAPTION } from "../description.js";
import { createMotion, upsertKey } from "../motion.js";
import type { SubjectMotion } from "../motion.js";
import { buildH3Prompt, describeMotion } from "../prompt.js";

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
});

describe("H3 prompt", () => {
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
