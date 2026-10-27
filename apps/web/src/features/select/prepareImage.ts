/** Keep the whole photo and its native ratio within the server's working-image limit. */
export async function prepareImage(file: File): Promise<Blob> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error("Choose a JPEG, PNG or WebP photo.");
  if (file.size > 20 * 1024 * 1024) throw new Error("Choose a photo under 20 MB.");
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 960 / Math.min(bitmap.width, bitmap.height), 2560 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Your browser could not open the photo canvas.");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Could not prepare the photo.")), "image/png");
    });
  } finally { bitmap.close(); }
}
