import sharp from "sharp";

export function maskBounds(pixels: Uint8Array, width: number, height: number) {
  if (pixels.length !== width * height) throw new Error("Mask dimensions do not match its pixels.");
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[y * width + x] < 128) continue;
      left = Math.min(left, x); top = Math.min(top, y);
      right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
  }
  return right < 0 ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

export async function decodeMask(bytes: Uint8Array, width: number, height: number) {
  const image = sharp(bytes, { limitInputPixels: 8_000_000 });
  const metadata = await image.metadata();
  if (metadata.width !== width || metadata.height !== height) throw new Error("SAM returned a mask with different dimensions from the photo.");
  const pixels = await image.removeAlpha().greyscale().threshold(128).raw().toBuffer();
  return { pixels, bounds: maskBounds(pixels, width, height) };
}

export async function encodeMask(pixels: Uint8Array, width: number, height: number) {
  return sharp(pixels, { raw: { width, height, channels: 1 } }).png().toBuffer();
}

/** A tracked mask's area, the median of its pixels (at pixel centres) and its bounds, or null if it is empty. */
export async function measureMask(bytes: Uint8Array, width: number, height: number) {
  const { pixels, bounds } = await decodeMask(bytes, width, height);
  if (!bounds) return null;
  const columns = new Uint32Array(width), rows = new Uint32Array(height);
  let area = 0;
  for (let y = bounds.y; y < bounds.y + bounds.height; y++) {
    for (let x = bounds.x; x < bounds.x + bounds.width; x++) {
      if (pixels[y * width + x] < 128) continue;
      columns[x]++; rows[y]++; area++;
    }
  }
  /** The centre of the row or column holding the `rank`th pixel, counting from 1. */
  const holding = (counts: Uint32Array, rank: number) => {
    let total = 0, index = 0;
    while (total + counts[index] < rank) total += counts[index++];
    return index + 0.5;
  };
  const medianOf = (counts: Uint32Array) => (holding(counts, Math.ceil(area / 2)) + holding(counts, Math.floor(area / 2) + 1)) / 2;
  return { area, x: medianOf(columns), y: medianOf(rows), bounds };
}
