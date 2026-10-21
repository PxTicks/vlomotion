import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { decodeMask } from "./masks.js";

/** Build the VLM input from the authoritative confirmed mask, rather than canvas UI state. */
export async function highlightSubject(imagePath: string, maskPath: string, width: number, height: number): Promise<Buffer> {
  const pixels = await sharp(imagePath).toColourspace("srgb").removeAlpha().raw().toBuffer();
  const { pixels: mask } = await decodeMask(await readFile(maskPath), width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!mask[i]) continue;
      const edge = x === 0 || y === 0 || x === width - 1 || y === height - 1
        || !mask[i - 1] || !mask[i + 1] || !mask[i - width] || !mask[i + width];
      const alpha = edge ? 1 : 0.45;
      const offset = i * 3;
      pixels[offset] = Math.round(pixels[offset] * (1 - alpha) + 242 * alpha);
      pixels[offset + 1] = Math.round(pixels[offset + 1] * (1 - alpha) + 255 * alpha);
      pixels[offset + 2] = Math.round(pixels[offset + 2] * (1 - alpha) + 89 * alpha);
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
}
