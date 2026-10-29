import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMaskMotion, maskBoxes } from "@h3-motion/shared";
import type { SubjectMotion } from "@h3-motion/shared";
import { MAX_MASKS, useInpaintStore } from "../useInpaintStore";
import type { InpaintMask } from "../useInpaintStore";
import { apiRequest, watchJob } from "../../../api";
import { renderInpaintVideos } from "../renderInpaint";
import { captureFrame, readFrame } from "../captureFrame";
import { useFollowSelection } from "../useFollowSelection";
import { mediaKind } from "../../shell/MediaUpload";

vi.mock("../../../api", () => ({ apiRequest: vi.fn(), watchJob: vi.fn() }));
vi.mock("../renderInpaint", () => ({ renderInpaintVideos: vi.fn() }));
vi.mock("../captureFrame", async original => ({ ...await original<typeof import("../captureFrame")>(), captureFrame: vi.fn(), readFrame: vi.fn() }));
const source = new File(["video"], "source.mp4", { type: "video/mp4" });
const video = { id: "d8d80a5e-0d7d-4e20-984d-d4b3dd09d6ec", url: "/api/files/source", width: 1920, height: 1080, frames: 124, startTime: 0, duration: 124 / 24, audio: false };
const bounds = { x: 192, y: 216, width: 384, height: 324 };
const still = createMaskMotion(bounds, 124);
const moving = { ...still, keys: [...still.keys, { id: "end", frame: 123, x: 1344, y: 378, sx: 1, sy: 1 }] };
const state = () => useInpaintStore.getState();
const mask = (motion: SubjectMotion<number>, patch: Partial<InpaintMask> = {}): InpaintMask =>
  ({ id: "mask-1", color: "#f2ff59", shape: "rectangle", bounds, motion, track: null, followIds: [], ...patch });
/** The store holding `masks`, with the first active. */
const withMasks = (...masks: InpaintMask[]) => ({ masks, activeMaskId: masks[0].id, bounds: masks[0].bounds, motion: masks[0].motion, shape: masks[0].shape, track: masks[0].track });
const queued = { id: "43194a97-8a46-41bb-9b9e-5c82899b1d9a", status: "queued" as const, message: "Preparing…", candidates: [], progress: null, error: null };
const videos = { kind: "done" as const, source: new Blob(), mask: new Blob(), container: "mp4" as const };
const result = { videoId: video.id, video: { id: crypto.randomUUID(), url: "/api/files/result" }, width: 854, height: 480, frames: 124, seed: 7, prompt: "A bird flies.", feather: 16, audio: "replace" as const };

const frame = { id: "6f1c2a4e-3b7d-4f0a-9c1e-2d5b8a7e4f10", url: "/api/files/frame", width: 854, height: 480 };
const subject = { id: "0b5e9c7a-1d2f-4e3a-8b6c-5a4d3e2f1c0b", url: "/api/files/subject", bounds: { x: 150, y: 180, width: 40, height: 40 } };
const follow = () => useFollowSelection.getState();
/** The first frame is uploaded, with `subject` found and ticked on it. */
function selectSubject() {
  follow().setImage(frame);
  useFollowSelection.setState({ candidates: [subject], selectedIds: [subject.id], selectionView: "subjects" });
}

beforeEach(() => {
  vi.resetAllMocks();
  useInpaintStore.setState(useInpaintStore.getInitialState(), true);
  useFollowSelection.setState(useFollowSelection.getInitialState(), true);
});
describe("inpainting editor", () => {
  it("routes supported media by type", () => {
    expect(mediaKind(source)).toBe("video");
    expect(mediaKind({ name: "CLIP.MP4", type: "" })).toBe("video");
    expect(mediaKind({ name: "photo.png", type: "image/png" })).toBe("image");
    expect(mediaKind({ name: "notes.txt", type: "text/plain" })).toBeNull();
  });
  it("clears prior mask animation, prompt and reference on a new source", async () => {
    selectSubject();
    useInpaintStore.setState({ ...withMasks(mask(moving)), prompt: "Old prompt", soundEffects: "Old sounds", music: "Old music", tier: 480, reference: new File(["ref"], "ref.png"), step: 2, result });
    vi.mocked(apiRequest).mockResolvedValue(video);
    expect(await state().upload(source)).toBe(true);
    expect(state()).toMatchObject({ video, source, frames: 124, bounds: null, motion: null, prompt: "", soundEffects: "", music: "", tier: 480, reference: null, step: 0, result: null });
    expect(follow()).toMatchObject({ image: null, candidates: [] });
  });
  it("draws the first mask before animating, then keys moves at the playhead", () => {
    useInpaintStore.setState({ video });
    state().visitStep(1); expect(state().step).toBe(0);
    state().addMask(bounds);
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
    useInpaintStore.setState({ video, ...withMasks(mask({ ...moving, keys: [...moving.keys.slice(0, 1), { id: "mid", frame: 50, x: 900, y: 500, sx: 1.5, sy: 1 }, moving.keys[1]] })), step: 2, playhead: 123 });
    const before = maskBoxes(bounds, state().motion!, video);
    state().visitStep(0);
    expect(state().playhead).toBe(0);
    state().drawMask({ ...bounds, x: 480, width: 192 });
    const after = maskBoxes(state().bounds!, state().motion!, video);
    expect(after[0]).toEqual({ x: 0.25, y: 0.2, width: 0.1, height: 0.3 });
    for (const frame of [50, 123]) for (const side of ["x", "y", "width", "height"] as const) expect(after[frame][side]).toBeCloseTo(before[frame][side], 9);
  });
  it("adds masks on the first frame, each with its own colour and shape, and edits the active one", () => {
    useInpaintStore.setState({ video });
    state().addMask(bounds);
    state().setShape("ellipse");
    state().addMask({ x: 960, y: 540, width: 192, height: 108 });
    const [first, second] = state().masks;
    expect(first).toMatchObject({ shape: "ellipse", bounds, color: "#f2ff59" });
    expect(second).toMatchObject({ shape: "ellipse", bounds: { x: 960, y: 540, width: 192, height: 108 }, color: "#65d9ff" });
    expect(state()).toMatchObject({ activeMaskId: second.id, bounds: second.bounds, motion: second.motion });
    state().setShape("rectangle");
    expect(state().masks.map(mask => mask.shape)).toEqual(["ellipse", "rectangle"]);
    state().selectMask(first.id);
    expect(state()).toMatchObject({ activeMaskId: first.id, shape: "ellipse", bounds });
    state().drawMask({ ...bounds, x: 0 });
    expect(state().masks.map(mask => mask.bounds.x)).toEqual([0, 960]);
  });
  it(`stops adding masks at ${MAX_MASKS}`, () => {
    useInpaintStore.setState({ video });
    for (let i = 0; i <= MAX_MASKS; i++) state().addMask({ x: i * 200, y: 0, width: 100, height: 100 });
    expect(state().masks).toHaveLength(MAX_MASKS);
    expect(new Set(state().masks.map(mask => mask.color)).size).toBe(MAX_MASKS);
    expect(state().notice).toMatch(/up to 8 masks/);
  });
  it("removes masks, making the one drawn before active, and returns to drawing without any", () => {
    useInpaintStore.setState({ video, ...withMasks(mask(still), mask(moving, { id: "mask-2" }), mask(still, { id: "mask-3" })), step: 1 });
    state().selectMask("mask-3");
    state().removeMask("mask-3");
    expect(state()).toMatchObject({ activeMaskId: "mask-2", motion: moving, step: 1 });
    state().removeMask("mask-1");
    expect(state()).toMatchObject({ activeMaskId: "mask-2", step: 1 });
    useInpaintStore.setState({ recording: true });
    state().removeMask("mask-2");
    expect(state().masks).toHaveLength(1);
    useInpaintStore.setState({ recording: false, playhead: 50 });
    state().removeMask("mask-2");
    expect(state()).toMatchObject({ masks: [], activeMaskId: null, bounds: null, motion: null, step: 0, playhead: 0 });
    state().visitStep(1);
    expect(state().step).toBe(0);
  });
  it("animates the selected mask without moving the others", () => {
    const other = { x: 960, y: 540, width: 192, height: 108 };
    useInpaintStore.setState({ video, ...withMasks(mask(still), mask(createMaskMotion(other, 124), { id: "mask-2", bounds: other })), step: 1, playhead: 60, selectedKeyId: "start" });
    state().selectMask("mask-2");
    expect(state()).toMatchObject({ activeMaskId: "mask-2", selectedKeyId: null });
    state().placeMask({ x: 1200, y: 600 });
    const [first, second] = state().masks;
    expect(first.motion).toBe(still);
    expect(second.motion.keys.map(key => [key.frame, key.x])).toEqual([[0, 1056], [60, 1200]]);
    expect(state().motion).toBe(second.motion);
    useInpaintStore.setState({ recording: true });
    state().selectMask("mask-1");
    expect(state().activeMaskId).toBe("mask-2");
  });
  it("generates one mask video from every mask", async () => {
    const other = { x: 960, y: 540, width: 192, height: 108 };
    useInpaintStore.setState({ source, video, ...withMasks(mask(moving), mask(still, { id: "mask-2", shape: "ellipse", bounds: other, motion: createMaskMotion(other, 124) })),
      prompt: "Two birds fly.", step: 2 });
    vi.mocked(renderInpaintVideos).mockResolvedValue(videos);
    vi.mocked(apiRequest).mockResolvedValue(queued);
    vi.mocked(watchJob).mockResolvedValue({ ...queued, status: "completed", inpainting: result });
    await state().generate();
    const { masks } = vi.mocked(renderInpaintVideos).mock.calls[0][0];
    expect(masks).toEqual([{ shape: "rectangle", boxes: maskBoxes(bounds, moving, video) }, { shape: "ellipse", boxes: maskBoxes(other, createMaskMotion(other, 124), video) }]);
    expect(masks![1].boxes[123]).toEqual({ x: 0.5, y: 0.5, width: 0.1, height: 0.1 });
    expect(state()).toMatchObject({ status: "idle", result });
  });
  it("edits a frame inside every mask, as long as one is in the frame there", async () => {
    const gone = { ...still, keys: [...still.keys, { id: "end", frame: 123, x: 5000, y: 378, sx: 1, sy: 1 }] };
    useInpaintStore.setState({ source, video, ...withMasks(mask(gone), mask(still, { id: "mask-2", shape: "ellipse" })), step: 2, playhead: 123, creating: "frame", referenceText: "a cat" });
    vi.mocked(captureFrame).mockResolvedValue({ image: new Blob(["frame"]), mask: new Blob(["mask"]) });
    vi.mocked(apiRequest).mockResolvedValue(queued);
    vi.mocked(watchJob).mockResolvedValue({ ...queued, status: "cancelled" });
    await state().createReference();
    expect(captureFrame).toHaveBeenCalledWith(expect.objectContaining({ masks: [
      { shape: "rectangle", box: maskBoxes(bounds, gone, video)[123] }, { shape: "ellipse", box: maskBoxes(bounds, still, video)[123] }] }));
    vi.mocked(captureFrame).mockClear();
    useInpaintStore.setState(withMasks(mask(gone), mask(gone, { id: "mask-2" })));
    await state().createReference();
    expect(captureFrame).not.toHaveBeenCalled();
    expect(state().error).toMatch(/^Every mask is outside the frame here/);
  });
  it("ticks each mask's own subjects when picking, and tracks for the mask that picked them", async () => {
    selectSubject();
    const other = { ...subject, id: "4c1f7d2a-9b3e-4a5c-8d6f-1e2a3b4c5d6e" };
    useFollowSelection.setState({ candidates: [subject, other] });
    useInpaintStore.setState({ source, video, ...withMasks(mask(still, { followIds: [subject.id] }), mask(still, { id: "mask-2" })), step: 1 });
    state().selectMask("mask-2");
    await state().startPicking();
    expect(follow().selectedIds).toEqual([]);
    follow().toggleCandidate(other.id);
    vi.mocked(renderInpaintVideos).mockResolvedValue({ ...videos, mask: null });
    const frames = Array.from({ length: 124 }, (_, i) => ({ area: 1600, x: 170 + 2 * i, y: 200, bounds: { x: 150 + 2 * i, y: 180, width: 40, height: 40 } }));
    const tracking = { videoId: video.id, width: 854, height: 480, frames };
    vi.mocked(apiRequest).mockResolvedValue(queued);
    vi.mocked(watchJob).mockResolvedValue({ ...queued, status: "completed", tracking });
    await state().followObject();
    expect(JSON.parse((vi.mocked(apiRequest).mock.calls[0][1]!.body as FormData).get("request") as string)).toMatchObject({ candidateIds: [other.id] });
    const [first, second] = state().masks;
    expect(first).toMatchObject({ motion: still, track: null, followIds: [subject.id] });
    expect(second).toMatchObject({ track: tracking, followIds: [other.id] });
    expect(second.motion.keys.length).toBeGreaterThan(1);
    expect(state().track).toBe(tracking);
    state().selectMask("mask-1");
    expect(state().track).toBeNull();
    await state().startPicking();
    expect(follow().selectedIds).toEqual([subject.id]);
  });
  it("records a drag on a still mask into a path, unless the user scrubbed first", () => {
    useInpaintStore.setState({ video, ...withMasks(mask(still)), step: 1 });
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
    useInpaintStore.setState({ video, ...withMasks(mask(still)), step: 1, playhead: 60 });
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
    useInpaintStore.setState({ video, ...withMasks(mask(moving)), step: 1, playhead: 50, result, view: "result", selectedKeyId: "end" });
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
    useInpaintStore.setState({ source, video, ...withMasks(mask(motion, { shape: "ellipse" })), prompt: "A bird from <Picture 1> flies.", reference, step: 2 });
    vi.mocked(renderInpaintVideos).mockResolvedValue(videos);
    vi.mocked(apiRequest).mockResolvedValue(queued);
    vi.mocked(watchJob).mockResolvedValue({ ...queued, status: "completed", inpainting: result });
    await state().generate();
    expect(renderInpaintVideos).toHaveBeenCalledWith(expect.objectContaining({ source, masks: [{ shape: "ellipse", boxes: maskBoxes(bounds, motion, video) }], size: { width: 1366, height: 768 }, grow: 24, audio: false }), expect.any(Function), expect.any(AbortSignal));
    const boxes = vi.mocked(renderInpaintVideos).mock.calls[0][0].masks![0].boxes;
    expect(boxes).toHaveLength(124);
    expect(boxes[0]).toEqual({ x: 0.1, y: 0.2, width: 0.2, height: 0.3 });
    const form = vi.mocked(apiRequest).mock.calls[0][1]!.body as FormData;
    expect(JSON.parse(form.get("request") as string)).toEqual({ videoId: video.id, width: 1366, height: 768, frames: 124, prompt: "A bird from <Picture 1> flies.", feather: 16, audio: "replace" });
    expect(form.get("reference")).toBe(reference);
    expect(state()).toMatchObject({ status: "idle", view: "result", result });
  });
  it("prepares the chosen resolution and closes the prompt with the sound effects and music", async () => {
    useInpaintStore.setState({ source, video, ...withMasks(mask(moving)), prompt: "A bird flies.", step: 2 });
    state().setTier(480); state().setSoundEffects(" Wings flapping. "); state().setMusic("Soft strings.");
    state().setGrow(100); state().setFeather(9);
    expect(state()).toMatchObject({ grow: 32, feather: 10 });
    state().setFeather(100);
    expect(state().feather).toBe(32);
    state().setGrow(0); state().setFeather(0);
    vi.mocked(renderInpaintVideos).mockResolvedValue(videos);
    vi.mocked(apiRequest).mockResolvedValue(queued);
    vi.mocked(watchJob).mockResolvedValue({ ...queued, status: "completed", inpainting: result });
    await state().generate();
    expect(renderInpaintVideos).toHaveBeenCalledWith(expect.objectContaining({ size: { width: 854, height: 480 }, grow: 0 }), expect.any(Function), expect.any(AbortSignal));
    const form = vi.mocked(apiRequest).mock.calls[0][1]!.body as FormData;
    expect(JSON.parse(form.get("request") as string)).toEqual({ videoId: video.id, width: 854, height: 480, frames: 124, feather: 0, audio: "replace",
      prompt: "A bird flies.\n\noverall_soundscape:\nWings flapping.\n\nnon_diegetic_music:\nSoft strings." });
  });
  it.each([["reference", true], ["preserve", true], ["replace", false]] as const)("keeps the sound in the source to %s it", async (audio, kept) => {
    useInpaintStore.setState({ source, video: { ...video, audio: true }, ...withMasks(mask(still)), prompt: "A bird flies.", step: 2 });
    expect(state().audio).toBe("reference");
    state().setAudio(audio);
    vi.mocked(renderInpaintVideos).mockResolvedValue(videos);
    vi.mocked(apiRequest).mockResolvedValue(queued);
    vi.mocked(watchJob).mockResolvedValue({ ...queued, status: "completed", inpainting: { ...result, audio } });
    await state().generate();
    expect(renderInpaintVideos).toHaveBeenCalledWith(expect.objectContaining({ audio: kept }), expect.any(Function), expect.any(AbortSignal));
    const request = JSON.parse((vi.mocked(apiRequest).mock.calls[0][1]!.body as FormData).get("request") as string);
    expect(request.audio).toBe(audio);
    expect(request.prompt.includes("<Audio 1>")).toBe(kept);
  });
  it("replaces the sound of a video without any, whatever was chosen", async () => {
    useInpaintStore.setState({ source, video, ...withMasks(mask(still)), prompt: "A bird flies.", step: 2, audio: "preserve" });
    vi.mocked(renderInpaintVideos).mockResolvedValue(videos);
    vi.mocked(apiRequest).mockResolvedValue(queued);
    vi.mocked(watchJob).mockResolvedValue({ ...queued, status: "completed", inpainting: result });
    await state().generate();
    expect(renderInpaintVideos).toHaveBeenCalledWith(expect.objectContaining({ audio: false }), expect.any(Function), expect.any(AbortSignal));
    expect(JSON.parse((vi.mocked(apiRequest).mock.calls[0][1]!.body as FormData).get("request") as string)).toMatchObject({ audio: "replace", prompt: "A bird flies." });
  });
  it("defines an uploaded reference as an object and lays the prompt out around it", async () => {
    const reference = new File(["ref"], "ref.png", { type: "image/png" });
    useInpaintStore.setState({ source, video, ...withMasks(mask(still)), prompt: "A lantern sways.", step: 2 });
    state().setReference(reference);
    expect(state()).toMatchObject({ referenceRole: { kind: "object" }, definition: "<Subject 1> is the object in <Picture 1>." });
    state().setDefinition("<Subject 1> is the red lantern in <Picture 1>.");
    vi.mocked(renderInpaintVideos).mockResolvedValue(videos);
    vi.mocked(apiRequest).mockResolvedValue(queued);
    vi.mocked(watchJob).mockResolvedValue({ ...queued, status: "completed", inpainting: result });
    await state().generate();
    const { prompt } = JSON.parse((vi.mocked(apiRequest).mock.calls[0][1]!.body as FormData).get("request") as string);
    expect(prompt).toMatch(/^subject_definitions:\n<Subject 1> is the red lantern in <Picture 1>\.\n\nsummary:\n\[video editing \+ reference generation\]/);
    expect(prompt).toContain("detailed_description:\n[Shot 1] A lantern sways.");
    state().setReference(null);
    expect(state()).toMatchObject({ reference: null, referenceRole: null, definition: "" });
  });
  it("sends a raw prompt as written, starting from the formatted one", async () => {
    useInpaintStore.setState({ source, video: { ...video, audio: true }, ...withMasks(mask(still)), prompt: "A lantern sways.", soundEffects: "Wind.", step: 2 });
    state().setReference(new File(["ref"], "ref.png", { type: "image/png" }));
    state().setPromptMode("raw");
    expect(state().rawPrompt).toMatch(/^subject_definitions:\n<Subject 1> is the object in <Picture 1>\.\n<Audio 1>/);
    expect(state().rawPrompt).toMatch(/overall_soundscape:\nThe ambience .* Wind\.$/);
    state().setRawPrompt("A lantern sways, written by hand.");
    vi.mocked(renderInpaintVideos).mockResolvedValue(videos);
    vi.mocked(apiRequest).mockResolvedValue(queued);
    vi.mocked(watchJob).mockResolvedValue({ ...queued, status: "completed", inpainting: result });
    await state().generate();
    expect(JSON.parse((vi.mocked(apiRequest).mock.calls[0][1]!.body as FormData).get("request") as string))
      .toMatchObject({ prompt: "A lantern sways, written by hand.", audio: "reference" });
  });
  it("splits an edited raw prompt back into the prompt, definition and sound fields", () => {
    useInpaintStore.setState({ source, video: { ...video, audio: true }, ...withMasks(mask(still)), prompt: "A lantern sways.", step: 2 });
    state().setReference(new File(["ref"], "ref.png", { type: "image/png" }));
    state().setPromptMode("raw");
    state().setRawPrompt(state().rawPrompt.replace("the object", "the red lantern").replace("[Shot 1] A lantern sways.", "[Shot 1] It glows.")
      .replace("carry on throughout the target video.", "carry on throughout the target video. Wind.") + "\n\nnon_diegetic_music:\nPiano.");
    state().setPromptMode("formatted");
    expect(state()).toMatchObject({ promptMode: "formatted", unformattable: false, prompt: "It glows.",
      definition: "<Subject 1> is the red lantern in <Picture 1>.", soundEffects: "Wind.", music: "Piano." });
  });
  it("offers to reset a raw prompt that no longer follows the format, keeping the formatted fields", () => {
    useInpaintStore.setState({ source, video, ...withMasks(mask(still)), prompt: "A bird flies.", music: "Strings.", step: 2 });
    state().setReference(new File(["ref"], "ref.png", { type: "image/png" }));
    state().setPromptMode("raw");
    state().setRawPrompt("A bird flies.");
    state().setPromptMode("formatted");
    expect(state()).toMatchObject({ promptMode: "raw", unformattable: true });
    state().resetPrompt();
    expect(state()).toMatchObject({ promptMode: "formatted", unformattable: false, prompt: "A bird flies.", music: "Strings." });
  });
  it("returns an unedited raw prompt to the fields, even with a blank main prompt", () => {
    useInpaintStore.setState({ source, video, ...withMasks(mask(still)), step: 2 });
    state().setReference(new File(["ref"], "ref.png", { type: "image/png" }));
    state().setPromptMode("raw");
    expect(state().rawPrompt).toContain("detailed_description:\n[Shot 1]");
    state().setPromptMode("formatted");
    expect(state()).toMatchObject({ promptMode: "formatted", unformattable: false, prompt: "" });
  });
  it("creates an object reference from its description and uses it", async () => {
    useInpaintStore.setState({ source, video, ...withMasks(mask(still)), step: 2 });
    state().openCreator("object"); state().setReferenceText(" a red paper lantern ");
    const created = { videoId: video.id, kind: "object" as const, description: "a red paper lantern", frame: null, seed: 4,
      image: { id: crypto.randomUUID(), url: "/api/files/object", width: 1024, height: 1024 } };
    vi.mocked(apiRequest).mockResolvedValue(queued);
    vi.mocked(watchJob).mockResolvedValue({ ...queued, status: "completed", reference: created });
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Blob(["png"])));
    await state().createReference();
    const [path, init] = vi.mocked(apiRequest).mock.calls[0];
    expect(path).toBe("/jobs/reference");
    expect(JSON.parse((init!.body as FormData).get("request") as string)).toEqual({ kind: "object", videoId: video.id, description: "a red paper lantern" });
    expect(captureFrame).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith("/api/files/object", expect.anything());
    expect(state().reference).toBeInstanceOf(File);
    expect(state()).toMatchObject({ status: "idle", task: null, creating: null, created, referenceRole: { kind: "object" },
      definition: "<Subject 1> is the red paper lantern in <Picture 1>." });
    fetch.mockRestore();
  });
  it("cancels the download of a reference whose job has finished, without cancelling the job", async () => {
    useInpaintStore.setState({ source, video, ...withMasks(mask(still)), step: 2, creating: "object", referenceText: "a lantern" });
    const created = { videoId: video.id, kind: "object" as const, description: "a lantern", frame: null, seed: 4,
      image: { id: crypto.randomUUID(), url: "/api/files/object", width: 1024, height: 1024 } };
    vi.mocked(apiRequest).mockResolvedValue(queued);
    vi.mocked(watchJob).mockResolvedValue({ ...queued, status: "completed", reference: created });
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => new Promise((_, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
    }));
    const running = state().createReference();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    await state().cancel();
    await running;
    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(state()).toMatchObject({ status: "idle", reference: null, referenceRole: null, notice: "Reference cancelled.", error: null });
    fetch.mockRestore();
  });
  it("creates an edited frame at the playhead, with the mask where it is on that frame", async () => {
    useInpaintStore.setState({ source, video, ...withMasks(mask(moving, { shape: "ellipse" })), step: 2, playhead: 50 });
    state().openCreator("frame"); state().setReferenceText("a red umbrella");
    const image = new Blob(["frame"]), maskImage = new Blob(["mask"]);
    vi.mocked(captureFrame).mockResolvedValue({ image, mask: maskImage });
    const created = { videoId: video.id, kind: "frame" as const, description: "a red umbrella", frame: 50, seed: 4,
      image: { id: crypto.randomUUID(), url: "/api/files/frame", width: 1920, height: 1080 } };
    vi.mocked(apiRequest).mockResolvedValue(queued);
    vi.mocked(watchJob).mockResolvedValue({ ...queued, status: "completed", reference: created });
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Blob(["png"])));
    await state().createReference();
    expect(captureFrame).toHaveBeenCalledWith({ source, frame: 50, size: { width: 1920, height: 1080 }, masks: [{ box: maskBoxes(bounds, moving, video)[50], shape: "ellipse" }] });
    const form = vi.mocked(apiRequest).mock.calls[0][1]!.body as FormData;
    expect(JSON.parse(form.get("request") as string)).toEqual({ kind: "frame", videoId: video.id, description: "a red umbrella", frame: 50 });
    expect(form.get("image")).toBeInstanceOf(Blob); expect(form.get("mask")).toBeInstanceOf(Blob);
    expect(state()).toMatchObject({ referenceRole: { kind: "frame", frame: 50, frames: 124 },
      definition: "<Picture 1> is the edited keyframe of [Shot 1] at 00:02.083, showing a red umbrella." });
    fetch.mockRestore();
  });
  it("won't edit a frame where the mask has left it", async () => {
    const gone = { ...still, keys: [...still.keys, { id: "end", frame: 123, x: 5000, y: 378, sx: 1, sy: 1 }] };
    useInpaintStore.setState({ source, video, ...withMasks(mask(gone)), step: 2, playhead: 123, creating: "frame", referenceText: "a cat" });
    await state().createReference();
    expect(captureFrame).not.toHaveBeenCalled();
    expect(apiRequest).not.toHaveBeenCalled();
    expect(state()).toMatchObject({ status: "idle", creating: "frame", error: expect.stringMatching(/outside the frame/) });
  });
  it("only picks an object to follow for a still mask, selecting it on the first frame as the tracker sees it", async () => {
    useInpaintStore.setState({ source, video, ...withMasks(mask(moving)), step: 1, playhead: 50 });
    await state().startPicking();
    expect(state().picking).toBe(false);
    useInpaintStore.setState({ motion: still });
    const png = new Blob(["frame"], { type: "image/png" });
    vi.mocked(readFrame).mockResolvedValue(png);
    vi.mocked(apiRequest).mockResolvedValue(frame);
    await state().startPicking();
    expect(readFrame).toHaveBeenCalledWith(source, 0, { width: 854, height: 480 });
    const [path, init] = vi.mocked(apiRequest).mock.calls[0];
    expect(path).toBe("/frames");
    expect((init!.body as FormData).get("videoId")).toBe(video.id);
    expect(state()).toMatchObject({ picking: true, playhead: 0, status: "idle", task: null });
    expect(follow()).toMatchObject({ image: frame, candidates: [], selectionView: "find" });
    // Tracking starts on the first frame, so the playhead can't leave it while picking.
    state().setPlayhead(40); state().scrub(60); state().togglePlay();
    expect(state()).toMatchObject({ picking: true, playhead: 0, playing: false });
    state().visitStep(2);
    expect(state().picking).toBe(false);
  });
  it("keeps the subjects selected before when picking again, without reading the frame", async () => {
    selectSubject();
    useInpaintStore.setState({ source, video, ...withMasks(mask(still, { followIds: [subject.id] })), step: 1 });
    await state().startPicking();
    expect(readFrame).not.toHaveBeenCalled();
    expect(state().picking).toBe(true);
    state().stopPicking();
    expect(state().picking).toBe(false);
    expect(follow()).toMatchObject({ image: frame, selectedIds: [subject.id] });
  });
  it("stops picking when reading the first frame is cancelled or fails", async () => {
    useInpaintStore.setState({ source, video, ...withMasks(mask(still)), step: 1 });
    vi.mocked(readFrame).mockImplementation(() => new Promise(() => undefined));
    const picking = state().startPicking();
    expect(state()).toMatchObject({ picking: true, task: "frame", status: "preparing" });
    state().stopPicking();
    await picking;
    expect(state()).toMatchObject({ picking: false, status: "idle", task: null, error: null });
    vi.mocked(readFrame).mockRejectedValue(new Error("This browser can't decode this video. Try an H.264 MP4."));
    await state().startPicking();
    expect(state()).toMatchObject({ picking: false, status: "idle", task: null, error: "This browser can't decode this video. Try an H.264 MP4." });
    expect(follow().image).toBeNull();
    expect(apiRequest).not.toHaveBeenCalled();
  });
  it("tracks the ticked subjects on the prepared frames and keys the mask to follow them", async () => {
    selectSubject();
    useInpaintStore.setState({ source, video, ...withMasks(mask(still)), step: 1, picking: true });
    vi.mocked(renderInpaintVideos).mockResolvedValue({ ...videos, mask: null });
    // On the 854 × 480 prepared frames, the object starts under the mask and drifts right 2 px a frame.
    const frames = Array.from({ length: 124 }, (_, i) => ({ area: 1600, x: 170 + 2 * i, y: 200, bounds: { x: 150 + 2 * i, y: 180, width: 40, height: 40 } }));
    const tracking = { videoId: video.id, width: 854, height: 480, frames };
    vi.mocked(apiRequest).mockResolvedValue(queued);
    vi.mocked(watchJob).mockResolvedValue({ ...queued, status: "completed", tracking });
    await state().followObject();
    expect(renderInpaintVideos).toHaveBeenCalledWith(expect.objectContaining({ source, masks: null, size: { width: 854, height: 480 } }), expect.any(Function), expect.any(AbortSignal));
    const [path, init] = vi.mocked(apiRequest).mock.calls[0];
    expect(path).toBe("/jobs/track");
    expect(JSON.parse((init!.body as FormData).get("request") as string)).toEqual({ videoId: video.id, width: 854, height: 480, frames: 124, frameId: frame.id, candidateIds: [subject.id] });
    const keys = state().motion!.keys;
    expect(keys[0]).toEqual(still.keys[0]);
    // 2 px a frame on the prepared frames is 2 × 1920 / 854 video pixels a frame.
    expect(keys.at(-1)).toMatchObject({ frame: 123, x: expect.closeTo(384 + 246 * 1920 / 854, 0), y: expect.closeTo(378, 6), sx: expect.closeTo(1, 6) });
    expect(state()).toMatchObject({ status: "idle", task: null, picking: false, track: tracking, notice: null });
    state().clearPath();
    expect(state().track).toBeNull();
  });
  it("only follows ticked subjects without unapplied points, while picking", async () => {
    selectSubject();
    useInpaintStore.setState({ source, video, ...withMasks(mask(still)), step: 1 });
    await state().followObject();
    useInpaintStore.setState({ picking: true });
    useFollowSelection.setState({ selectedIds: [] });
    await state().followObject();
    useFollowSelection.setState({ selectedIds: [subject.id], pointsPending: true });
    await state().followObject();
    expect(renderInpaintVideos).not.toHaveBeenCalled();
    expect(state()).toMatchObject({ status: "idle", task: null, motion: still, picking: true });
  });
  it("reports a track that misses the first frame and keeps the still mask", async () => {
    selectSubject();
    useInpaintStore.setState({ source, video, ...withMasks(mask(still)), step: 1, picking: true });
    vi.mocked(renderInpaintVideos).mockResolvedValue({ ...videos, mask: null });
    vi.mocked(apiRequest).mockResolvedValue(queued);
    vi.mocked(watchJob).mockResolvedValue({ ...queued, status: "completed", tracking: { videoId: video.id, width: 854, height: 480, frames: Array(124).fill(null) } });
    await state().followObject();
    expect(state()).toMatchObject({ motion: still, track: null, error: "SAM couldn't find the selected object on the first frame. Select it again." });
  });
  it("keeps the last result when replacement generation fails", async () => {
    useInpaintStore.setState({ source, video, ...withMasks(mask(still)), prompt: "A bird flies.", step: 2, result });
    vi.mocked(renderInpaintVideos).mockRejectedValue(new Error("Encoding failed"));
    await useInpaintStore.getState().generate();
    expect(useInpaintStore.getState()).toMatchObject({ status: "idle", result, error: "Encoding failed" });
  });
  it("cancels preparation before an upload starts", async () => {
    useInpaintStore.setState({ source, video, ...withMasks(mask(moving)), prompt: "A bird flies.", step: 2 });
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
    useInpaintStore.setState({ source, video, ...withMasks(mask(moving)), prompt: "A bird flies.", step: 2 });
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
    useInpaintStore.setState({ source, video, ...withMasks(mask(still)), prompt: "A bird flies.", step: 2, result });
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
