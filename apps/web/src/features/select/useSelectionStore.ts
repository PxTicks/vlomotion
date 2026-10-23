import { create } from "zustand";
import { selectionResultSchema } from "@h3-motion/shared";
import type { AspectRatio, ImageAsset, IsolationResult, JobSnapshot, MaskCandidate, Point } from "@h3-motion/shared";
import { jobSnapshotSchema } from "@h3-motion/shared";
import { apiRequest, submitSegment, uploadImage, watchJob } from "../../api";
import { cropImage } from "./cropImage";

/** Select, Isolate, Move, Generate. */
export type Phase = 0 | 1 | 2 | 3;

interface PointDraft { positive: Point[]; negative: Point[]; pointsPending: boolean }
type SelectionView = "find" | "subjects" | "add" | "edit";
interface SelectionSnapshot extends PointDraft {
  selectionView: SelectionView;
  candidates: MaskCandidate[]; selectedIds: string[]; activeId: string | null;
  labels: Record<string, string>; drafts: Record<string, PointDraft>; selectionText: string;
}
const NEW_SUBJECT = "new";
const emptyPoints = (): PointDraft => ({ positive: [], negative: [], pointsPending: false });
export const hasPendingPoints = (state: Pick<SelectionState, "pointsPending" | "drafts">) =>
  state.pointsPending || Object.values(state.drafts).some(draft => draft.pointsPending);

interface SelectionState {
  selectionView: SelectionView;
  editorStart: { snapshot: SelectionSnapshot; history: SelectionSnapshot[] } | null;
  cancelEditor: () => void;
  source: File | null; image: ImageAsset | null; aspectRatio: AspectRatio;
  text: string; selectionText: string; candidates: MaskCandidate[]; selectedIds: string[];
  activeId: string | null; labels: Record<string, string>; drafts: Record<string, PointDraft>; history: SelectionSnapshot[];
  hoveredId: string | null; positive: Point[]; negative: Point[]; pointsPending: boolean;
  mask: ImageAsset | null; busy: boolean; job: JobSnapshot | null;
  error: string | null; notice: string | null; phase: Phase;
  isolation: IsolationResult | null;
  setText: (text: string) => void;
  addSubject: () => void; editSubject: (id: string) => void; deleteSubject: (id: string) => void;
  includeAll: () => void; undo: () => void;
  setHoveredId: (id: string | null) => void;
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
  function snapshot(): SelectionSnapshot {
    const { selectionView, candidates, selectedIds, activeId, labels, drafts, positive, negative, pointsPending, selectionText } = get();
    return { selectionView, candidates, selectedIds, activeId, labels, drafts, positive, negative, pointsPending, selectionText };
  }
  function checkpoint() { set({ history: [...get().history.slice(-29), snapshot()] }); }
  function updatePoints(draft: PointDraft) {
    set({ ...draft, drafts: { ...get().drafts, [get().activeId ?? NEW_SUBJECT]: draft }, mask: null, isolation: null });
  }
  function discardEditor() {
    const start = get().editorStart;
    if (!start) return;
    set({ ...start.snapshot, history: start.history, editorStart: null, hoveredId: null,
      notice: null });
  }
  async function run(mode: "text" | "points", positive: Point[] = [], negative: Point[] = []) {
    const { image, text, busy, selectedIds, candidates, activeId, labels, drafts } = get();
    if (!image || busy) return;
    const before = snapshot();
    set({ busy: true, mask: null, isolation: null, phase: 0, error: null, notice: null, job: null });
    try {
      // Each submission is an independent SAM job; a new subject never receives another subject's points.
      const initial = await submitSegment(mode === "text" ? { mode, imageId: image.id, text }
        : { mode, imageId: image.id, positive, negative });
      const result = await watchJob(initial, job => set({ job }));
      if (result.status === "failed") throw new Error(result.error ?? result.message);
      if (result.status === "cancelled") {
        if (get().editorStart) discardEditor();
        else set({ notice: "Selection cancelled. Your subjects and points are unchanged." });
        return;
      }
      const found = result.candidates;
      if (!found.length) {
        set({ notice: "No subject found. Try another name, or adjust your points and apply again." });
        return;
      }
      const editor = get().editorStart;
      set({ history: [...(editor?.history ?? get().history).slice(-29), editor?.snapshot ?? before] });
      if (mode === "text") {
        const added = found.filter(candidate => !candidates.some(existing => existing.id === candidate.id));
        const nextLabels = { ...labels };
        added.forEach((candidate, index) => { nextLabels[candidate.id] = text.trim() + (found.length > 1 ? ` ${index + 1}` : ""); });
        const single = found.length === 1 ? found[0] : undefined;
        const nextActive = single?.id ?? null;
        const nextDrafts = { ...drafts };
        delete nextDrafts[NEW_SUBJECT];
        set({ selectionText: candidates.length ? "" : text.trim(), candidates: [...candidates, ...added],
          selectedIds: single ? [...new Set([...selectedIds, single.id])] : selectedIds,
          labels: nextLabels, activeId: nextActive, drafts: nextDrafts, ...(nextDrafts[nextActive ?? NEW_SUBJECT] ?? emptyPoints()),
          selectionView: "subjects", editorStart: null,
          notice: null });
      } else {
        const replacement = found[0];
        const nextCandidates = candidates.filter(candidate => candidate.id !== replacement.id || candidate.id === activeId);
        const targetIndex = nextCandidates.findIndex(candidate => candidate.id === activeId);
        if (targetIndex >= 0) nextCandidates.splice(targetIndex, 1, replacement);
        else nextCandidates.push(replacement);
        const nextDrafts = { ...drafts };
        delete nextDrafts[activeId ?? NEW_SUBJECT];
        const draft = { positive, negative, pointsPending: false };
        nextDrafts[replacement.id] = draft;
        const nextLabels = { ...labels, [replacement.id]: activeId ? labels[activeId] ?? "Subject" : `Subject ${candidates.length + 1}` };
        if (activeId && activeId !== replacement.id) delete nextLabels[activeId];
        const included = activeId ? selectedIds.includes(activeId) : true;
        set({ candidates: nextCandidates, selectionText: "", labels: nextLabels, drafts: nextDrafts,
          activeId: replacement.id, ...draft, selectionView: "subjects", editorStart: null,
          selectedIds: [...new Set([...selectedIds.filter(id => id !== activeId), ...(included ? [replacement.id] : [])])],
          notice: null });
      }
    } catch (error) { set({ error: message(error) }); }
    finally { set({ busy: false }); }
  }
  return {
    selectionView: "find", editorStart: null,
    source: null, image: null, aspectRatio: "16:9", text: "", selectionText: "", candidates: [], selectedIds: [],
    activeId: null, labels: {}, drafts: {}, history: [], hoveredId: null,
    ...emptyPoints(), mask: null, isolation: null, busy: false, job: null, error: null, notice: null, phase: 0,
    setText: text => set({ text }),
    setHoveredId: hoveredId => set({ hoveredId }),
    cancelEditor: () => { if (!get().busy) discardEditor(); },
    addSubject: () => {
      if (get().busy) return;
      const start = get().editorStart ?? { snapshot: snapshot(), history: get().history };
      set({ selectionView: "add", editorStart: start, activeId: null, text: "", ...(get().drafts[NEW_SUBJECT] ?? emptyPoints()), phase: 0,
        notice: null });
    },
    editSubject: id => {
      if (get().busy || !get().candidates.some(candidate => candidate.id === id)) return;
      set({ selectionView: "edit", editorStart: get().editorStart ?? { snapshot: snapshot(), history: get().history }, activeId: id, ...(get().drafts[id] ?? emptyPoints()), phase: 0,
        notice: null });
    },
    deleteSubject: id => {
      if (get().busy || !get().candidates.some(candidate => candidate.id === id)) return;
      checkpoint();
      const state = get(), drafts = { ...state.drafts }, labels = { ...state.labels };
      delete drafts[id]; delete labels[id];
      set({ candidates: state.candidates.filter(candidate => candidate.id !== id), selectedIds: state.selectedIds.filter(value => value !== id),
        drafts, labels, ...(state.activeId === id ? { activeId: null, ...(drafts[NEW_SUBJECT] ?? emptyPoints()) } : {}),
        selectionView: state.candidates.length > 1 ? "subjects" : "find", editorStart: null, mask: null, isolation: null, phase: 0, selectionText: "", notice: "Subject deleted. Undo to restore it." });
    },
    includeAll: () => {
      if (get().busy) return;
      checkpoint();
      set({ selectedIds: get().candidates.map(candidate => candidate.id), mask: null, isolation: null, phase: 0, selectionText: "" });
    },
    undo: () => {
      const { history, busy, editorStart, selectionView, activeId } = get();
      const previous = history.at(-1);
      if (busy || !previous) return;
      if (editorStart) {
        if (previous.selectionView !== selectionView || previous.activeId !== activeId) return;
        set({ ...previous, history: history.slice(0, -1), editorStart, selectionView,
          mask: null, isolation: null, notice: null });
        return;
      }
      set({ ...previous, history: history.slice(0, -1), mask: null, isolation: null, phase: 0, hoveredId: null, editorStart: null, selectionView: previous.candidates.length ? "subjects" : "find", notice: "Last selection change undone." });
    },
    clearError: () => set({ error: null }),
    upload: async (source, ratio = get().aspectRatio) => {
      if (get().busy) return;
      set({ busy: true, error: null, notice: null });
      try {
        const image = await uploadImage(await cropImage(source, ratio));
        set({ source, image, aspectRatio: ratio, selectionText: "", candidates: [], selectedIds: [], mask: null, isolation: null, job: null,
          selectionView: "find", editorStart: null, ...emptyPoints(), activeId: null, labels: {}, drafts: {}, history: [], hoveredId: null, phase: 0, notice: null });
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
      const { image, busy, phase } = get();
      if (!image || busy || phase !== 0) return;
      const positive = isNegative ? get().positive : [...get().positive, point];
      const negative = isNegative ? [...get().negative, point] : get().negative;
      if (positive.length > 64 || negative.length > 64) { set({ notice: "You can use up to 64 include points and 64 exclude points. Clear the points to start again." }); return; }
      if (get().selectionView === "subjects") return;
      if (get().selectionView === "find") {
        set({ editorStart: { snapshot: snapshot(), history: get().history }, selectionView: "add" });
      }
      checkpoint();
      updatePoints({ positive, negative, pointsPending: true });
      set({ notice: null });
    },
    removePoint: (index, isNegative) => {
      const { image, busy, phase, positive, negative } = get();
      const points = isNegative ? negative : positive;
      if (!image || busy || phase !== 0 || !Number.isInteger(index) || index < 0 || index >= points.length) return;
      const remaining = points.filter((_, i) => i !== index);
      const nextPositive = isNegative ? positive : remaining;
      const nextNegative = isNegative ? remaining : negative;
      const pointsPending = nextPositive.length + nextNegative.length > 0;
      checkpoint();
      updatePoints({ positive: nextPositive, negative: nextNegative, pointsPending });
      set({ notice: pointsPending ? "Point removed. Apply refinement when you’re ready." : "All points removed. Your current subject selection is unchanged." });
    },
    applyRefinement: async () => {
      const { image, busy, phase, positive, negative, pointsPending } = get();
      if (!image || busy || phase !== 0 || !positive.length || !pointsPending) return;
      await run("points", positive, negative);
    },
    clearPoints: () => {
      if (get().busy) return;
      checkpoint();
      updatePoints(emptyPoints());
      set({ notice: "Points cleared. The applied mask is unchanged." });
    },
    toggleCandidate: id => {
      if (get().busy) return;
      if (!get().candidates.some(candidate => candidate.id === id)) return;
      checkpoint();
      const ids = get().selectedIds;
      set({ selectedIds: ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id],
        mask: null, isolation: null, phase: 0, selectionText: "", notice: null });
    },
    confirm: async () => {
      const { image, selectedIds, busy } = get();
      if (!image || !selectedIds.length || busy || hasPendingPoints(get())) return;
      set({ busy: true, error: null });
      try {
        const result = selectionResultSchema.parse(await apiRequest("/selection", { method: "POST",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify({ imageId: image.id, candidateIds: selectedIds }) }));
        set({ mask: result.mask, isolation: null, phase: 1, notice: "Selection confirmed. Isolate the subject to create a clean background." });
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
