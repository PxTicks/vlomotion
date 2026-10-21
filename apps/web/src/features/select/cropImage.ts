import { centerCrop, generationSize } from "@h3-motion/shared";
import type { AspectRatio } from "@h3-motion/shared";

export async function cropImage(file: File, ratio: AspectRatio): Promise<Blob> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error("Choose a JPEG, PNG or WebP photo.");
  if (file.size > 20 * 1024 * 1024) throw new Error("Choose a photo under 20 MB.");
  const bitmap = await createImageBitmap(file);
  try {
    const generation = generationSize(ratio);
    const canvas = document.createElement("canvas");
    canvas.width = generation.width * 2; canvas.height = generation.height * 2;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Your browser could not open the photo canvas.");
    const crop = centerCrop(bitmap, canvas);
    context.drawImage(bitmap, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Could not prepare the photo.")), "image/png");
    });
  } finally { bitmap.close(); }
}
