import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { decodeMask } from "./masks.js";

/** Outline width as a share of the short side: thick enough to survive the VLM's downscale. */
const OUTLINE_SHARE = 0.005;

/**
 * Build the VLM input from the authoritative confirmed mask, rather than canvas UI state. A yellow outline is drawn just
 * outside the mask and the subject's own pixels are left untouched, so a tint can't change the colours the VLM reports.
 */
export async function highlightSubject(imagePath: string, maskPath: string, width: number, height: number): Promise<Buffer> {
  const pixels = await sharp(imagePath).toColourspace("srgb").removeAlpha().raw().toBuffer();
  const { pixels: mask } = await decodeMask(await readFile(maskPath), width, height);
  const radius = Math.max(2, Math.round(Math.min(width, height) * OUTLINE_SHARE));
  const grown = dilate(dilate(mask, width, height, radius, 1), width, height, radius, width);
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] || !grown[i]) continue;
    pixels[i * 3] = 242; pixels[i * 3 + 1] = 255; pixels[i * 3 + 2] = 89;
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

/** Grows the mask by `radius` pixels along rows (`step` 1) or columns (`step` = width), in linear time. */
function dilate(mask: Uint8Array, width: number, height: number, radius: number, step: number) {
  const out = new Uint8Array(mask.length);
  const [lines, length, stride] = step === 1 ? [height, width, width] : [width, height, 1];
  for (let line = 0; line < lines; line++) {
    const start = line * stride;
    let last = -Infinity;
    for (let k = 0; k < length; k++) {
      if (mask[start + k * step]) last = k;
      if (k - last <= radius) out[start + k * step] = 255;
    }
    last = Infinity;
    for (let k = length - 1; k >= 0; k--) {
      if (mask[start + k * step]) last = k;
      if (last - k <= radius) out[start + k * step] = 255;
    }
  }
  return out;
}
