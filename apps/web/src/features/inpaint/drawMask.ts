import type { FrameSize, MaskBox, MaskShape } from "@h3-motion/shared";

/**
 * Paints the mask white on black: `box` is a fraction of the frame, which is `size` in canvas pixels. `grow` widens it
 * by that many canvas pixels all round; stroking the outline at twice that width grows it exactly, with round corners.
 */
export function drawMask(context: OffscreenCanvasRenderingContext2D, size: FrameSize, box: MaskBox, shape: MaskShape, grow = 0) {
  context.fillStyle = "black";
  context.fillRect(0, 0, size.width, size.height);
  const x = box.x * size.width, y = box.y * size.height, w = box.width * size.width, h = box.height * size.height;
  context.fillStyle = "white";
  context.beginPath();
  if (shape === "ellipse") context.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  else context.rect(x, y, w, h);
  context.fill();
  if (grow > 0) {
    context.strokeStyle = "white"; context.lineWidth = grow * 2; context.lineJoin = "round";
    context.stroke();
  }
}
