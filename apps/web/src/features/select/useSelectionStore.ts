import { create } from "zustand";
import { selectionResultSchema } from "@h3-motion/shared";
import type { AspectRatio, ImageAsset, IsolationResult, JobSnapshot, MaskCandidate, Point } from "@h3-motion/shared";
import { jobSnapshotSchema } from "@h3-motion/shared";
import { apiRequest, submitSegment, uploadImage, watchJob } from "../../api";
import { cropImage } from "./cropImage";

/** Select, Isolate, Move, Generate. */
export type Phase = 0 | 1 | 2 | 3;

interface SelectionState {
  source: File | null; image: ImageAsset | null; aspectRatio: AspectRatio;
  text: string; selectionText: string; candidates: MaskCandidate[]; selectedIds: string[];
  refine: boolean; positive: Point[]; negative: Point[]; pointsPending: boolean;
  mask: ImageAsset | null; busy: boolean; job: JobSnapshot | null;
  error: string | null; notice: string | null; phase: Phase;
  isolation: IsolationResult | null;
  setText: (text: string) => void; setRefine: (refine: boolean) => void;
  upload: (file: File, ratio?: AspectRatio) => Promise<void>;
  changeAspectRatio: (ratio: AspectRatio) => Promise<void>;
  segment: () => Promise<void>; addPoint: (point: Point, negative: boolean) => void;
  removePoint: (index: number, negative: boolean) => void;
  applyRefinement: () => Promise<void>; clearPoints: () => void;
  toggleCandidate: (id: string) => void; confirm: () => Promise<void>;
  cancel: () => Promise<void>; clearError: () => void;
  isolate: (instruction?: string) => Promise<void>; visitPhase: (phase: Phase) => void;
}

const message = (error: unknown) => error instanceof Error ? error.message : "Something went wrong. Try again.";

export function currentIsolation(state: Pick<SelectionState, "image" | "mask" | "isolation">): IsolationResult | null {
  const { image, mask, isolation } = state;
  return image && mask && isolation?.imageId === image.id && isolation.maskId === mask.id ? isolation : null;
}

export function canRecoverIsolation(state: Pick<SelectionState, "image" | "mask" | "job">): boolean {
  const { image, mask, job } = state;
  return !!image && !!mask && job?.status === "failed" && job.imageId === image.id && job.maskId === mask.id;
}

export const useSelectionStore = create<SelectionState>((set, get) => {
  async function run(mode: "text" | "points", positive: Point[] = [], negative: Point[] = []) {
    const { image, text, busy, selectedIds, candidates } = get();
    if (!image || busy) return;
    const replacedId = mode === "points" ? selectedIds[0] : undefined;
    set({ busy: true, mask: null, isolation: null, phase: 0, error: null, notice: null, job: null });
    try {
      const initial = await submitSegment(mode === "text" ? { mode, imageId: image.id, text }
        : { mode, imageId: image.id, positive, negative });
      const result = await watchJob(initial, job => set({ job }));
      if (result.status === "failed") throw new Error(result.error ?? result.message);
      if (result.status === "cancelled") { set({ notice: "Selection cancelled." }); return; }
      const found = result.candidates;
      if (mode === "text") {
        set({ selectionText: text.trim(), candidates: found, selectedIds: found[0] ? [found[0].id] : [], positive: [], negative: [], pointsPending: false, refine: found.length === 0 });
      } else {
        const replacement = found[0];
        if (!replacement) {
          set({ notice: "No subject found for these points. Adjust the points and apply again, or clear them to keep the current selection." });
          return;
        }
        const nextCandidates = [...candidates];
        const targetIndex = candidates.findIndex(candidate => candidate.id === replacedId);
        if (targetIndex >= 0) nextCandidates.splice(targetIndex, 1, ...(replacement ? [replacement] : []));
        else if (replacement) nextCandidates.push(replacement);
        // Points can select a different object, so the old search name is no longer reliable.
        set({ candidates: nextCandidates, selectionText: "",
          selectedIds: [replacement.id, ...selectedIds.filter(id => id !== replacedId)], pointsPending: false });
      }
      set({ notice: result.message });
    } catch (error) { set({ error: message(error) }); }
    finally { set({ busy: false }); }
  }
  return {
    source: null, image: null, aspectRatio: "16:9", text: "", selectionText: "", candidates: [], selectedIds: [],
    refine: false, positive: [], negative: [], pointsPending: false, mask: null, isolation: null, busy: false, job: null, error: null, notice: null, phase: 0,
    setText: text => set({ text }),
    setRefine: refine => {
      if (get().busy) return;
      set({ refine, positive: [], negative: [], pointsPending: false,
        ...(get().pointsPending ? { notice: "Unapplied points cleared." } : {}) });
    },
    clearError: () => set({ error: null }),
    upload: async (source, ratio = get().aspectRatio) => {
      if (get().busy) return;
      set({ busy: true, error: null, notice: null });
      try {
        const image = await uploadImage(await cropImage(source, ratio));
        set({ source, image, aspectRatio: ratio, selectionText: "", candidates: [], selectedIds: [], mask: null, isolation: null, job: null,
          positive: [], negative: [], pointsPending: false, refine: false, phase: 0, notice: "Photo ready. Name the subject you want to move." });
      } catch (error) { set({ error: message(error) }); }
      finally { set({ busy: false }); }
    },
    changeAspectRatio: async ratio => {
      const source = get().source;
      if (source) await get().upload(source, ratio);
      else set({ aspectRatio: ratio });
    },
    segment: () => run("text"),
    addPoint: (point, isNegative) => {
      const { image, busy, refine, phase } = get();
      if (!image || busy || !refine || phase !== 0) return;
      const positive = isNegative ? get().positive : [...get().positive, point];
      const negative = isNegative ? [...get().negative, point] : get().negative;
      if (positive.length > 64 || negative.length > 64) { set({ notice: "You can use up to 64 include points and 64 exclude points. Clear the points to start again." }); return; }
      set({ positive, negative, pointsPending: true, mask: null, isolation: null,
        notice: "Points added. Apply refinement when you’re ready." });
    },
    removePoint: (index, isNegative) => {
      const { image, busy, refine, phase, positive, negative } = get();
      const points = isNegative ? negative : positive;
      if (!image || busy || !refine || phase !== 0 || !Number.isInteger(index) || index < 0 || index >= points.length) return;
      const remaining = points.filter((_, i) => i !== index);
      const nextPositive = isNegative ? positive : remaining;
      const nextNegative = isNegative ? remaining : negative;
      const pointsPending = nextPositive.length + nextNegative.length > 0;
      set({ positive: nextPositive, negative: nextNegative, pointsPending, mask: null, isolation: null,
        notice: pointsPending ? "Point removed. Apply refinement when you’re ready." : "All points removed. Your current subject selection is unchanged." });
    },
    applyRefinement: async () => {
      const { image, busy, refine, phase, positive, negative, pointsPending } = get();
      if (!image || busy || !refine || phase !== 0 || !positive.length || !pointsPending) return;
      await run("points", positive, negative);
    },
    clearPoints: () => {
      if (get().busy) return;
      set({ positive: [], negative: [], pointsPending: false, notice: "Points cleared. Your current subject selection is unchanged." });
    },
    toggleCandidate: id => {
      if (get().busy) return;
      const ids = get().selectedIds;
      set({ selectedIds: ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id],
        mask: null, isolation: null, phase: 0, positive: [], negative: [], pointsPending: false, notice: "Selection changed. Confirm it and isolate again to continue." });
    },
    confirm: async () => {
      const { image, selectedIds, busy, pointsPending } = get();
      if (!image || !selectedIds.length || busy || pointsPending) return;
      set({ busy: true, error: null });
      try {
        const result = selectionResultSchema.parse(await apiRequest("/selection", { method: "POST",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify({ imageId: image.id, candidateIds: selectedIds }) }));
        set({ mask: result.mask, isolation: null, phase: 1, refine: false, notice: "Selection confirmed. Isolate the subject to create a clean background." });
      } catch (error) { set({ error: message(error) }); }
      finally { set({ busy: false }); }
    },
    cancel: async () => {
      const job = get().job;
      if (!job || !["queued", "running"].includes(job.status)) return;
      try { await apiRequest(`/jobs/${job.id}/cancel`, { method: "POST" }); }
      catch (error) { set({ error: message(error) }); }
    },
    visitPhase: phase => {
      const state = get();
      if (state.busy || (phase >= 1 && !state.mask) || (phase >= 2 && !currentIsolation(state))) return;
      set({ phase });
    },
    isolate: async instruction => {
      const state = get();
      const { image, mask, busy, selectionText } = state;
      if (!image || !mask || busy) return;
      const previous = currentIsolation(state);
      const editInstruction = instruction ?? (previous?.instructionSource === "custom" ? previous.instruction : undefined);
      set({ busy: true, error: null, notice: null, job: null });
      try {
        const initial = jobSnapshotSchema.parse(await apiRequest("/jobs/isolate", { method: "POST",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify({
            imageId: image.id, maskId: mask.id, userText: selectionText,
            ...(editInstruction ? { instruction: editInstruction } : {}),
          }) }));
        const result = await watchJob(initial, job => set({ job }));
        if (result.status === "failed") throw new Error(result.error ?? result.message);
        if (result.status === "cancelled") { set({ notice: "Isolation cancelled. Your last background is unchanged." }); return; }
        if (!result.isolation) throw new Error("Background removal completed without a result. Try again.");
        if (result.isolation.imageId !== image.id || result.isolation.maskId !== mask.id) throw new Error("Selection changed. Confirm it and isolate again.");
        set({ isolation: result.isolation, notice: result.message });
      } catch (error) { set({ error: message(error) }); }
      finally { set({ busy: false }); }
    },
  };
});
