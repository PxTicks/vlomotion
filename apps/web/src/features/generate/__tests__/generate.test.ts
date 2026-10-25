import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CAPTION, createMotion, upsertKey } from "@h3-motion/shared";
import type { IsolationResult, JobSnapshot } from "@h3-motion/shared";
import { apiRequest, watchJob } from "../../../api";
import { useSelectionStore } from "../../select";
import { layersKeyOf, subjectKeyOf, useMotionStore } from "../../motion";
import type { SubjectLayers } from "../../motion";
import { currentParts, resolveInputs } from "../inputs";
import { useGenerateStore } from "../useGenerateStore";
import { renderMotionVideos } from "../renderMotion";
import type { MotionVideos } from "../renderMotion";

vi.mock("../../../api", () => ({ apiRequest: vi.fn(), submitSegment: vi.fn(), uploadImage: vi.fn(), watchJob: vi.fn() }));
vi.mock("../renderMotion", () => ({ renderMotionVideos: vi.fn() }));
const image = { id: "f4c8a75f-2c99-4d89-b30e-fe18d97ede92", url: "/api/files/photo", width: 1728, height: 960 };
const mask = { ...image, id: "0b8e1c55-0a51-4a3e-9d0e-6f3f4a1b2c3d", url: "/api/files/mask" };
const isolation: IsolationResult = { imageId: image.id, maskId: mask.id, plate: { ...image, id: "1b8e1c55-0a51-4a3e-9d0e-6f3f4a1b2c3d", url: "/api/files/plate" },
  phrase: "the red ball", caption: { ...DEFAULT_CAPTION, subject: "the red ball", motion_verb: "rolls" }, instruction: "Remove it.",
  descriptionSource: "model", instructionSource: "model", seed: 1 };
const layers = { width: 1728, height: 960 } as unknown as SubjectLayers;
const settings = { tier: 480 as const, lockIn: 6, prompt: null };
const videos: MotionVideos = { reference: new Blob(), mask: new Blob(), start: new Blob(), container: "mp4" };
const queued: JobSnapshot = { id: "73ec450b-4181-46f9-aa8b-fb07ff5e3b38", status: "queued", progress: null,
  message: "Preparing video generation…", candidates: [], error: null };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
  useGenerateStore.setState(useGenerateStore.getInitialState(), true);
  useMotionStore.setState(useMotionStore.getInitialState(), true);
  useSelectionStore.setState({ image, mask, isolation, aspectRatio: "16:9", phase: 3 });
  const motion = upsertKey(createMotion({ x: 400, y: 500 }), 123, { x: 1400, y: 500 }, "end")!.motion;
  useMotionStore.setState({ motion, subjectKey: subjectKeyOf(image.id, mask.id), bounds: { x: 300, y: 400, width: 200, height: 200 },
    layers, layersKey: layersKeyOf(image.url, mask.url, isolation.plate.url) });
});

describe("generation inputs", () => {
  it("builds the size and prompt from the current subject, caption and path", () => {
    const inputs = resolveInputs(currentParts(settings))!;
    expect(inputs.size).toEqual({ width: 864, height: 480 });
    expect(inputs.prompt).toContain("the red ball in <Picture 1> rolls to the right across the frame");
    expect(resolveInputs(currentParts({ ...settings, tier: 720 }))!.size).toEqual({ width: 1248, height: 704 });
  });
  it("changes its signature with anything that changes the video, and treats a blank prompt as automatic", () => {
    const base = resolveInputs(currentParts(settings))!;
    expect(resolveInputs(currentParts({ ...settings, lockIn: 9 }))!.signature).not.toBe(base.signature);
    expect(resolveInputs(currentParts({ ...settings, prompt: "A ball rolls." }))!.promptFields.mainPrompt).toBe("A ball rolls.");
    expect(resolveInputs(currentParts({ ...settings, prompt: "   " }))!.signature).toBe(base.signature);
  });
  it("keeps main, sound effects and music edits independent and includes all three in the request", () => {
    const base = resolveInputs(currentParts(settings))!;
    const changed = resolveInputs(currentParts({ ...settings, prompt: "A ball rolls.", soundEffects: "Soft rolling sounds.", music: "Gentle piano." }))!;
    expect(changed.promptFields).toEqual({ mainPrompt: "A ball rolls.", soundEffects: "Soft rolling sounds.", music: "Gentle piano." });
    expect(changed.prompt).toContain("integrated_multimodal_description: [Shot 1] A ball rolls.");
    expect(changed.prompt).toContain("overall_soundscape: Soft rolling sounds.");
    expect(changed.prompt).toContain("non_diegetic_music: Gentle piano.");
    expect(changed.signature).not.toBe(base.signature);
    expect(resolveInputs(currentParts({ ...settings, soundEffects: "Soft rolling sounds." }))!.signature).not.toBe(base.signature);
    expect(resolveInputs(currentParts({ ...settings, music: "Gentle piano." }))!.signature).not.toBe(base.signature);
  });
  it("uses the existing automatic soundscape by default and allows optional audio fields to be cleared", () => {
    const base = resolveInputs(currentParts(settings))!;
    expect(base.promptFields.soundEffects).toBe(DEFAULT_CAPTION.soundscape);
    expect(base.promptFields.music).toBe("");
    const silent = resolveInputs(currentParts({ ...settings, soundEffects: "", music: "" }))!;
    expect(silent.promptFields.mainPrompt).toBe(base.promptFields.mainPrompt);
    expect(silent.prompt).toContain("overall_soundscape: N/A");
    expect(silent.prompt).toContain("non_diegetic_music: N/A");
  });
  it("waits for layers that belong to the current background", () => {
    useMotionStore.setState({ layersKey: "stale" });
    expect(resolveInputs(currentParts(settings))).toBeNull();
  });
  it("includes every subject's motion and layer order, independent of which subject is active", () => {
    const firstLayers = { ...layers, bounds: { x: 300, y: 400, width: 200, height: 200 } };
    const secondLayers = { ...layers, bounds: { x: 900, y: 400, width: 200, height: 200 } };
    const store = useMotionStore.getState();
    store.prepareSubjects(subjectKeyOf(image.id, mask.id), layersKeyOf(image.url, mask.url, isolation.plate.url), "scene", layers,
      [{ id: "first", name: "Red ball", layers: firstLayers }, { id: "second", name: "Blue ball", layers: secondLayers }]);
    store.setPlayhead(123);
    store.placeSubject({ x: 800, y: 500 });
    const initial = resolveInputs(currentParts(settings))!;
    expect(initial.layers.subjects).toHaveLength(2);
    expect(initial.autoPrompt).toContain("Red ball moves");
    expect(initial.autoPrompt).toContain("Blue ball stays still");
    store.selectSubject("second");
    expect(resolveInputs(currentParts(settings))!.signature).toBe(initial.signature);
    store.placeSubject({ x: 100, y: 500 });
    const changed = resolveInputs(currentParts(settings))!;
    expect(changed.signature).not.toBe(initial.signature);
    expect(changed.layers.subjects![1].motion).toBe(useMotionStore.getState().subjects[1].motion);
    store.reorderSubject("second", -1);
    const reordered = resolveInputs(currentParts(settings))!;
    expect(reordered.signature).not.toBe(changed.signature);
    expect(reordered.subjects.map(subject => subject.id)).toEqual(["second", "first"]);
    expect(reordered.layers.subjects![0].layers).toBe(secondLayers);
  });
});

describe("generate guards", () => {
  it("uploads the composed main prompt and optional audio instructions", async () => {
    const store = useGenerateStore.getState();
    store.setPrompt("A red ball rolls past the camera.");
    store.setSoundEffects("Soft rolling sounds.");
    store.setMusic("Quiet piano music.");
    vi.mocked(renderMotionVideos).mockResolvedValue(videos);
    vi.mocked(apiRequest).mockResolvedValue(queued);
    vi.mocked(watchJob).mockResolvedValue({ ...queued, status: "cancelled" });
    await store.generate();
    const form = vi.mocked(apiRequest).mock.calls[0][1]!.body as FormData;
    const request = JSON.parse(form.get("request") as string);
    expect(request.prompt).toContain("integrated_multimodal_description: [Shot 1] A red ball rolls past the camera.");
    expect(request.prompt).toContain("overall_soundscape: Soft rolling sounds.");
    expect(request.prompt).toContain("non_diegetic_music: Quiet piano music.");
  });
  it("defaults lock-in to 6 and snaps changes to the five control points", () => {
    expect(useGenerateStore.getState().lockIn).toBe(6);
    for (const [input, expected] of [[0, 3], [3, 3], [5, 6], [8, 9], [12, 12], [17, 15]]) {
      useGenerateStore.getState().setLockIn(input);
      expect(useGenerateStore.getState().lockIn).toBe(expected);
    }
  });
  it("refuses a path without movement and an invalid seed before rendering", async () => {
    useMotionStore.setState({ motion: createMotion({ x: 400, y: 500 }) });
    await useGenerateStore.getState().generate();
    expect(useGenerateStore.getState().error).toMatch(/doesn't move yet/);
    useMotionStore.setState({ motion: upsertKey(createMotion({ x: 400, y: 500 }), 60, { x: 900, y: 500 }, "end")!.motion });
    useGenerateStore.setState({ error: null, seed: "-4" });
    await useGenerateStore.getState().generate();
    expect(useGenerateStore.getState()).toMatchObject({ status: "idle", error: expect.stringMatching(/seed must be a whole number/) });
    expect(renderMotionVideos).not.toHaveBeenCalled();
  });
  it("returns to idle with a notice when rendering is cancelled", async () => {
    vi.mocked(renderMotionVideos).mockImplementation((_layers, _motion, _size, _progress, signal) =>
      new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")))));
    const running = useGenerateStore.getState().generate();
    expect(useGenerateStore.getState().status).toBe("rendering");
    await useGenerateStore.getState().cancel();
    await running;
    expect(useGenerateStore.getState()).toMatchObject({ status: "idle", error: null, notice: expect.stringMatching(/cancelled/) });
  });
  it("does not upload when cancellation arrives just as rendering finishes", async () => {
    const rendered = deferred<MotionVideos>();
    vi.mocked(renderMotionVideos).mockReturnValue(rendered.promise);
    const running = useGenerateStore.getState().generate();
    await useGenerateStore.getState().cancel();
    rendered.resolve(videos);
    await running;
    expect(apiRequest).not.toHaveBeenCalled();
    expect(useGenerateStore.getState()).toMatchObject({ status: "idle", notice: expect.stringMatching(/cancelled/) });
  });
  it("retains an upload's job handle, cancels it and waits for confirmation", async () => {
    const submitted = deferred<unknown>(), finished = deferred<JobSnapshot>();
    vi.mocked(renderMotionVideos).mockResolvedValue(videos);
    vi.mocked(apiRequest).mockReturnValueOnce(submitted.promise).mockResolvedValue({});
    vi.mocked(watchJob).mockReturnValue(finished.promise);
    const previous = { imageId: image.id, maskId: mask.id, plateId: isolation.plate.id,
      video: { id: "last-video", url: "/api/files/last-video" }, width: 864, height: 480, frames: 124 as const,
      prompt: "A ball rolls.", lockIn: 3, seed: 1, signature: "previous" };
    useGenerateStore.setState({ result: previous, view: "result" });
    const running = useGenerateStore.getState().generate();
    await vi.waitFor(() => expect(useGenerateStore.getState().status).toBe("uploading"));
    expect(vi.mocked(apiRequest).mock.calls[0][1]?.signal).toBeUndefined();
    await useGenerateStore.getState().cancel();
    expect(useGenerateStore.getState().status).toBe("uploading");
    expect(watchJob).not.toHaveBeenCalled();
    submitted.resolve(queued);
    await vi.waitFor(() => expect(watchJob).toHaveBeenCalled());
    expect(apiRequest).toHaveBeenCalledWith(`/jobs/${queued.id}/cancel`, { method: "POST" });
    expect(useGenerateStore.getState()).toMatchObject({ status: "generating", result: previous, notice: null });
    finished.resolve({ ...queued, status: "cancelled" });
    await running;
    expect(useGenerateStore.getState()).toMatchObject({ status: "idle", result: previous, view: "result", notice: expect.stringMatching(/cancelled/) });
  });
  it("keeps an accepted job tracked and cancellable if the cancellation request fails", async () => {
    const submitted = deferred<unknown>(), finished = deferred<JobSnapshot>();
    vi.mocked(renderMotionVideos).mockResolvedValue(videos);
    vi.mocked(apiRequest).mockReturnValueOnce(submitted.promise).mockRejectedValueOnce(new Error("Connection lost"));
    vi.mocked(watchJob).mockReturnValue(finished.promise);
    const running = useGenerateStore.getState().generate();
    await vi.waitFor(() => expect(useGenerateStore.getState().status).toBe("uploading"));
    await useGenerateStore.getState().cancel();
    submitted.resolve(queued);
    await vi.waitFor(() => expect(watchJob).toHaveBeenCalled());
    expect(useGenerateStore.getState()).toMatchObject({ status: "generating", job: queued, error: "Connection lost", notice: null });
    vi.mocked(apiRequest).mockResolvedValue({});
    await useGenerateStore.getState().cancel();
    expect(apiRequest).toHaveBeenLastCalledWith(`/jobs/${queued.id}/cancel`, { method: "POST" });
    finished.resolve({ ...queued, status: "cancelled" });
    await running;
    expect(useGenerateStore.getState().status).toBe("idle");
  });
  it("reports upload failures even when cancellation was requested", async () => {
    const submitted = deferred<unknown>();
    vi.mocked(renderMotionVideos).mockResolvedValue(videos);
    vi.mocked(apiRequest).mockReturnValue(submitted.promise);
    const running = useGenerateStore.getState().generate();
    await vi.waitFor(() => expect(useGenerateStore.getState().status).toBe("uploading"));
    await useGenerateStore.getState().cancel();
    submitted.reject(new Error("Upload failed"));
    await running;
    expect(useGenerateStore.getState()).toMatchObject({ status: "idle", error: "Upload failed", notice: null });
  });
});
