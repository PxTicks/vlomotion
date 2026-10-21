import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { expect, it } from "vitest";
import { highlightSubject } from "../highlight.js";
import { encodeMask } from "../masks.js";

it("highlights only the confirmed union and preserves every exterior pixel", async () => {
  const root = await mkdtemp(join(tmpdir(), "h3m-highlight-"));
  try {
    const original = await sharp({ create: { width: 5, height: 5, channels: 3, background: { r: 40, g: 60, b: 80 } } }).png().toBuffer();
    const mask = new Uint8Array(25);
    for (let y = 1; y < 4; y++) for (let x = 1; x < 4; x++) mask[y * 5 + x] = 255;
    const imagePath = join(root, "original.png"), maskPath = join(root, "mask.png");
    await writeFile(imagePath, original); await writeFile(maskPath, await encodeMask(mask, 5, 5));
    const pixels = await sharp(await highlightSubject(imagePath, maskPath, 5, 5)).raw().toBuffer();
    expect([...pixels.subarray(0, 3)]).toEqual([40, 60, 80]);
    expect([...pixels.subarray(6 * 3, 6 * 3 + 3)]).toEqual([242, 255, 89]);
    expect([...pixels.subarray(12 * 3, 12 * 3 + 3)]).toEqual([131, 148, 84]);
    for (let i = 0; i < mask.length; i++) if (!mask[i]) expect([...pixels.subarray(i * 3, i * 3 + 3)]).toEqual([40, 60, 80]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
