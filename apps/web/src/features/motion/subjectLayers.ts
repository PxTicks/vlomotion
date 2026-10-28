import { isAtRest } from "@h3-motion/shared";
import type { Placement, Point, Rect, SubjectMotion } from "@h3-motion/shared";

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Drawable = CanvasImageSource & { width: number; height: number };

/** The images the compositor draws, in working-image pixels. Plain enough to transfer to a worker as ImageBitmaps. */
export interface RenderLayers {
  width: number; height: number;
  photo: Drawable; plate: Drawable;
  /** The original photo with the subject's feathered alpha: the piece that moves. */
  cutout: Drawable;
  /** The binary subject in white on transparent, for the TTM mask video. */
  matte: Drawable;
  /** Independent cutouts in front-to-back order, used by the video renderer. */
  subjects?: { layers: RenderLayers; motion: SubjectMotion }[];
}

export interface SubjectLayers extends RenderLayers {
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
export const layersKeyOf = (photoUrl: string, maskUrl: string, plateUrl: string) => `${photoUrl}|${maskUrl}|${plateUrl}`;

export const hitsSubject = (layers: SubjectLayers, point: Point, { anchor, offset, sx, sy }: Placement) => {
  if (!sx || !sy) return false;
  // Unscaled axes skip the anchor round trip, which could tip an exact pixel edge into its neighbour.
  const x = Math.floor(sx === 1 ? point.x - offset.x : anchor.x + (point.x - anchor.x - offset.x) / sx);
  const y = Math.floor(sy === 1 ? point.y - offset.y : anchor.y + (point.y - anchor.y - offset.y) / sy);
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

export async function loadSubjectLayers(photoUrl: string, plateUrl: string, maskUrl: string, shared?: Pick<SubjectLayers, "photo" | "plate">): Promise<SubjectLayers> {
  const [photo, plate, maskImage] = await Promise.all([shared?.photo ?? loadImage(photoUrl), shared?.plate ?? loadImage(plateUrl), loadImage(maskUrl)]);
  const width = photo.width, height = photo.height;
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
  const matte = document.createElement("canvas");
  matte.width = width; matte.height = height;
  const white = new ImageData(width, height);
  for (let i = 0; i < mask.length; i++) { white.data[i * 4] = white.data[i * 4 + 1] = white.data[i * 4 + 2] = 255; white.data[i * 4 + 3] = mask[i]; }
  // CPU-backed like the cut-out: a GPU context reset would silently blank the TTM mask.
  matte.getContext("2d", { willReadFrequently: true })!.putImageData(white, 0, 0);
  return { width, height, photo, plate, cutout: canvas, matte, mask, bounds };
}

/**
 * Map the whole working image into the output canvas, including its even-pixel encoder rounding.
 * Without a placement the image is drawn as is, as the photo and plate always are.
 */
function drawLayer(context: Context2D, layers: RenderLayers, image: Drawable, placement?: Placement) {
  const { width, height } = context.canvas;
  const toX = (x: number) => x * width / layers.width, toY = (y: number) => y * height / layers.height;
  if (!placement) { context.drawImage(image, 0, 0, width, height); return; }
  const { anchor, offset, sx, sy } = placement;
  if (sx === 1 && sy === 1) { context.drawImage(image, toX(offset.x), toY(offset.y), width, height); return; }
  context.save();
  context.translate(toX(anchor.x + offset.x), toY(anchor.y + offset.y));
  context.scale(sx, sy);
  context.drawImage(image, -toX(anchor.x), -toY(anchor.y), width, height);
  context.restore();
}

/**
 * Draws one reference frame: the plate with the cut-out at its placement.
 * At rest the original photo is drawn instead, so those frames match the start frame exactly.
 */
export function drawReference(context: Context2D, layers: RenderLayers, placement: Placement) {
  if (isAtRest(placement)) { drawLayer(context, layers, layers.photo); return; }
  drawLayer(context, layers, layers.plate);
  drawLayer(context, layers, layers.cutout, placement);
}

/** Draws one TTM mask frame: the subject in white at its placement, black everywhere else. */
export function drawMask(context: Context2D, layers: RenderLayers, placement: Placement) {
  context.fillStyle = "#000";
  context.fillRect(0, 0, context.canvas.width, context.canvas.height);
  drawLayer(context, layers, layers.matte, placement);
}

export function drawGhost(context: Context2D, layers: RenderLayers, placement: Placement, opacity: number) {
  context.save();
  context.globalAlpha = opacity;
  drawLayer(context, layers, layers.cutout, placement);
  context.restore();
}

export interface PositionedSubject { layers: RenderLayers; placement: Placement }

/** Subjects are listed front first; compositing draws the back layer first. */
export function drawSceneReference(context: Context2D, layers: RenderLayers, subjects: PositionedSubject[], originalFrame = false) {
  if (originalFrame) { drawLayer(context, layers, layers.photo); return; }
  drawLayer(context, layers, layers.plate);
  for (let index = subjects.length - 1; index >= 0; index--) {
    const subject = subjects[index];
    drawLayer(context, subject.layers, subject.layers.cutout, subject.placement);
  }
}

export function drawSceneMask(context: Context2D, subjects: PositionedSubject[]) {
  context.fillStyle = "#000";
  context.fillRect(0, 0, context.canvas.width, context.canvas.height);
  for (let index = subjects.length - 1; index >= 0; index--) {
    const subject = subjects[index];
    drawLayer(context, subject.layers, subject.layers.matte, subject.placement);
  }
}
