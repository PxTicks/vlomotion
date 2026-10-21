import type { Point, Rect } from "@h3-motion/shared";

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Drawable = CanvasImageSource & { width: number; height: number };

/** Everything the compositor needs, in working-image pixels. */
export interface SubjectLayers {
  width: number; height: number;
  photo: Drawable; plate: Drawable;
  /** The original photo with the subject's feathered alpha: the piece that moves. */
  cutout: Drawable;
  /** Binary subject mask (0 or 255), one byte per pixel, for hit testing. */
  mask: Uint8ClampedArray;
  bounds: Rect;
}

/** Thresholds the red channel of an RGBA mask image: white means subject. */
export function binaryMask(rgba: Uint8ClampedArray): Uint8ClampedArray {
  const mask = new Uint8ClampedArray(rgba.length / 4);
  for (let i = 0; i < mask.length; i++) mask[i] = rgba[i * 4] >= 128 ? 255 : 0;
  return mask;
}

export function maskBounds(mask: Uint8ClampedArray, width: number, height: number): Rect | null {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!mask[y * width + x]) continue;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** A 3 × 3 box average: the 1 px alpha feather the cut-out gets when drawn. */
export function featherMask(mask: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(mask.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let sum = 0, count = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      sum += mask[ny * width + nx]; count++;
    }
    out[y * width + x] = Math.round(sum / count);
  }
  return out;
}

export const subjectKeyOf = (imageId: string, maskId: string) => `${imageId}:${maskId}`;

export const hitsSubject = (layers: SubjectLayers, point: Point, offset: Point) => {
  const x = Math.floor(point.x - offset.x), y = Math.floor(point.y - offset.y);
  return x >= 0 && y >= 0 && x < layers.width && y < layers.height && layers.mask[y * layers.width + x] > 0;
};

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not load the subject layers. Try isolating the subject again."));
    image.src = url;
  });
}

export async function loadSubjectLayers(photoUrl: string, plateUrl: string, maskUrl: string): Promise<SubjectLayers> {
  const [photo, plate, maskImage] = await Promise.all([loadImage(photoUrl), loadImage(plateUrl), loadImage(maskUrl)]);
  const width = photo.naturalWidth, height = photo.naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  context.drawImage(maskImage, 0, 0, width, height);
  const mask = binaryMask(context.getImageData(0, 0, width, height).data);
  const bounds = maskBounds(mask, width, height);
  if (!bounds) throw new Error("The subject mask is empty. Go back and confirm a selection.");
  const alpha = featherMask(mask, width, height);
  context.clearRect(0, 0, width, height);
  context.drawImage(photo, 0, 0);
  const pixels = context.getImageData(0, 0, width, height);
  for (let i = 0; i < alpha.length; i++) pixels.data[i * 4 + 3] = alpha[i];
  context.putImageData(pixels, 0, 0);
  return { width, height, photo, plate, cutout: canvas, mask, bounds };
}

/**
 * Draws one reference frame scaled to the context's canvas: the plate with the cut-out at its offset.
 * At rest the original photo is drawn instead, so those frames match the start frame exactly.
 */
export function drawReference(context: Context2D, layers: SubjectLayers, offset: Point) {
  const { width, height } = context.canvas;
  if (offset.x === 0 && offset.y === 0) { context.drawImage(layers.photo, 0, 0, width, height); return; }
  context.drawImage(layers.plate, 0, 0, width, height);
  context.drawImage(layers.cutout, offset.x * width / layers.width, offset.y * height / layers.height, width, height);
}

export function drawGhost(context: Context2D, layers: SubjectLayers, offset: Point, opacity: number) {
  const { width, height } = context.canvas;
  context.save();
  context.globalAlpha = opacity;
  context.drawImage(layers.cutout, offset.x * width / layers.width, offset.y * height / layers.height, width, height);
  context.restore();
}
