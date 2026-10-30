import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { EDGE_FREEDOM, LOCK_IN, jobSnapshotSchema, parseH3Prompt, validateMotion } from "@h3-motion/shared";
import type { AnimateRequest, AnimationResult, JobSnapshot } from "@h3-motion/shared";
import { apiRequest, watchJob } from "../../api";
import { currentIsolation, useSelectionStore } from "../select";
import { currentParts, resolveInputs } from "./inputs";
import type { Tier } from "./inputs";
import { renderMotionVideos } from "./renderMotion";
import type { PromptMode } from "../shell/PromptModeToggle";

export type GenerateStatus = "idle" | "rendering" | "uploading" | "generating";
export interface GeneratedVideo extends AnimationResult { signature: string }

interface GenerateState {
  lockIn: number; edgeFreedom: number; tier: Tier; seed: string; prompt: string | null;
  soundEffects: string | null; music: string;
  /** In raw mode `rawPrompt` is sent as written; the fields keep the formatted prompt it started from. */
  promptMode: PromptMode; rawPrompt: string;
  /** The raw prompt couldn't be split back into the fields when formatted mode was chosen. */
  unformattable: boolean;
  status: GenerateStatus; progress: number | null; job: JobSnapshot | null;
  result: GeneratedVideo | null; view: "source" | "result"; error: string | null; notice: string | null;
  setLockIn: (lockIn: number) => void; setEdgeFreedom: (edgeFreedom: number) => void; setTier: (tier: Tier) => void; setSeed: (seed: string) => void;
  /** null follows the generated main prompt or sound effects. */
  setPrompt: (prompt: string | null) => void;
  setSoundEffects: (soundEffects: string | null) => void; setMusic: (music: string) => void;
  /** Raw starts from the formatted prompt. Formatted splits the raw prompt back into the fields, or flags it `unformattable`. */
  setPromptMode: (mode: PromptMode) => void; setRawPrompt: (rawPrompt: string) => void;
  /** Drops the raw prompt and returns to the formatted prompt it started from. */
  resetPrompt: () => void; keepRawPrompt: () => void;
  setView: (view: "source" | "result") => void; clearError: () => void;
  /** Renders, uploads and generates. `newSeed` ignores the seed field, for Regenerate. */
  generate: (options?: { newSeed?: boolean }) => Promise<void>;
  cancel: () => Promise<void>;
}

/** The prompt settings `resolveInputs` reads; `rawPrompt` only in raw mode. */
export function promptSettings({ tier, lockIn, edgeFreedom, prompt, soundEffects, music, promptMode, rawPrompt }:
  Pick<GenerateState, "tier" | "lockIn" | "edgeFreedom" | "prompt" | "soundEffects" | "music" | "promptMode" | "rawPrompt">) {
  return { tier, lockIn, edgeFreedom, prompt, soundEffects, music, rawPrompt: promptMode === "raw" ? rawPrompt : null };
}

/** The current prompt settings, so every view resolves the same inputs, and signature, that `generate` sends. */
export function usePromptSettings() {
  return promptSettings(useGenerateStore(useShallow(({ tier, lockIn, edgeFreedom, prompt, soundEffects, music, promptMode, rawPrompt }) =>
    ({ tier, lockIn, edgeFreedom, prompt, soundEffects, music, promptMode, rawPrompt }))));
}

const message = (error: unknown) => error instanceof Error ? error.message : "Something went wrong. Try again.";
let controller: AbortController | null = null;

export const useGenerateStore = create<GenerateState>((set, get) => ({
  lockIn: LOCK_IN.default, edgeFreedom: EDGE_FREEDOM.default, tier: 768, seed: "", prompt: null, soundEffects: null, music: "",
  promptMode: "formatted", rawPrompt: "", unformattable: false,
  status: "idle", progress: null, job: null, result: null, view: "source", error: null, notice: null,
  setLockIn: lockIn => set({ lockIn: Math.min(LOCK_IN.max, Math.max(LOCK_IN.min, Math.round(lockIn / LOCK_IN.step) * LOCK_IN.step)) }),
  setEdgeFreedom: edgeFreedom => set({ edgeFreedom: Math.min(EDGE_FREEDOM.max, Math.max(EDGE_FREEDOM.min, Math.round(edgeFreedom / EDGE_FREEDOM.step) * EDGE_FREEDOM.step)) }),
  setTier: tier => set({ tier }),
  setSeed: seed => set({ seed }),
  setPrompt: prompt => set({ prompt }),
  setSoundEffects: soundEffects => set({ soundEffects }),
  setMusic: music => set({ music }),
  setPromptMode: mode => {
    const state = get();
    if (state.status !== "idle" || mode === state.promptMode) return;
    const formatted = resolveInputs(currentParts({ ...promptSettings(state), rawPrompt: null }));
    if (mode === "raw") { if (formatted) set({ promptMode: "raw", rawPrompt: formatted.prompt, unformattable: false }); return; }
    if (formatted && state.rawPrompt.trim() === formatted.prompt) { set({ promptMode: "formatted", unformattable: false }); return; }
    const fields = parseH3Prompt(state.rawPrompt);
    if (!fields) { set({ unformattable: true }); return; }
    // A field left as it was keeps following the automatic prompt.
    const current = formatted?.promptFields;
    set({ promptMode: "formatted", unformattable: false, music: fields.music,
      prompt: fields.mainPrompt === current?.mainPrompt ? state.prompt : fields.mainPrompt,
      soundEffects: fields.soundEffects === current?.soundEffects ? state.soundEffects : fields.soundEffects });
  },
  setRawPrompt: rawPrompt => set({ rawPrompt, unformattable: false }),
  resetPrompt: () => { if (get().status === "idle") set({ promptMode: "formatted", unformattable: false }); },
  keepRawPrompt: () => set({ unformattable: false }),
  setView: view => set({ view }),
  clearError: () => set({ error: null }),
  generate: async ({ newSeed = false } = {}) => {
    const { status, seed: seedText } = get();
    if (status !== "idle") return;
    const inputs = resolveInputs(currentParts(promptSettings(get())));
    if (!inputs) { set({ error: "Isolate the subject and give it a path before generating." }); return; }
    if (!inputs.prompt) { set({ error: "Write a prompt before generating." }); return; }
    const motions = inputs.subjects.length ? inputs.subjects.map(subject => subject.motion) : [inputs.motion];
    const invalid = motions.flatMap(validateMotion)[0];
    if (invalid) { set({ error: invalid }); return; }
    if (motions.every(motion => motion.keys.length < 2)) { set({ error: "The subject doesn't move yet. Go back to Move and drag it along a path." }); return; }
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
        ...inputs.size, frames: inputs.motion.frames, prompt: inputs.prompt, lockIn: inputs.lockIn, edgeFreedom: inputs.edgeFreedom, ...(seed === undefined ? {} : { seed }) };
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

// Prompt edits describe one photo. "New upload" keeps the stores for Return to editor, so a different photo clears them here.
useSelectionStore.subscribe((state, previous) => {
  if (state.image?.id !== previous.image?.id)
    useGenerateStore.setState({ prompt: null, soundEffects: null, music: "", promptMode: "formatted", rawPrompt: "", unformattable: false });
});

/** The last result, if it was made for the current photo, selection and background. */
export function useCurrentResult(): GeneratedVideo | null {
  const result = useGenerateStore(s => s.result);
  const image = useSelectionStore(s => s.image);
  const mask = useSelectionStore(s => s.mask);
  const plateId = useSelectionStore(s => currentIsolation(s)?.plate.id);
  return result && result.imageId === image?.id && result.maskId === mask?.id && result.plateId === plateId ? result : null;
}
