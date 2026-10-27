import { beforeEach, describe, expect, it, vi } from "vitest";
import { useInpaintStore } from "../useInpaintStore";
import { apiRequest, watchJob } from "../../../api";
import { renderInpaintVideos } from "../renderInpaint";
import { mediaKind } from "../../shell/MediaUpload";

vi.mock("../../../api", () => ({ apiRequest: vi.fn(), watchJob: vi.fn() }));
vi.mock("../renderInpaint", () => ({ renderInpaintVideos: vi.fn() }));
const source = new File(["video"], "source.mp4", { type: "video/mp4" });
const video = { id: "d8d80a5e-0d7d-4e20-984d-d4b3dd09d6ec", url: "/api/files/source", width: 1920, height: 1080, frames: 124, startTime: 0, duration: 124 / 24 };
const first = { frame: 0, x: 0.1, y: 0.2, width: 0.2, height: 0.3 };
const end = { ...first, frame: 123, x: 0.6 };
const queued = { id: "43194a97-8a46-41bb-9b9e-5c82899b1d9a", status: "queued" as const, message: "Preparing…", candidates: [], progress: null, error: null };
const videos = { kind: "done" as const, source: new Blob(), mask: new Blob(), container: "mp4" as const };
const result = { videoId: video.id, video: { id: crypto.randomUUID(), url: "/api/files/result" }, width: 864, height: 480, frames: 124, seed: 7, prompt: "A bird flies." };

beforeEach(() => {
  vi.resetAllMocks();
  useInpaintStore.setState(useInpaintStore.getInitialState(), true);
});
describe("inpainting editor", () => {
  it("routes supported media by type", () => {
    expect(mediaKind(source)).toBe("video");
    expect(mediaKind({ name: "CLIP.MP4", type: "" })).toBe("video");
    expect(mediaKind({ name: "photo.png", type: "image/png" })).toBe("image");
    expect(mediaKind({ name: "notes.txt", type: "text/plain" })).toBeNull();
  });
  it("clears prior mask animation, prompt and reference on a new source", async () => {
    useInpaintStore.setState({ keys: [first, end], prompt: "Old prompt", reference: new File(["ref"], "ref.png"), step: 2, result });
    vi.mocked(apiRequest).mockResolvedValue(video);
    expect(await useInpaintStore.getState().upload(source)).toBe(true);
    expect(useInpaintStore.getState()).toMatchObject({ video, source, frames: 124, keys: [], prompt: "", reference: null, step: 0, result: null });
  });
  it("upserts keys at the playhead, protects the initial key and guards navigation", () => {
    useInpaintStore.setState({ video });
    const store = useInpaintStore.getState();
    store.visitStep(1); expect(useInpaintStore.getState().step).toBe(0);
    store.visitStep(2); expect(useInpaintStore.getState().step).toBe(0);
    store.setMask(first); store.visitStep(1);
    store.visitStep(2); expect(useInpaintStore.getState().step).toBe(2);
    store.visitStep(1);
    store.setPlayhead(123); store.setMask(end);
    store.setMask({ ...end, x: 0.7 });
    expect(useInpaintStore.getState().keys).toHaveLength(2);
    expect(useInpaintStore.getState().keys[1].x).toBe(0.7);
    store.deleteKey(0); expect(useInpaintStore.getState().keys).toHaveLength(2);
    store.visitStep(2); expect(useInpaintStore.getState().step).toBe(2);
    store.setPlayhead(999); expect(useInpaintStore.getState().playhead).toBe(123);
  });
  it("preserves the rest of the animation when redrawing the initial mask", () => {
    const middle = { ...first, frame: 50, x: 0.3 };
    useInpaintStore.setState({ video, keys: [first, middle, end], step: 2, playhead: 123 });
    const store = useInpaintStore.getState();
    store.visitStep(0);
    store.setMask({ ...first, x: 0.25 });
    expect(useInpaintStore.getState().keys).toEqual([{ ...first, x: 0.25 }, middle, end]);
  });
  it.each(["prompt", "reference", "shape", "mask", "addKey", "deleteKey"] as const)("preserves a finished download after a %s edit", edit => {
    useInpaintStore.setState({ video, keys: [first, end], step: 1, playhead: 50, result, view: "result" });
    const store = useInpaintStore.getState();
    if (edit === "prompt") store.setPrompt("A different prompt");
    else if (edit === "reference") store.setReference(new File(["ref"], "ref.png"));
    else if (edit === "shape") store.setShape("ellipse");
    else if (edit === "mask") store.setMask({ ...first, x: 0.3 });
    else if (edit === "addKey") store.addKey();
    else store.deleteKey(123);
    expect(useInpaintStore.getState()).toMatchObject({ result, view: "preview" });
  });
  it.each([{ keys: [first] }, { keys: [first, end] }])("generates with $keys.length keyframes and uploads the optional reference", async ({ keys }) => {
    const reference = new File(["ref"], "ref.png", { type: "image/png" });
    useInpaintStore.setState({ source, video, keys, shape: "ellipse", prompt: "A bird from <Picture 1> flies.", reference, step: 2 });
    vi.mocked(renderInpaintVideos).mockResolvedValue(videos);
    vi.mocked(apiRequest).mockResolvedValue(queued);
    vi.mocked(watchJob).mockResolvedValue({ ...queued, status: "completed", inpainting: result });
    await useInpaintStore.getState().generate();
    expect(renderInpaintVideos).toHaveBeenCalledWith(expect.objectContaining({ source, shape: "ellipse", keys, size: { width: 864, height: 480 } }), expect.any(Function), expect.any(AbortSignal));
    const form = vi.mocked(apiRequest).mock.calls[0][1]!.body as FormData;
    expect(JSON.parse(form.get("request") as string)).toEqual({ videoId: video.id, width: 864, height: 480, frames: 124, prompt: "A bird from <Picture 1> flies." });
    expect(form.get("reference")).toBe(reference);
    expect(useInpaintStore.getState()).toMatchObject({ status: "idle", view: "result", result });
  });
  it("keeps the last result when replacement generation fails", async () => {
    useInpaintStore.setState({ source, video, keys: [first], prompt: "A bird flies.", step: 2, result });
    vi.mocked(renderInpaintVideos).mockRejectedValue(new Error("Encoding failed"));
    await useInpaintStore.getState().generate();
    expect(useInpaintStore.getState()).toMatchObject({ status: "idle", result, error: "Encoding failed" });
  });
  it("cancels preparation before an upload starts", async () => {
    useInpaintStore.setState({ source, video, keys: [first, end], prompt: "A bird flies.", step: 2 });
    vi.mocked(renderInpaintVideos).mockImplementation((_request, _progress, signal) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")));
    }));
    const running = useInpaintStore.getState().generate();
    await useInpaintStore.getState().cancel();
    await running;
    expect(apiRequest).not.toHaveBeenCalled();
    expect(useInpaintStore.getState()).toMatchObject({ status: "idle", error: null, notice: "Inpainting cancelled." });
  });
  it("tracks and cancels a job accepted while upload cancellation is pending", async () => {
    useInpaintStore.setState({ source, video, keys: [first, end], prompt: "A bird flies.", step: 2 });
    vi.mocked(renderInpaintVideos).mockResolvedValue(videos);
    let submitted!: (value: unknown) => void;
    vi.mocked(apiRequest).mockReturnValueOnce(new Promise(resolve => { submitted = resolve; })).mockResolvedValue({});
    vi.mocked(watchJob).mockResolvedValue({ ...queued, status: "cancelled" });
    const running = useInpaintStore.getState().generate();
    await vi.waitFor(() => expect(useInpaintStore.getState().status).toBe("uploading"));
    await useInpaintStore.getState().cancel();
    submitted(queued);
    await running;
    expect(apiRequest).toHaveBeenCalledWith(`/jobs/${queued.id}/cancel`, { method: "POST" });
    expect(useInpaintStore.getState()).toMatchObject({ status: "idle", notice: "Inpainting cancelled." });
  });
  it.each([new DOMException("Cancelled", "AbortError"), new TypeError("fetch failed")])("aborts an upload and reports cancellation when it rejects with $name", async error => {
    useInpaintStore.setState({ source, video, keys: [first], prompt: "A bird flies.", step: 2, result });
    vi.mocked(renderInpaintVideos).mockResolvedValue(videos);
    vi.mocked(apiRequest).mockImplementation((_path, init) => new Promise((_, reject) => {
      init!.signal!.addEventListener("abort", () => reject(error), { once: true });
    }));
    const running = useInpaintStore.getState().generate();
    await vi.waitFor(() => expect(useInpaintStore.getState().status).toBe("uploading"));
    const signal = vi.mocked(apiRequest).mock.calls[0][1]!.signal!;
    await useInpaintStore.getState().cancel();
    await running;
    expect(signal.aborted).toBe(true);
    expect(watchJob).not.toHaveBeenCalled();
    expect(useInpaintStore.getState()).toMatchObject({ status: "idle", error: null, notice: "Inpainting cancelled.", result });
  });
});
