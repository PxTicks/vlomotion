import type { FrameSize, MaskBox, MaskShape } from "@h3-motion/shared";

/** Paints the mask white on black: `box` is a fraction of the frame, which is `size` in canvas pixels. */
export function drawMask(context: OffscreenCanvasRenderingContext2D, size: FrameSize, box: MaskBox, shape: MaskShape) {
  context.fillStyle = "black";
  context.fillRect(0, 0, size.width, size.height);
  const x = box.x * size.width, y = box.y * size.height, w = box.width * size.width, h = box.height * size.height;
  context.fillStyle = "white";
  if (shape === "ellipse") {
    context.beginPath(); context.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); context.fill();
  } else context.fillRect(x, y, w, h);
}
