import { describe, expect, it } from "vitest";
import { decodeMask, encodeMask, maskBounds } from "../masks.js";

describe("white-subject masks", () => {
  it("derives inclusive bounds from pixels and detects empty outputs", () => {
    expect(maskBounds(Uint8Array.from([0, 0, 255, 0, 255, 0]), 3, 2)).toEqual({ x: 1, y: 0, width: 2, height: 2 });
    expect(maskBounds(new Uint8Array(6), 3, 2)).toBeNull();
    expect(() => maskBounds(new Uint8Array(5), 3, 2)).toThrow("dimensions");
  });
  it("thresholds a PNG around 0.5 without interpreting black as alpha", async () => {
    const png = await encodeMask(Uint8Array.from([0, 127, 128, 255]), 2, 2);
    const decoded = await decodeMask(png, 2, 2);
    expect([...decoded.pixels]).toEqual([0, 0, 255, 255]);
    expect(decoded.bounds).toEqual({ x: 0, y: 1, width: 2, height: 1 });
    await expect(decodeMask(png, 3, 2)).rejects.toThrow("different dimensions");
  });
});
