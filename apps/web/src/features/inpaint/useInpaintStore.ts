import { create } from "zustand";
import { MAX_VIDEO_UPLOAD_BYTES, clampMask, inpaintFrames, inpaintSize, jobSnapshotSchema, maskAt, videoAssetSchema } from "@h3-motion/shared";
import type { InpaintResult, JobSnapshot, MaskBox, MaskKeyframe, MaskShape, VideoAsset } from "@h3-motion/shared";
import { apiRequest, watchJob } from "../../api";
import { renderInpaintVideos } from "./renderInpaint";

type Status = "idle" | "preparing" | "uploading" | "generating";
interface InpaintState {
  source: File | null; video: VideoAsset | null; frames: number; uploading: boolean;
  step: 0 | 1 | 2; shape: MaskShape; keys: MaskKeyframe[]; playhead: number; playing: boolean;
  prompt: string; reference: File | null; result: InpaintResult | null; view: "preview" | "result";
  status: Status; progress: number | null; job: JobSnapshot | null; error: string | null; notice: string | null;
  upload(file: File): Promise<boolean>; visitStep(step: 0 | 1 | 2): void;
  setShape(shape: MaskShape): void; setMask(box: MaskBox): void; addKey(): void; deleteKey(frame: number): void;
  setPlayhead(frame: number): void; setPlaying(playing: boolean): void;
  setPrompt(prompt: string): void; setReference(file: File | null): void; setView(view: "preview" | "result"): void;
  clearError(): void; generate(): Promise<void>; cancel(): Promise<void>;
}
let controller: AbortController | null = null;
const message = (error: unknown) => error instanceof Error ? error.message : "Something went wrong. Try again.";
const edited = { view: "preview" as const, notice: null };

export const useInpaintStore = create<InpaintState>((set, get) => ({
  source: null, video: null, frames: 124, uploading: false, step: 0, shape: "rectangle", keys: [], playhead: 0, playing: false,
  prompt: "", reference: null, result: null, view: "preview", status: "idle", progress: null, job: null, error: null, notice: null,
  upload: async file => {
    if (get().uploading || get().status !== "idle") return false;
    set({ uploading: true, error: null });
    try {
      if (file.size > MAX_VIDEO_UPLOAD_BYTES) throw new Error("Choose a video up to 200 MB.");
      const form = new FormData(); form.set("video", file);
      const video = videoAssetSchema.parse(await apiRequest("/videos", { method: "POST", body: form }));
      set({ source: file, video, frames: inpaintFrames(video.duration), step: 0, keys: [], playhead: 0, playing: false,
        shape: "rectangle", prompt: "", reference: null, result: null, job: null, progress: null, ...edited });
      return true;
    } catch (error) { set({ error: message(error) }); return false; }
    finally { set({ uploading: false }); }
  },
  visitStep: step => {
    if (get().status !== "idle" || (step > 0 && !get().keys.length)) return;
    set({ step, playing: false, view: "preview", ...(step === 0 ? { playhead: 0 } : {}) });
  },
  setShape: shape => { if (get().status === "idle") set({ shape, ...edited }); },
  setMask: box => {
    if (get().status !== "idle" || !get().video || get().step === 2) return;
    const { step, keys, playhead } = get();
    const key = { ...clampMask(box), frame: step === 0 ? 0 : playhead };
    set({ keys: [...keys.filter(k => k.frame !== key.frame), key].sort((a, b) => a.frame - b.frame), ...edited });
  },
  addKey: () => {
    const { keys, playhead, status } = get(), box = maskAt(keys, playhead);
    if (status !== "idle" || !box || keys.some(k => k.frame === playhead)) return;
    set({ keys: [...keys, { ...box, frame: playhead }].sort((a, b) => a.frame - b.frame), ...edited });
  },
  deleteKey: frame => {
    if (frame === 0 || get().status !== "idle") return;
    set({ keys: get().keys.filter(key => key.frame !== frame), ...edited });
  },
  setPlayhead: frame => set({ playhead: Math.max(0, Math.min(get().frames - 1, Math.round(frame))) }),
  setPlaying: playing => set({ playing }),
  setPrompt: prompt => { if (get().status === "idle") set({ prompt, ...edited }); },
  setReference: reference => { if (get().status === "idle") set({ reference, ...edited }); },
  setView: view => set({ view }), clearError: () => set({ error: null }),
  generate: async () => {
    const { source, video, frames, keys, shape, prompt, reference, status } = get();
    if (status !== "idle" || !source || !video || !keys.length || !prompt.trim()) return;
    controller = new AbortController();
    const { signal } = controller;
    set({ status: "preparing", progress: 0, error: null, notice: null, job: null, playing: false });
    try {
      const size = inpaintSize(video.width, video.height);
      const videos = await renderInpaintVideos({ source, frames, keys, shape, size }, progress => set({ progress }), signal);
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
}));
