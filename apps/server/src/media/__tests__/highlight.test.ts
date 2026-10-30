import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { expect, it } from "vitest";
import { highlightSubject } from "../highlight.js";
import { encodeMask } from "../masks.js";

it("outlines the confirmed union just outside it, leaving the subject and the rest untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "h3m-highlight-"));
  try {
    const original = await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 200, g: 30, b: 30 } } }).png().toBuffer();
    const mask = new Uint8Array(400);
    for (let y = 6; y < 14; y++) for (let x = 6; x < 14; x++) mask[y * 20 + x] = 255;
    const imagePath = join(root, "original.png"), maskPath = join(root, "mask.png");
    await writeFile(imagePath, original); await writeFile(maskPath, await encodeMask(mask, 20, 20));
    const pixels = await sharp(await highlightSubject(imagePath, maskPath, 20, 20)).raw().toBuffer();
    const at = (x: number, y: number) => [...pixels.subarray((y * 20 + x) * 3, (y * 20 + x) * 3 + 3)];
    // The outline is 2 px wide on a small frame.
    for (const [x, y] of [[5, 9], [4, 9], [9, 15], [4, 4], [15, 15]]) expect(at(x, y)).toEqual([242, 255, 89]);
    for (const [x, y] of [[3, 9], [9, 16], [0, 0]]) expect(at(x, y)).toEqual([200, 30, 30]);
    for (let i = 0; i < mask.length; i++) if (mask[i]) expect([...pixels.subarray(i * 3, i * 3 + 3)]).toEqual([200, 30, 30]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
