import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMaskMotion, maskBoxes } from "@h3-motion/shared";
import { useInpaintStore } from "../useInpaintStore";
import { apiRequest, watchJob } from "../../../api";
import { renderInpaintVideos } from "../renderInpaint";
import { mediaKind } from "../../shell/MediaUpload";

vi.mock("../../../api", () => ({ apiRequest: vi.fn(), watchJob: vi.fn() }));
vi.mock("../renderInpaint", () => ({ renderInpaintVideos: vi.fn() }));
const source = new File(["video"], "source.mp4", { type: "video/mp4" });
const video = { id: "d8d80a5e-0d7d-4e20-984d-d4b3dd09d6ec", url: "/api/files/source", width: 1920, height: 1080, frames: 124, startTime: 0, duration: 124 / 24 };
const bounds = { x: 192, y: 216, width: 384, height: 324 };
const still = createMaskMotion(bounds, 124);
const moving = { ...still, keys: [...still.keys, { id: "end", frame: 123, x: 1344, y: 378, sx: 1, sy: 1 }] };
const state = () => useInpaintStore.getState();
const queued = { id: "43194a97-8a46-41bb-9b9e-5c82899b1d9a", status: "queued" as const, message: "Preparing…", candidates: [], progress: null, error: null };
const videos = { kind: "done" as const, source: new Blob(), mask: new Blob(), container: "mp4" as const };
const result = { videoId: video.id, video: { id: crypto.randomUUID(), url: "/api/files/result" }, width: 854, height: 480, frames: 124, seed: 7, prompt: "A bird flies." };

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
    useInpaintStore.setState({ bounds, motion: moving, prompt: "Old prompt", reference: new File(["ref"], "ref.png"), step: 2, result });
    vi.mocked(apiRequest).mockResolvedValue(video);
    expect(await state().upload(source)).toBe(true);
    expect(state()).toMatchObject({ video, source, frames: 124, bounds: null, motion: null, prompt: "", reference: null, step: 0, result: null });
  });
  it("draws the first mask before animating, then keys moves at the playhead", () => {
    useInpaintStore.setState({ video });
    state().visitStep(1); expect(state().step).toBe(0);
    state().drawMask(bounds);
    expect(state().motion?.keys).toEqual([{ id: "start", frame: 0, x: 384, y: 378 }]);
    state().visitStep(1);
    expect(state().beginMaskDrag()).toEqual({ x: 384, y: 378, sx: 1, sy: 1 });
    expect(state().playhead).toBe(123);
    state().placeMask({ x: 1344, y: 378 });
    state().placeMask({ x: 1400, y: 378 });
    expect(state().motion?.keys.map(key => [key.frame, key.x])).toEqual([[0, 384], [123, 1400]]);
    expect(state().selectedKeyId).toBe(state().motion?.keys[1].id);
    state().drawMask({ ...bounds, x: 0 });
    expect(state().bounds).toEqual(bounds);
    state().setPlayhead(0);
    expect(state().beginMaskDrag()).toBeNull();
    expect(state().notice).toMatch(/first frame keeps the mask you drew/);
    state().setPlayhead(999); expect(state().playhead).toBe(123);
  });
  it("keeps the rest of the animation on screen when redrawing the first mask", () => {
    useInpaintStore.setState({ video, bounds, motion: { ...moving, keys: [...moving.keys.slice(0, 1), { id: "mid", frame: 50, x: 900, y: 500, sx: 1.5, sy: 1 }, moving.keys[1]] }, step: 2, playhead: 123 });
    const before = maskBoxes(bounds, state().motion!, video);
    state().visitStep(0);
    expect(state().playhead).toBe(0);
    state().drawMask({ ...bounds, x: 480, width: 192 });
    const after = maskBoxes(state().bounds!, state().motion!, video);
    expect(after[0]).toEqual({ x: 0.25, y: 0.2, width: 0.1, height: 0.3 });
    for (const frame of [50, 123]) for (const side of ["x", "y", "width", "height"] as const) expect(after[frame][side]).toBeCloseTo(before[frame][side], 9);
  });
  it("records a drag on a still mask into a path, unless the user scrubbed first", () => {
    useInpaintStore.setState({ video, bounds, motion: still, step: 1 });
    state().setPlayhead(60);
    expect(state().startRecording()).toBeNull();
    state().setPlayhead(0);
    expect(state().startRecording()).toBe(0);
    state().finishRecording([{ time: 0, x: 384, y: 378 }, { time: 200, x: 800, y: 400 }, { time: 400, x: 1344, y: 378 }]);
    const keys = state().motion!.keys;
    expect(state().recording).toBe(false);
    expect(keys.length).toBeGreaterThan(1);
    expect(keys.at(-1)).toMatchObject({ frame: 123, x: 1344, y: 378 });
  });
  it("resizes, resets and deletes the selected key, but never the drawn mask", () => {
    useInpaintStore.setState({ video, bounds, motion: still, step: 1, playhead: 60 });
    state().placeMask({ x: 600, y: 400, sx: 2, sy: 1.5 });
    const id = state().selectedKeyId!;
    expect(state().motion!.keys[1]).toMatchObject({ id, frame: 60, sx: 2, sy: 1.5 });
    state().resetScale();
    expect(state().motion!.keys[1]).toMatchObject({ sx: 1, sy: 1 });
    state().selectKey("start"); state().deleteSelected();
    expect(state().motion!.keys).toHaveLength(2);
    state().selectKey(id); state().deleteSelected();
    expect(state().motion!.keys).toHaveLength(1);
  });
  it.each(["prompt", "reference", "shape", "mask", "addKey", "deleteKey"] as const)("preserves a finished download after a %s edit", edit => {
    useInpaintStore.setState({ video, bounds, motion: moving, step: 1, playhead: 50, result, view: "result", selectedKeyId: "end" });
    const store = state();
    if (edit === "prompt") store.setPrompt("A different prompt");
    else if (edit === "reference") store.setReference(new File(["ref"], "ref.png"));
    else if (edit === "shape") store.setShape("ellipse");
    else if (edit === "mask") store.placeMask({ x: 700, y: 400 });
    else if (edit === "addKey") store.addKey();
    else store.deleteSelected();
    expect(state()).toMatchObject({ result, view: "preview" });
  });
  it.each([{ motion: still }, { motion: moving }])("generates a mask with $motion.keys.length keys and uploads the optional reference", async ({ motion }) => {
    const reference = new File(["ref"], "ref.png", { type: "image/png" });
    useInpaintStore.setState({ source, video, bounds, motion, shape: "ellipse", prompt: "A bird from <Picture 1> flies.", reference, step: 2 });
    vi.mocked(renderInpaintVideos).mockResolvedValue(videos);
    vi.mocked(apiRequest).mockResolvedValue(queued);
    vi.mocked(watchJob).mockResolvedValue({ ...queued, status: "completed", inpainting: result });
    await state().generate();
    expect(renderInpaintVideos).toHaveBeenCalledWith(expect.objectContaining({ source, shape: "ellipse", boxes: maskBoxes(bounds, motion, video), size: { width: 854, height: 480 } }), expect.any(Function), expect.any(AbortSignal));
    const boxes = vi.mocked(renderInpaintVideos).mock.calls[0][0].boxes!;
    expect(boxes).toHaveLength(124);
    expect(boxes[0]).toEqual({ x: 0.1, y: 0.2, width: 0.2, height: 0.3 });
    const form = vi.mocked(apiRequest).mock.calls[0][1]!.body as FormData;
    expect(JSON.parse(form.get("request") as string)).toEqual({ videoId: video.id, width: 854, height: 480, frames: 124, prompt: "A bird from <Picture 1> flies." });
    expect(form.get("reference")).toBe(reference);
    expect(state()).toMatchObject({ status: "idle", view: "result", result });
  });
  it("only picks an object to follow for a still mask, starting from the first frame", () => {
    useInpaintStore.setState({ video, bounds, motion: moving, step: 1, playhead: 50 });
    state().startPicking();
    expect(state().picking).toBe(false);
    useInpaintStore.setState({ motion: still });
    state().startPicking();
    expect(state()).toMatchObject({ picking: true, playhead: 0 });
    // The click has to land on the first frame, so the playhead can't leave it while picking.
    state().setPlayhead(40); state().scrub(60); state().togglePlay();
    expect(state()).toMatchObject({ picking: true, playhead: 0, playing: false });
    state().visitStep(2);
    expect(state().picking).toBe(false);
  });
  it("tracks the clicked object on the prepared frames and keys the mask to follow it", async () => {
    useInpaintStore.setState({ source, video, bounds, motion: still, step: 1, picking: true });
    vi.mocked(renderInpaintVideos).mockResolvedValue({ ...videos, mask: null });
    // On the 854 × 480 prepared frames, the object starts under the mask and drifts right 2 px a frame.
    const frames = Array.from({ length: 124 }, (_, i) => ({ area: 1600, x: 170 + 2 * i, y: 200, bounds: { x: 150 + 2 * i, y: 180, width: 40, height: 40 } }));
    const tracking = { videoId: video.id, width: 854, height: 480, frames };
    vi.mocked(apiRequest).mockResolvedValue(queued);
    vi.mocked(watchJob).mockResolvedValue({ ...queued, status: "completed", tracking });
    await state().followObject({ x: 960, y: 540 });
    expect(renderInpaintVideos).toHaveBeenCalledWith(expect.objectContaining({ source, boxes: null, size: { width: 854, height: 480 } }), expect.any(Function), expect.any(AbortSignal));
    const [path, init] = vi.mocked(apiRequest).mock.calls[0];
    expect(path).toBe("/jobs/track");
    expect(JSON.parse((init!.body as FormData).get("request") as string)).toEqual({ videoId: video.id, width: 854, height: 480, frames: 124, positive: [{ x: 427, y: 240 }] });
    const keys = state().motion!.keys;
    expect(keys[0]).toEqual(still.keys[0]);
    // 2 px a frame on the prepared frames is 2 × 1920 / 854 video pixels a frame.
    expect(keys.at(-1)).toMatchObject({ frame: 123, x: expect.closeTo(384 + 246 * 1920 / 854, 0), y: expect.closeTo(378, 6), sx: expect.closeTo(1, 6) });
    expect(state()).toMatchObject({ status: "idle", task: null, picking: false, track: tracking, notice: expect.stringMatching(/now follows the object/) });
    state().clearPath();
    expect(state().track).toBeNull();
  });
  it("only follows an object clicked while picking", async () => {
    useInpaintStore.setState({ source, video, bounds, motion: still, step: 1, playhead: 30 });
    await state().followObject({ x: 960, y: 540 });
    expect(renderInpaintVideos).not.toHaveBeenCalled();
    expect(state()).toMatchObject({ status: "idle", task: null, motion: still });
  });
  it("reports a track that misses the first frame and keeps the still mask", async () => {
    useInpaintStore.setState({ source, video, bounds, motion: still, step: 1, picking: true });
    vi.mocked(renderInpaintVideos).mockResolvedValue({ ...videos, mask: null });
    vi.mocked(apiRequest).mockResolvedValue(queued);
    vi.mocked(watchJob).mockResolvedValue({ ...queued, status: "completed", tracking: { videoId: video.id, width: 854, height: 480, frames: Array(124).fill(null) } });
    await state().followObject({ x: 10, y: 10 });
    expect(state()).toMatchObject({ motion: still, track: null, error: "SAM couldn't find the object on the first frame. Click on it again." });
  });
  it("keeps the last result when replacement generation fails", async () => {
    useInpaintStore.setState({ source, video, bounds, motion: still, prompt: "A bird flies.", step: 2, result });
    vi.mocked(renderInpaintVideos).mockRejectedValue(new Error("Encoding failed"));
    await useInpaintStore.getState().generate();
    expect(useInpaintStore.getState()).toMatchObject({ status: "idle", result, error: "Encoding failed" });
  });
  it("cancels preparation before an upload starts", async () => {
    useInpaintStore.setState({ source, video, bounds, motion: moving, prompt: "A bird flies.", step: 2 });
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
    useInpaintStore.setState({ source, video, bounds, motion: moving, prompt: "A bird flies.", step: 2 });
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
    useInpaintStore.setState({ source, video, bounds, motion: still, prompt: "A bird flies.", step: 2, result });
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
