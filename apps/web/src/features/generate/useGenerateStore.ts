import { create } from "zustand";
import { LOCK_IN, jobSnapshotSchema, validateMotion } from "@h3-motion/shared";
import type { AnimateRequest, AnimationResult, JobSnapshot } from "@h3-motion/shared";
import { apiRequest, watchJob } from "../../api";
import { currentIsolation, useSelectionStore } from "../select";
import { currentParts, resolveInputs } from "./inputs";
import type { Tier } from "./inputs";
import { renderMotionVideos } from "./renderMotion";

export type GenerateStatus = "idle" | "rendering" | "uploading" | "generating";
export interface GeneratedVideo extends AnimationResult { signature: string }

interface GenerateState {
  lockIn: number; tier: Tier; seed: string; prompt: string | null;
  status: GenerateStatus; progress: number | null; job: JobSnapshot | null;
  result: GeneratedVideo | null; view: "source" | "result"; error: string | null; notice: string | null;
  setLockIn: (lockIn: number) => void; setTier: (tier: Tier) => void; setSeed: (seed: string) => void;
  /** null returns to the automatic prompt. */
  setPrompt: (prompt: string | null) => void;
  setView: (view: "source" | "result") => void; clearError: () => void;
  /** Renders, uploads and generates. `newSeed` ignores the seed field, for Regenerate. */
  generate: (options?: { newSeed?: boolean }) => Promise<void>;
  cancel: () => Promise<void>;
}

const message = (error: unknown) => error instanceof Error ? error.message : "Something went wrong. Try again.";
let controller: AbortController | null = null;

export const useGenerateStore = create<GenerateState>((set, get) => ({
  lockIn: LOCK_IN.default, tier: 480, seed: "", prompt: null,
  status: "idle", progress: null, job: null, result: null, view: "source", error: null, notice: null,
  setLockIn: lockIn => set({ lockIn: Math.min(LOCK_IN.max, Math.max(LOCK_IN.min, Math.round(lockIn / LOCK_IN.step) * LOCK_IN.step)) }),
  setTier: tier => set({ tier }),
  setSeed: seed => set({ seed }),
  setPrompt: prompt => set({ prompt }),
  setView: view => set({ view }),
  clearError: () => set({ error: null }),
  generate: async ({ newSeed = false } = {}) => {
    const { status, tier, lockIn, prompt, seed: seedText } = get();
    if (status !== "idle") return;
    const inputs = resolveInputs(currentParts({ tier, lockIn, prompt }));
    if (!inputs) { set({ error: "Isolate the subject and give it a path before generating." }); return; }
    const invalid = validateMotion(inputs.motion)[0];
    if (invalid) { set({ error: invalid }); return; }
    if (inputs.motion.keys.length < 2) { set({ error: "The subject doesn't move yet. Go back to Move and drag it along a path." }); return; }
    let seed: number | undefined;
    if (!newSeed && seedText.trim()) {
      seed = Number(seedText.trim());
      if (!Number.isSafeInteger(seed) || seed < 0) { set({ error: "The seed must be a whole number, 0 or more. Leave it empty for a random seed." }); return; }
    }
    controller = new AbortController();
    const { signal } = controller;
    set({ status: "rendering", progress: 0, error: null, notice: null, job: null });
    try {
      const videos = await renderMotionVideos(inputs.layers, inputs.motion, inputs.size, value => set({ progress: value }), signal);
      signal.throwIfAborted();
      set({ status: "uploading", progress: null });
      const request: AnimateRequest = { imageId: inputs.image.id, maskId: inputs.mask.id, plateId: inputs.isolation.plate.id,
        ...inputs.size, frames: inputs.motion.frames, prompt: inputs.prompt, lockIn: inputs.lockIn, ...(seed === undefined ? {} : { seed }) };
      const form = new FormData();
      form.set("request", JSON.stringify(request));
      form.set("reference", videos.reference, `reference.${videos.container}`);
      form.set("mask", videos.mask, `mask.${videos.container}`);
      form.set("start", videos.start, "start.png");
      // Keep the response handle: aborting an upload can leave an accepted server job running.
      const initial = jobSnapshotSchema.parse(await apiRequest("/jobs/animate", { method: "POST", body: form }));
      set({ status: "generating", job: initial, progress: initial.progress });
      if (signal.aborted && ["queued", "running"].includes(initial.status)) await get().cancel();
      const result = await watchJob(initial, job => set({ job, progress: job.progress }));
      if (result.status === "failed") throw new Error(result.error ?? result.message);
      if (result.status === "cancelled") { set({ notice: "Generation cancelled. Your last video is unchanged." }); return; }
      if (!result.animation) throw new Error("Generation completed without a video. Try again.");
      set({ result: { ...result.animation, signature: inputs.signature }, view: "result", notice: result.message });
    } catch (error) {
      set(signal.aborted && get().status === "rendering"
        ? { notice: "Generation cancelled. Your last video is unchanged." } : { error: message(error) });
    } finally {
      controller = null;
      set({ status: "idle", progress: null });
    }
  },
  cancel: async () => {
    const { status, job } = get();
    if (status === "rendering" || status === "uploading") { controller?.abort(); return; }
    if (status !== "generating" || !job) return;
    try { await apiRequest(`/jobs/${job.id}/cancel`, { method: "POST" }); }
    catch (error) { set({ error: message(error) }); }
  },
}));

/** The last result, if it was made for the current photo, selection and background. */
export function useCurrentResult(): GeneratedVideo | null {
  const result = useGenerateStore(s => s.result);
  const image = useSelectionStore(s => s.image);
  const mask = useSelectionStore(s => s.mask);
  const plateId = useSelectionStore(s => currentIsolation(s)?.plate.id);
  return result && result.imageId === image?.id && result.maskId === mask?.id && result.plateId === plateId ? result : null;
}
