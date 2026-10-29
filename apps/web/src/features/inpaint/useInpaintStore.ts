import { create } from "zustand";
import {
  MASK_FEATHER, MASK_GROW, MAX_VIDEO_UPLOAD_BYTES, applyRecording, buildMotionCurve, composeInpaintPrompt, createMaskMotion, deleteKey, fitMask, followTrack, imageAssetSchema, inpaintFrames,
  inpaintSize, insertKeyAtLength, isStartKey, jobSnapshotSchema, lastFrame, maskBoxes, moveKey, rebaseMask, referenceDefinition, retimeKey, upsertKey,
  videoAssetSchema,
} from "@h3-motion/shared";
import type {
  FrameSize, InpaintAudioMode, InpaintResult, JobSnapshot, MaskBox, MaskShape, Point, Pose, Rect, ReferenceRequest, ReferenceResult, ReferenceRole, Scale, SubjectMotion,
  TimedSample, TrackResult, VideoAsset, VideoTier,
} from "@h3-motion/shared";
import { apiRequest, watchJob } from "../../api";
import { renderInpaintVideos } from "./renderInpaint";
import { captureFrame, readFrame, referenceFrameSize } from "./captureFrame";
import { resetFollowSelection, useFollowSelection } from "./useFollowSelection";
import { hasPendingPoints } from "../select/useSelectionStore";
import { SUBJECT_COLORS } from "../motion/useMotionStore";

type Status = "idle" | "preparing" | "uploading" | "generating";
/**
 * What the running job does: inpaint the video, read the first frame to select an object on, track that object for
 * the mask to follow, or create a reference image.
 */
type Task = "inpaint" | "frame" | "track" | "reference";
/** The most masks one video can have; each is a colour of its own. */
export const MAX_MASKS = 8;
export interface InpaintMask {
  id: string; color: string; shape: MaskShape;
  /** The mask drawn on the first frame, in video pixels. `motion` moves and resizes it from there, anchored at its centre. */
  bounds: Rect; motion: SubjectMotion<number>;
  /** The object the mask last followed, for showing where it was tracked. */
  track: TrackResult | null;
  /** The subjects ticked in `useFollowSelection` when an object was last picked for this mask. */
  followIds: string[];
}
interface InpaintState {
  source: File | null; video: VideoAsset | null; frames: number; uploading: boolean;
  step: 0 | 1 | 2;
  /** Masks in the order they were drawn; all of them are inpainted. `shape`, `bounds`, `motion` and `track` mirror the active one. */
  masks: InpaintMask[]; activeMaskId: string | null;
  /** The active mask's shape, and the shape of the next mask drawn. */
  shape: MaskShape;
  bounds: Rect | null; motion: SubjectMotion<number> | null;
  playhead: number; playing: boolean; recording: boolean;
  /** The user parked the playhead after the first frame, so a still mask is keyframed there instead of recorded. */
  scrubbed: boolean; selectedKeyId: string | null;
  prompt: string; soundEffects: string; music: string; reference: File | null; result: InpaintResult | null; view: "preview" | "result";
  /** The short edge of the delivered video. */
  tier: VideoTier;
  /** How far the mask is grown, and how softly the patch is blended in, in delivered-video pixels. */
  grow: number; feather: number;
  /** What happens to the source's sound, when it has any; a source without sound is always `replace`d. */
  audio: InpaintAudioMode;
  /** What the reference is to H3, which decides how the prompt defines it; null without a reference. */
  referenceRole: ReferenceRole | null;
  /** The reference's `subject_definitions` line, prefilled for its role and editable. */
  definition: string;
  /** The reference being created: an object from a description, or the frame at the playhead edited inside the mask. */
  creating: "object" | "frame" | null; referenceText: string;
  /** The last reference created, to try again. */
  created: ReferenceResult | null;
  status: Status; task: Task | null; progress: number | null; job: JobSnapshot | null; error: string | null; notice: string | null;
  /** Selecting the object the active mask should follow, on the first frame in `useFollowSelection`. */
  picking: boolean;
  track: TrackResult | null;
  upload(file: File): Promise<boolean>; visitStep(step: 0 | 1 | 2): void;
  /** Sets the active mask's shape, and the shape of masks drawn next. */
  setShape(shape: MaskShape): void;
  /** Adds a mask drawn on the first frame, and makes it active. */
  addMask(rect: Rect): void;
  /** Redraws the active mask on the first frame. Its later keys keep their position and size on screen. */
  drawMask(rect: Rect): void;
  /** Makes a mask active, to edit or animate it. */
  selectMask(id: string): void; removeMask(id: string): void;
  /** Moves the playhead for the user; parking it after the first frame switches path creation to keyframing. */
  setPlayhead(frame: number): void;
  /** Moves the playhead like setPlayhead and selects the last key it passed or landed on. */
  scrub(frame: number): void; togglePlay(): void;
  /** Stops playback and selects the last key it passed since play started. */
  pause(): void;
  /** Stops playback and drops an unfinished take, e.g. when the editor closes. */
  leave(): void;
  /** Starts dragging or resizing the active mask at the playhead; returns its pose there, or null if this frame can't change. */
  beginMaskDrag(): Pose | null;
  /** Keys the active mask's centre, and its scale when given, at the playhead. */
  placeMask(pose: Point & Partial<Scale>): void; addKey(): void;
  selectKey(id: string | null): void; moveKey(id: string, point: Point): void;
  retimeKey(id: string, frame: number): void; insertAtLength(length: number): string | null;
  deleteSelected(): void; resetScale(): void; clearPath(): void;
  /** Starts a take on the active mask while it is still, unless the user scrubbed first; returns the frame it starts at. */
  startRecording(): number | null;
  /** Applies a take, timed to fill the clip from the playhead where it started. */
  finishRecording(samples: TimedSample[]): void;
  /**
   * Starts selecting an object for the active mask to follow while it is still, on the first frame, where tracking
   * starts. The playhead goes there and stays. The frame is read and uploaded the first time; later picks keep the
   * subjects found before, ticking those this mask last followed.
   */
  startPicking(): Promise<void>;
  /** Stops selecting, keeping the mask's selection for next time, or cancels reading the frame. */
  stopPicking(): void;
  /** Tracks the subjects ticked in `useFollowSelection` and keys the active mask to follow them. Only while picking. */
  followObject(): Promise<void>;
  setPrompt(prompt: string): void; setSoundEffects(soundEffects: string): void; setMusic(music: string): void;
  setTier(tier: VideoTier): void; setGrow(grow: number): void; setFeather(feather: number): void; setAudio(audio: InpaintAudioMode): void; setView(view: "preview" | "result"): void;
  /** Uses an uploaded image as the reference, as an object; null removes the reference. */
  setReference(file: File | null): void; setDefinition(definition: string): void;
  openCreator(kind: "object" | "frame" | null): void; setReferenceText(text: string): void;
  /** Creates the reference being described with Qwen Image and uses it. A frame is the one at the playhead. */
  createReference(): Promise<void>;
  /** Creates the last created reference again, with a new seed. */
  recreateReference(): Promise<void>;
  clearError(): void; generate(): Promise<void>; cancel(): Promise<void>;
}
let controller: AbortController | null = null;
const message = (error: unknown) => error instanceof Error ? error.message : "Something went wrong. Try again.";
const edited = { view: "preview" as const, notice: null };
const newId = () => globalThis.crypto.randomUUID();
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const stepped = (value: number, range: { min: number; max: number; step: number }) => clamp(Math.round(value / range.step) * range.step, range.min, range.max);
export const videoFrame = (video: Pick<VideoAsset, "width" | "height">): FrameSize => ({ width: video.width, height: video.height });
/** What happens to the video's sound: the chosen option, unless it has none to keep or reference. */
export const audioMode = (video: Pick<VideoAsset, "audio"> | null, audio: InpaintAudioMode): InpaintAudioMode => video?.audio ? audio : "replace";
/** The colour the next mask drawn gets: the first one no mask uses. */
export const nextMaskColor = (masks: Pick<InpaintMask, "color">[]) => SUBJECT_COLORS.find(color => !masks.some(mask => mask.color === color)) ?? SUBJECT_COLORS[0];
/** The fields that mirror the active mask, or are cleared without one; `shape` is kept for the next mask drawn. */
function mirror(masks: InpaintMask[], activeMaskId: string | null) {
  const active = masks.find(mask => mask.id === activeMaskId);
  return { masks, activeMaskId: active?.id ?? null, bounds: active?.bounds ?? null, motion: active?.motion ?? null, track: active?.track ?? null,
    ...(active ? { shape: active.shape } : {}) };
}
const outside = (box: MaskBox) => box.x >= 1 || box.y >= 1 || box.x + box.width <= 0 || box.y + box.height <= 0;

/** Settles like `promise`, or rejects as soon as `signal` aborts, for work that can't be stopped. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** The key nearest `to` among those passed moving the playhead from `from` to `to`, excluding where it started. */
function lastCrossed(motion: SubjectMotion<number>, from: number, to: number) {
  const crossed = motion.keys.filter(key => to > from ? key.frame > from && key.frame <= to : key.frame < from && key.frame >= to);
  return crossed.reduce<typeof crossed[number] | null>((best, key) => !best || Math.abs(key.frame - to) < Math.abs(best.frame - to) ? key : best, null);
}

export const useInpaintStore = create<InpaintState>((set, get) => {
  let playStart = 0;
  /** Uploads a prepared job and follows it to the end. Returns its final snapshot, or null if it was cancelled. */
  async function runJob(path: string, form: FormData, signal: AbortSignal): Promise<JobSnapshot | null> {
    set({ status: "uploading", progress: null });
    const initial = jobSnapshotSchema.parse(await apiRequest(path, { method: "POST", body: form, signal }));
    set({ status: "generating", job: initial });
    if (signal.aborted && ["queued", "running"].includes(initial.status)) await get().cancel();
    const result = await watchJob(initial, job => set({ job, progress: job.progress }));
    set({ job: result });
    if (result.status === "failed") throw new Error(result.error ?? result.message);
    return result.status === "cancelled" ? null : result;
  }
  /** The active mask's motion while it can be animated: idle, on the Animate step. */
  function animating() {
    const { motion, status, step } = get();
    return status === "idle" && step === 1 ? motion : null;
  }
  /** Changes the mask `id`, which is the active one unless given. */
  function patchMask(patch: Partial<InpaintMask>, extra: Partial<InpaintState> = {}, id = get().activeMaskId) {
    const { masks, activeMaskId } = get();
    set({ ...mirror(masks.map(mask => mask.id === id ? { ...mask, ...patch } : mask), activeMaskId), ...extra });
  }
  /** Keeps dragged positions within one frame's width or height of the video, so keys stay reachable. */
  function bounded(point: Point): Point {
    const { video } = get();
    if (!video) return point;
    return { x: clamp(point.x, -video.width, video.width * 2), y: clamp(point.y, -video.height, video.height * 2) };
  }
  function edit(next: SubjectMotion<number>, extra: Partial<InpaintState> = {}) {
    if (next !== get().motion) patchMask({ motion: next }, { ...edited, ...extra });
  }
  /** Every mask's boxes on every frame, as fractions of the frame, for the mask video. */
  function allBoxes(video: VideoAsset) {
    return get().masks.map(mask => ({ shape: mask.shape, boxes: maskBoxes(mask.bounds, mask.motion, videoFrame(video)) }));
  }
  return {
    source: null, video: null, frames: 124, uploading: false, step: 0, masks: [], activeMaskId: null, shape: "rectangle", bounds: null, motion: null,
    playhead: 0, playing: false, recording: false, scrubbed: false, selectedKeyId: null,
    prompt: "", soundEffects: "", music: "", tier: 768, grow: MASK_GROW.default, feather: MASK_FEATHER.default, audio: "reference", reference: null, result: null, view: "preview", status: "idle", task: null, progress: null, job: null, error: null, notice: null,
    picking: false, track: null, referenceRole: null, definition: "", creating: null, referenceText: "", created: null,
    upload: async file => {
      if (get().uploading || get().status !== "idle") return false;
      set({ uploading: true, error: null });
      try {
        if (file.size > MAX_VIDEO_UPLOAD_BYTES) throw new Error("Choose a video up to 200 MB.");
        const form = new FormData(); form.set("video", file);
        const video = videoAssetSchema.parse(await apiRequest("/videos", { method: "POST", body: form }));
        resetFollowSelection();
        set({ source: file, video, frames: inpaintFrames(video.duration), step: 0, ...mirror([], null), picking: false,
          playhead: 0, playing: false, recording: false, scrubbed: false, selectedKeyId: null,
          shape: "rectangle", prompt: "", soundEffects: "", music: "", reference: null, referenceRole: null, definition: "", creating: null, referenceText: "", created: null,
          result: null, job: null, progress: null, ...edited });
        return true;
      } catch (error) { set({ error: message(error) }); return false; }
      finally { set({ uploading: false }); }
    },
    visitStep: step => {
      if (get().status !== "idle" || get().recording || (step > 0 && !get().masks.length)) return;
      set({ step, playing: false, picking: false, view: "preview", ...(step === 0 ? { playhead: 0, scrubbed: false, selectedKeyId: null } : {}) });
    },
    setShape: shape => {
      if (get().status !== "idle") return;
      if (get().activeMaskId) patchMask({ shape }, edited); else set({ shape });
    },
    addMask: rect => {
      const { video, masks, shape, frames, status, step } = get();
      if (status !== "idle" || !video || step !== 0) return;
      if (masks.length >= MAX_MASKS) { set({ notice: `You can draw up to ${MAX_MASKS} masks. Remove one to add another.` }); return; }
      const bounds = fitMask(rect, videoFrame(video));
      const mask: InpaintMask = { id: newId(), color: nextMaskColor(masks), shape, bounds, motion: createMaskMotion(bounds, frames), track: null, followIds: [] };
      set({ ...mirror([...masks, mask], mask.id), selectedKeyId: null, ...edited });
    },
    drawMask: rect => {
      const { video, bounds, motion, status, step } = get();
      if (status !== "idle" || !video || step !== 0 || !bounds || !motion) return;
      const next = fitMask(rect, videoFrame(video));
      patchMask({ bounds: next, motion: rebaseMask(motion, bounds, next) }, edited);
    },
    selectMask: id => {
      const { masks, activeMaskId, status, recording, picking } = get();
      if (id === activeMaskId || status !== "idle" || recording || picking || !masks.some(mask => mask.id === id)) return;
      set({ ...mirror(masks, id), selectedKeyId: null, playing: false, notice: null });
    },
    removeMask: id => {
      const { masks, activeMaskId, status, recording, picking, step } = get();
      if (status !== "idle" || recording || picking || !masks.some(mask => mask.id === id)) return;
      const rest = masks.filter(mask => mask.id !== id);
      // The mask drawn before the removed one takes its place, so removing several in a row walks back through them.
      const index = masks.findIndex(mask => mask.id === id), next = id === activeMaskId ? rest[Math.max(0, index - 1)]?.id ?? null : activeMaskId;
      set({ ...mirror(rest, next), ...(id === activeMaskId ? { selectedKeyId: null } : {}), playing: false, ...edited,
        ...(rest.length ? {} : { step: 0, playhead: 0, scrubbed: false }) });
    },
    setPlayhead: frame => {
      // While picking, the video must stay on the first frame, where tracking starts.
      if (get().recording || get().picking) return;
      const playhead = clamp(Math.round(frame), 0, get().frames - 1);
      set({ playhead, playing: false, scrubbed: playhead > 0 });
    },
    scrub: frame => {
      const { playhead: from, setPlayhead } = get();
      setPlayhead(frame);
      const { motion, playhead: to } = get();
      const key = motion && lastCrossed(motion, from, to);
      if (key) set({ selectedKeyId: key.id });
    },
    togglePlay: () => {
      const { motion, playing, playhead, recording, picking, frames, pause } = get();
      if (!motion || recording || picking) return;
      if (playing) { pause(); return; }
      playStart = playhead >= frames - 1 ? 0 : playhead;
      set({ playing: true, scrubbed: false, playhead: playStart });
    },
    pause: () => {
      const { motion, playing, playhead } = get();
      if (!playing) return;
      const key = motion && lastCrossed(motion, playStart, playhead);
      set({ playing: false, ...(key ? { selectedKeyId: key.id } : {}) });
    },
    leave: () => set({ playing: false, recording: false }),
    beginMaskDrag: () => {
      const motion = animating(), { playhead } = get();
      if (!motion) return null;
      set({ playing: false });
      if (playhead === 0) {
        if (motion.keys.length > 1) {
          set({ notice: "The first frame keeps the mask you drew. Move the playhead to a later time first." });
          return null;
        }
        // With no keys yet, the first drag sets where the mask ends up.
        set({ playhead: lastFrame(motion) });
        return { ...motion.anchor, sx: 1, sy: 1 };
      }
      const curve = buildMotionCurve(motion);
      return { ...curve.positionAt(playhead), ...curve.scaleAt(playhead) };
    },
    placeMask: pose => {
      const motion = animating(), { playhead } = get();
      if (!motion) return;
      const result = upsertKey(motion, playhead, { ...pose, ...bounded(pose) }, newId());
      if (!result) { set({ notice: "You've reached the key limit. Delete a key to add another." }); return; }
      edit(result.motion, { selectedKeyId: result.id });
    },
    addKey: () => {
      const motion = animating(), { playhead } = get();
      if (!motion) return;
      if (playhead === 0) { set({ notice: "The first frame already has a key: the mask you drew." }); return; }
      const existing = motion.keys.find(key => key.frame === playhead);
      if (existing) { set({ selectedKeyId: existing.id }); return; }
      const curve = buildMotionCurve(motion);
      const result = upsertKey(motion, playhead, { ...curve.positionAt(playhead), ...curve.scaleAt(playhead) }, newId());
      if (!result) { set({ notice: "You've reached the key limit. Delete a key to add another." }); return; }
      edit(result.motion, { selectedKeyId: result.id });
    },
    selectKey: id => set({ selectedKeyId: id }),
    moveKey: (id, point) => { const motion = animating(); if (motion) edit(moveKey(motion, id, bounded(point))); },
    retimeKey: (id, frame) => {
      const motion = animating();
      if (!motion) return;
      const next = retimeKey(motion, id, frame);
      edit(next, { playhead: next.keys.find(key => key.id === id)?.frame ?? get().playhead });
    },
    insertAtLength: length => {
      const motion = animating();
      if (!motion) return null;
      const result = insertKeyAtLength(motion, length, newId());
      if (!result) return null;
      edit(result.motion, { selectedKeyId: result.id, playing: false,
        playhead: result.motion.keys.find(key => key.id === result.id)!.frame });
      return result.id;
    },
    deleteSelected: () => {
      const motion = animating(), { selectedKeyId } = get();
      if (!motion || !selectedKeyId || isStartKey(motion, selectedKeyId)) return;
      edit(deleteKey(motion, selectedKeyId), { selectedKeyId: null });
    },
    resetScale: () => {
      const motion = animating(), key = motion?.keys.find(key => key.id === get().selectedKeyId);
      if (motion && key) edit(moveKey(motion, key.id, { x: key.x, y: key.y, sx: 1, sy: 1 }));
    },
    clearPath: () => {
      const motion = animating(), { bounds } = get();
      if (!motion || !bounds || get().recording) return;
      patchMask({ motion: createMaskMotion(bounds, motion.frames), track: null }, { ...edited, playhead: 0, playing: false, scrubbed: false, selectedKeyId: null });
    },
    startRecording: () => {
      const motion = animating(), { recording, scrubbed, playhead } = get();
      if (!motion || recording || scrubbed || motion.keys.length > 1) return null;
      const start = playhead >= lastFrame(motion) ? 0 : playhead;
      set({ recording: true, playing: false, playhead: start, selectedKeyId: null, notice: null });
      return start;
    },
    finishRecording: samples => {
      const { motion, recording, playhead } = get();
      if (!motion || !recording) return;
      const next = applyRecording(motion, samples, playhead, newId);
      patchMask({ motion: next }, { recording: false, playing: false, ...edited,
        notice: next === motion ? "Nothing was recorded. Press on the mask and drag it along its path." : null });
    },
    startPicking: async () => {
      const { source, video, recording, picking } = get(), motion = animating();
      if (!source || !video || !motion || recording || picking || useFollowSelection.getState().busy || motion.keys.length > 1) return;
      set({ picking: true, playing: false, playhead: 0, scrubbed: false, selectedKeyId: null, error: null, notice: null });
      // Subjects found for other masks stay listed, but only those this mask followed are ticked.
      const { candidates } = useFollowSelection.getState(), followIds = get().masks.find(mask => mask.id === get().activeMaskId)?.followIds ?? [];
      useFollowSelection.setState({ selectedIds: followIds.filter(id => candidates.some(candidate => candidate.id === id)) });
      if (useFollowSelection.getState().image) return;
      controller = new AbortController();
      const { signal } = controller;
      set({ task: "frame", status: "preparing", progress: null, job: null });
      try {
        // Selected on the frame the tracker sees, so the subjects' masks start it as they are.
        const frame = await abortable(readFrame(source, 0, inpaintSize(video.width, video.height)), signal);
        set({ status: "uploading" });
        const form = new FormData();
        form.set("videoId", video.id); form.set("image", frame, "frame.png");
        const image = imageAssetSchema.parse(await apiRequest("/frames", { method: "POST", body: form, signal }));
        signal.throwIfAborted();
        useFollowSelection.getState().setImage(image);
      } catch (error) {
        set({ picking: false, ...(signal.aborted ? {} : { error: message(error) }) });
      } finally { controller = null; set({ status: "idle", task: null, progress: null }); }
    },
    stopPicking: () => {
      if (get().task === "frame") controller?.abort();
      if (get().picking) patchMask({ followIds: useFollowSelection.getState().selectedIds });
      set({ picking: false });
    },
    followObject: async () => {
      const { source, video, frames, recording, picking } = get(), motion = animating();
      const selection = useFollowSelection.getState();
      if (!picking || !source || !video || !motion || recording || motion.keys.length > 1) return;
      if (!selection.image || !selection.selectedIds.length || selection.busy || hasPendingPoints(selection)) return;
      const { image, selectedIds } = selection, id = get().activeMaskId!;
      patchMask({ followIds: selectedIds });
      controller = new AbortController();
      const { signal } = controller;
      set({ task: "track", status: "preparing", progress: 0, picking: false, playing: false, playhead: 0, selectedKeyId: null, error: null, notice: null, job: null });
      try {
        const size = inpaintSize(video.width, video.height);
        const prepared = await renderInpaintVideos({ source, frames, masks: null, size }, progress => set({ progress }), signal);
        signal.throwIfAborted();
        const form = new FormData();
        form.set("request", JSON.stringify({ videoId: video.id, ...size, frames, frameId: image.id, candidateIds: selectedIds }));
        form.set("source", prepared.source, `source.${prepared.container}`);
        const result = await runJob("/jobs/track", form, signal);
        if (!result) { set({ notice: "Tracking cancelled." }); return; }
        if (!result.tracking) throw new Error("Tracking completed without a track.");
        const followed = followTrack(get().masks.find(mask => mask.id === id)?.motion ?? motion, result.tracking, videoFrame(video), newId);
        if (!followed) throw new Error("SAM couldn't find the selected object on the first frame. Select it again.");
        patchMask({ motion: followed.motion, track: result.tracking }, { ...edited, notice: followed.filled
          ? `The object was lost on ${followed.filled} of ${frames} frames, so those were filled in.` : null }, id);
      } catch (error) {
        set(signal.aborted ? { notice: "Tracking cancelled." } : { error: message(error) });
      } finally { controller = null; set({ status: "idle", task: null, progress: null }); }
    },
    setPrompt: prompt => { if (get().status === "idle") set({ prompt, ...edited }); },
    setSoundEffects: soundEffects => { if (get().status === "idle") set({ soundEffects, ...edited }); },
    setMusic: music => { if (get().status === "idle") set({ music, ...edited }); },
    setTier: tier => { if (get().status === "idle") set({ tier, ...edited }); },
    setGrow: grow => { if (get().status === "idle") set({ grow: stepped(grow, MASK_GROW), ...edited }); },
    setFeather: feather => { if (get().status === "idle") set({ feather: stepped(feather, MASK_FEATHER), ...edited }); },
    setAudio: audio => { if (get().status === "idle") set({ audio, ...edited }); },
    setReference: reference => {
      if (get().status !== "idle") return;
      const role: ReferenceRole | null = reference && { kind: "object" };
      set({ reference, referenceRole: role, definition: role ? referenceDefinition(role) : "", created: null, ...edited });
    },
    setDefinition: definition => { if (get().status === "idle") set({ definition, ...edited }); },
    // A frame is picked on the source's timeline, so the preview shows the source rather than a result.
    openCreator: creating => { if (get().status === "idle") set({ creating, playing: false, error: null, ...(creating === "frame" ? { view: "preview" } : {}) }); },
    setReferenceText: referenceText => set({ referenceText }),
    createReference: async () => {
      const { source, video, frames, masks, playhead, creating, referenceText, status } = get();
      const description = referenceText.trim();
      if (status !== "idle" || !source || !video || !creating || !description || (creating === "frame" && !masks.length)) return;
      controller = new AbortController();
      const { signal } = controller;
      set({ task: "reference", status: "preparing", progress: null, picking: false, playing: false, error: null, notice: null, job: null });
      try {
        const request: ReferenceRequest = creating === "object" ? { kind: "object", videoId: video.id, description }
          : { kind: "frame", videoId: video.id, description, frame: playhead };
        const form = new FormData();
        form.set("request", JSON.stringify(request));
        if (creating === "frame") {
          const shapes = allBoxes(video).map(({ shape, boxes }) => ({ shape, box: boxes[playhead] }));
          if (shapes.every(({ box }) => outside(box))) {
            throw new Error(`${shapes.length > 1 ? "Every mask is" : "The mask is"} outside the frame here. Move the playhead to where one covers the video.`);
          }
          const frame = await captureFrame({ source, frame: playhead, size: referenceFrameSize(video), masks: shapes });
          signal.throwIfAborted();
          form.set("image", frame.image, "frame.png"); form.set("mask", frame.mask, "mask.png");
        }
        const result = await runJob("/jobs/reference", form, signal);
        if (!result) { set({ notice: "Reference cancelled." }); return; }
        const created = result.reference;
        if (!created) throw new Error("Qwen Image completed without an image.");
        const response = await fetch(created.image.url, { credentials: "same-origin", signal });
        if (!response.ok) throw new Error("Could not download the reference image. Try again.");
        const reference = new File([await response.blob()], `${created.kind}.png`, { type: "image/png" });
        signal.throwIfAborted();
        const role: ReferenceRole = created.frame === null ? { kind: "object" } : { kind: "frame", frame: created.frame, frames };
        set({ reference, referenceRole: role, definition: referenceDefinition(role, created.description), created, creating: null, ...edited });
      } catch (error) {
        set(signal.aborted ? { notice: "Reference cancelled." } : { error: message(error) });
      } finally { controller = null; set({ status: "idle", task: null, progress: null }); }
    },
    recreateReference: async () => {
      const { created, status } = get();
      if (!created || status !== "idle") return;
      set({ creating: created.kind, referenceText: created.description, ...(created.frame === null ? {} : { playhead: created.frame, playing: false }) });
      await get().createReference();
    },
    setView: view => set({ view }), clearError: () => set({ error: null }),
    generate: async () => {
      const { source, video, frames, masks, prompt, soundEffects, music, tier, grow, feather, reference, referenceRole, definition, status } = get();
      const audio = audioMode(video, get().audio);
      if (status !== "idle" || !source || !video || !masks.length || !prompt.trim()) return;
      controller = new AbortController();
      const { signal } = controller;
      set({ task: "inpaint", status: "preparing", progress: 0, picking: false, error: null, notice: null, job: null, playing: false });
      try {
        const size = inpaintSize(video.width, video.height, tier);
        // A replaced sound is left out of the source, so H3 never hears it.
        const videos = await renderInpaintVideos({ source, frames, masks: allBoxes(video), size, grow, audio: audio !== "replace" }, progress => set({ progress }), signal);
        signal.throwIfAborted();
        if (!videos.mask) throw new Error("Could not prepare the mask video.");
        const form = new FormData();
        const text = composeInpaintPrompt(prompt, reference && referenceRole ? { role: referenceRole, definition } : undefined, { soundEffects, music, mode: audio });
        form.set("request", JSON.stringify({ videoId: video.id, ...size, frames, prompt: text, feather, audio }));
        form.set("source", videos.source, `source.${videos.container}`);
        form.set("mask", videos.mask, `mask.${videos.container}`);
        if (reference) form.set("reference", reference);
        const result = await runJob("/jobs/inpaint", form, signal);
        if (!result) { set({ notice: "Inpainting cancelled." }); return; }
        if (!result.inpainting) throw new Error("Inpainting completed without a video.");
        set({ result: result.inpainting, view: "result", notice: null });
      } catch (error) {
        set(signal.aborted ? { notice: "Inpainting cancelled." } : { error: message(error) });
      } finally { controller = null; set({ status: "idle", task: null, progress: null }); }
    },
    cancel: async () => {
      const { status, job } = get();
      // Before upload, and after the remote job has finished (e.g. while downloading its result), the work is local.
      if (status === "preparing" || status === "uploading" || (job && !["queued", "running"].includes(job.status))) { controller?.abort(); return; }
      if (status !== "generating" || !job) return;
      try { await apiRequest(`/jobs/${job.id}/cancel`, { method: "POST" }); }
      catch (error) { set({ error: message(error) }); }
    },
  };
});
