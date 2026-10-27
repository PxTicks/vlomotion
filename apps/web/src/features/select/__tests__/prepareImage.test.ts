import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareImage } from "../prepareImage";

afterEach(() => vi.unstubAllGlobals());

describe("photo preparation", () => {
  it.each([
    [4000, 2800, 1371, 960], [2800, 4000, 960, 1371], [900, 1200, 900, 1200],
  ])("keeps the full %s × %s photo at its native ratio", async (width, height, workingWidth, workingHeight) => {
    const bitmap = { width, height, close: vi.fn() }, drawImage = vi.fn();
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage }),
      toBlob: (done: BlobCallback) => done(new Blob(["png"], { type: "image/png" })) };
    vi.stubGlobal("createImageBitmap", vi.fn(async () => bitmap));
    vi.stubGlobal("document", { createElement: () => canvas });
    const png = await prepareImage(new File(["photo"], "photo.jpg", { type: "image/jpeg" }));
    expect(png.type).toBe("image/png");
    expect(canvas).toMatchObject({ width: workingWidth, height: workingHeight });
    // The whole bitmap is mapped to the canvas, without selecting a cropped source rectangle.
    expect(drawImage).toHaveBeenCalledExactlyOnceWith(bitmap, 0, 0, workingWidth, workingHeight);
    expect(bitmap.close).toHaveBeenCalledOnce();
  });
});
