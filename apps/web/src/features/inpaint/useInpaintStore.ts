import { create } from "zustand";
import {
  MAX_VIDEO_UPLOAD_BYTES, applyRecording, buildMotionCurve, createMaskMotion, deleteKey, fitMask, inpaintFrames, inpaintSize, insertKeyAtLength,
  isStartKey, jobSnapshotSchema, lastFrame, maskBoxes, moveKey, rebaseMask, retimeKey, upsertKey, videoAssetSchema,
} from "@h3-motion/shared";
import type { FrameSize, InpaintResult, JobSnapshot, MaskShape, Point, Pose, Rect, Scale, SubjectMotion, TimedSample, VideoAsset } from "@h3-motion/shared";
import { apiRequest, watchJob } from "../../api";
import { renderInpaintVideos } from "./renderInpaint";

type Status = "idle" | "preparing" | "uploading" | "generating";
interface InpaintState {
  source: File | null; video: VideoAsset | null; frames: number; uploading: boolean;
  step: 0 | 1 | 2; shape: MaskShape;
  /** The mask drawn on the first frame, in video pixels. `motion` moves and resizes it from there, anchored at its centre. */
  bounds: Rect | null; motion: SubjectMotion<number> | null;
  playhead: number; playing: boolean; recording: boolean;
  /** The user parked the playhead after the first frame, so a still mask is keyframed there instead of recorded. */
  scrubbed: boolean; selectedKeyId: string | null;
  prompt: string; reference: File | null; result: InpaintResult | null; view: "preview" | "result";
  status: Status; progress: number | null; job: JobSnapshot | null; error: string | null; notice: string | null;
  upload(file: File): Promise<boolean>; visitStep(step: 0 | 1 | 2): void; setShape(shape: MaskShape): void;
  /** Draws or redraws the first-frame mask. Later keys keep their position and size on screen. */
  drawMask(rect: Rect): void;
  /** Moves the playhead for the user; parking it after the first frame switches path creation to keyframing. */
  setPlayhead(frame: number): void;
  /** Moves the playhead like setPlayhead and selects the last key it passed or landed on. */
  scrub(frame: number): void; togglePlay(): void;
  /** Stops playback and selects the last key it passed since play started. */
  pause(): void;
  /** Stops playback and drops an unfinished take, e.g. when the editor closes. */
  leave(): void;
  /** Starts dragging or resizing the mask at the playhead; returns its pose there, or null if this frame can't change. */
  beginMaskDrag(): Pose | null;
  /** Keys the mask's centre, and its scale when given, at the playhead. */
  placeMask(pose: Point & Partial<Scale>): void; addKey(): void;
  selectKey(id: string | null): void; moveKey(id: string, point: Point): void;
  retimeKey(id: string, frame: number): void; insertAtLength(length: number): string | null;
  deleteSelected(): void; resetScale(): void; clearPath(): void;
  /** Starts a take on a still mask, unless the user scrubbed first; returns the frame it starts at. */
  startRecording(): number | null;
  /** Applies a take, timed to fill the clip from the playhead where it started. */
  finishRecording(samples: TimedSample[]): void;
  setPrompt(prompt: string): void; setReference(file: File | null): void; setView(view: "preview" | "result"): void;
  clearError(): void; generate(): Promise<void>; cancel(): Promise<void>;
}
let controller: AbortController | null = null;
const message = (error: unknown) => error instanceof Error ? error.message : "Something went wrong. Try again.";
const edited = { view: "preview" as const, notice: null };
const newId = () => globalThis.crypto.randomUUID();
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
export const videoFrame = (video: Pick<VideoAsset, "width" | "height">): FrameSize => ({ width: video.width, height: video.height });

/** The key nearest `to` among those passed moving the playhead from `from` to `to`, excluding where it started. */
function lastCrossed(motion: SubjectMotion<number>, from: number, to: number) {
  const crossed = motion.keys.filter(key => to > from ? key.frame > from && key.frame <= to : key.frame < from && key.frame >= to);
  return crossed.reduce<typeof crossed[number] | null>((best, key) => !best || Math.abs(key.frame - to) < Math.abs(best.frame - to) ? key : best, null);
}

export const useInpaintStore = create<InpaintState>((set, get) => {
  let playStart = 0;
  /** The mask's motion while it can be animated: idle, on the Animate step. */
  function animating() {
    const { motion, status, step } = get();
    return status === "idle" && step === 1 ? motion : null;
  }
  /** Keeps dragged positions within one frame's width or height of the video, so keys stay reachable. */
  function bounded(point: Point): Point {
    const { video } = get();
    if (!video) return point;
    return { x: clamp(point.x, -video.width, video.width * 2), y: clamp(point.y, -video.height, video.height * 2) };
  }
  function edit(next: SubjectMotion<number>, extra: Partial<InpaintState> = {}) {
    if (next !== get().motion) set({ motion: next, ...edited, ...extra });
  }
  return {
    source: null, video: null, frames: 124, uploading: false, step: 0, shape: "rectangle", bounds: null, motion: null,
    playhead: 0, playing: false, recording: false, scrubbed: false, selectedKeyId: null,
    prompt: "", reference: null, result: null, view: "preview", status: "idle", progress: null, job: null, error: null, notice: null,
    upload: async file => {
      if (get().uploading || get().status !== "idle") return false;
      set({ uploading: true, error: null });
      try {
        if (file.size > MAX_VIDEO_UPLOAD_BYTES) throw new Error("Choose a video up to 200 MB.");
        const form = new FormData(); form.set("video", file);
        const video = videoAssetSchema.parse(await apiRequest("/videos", { method: "POST", body: form }));
        set({ source: file, video, frames: inpaintFrames(video.duration), step: 0, bounds: null, motion: null,
          playhead: 0, playing: false, recording: false, scrubbed: false, selectedKeyId: null,
          shape: "rectangle", prompt: "", reference: null, result: null, job: null, progress: null, ...edited });
        return true;
      } catch (error) { set({ error: message(error) }); return false; }
      finally { set({ uploading: false }); }
    },
    visitStep: step => {
      if (get().status !== "idle" || get().recording || (step > 0 && !get().bounds)) return;
      set({ step, playing: false, view: "preview", ...(step === 0 ? { playhead: 0, scrubbed: false, selectedKeyId: null } : {}) });
    },
    setShape: shape => { if (get().status === "idle") set({ shape, ...edited }); },
    drawMask: rect => {
      const { video, bounds, motion, frames, status, step } = get();
      if (status !== "idle" || !video || step !== 0) return;
      const next = fitMask(rect, videoFrame(video));
      set({ bounds: next, motion: motion && bounds ? rebaseMask(motion, bounds, next) : createMaskMotion(next, frames), ...edited });
    },
    setPlayhead: frame => {
      if (get().recording) return;
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
      const { motion, playing, playhead, recording, frames, pause } = get();
      if (!motion || recording) return;
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
          set({ notice: "The first frame keeps the mask you drew. Move the playhead to a later time, or go back to Draw mask to change it." });
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
      edit(createMaskMotion(bounds, motion.frames), { playhead: 0, playing: false, scrubbed: false, selectedKeyId: null });
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
      set({ motion: next, recording: false, playing: false, ...edited,
        notice: next === motion ? "Nothing was recorded. Press on the mask and drag it along its path." : null });
    },
    setPrompt: prompt => { if (get().status === "idle") set({ prompt, ...edited }); },
    setReference: reference => { if (get().status === "idle") set({ reference, ...edited }); },
    setView: view => set({ view }), clearError: () => set({ error: null }),
    generate: async () => {
      const { source, video, frames, bounds, motion, shape, prompt, reference, status } = get();
      if (status !== "idle" || !source || !video || !bounds || !motion || !prompt.trim()) return;
      controller = new AbortController();
      const { signal } = controller;
      set({ status: "preparing", progress: 0, error: null, notice: null, job: null, playing: false });
      try {
        const size = inpaintSize(video.width, video.height);
        const boxes = maskBoxes(bounds, motion, videoFrame(video));
        const videos = await renderInpaintVideos({ source, frames, boxes, shape, size }, progress => set({ progress }), signal);
        signal.throwIfAborted();
        set({ status: "uploading", progress: null });
        const form = new FormData();
        form.set("request", JSON.stringify({ videoId: video.id, ...size, frames, prompt }));
        form.set("source", videos.source, `source.${videos.container}`);
        form.set("mask", videos.mask, `mask.${videos.container}`);
        if (reference) form.set("reference", reference);
        const initial = jobSnapshotSchema.parse(await apiRequest("/jobs/inpaint", { method: "POST", body: form, signal }));
        set({ status: "generating", job: initial });
        if (signal.aborted && ["queued", "running"].includes(initial.status)) await get().cancel();
        const result = await watchJob(initial, job => set({ job, progress: job.progress }));
        if (result.status === "failed") throw new Error(result.error ?? result.message);
        if (result.status === "cancelled") { set({ notice: "Inpainting cancelled." }); return; }
        if (!result.inpainting) throw new Error("Inpainting completed without a video.");
        set({ result: result.inpainting, view: "result", notice: null });
      } catch (error) {
        set(signal.aborted ? { notice: "Inpainting cancelled." } : { error: message(error) });
      } finally { controller = null; set({ status: "idle", progress: null }); }
    },
    cancel: async () => {
      const { status, job } = get();
      if (status === "preparing" || status === "uploading") { controller?.abort(); return; }
      if (status !== "generating" || !job) return;
      try { await apiRequest(`/jobs/${job.id}/cancel`, { method: "POST" }); }
      catch (error) { set({ error: message(error) }); }
    },
  };
});
