import { describe, expect, it } from "vitest";
import { canApplyPointPrompt, segmentRequestSchema } from "../api.js";

describe("point prompt eligibility", () => {
  it.each([
    [false, [], [], false],
    [false, [], [{ x: 1, y: 1 }], false],
    [false, [{ x: 1, y: 1 }], [], true],
    [true, [], [], false],
    [true, [], [{ x: 1, y: 1 }], true],
    [true, [{ x: 1, y: 1 }], [{ x: 2, y: 2 }], true],
  ] as const)("keeps the request schema and Apply rule consistent for prior=%s", (hasPrior, positive, negative, allowed) => {
    expect(canApplyPointPrompt(hasPrior, positive, negative)).toBe(allowed);
    const request = { mode: "points", imageId: crypto.randomUUID(), positive, negative,
      ...(hasPrior ? { candidateId: crypto.randomUUID() } : {}) };
    expect(segmentRequestSchema.safeParse(request).success).toBe(allowed);
  });
});
