import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CAPTION } from "@h3-motion/shared";
import type { IsolationResult, JobSnapshot, MaskCandidate } from "@h3-motion/shared";
import { apiRequest, submitSegment, watchJob } from "../../../api";
import { canRecoverIsolation, currentIsolation, useSelectionStore } from "../useSelectionStore";

vi.mock("../../../api", () => ({ apiRequest: vi.fn(), submitSegment: vi.fn(), uploadImage: vi.fn(), watchJob: vi.fn() }));
const image = { id: "f4c8a75f-2c99-4d89-b30e-fe18d97ede92", url: "/api/files/photo", width: 100, height: 100 };
const candidate = (id: string): MaskCandidate => ({ id, url: `/api/files/${id}`, bounds: { x: 0, y: 0, width: 10, height: 10 } });
const first = candidate("first"), second = candidate("second"), refined = candidate("refined");
const result = (candidates: MaskCandidate[]): JobSnapshot => ({ id: "job", status: "completed", message: "Done", progress: 1, candidates, error: null });
const isolated: IsolationResult = { imageId: image.id, maskId: image.id, plate: { ...image, url: "/api/files/plate" },
  phrase: "the brown dog", caption: DEFAULT_CAPTION, descriptionSource: "model", instructionSource: "model", instruction: "Remove the brown dog.", seed: 42 };
const isolationJob = (status: JobSnapshot["status"]): JobSnapshot => ({ ...result([]), id: "86e24514-60d6-4dd7-a85b-a0d025caf7c4",
  stage: "isolate", status, ...(status === "completed" ? { isolation: isolated } : {}) });

beforeEach(() => {
  vi.resetAllMocks();
  useSelectionStore.setState(useSelectionStore.getInitialState(), true);
  useSelectionStore.setState({ image, text: "dog", selectionText: "dog" });
  vi.mocked(submitSegment).mockResolvedValue({ ...result([]), status: "queued" });
});

describe("selection transitions", () => {
  it("shows multiple search matches as suggestions without automatically including them", async () => {
    vi.mocked(watchJob).mockResolvedValue(result([first, second]));
    await useSelectionStore.getState().segment();
    expect(useSelectionStore.getState()).toMatchObject({ candidates: [first, second], selectedIds: [], busy: false });
  });
  it("switches to points when no text candidates are returned", async () => {
    vi.mocked(watchJob).mockResolvedValue(result([]));
    await useSelectionStore.getState().segment();
    expect(useSelectionStore.getState()).toMatchObject({ activeId: null, candidates: [], selectedIds: [] });
  });
  it("replaces only the explicit editing target and keeps it active", async () => {
    useSelectionStore.setState({ candidates: [first, second], selectedIds: [first.id, second.id], selectionView: "edit", activeId: first.id });
    vi.mocked(watchJob).mockResolvedValue(result([refined]));
    useSelectionStore.getState().addPoint({ x: 4, y: 5 }, false);
    await useSelectionStore.getState().applyRefinement();
    expect(submitSegment).toHaveBeenCalledWith({ mode: "points", imageId: image.id, candidateId: first.id, positive: [{ x: 4, y: 5 }], negative: [] });
    expect(useSelectionStore.getState().selectedIds).toEqual([second.id, refined.id]);
    const again = candidate("again");
    vi.mocked(watchJob).mockResolvedValue(result([again]));
    useSelectionStore.getState().editSubject(refined.id);
    useSelectionStore.getState().addPoint({ x: 8, y: 9 }, true);
    await useSelectionStore.getState().applyRefinement();
    expect(submitSegment).toHaveBeenLastCalledWith({ mode: "points", imageId: image.id, candidateId: first.id, positive: [{ x: 4, y: 5 }], negative: [{ x: 8, y: 9 }] });
    expect(useSelectionStore.getState().candidates).toEqual([again, second]);
    expect(useSelectionStore.getState().selectedIds).toEqual([second.id, again.id]);
  });
  it("collects multiple include/exclude points without submitting or locking the canvas", async () => {
    useSelectionStore.setState({ selectionView: "edit", activeId: first.id, candidates: [first], selectedIds: [first.id] });
    const store = useSelectionStore.getState();
    store.addPoint({ x: 4, y: 5 }, false);
    store.addPoint({ x: 6, y: 7 }, false);
    store.addPoint({ x: 8, y: 9 }, true);
    expect(submitSegment).not.toHaveBeenCalled();
    expect(useSelectionStore.getState()).toMatchObject({ busy: false, pointsPending: true,
      positive: [{ x: 4, y: 5 }, { x: 6, y: 7 }], negative: [{ x: 8, y: 9 }] });
    vi.mocked(watchJob).mockResolvedValue(result([refined]));
    await store.applyRefinement();
    expect(submitSegment).toHaveBeenCalledExactlyOnceWith({ mode: "points", imageId: image.id, candidateId: first.id,
      positive: [{ x: 4, y: 5 }, { x: 6, y: 7 }], negative: [{ x: 8, y: 9 }] });
    expect(useSelectionStore.getState()).toMatchObject({ pointsPending: false, selectedIds: [refined.id] });
    await store.applyRefinement();
    expect(submitSegment).toHaveBeenCalledTimes(1);
  });
  it("requires an include point for a new subject but allows exclude points to be placed first", async () => {
    useSelectionStore.setState({ selectionView: "add", activeId: null });
    useSelectionStore.getState().addPoint({ x: 8, y: 9 }, true);
    await useSelectionStore.getState().applyRefinement();
    expect(useSelectionStore.getState().negative).toEqual([{ x: 8, y: 9 }]);
    expect(submitSegment).not.toHaveBeenCalled();
  });
  it("removes individual include and exclude points without submitting refinement", () => {
    useSelectionStore.setState({ selectionView: "edit", activeId: first.id, candidates: [first], selectedIds: [first.id] });
    const store = useSelectionStore.getState();
    store.addPoint({ x: 4, y: 5 }, false);
    store.addPoint({ x: 6, y: 7 }, false);
    store.addPoint({ x: 8, y: 9 }, true);
    store.removePoint(0, false);
    expect(useSelectionStore.getState()).toMatchObject({ positive: [{ x: 6, y: 7 }], negative: [{ x: 8, y: 9 }], pointsPending: true });
    store.removePoint(0, true);
    expect(useSelectionStore.getState()).toMatchObject({ positive: [{ x: 6, y: 7 }], negative: [], pointsPending: true });
    store.removePoint(0, false);
    expect(useSelectionStore.getState()).toMatchObject({ positive: [], negative: [], pointsPending: false, candidates: [first] });
    expect(submitSegment).not.toHaveBeenCalled();
  });
  it("marks removal of an applied point as pending and submits only the remaining points", async () => {
    const positive = [{ x: 4, y: 5 }, { x: 6, y: 7 }];
    useSelectionStore.setState({ selectionView: "edit", activeId: first.id, candidates: [first], selectedIds: [first.id], positive, pointsPending: false });
    useSelectionStore.getState().removePoint(0, false);
    expect(useSelectionStore.getState().pointsPending).toBe(true);
    vi.mocked(watchJob).mockResolvedValue(result([refined]));
    await useSelectionStore.getState().applyRefinement();
    expect(submitSegment).toHaveBeenCalledExactlyOnceWith({ mode: "points", imageId: image.id, candidateId: first.id, positive: [positive[1]], negative: [] });
  });
  it("ignores invalid point removals and prevents editing during refinement", () => {
    const positive = [{ x: 4, y: 5 }];
    useSelectionStore.setState({ selectionView: "edit", activeId: first.id, positive, pointsPending: false });
    const store = useSelectionStore.getState();
    for (const index of [-1, 1, 0.5]) store.removePoint(index, false);
    useSelectionStore.setState({ busy: true });
    store.removePoint(0, false);
    expect(useSelectionStore.getState()).toMatchObject({ positive, pointsPending: false });
    expect(submitSegment).not.toHaveBeenCalled();
  });
  it("blocks confirmation until pending points are applied or cleared", async () => {
    useSelectionStore.setState({ selectionView: "edit", activeId: first.id, candidates: [first], selectedIds: [first.id] });
    useSelectionStore.getState().addPoint({ x: 4, y: 5 }, false);
    await useSelectionStore.getState().confirm();
    expect(apiRequest).not.toHaveBeenCalled();
    useSelectionStore.getState().clearPoints();
    expect(useSelectionStore.getState()).toMatchObject({ positive: [], negative: [], pointsPending: false, candidates: [first] });
    vi.mocked(apiRequest).mockResolvedValue({ mask: image });
    await useSelectionStore.getState().confirm();
    expect(apiRequest).toHaveBeenCalledOnce();
  });
  it.each(["failed", "cancelled", "empty"])("keeps points and the current candidate available after %s refinement", async status => {
    useSelectionStore.setState({ selectionView: "edit", activeId: first.id, candidates: [first, second], selectedIds: [first.id, second.id] });
    useSelectionStore.getState().addPoint({ x: 4, y: 5 }, false);
    vi.mocked(watchJob).mockResolvedValue(status === "empty" ? result([])
      : { ...result([]), status: status as "failed" | "cancelled", error: "Refinement failed" });
    await useSelectionStore.getState().applyRefinement();
    expect(useSelectionStore.getState()).toMatchObject({ pointsPending: true, busy: false,
      candidates: [first, second], selectedIds: [first.id, second.id], positive: [{ x: 4, y: 5 }] });
  });
  it("preserves per-subject and new-subject drafts when switching targets or inclusion", () => {
    useSelectionStore.setState({ candidates: [first, second], selectedIds: [first.id], selectionView: "edit", activeId: first.id });
    const store = useSelectionStore.getState();
    store.addPoint({ x: 4, y: 5 }, false);
    store.toggleCandidate(second.id);
    expect(useSelectionStore.getState().positive).toEqual([{ x: 4, y: 5 }]);
    store.editSubject(second.id);
    expect(useSelectionStore.getState().positive).toEqual([]);
    store.addPoint({ x: 8, y: 9 }, false);
    store.addSubject();
    store.addPoint({ x: 20, y: 20 }, false);
    store.editSubject(first.id);
    expect(useSelectionStore.getState().positive).toEqual([{ x: 4, y: 5 }]);
    store.editSubject(second.id);
    expect(useSelectionStore.getState().positive).toEqual([{ x: 8, y: 9 }]);
    store.addSubject();
    expect(useSelectionStore.getState().positive).toEqual([{ x: 20, y: 20 }]);
    expect(submitSegment).not.toHaveBeenCalled();
  });
  it("edits the named subject even when a different subject is first included", async () => {
    useSelectionStore.setState({ candidates: [first, second], selectedIds: [first.id, second.id] });
    useSelectionStore.getState().editSubject(second.id);
    useSelectionStore.getState().addPoint({ x: 70, y: 70 }, false);
    vi.mocked(watchJob).mockResolvedValue(result([refined]));
    await useSelectionStore.getState().applyRefinement();
    expect(useSelectionStore.getState()).toMatchObject({ candidates: [first, refined], activeId: refined.id, selectedIds: [first.id, refined.id] });
  });
  it("starts a separate point job for a new subject only after intentional Apply", async () => {
    useSelectionStore.setState({ candidates: [first], selectedIds: [first.id], selectionView: "edit", activeId: first.id });
    useSelectionStore.getState().addPoint({ x: 4, y: 5 }, false);
    useSelectionStore.getState().addSubject();
    useSelectionStore.getState().addPoint({ x: 80, y: 80 }, false);
    expect(submitSegment).not.toHaveBeenCalled();
    vi.mocked(watchJob).mockResolvedValue(result([second]));
    await useSelectionStore.getState().applyRefinement();
    expect(submitSegment).toHaveBeenCalledExactlyOnceWith({ mode: "points", imageId: image.id, positive: [{ x: 80, y: 80 }], negative: [] });
    expect(useSelectionStore.getState()).toMatchObject({ candidates: [first, second], selectedIds: [first.id, second.id], selectionView: "subjects", activeId: second.id });
    useSelectionStore.getState().editSubject(first.id);
    expect(useSelectionStore.getState().positive).toEqual([{ x: 4, y: 5 }]);
  });
  it("adds search suggestions without losing included subjects or pending points and deduplicates repeated results", async () => {
    useSelectionStore.setState({ candidates: [first], selectedIds: [first.id], selectionView: "edit", activeId: first.id });
    useSelectionStore.getState().addPoint({ x: 4, y: 5 }, false);
    vi.mocked(watchJob).mockResolvedValue(result([first, second]));
    await useSelectionStore.getState().segment();
    expect(useSelectionStore.getState()).toMatchObject({ candidates: [first, second], selectedIds: [first.id], selectionView: "subjects", drafts: { [first.id]: { positive: [{ x: 4, y: 5 }], pointsPending: true } } });
    await useSelectionStore.getState().segment();
    expect(useSelectionStore.getState().candidates).toEqual([first, second]);
    useSelectionStore.getState().includeAll();
    expect(useSelectionStore.getState().selectedIds).toEqual([first.id, second.id]);
  });
  it("blocks confirmation for pending points on an inactive subject or the new-subject draft", async () => {
    useSelectionStore.setState({ candidates: [first, second], selectedIds: [first.id], selectionView: "edit", activeId: first.id });
    const store = useSelectionStore.getState();
    store.addPoint({ x: 4, y: 5 }, false);
    store.editSubject(second.id);
    await store.confirm();
    expect(apiRequest).not.toHaveBeenCalled();
    store.editSubject(first.id); store.clearPoints(); store.addSubject();
    store.addPoint({ x: 80, y: 80 }, false); store.editSubject(first.id);
    await store.confirm();
    expect(apiRequest).not.toHaveBeenCalled();
  });
  it("deletes and restores a subject including its inclusion, editing target and points", () => {
    useSelectionStore.setState({ candidates: [first, second], selectedIds: [first.id, second.id], selectionView: "edit", activeId: second.id });
    const store = useSelectionStore.getState();
    store.addPoint({ x: 70, y: 70 }, false);
    store.deleteSubject(second.id);
    expect(useSelectionStore.getState()).toMatchObject({ candidates: [first], selectedIds: [first.id], activeId: null });
    store.undo();
    expect(useSelectionStore.getState()).toMatchObject({ candidates: [first, second], selectedIds: [first.id, second.id], selectionView: "subjects", activeId: second.id, positive: [{ x: 70, y: 70 }], pointsPending: true });
  });
  it("undo restores the previous mask after applying a correction", async () => {
    useSelectionStore.setState({ candidates: [first], selectedIds: [first.id], selectionView: "edit", activeId: first.id });
    const store = useSelectionStore.getState();
    store.addPoint({ x: 4, y: 5 }, false);
    vi.mocked(watchJob).mockResolvedValue(result([refined]));
    await store.applyRefinement();
    store.undo();
    expect(useSelectionStore.getState()).toMatchObject({ candidates: [first], selectionView: "subjects", activeId: first.id, selectedIds: [first.id], pointsPending: true });
  });
  it("editing an excluded subject does not silently include it", async () => {
    useSelectionStore.setState({ candidates: [first, second], selectedIds: [first.id], selectionView: "edit", activeId: second.id });
    useSelectionStore.getState().addPoint({ x: 70, y: 70 }, false);
    vi.mocked(watchJob).mockResolvedValue(result([refined]));
    await useSelectionStore.getState().applyRefinement();
    expect(useSelectionStore.getState().selectedIds).toEqual([first.id]);
  });
  it("reveals the point editor only after the first click and cancels back to the initial prompt", () => {
    const store = useSelectionStore.getState();
    expect(store.selectionView).toBe("find");
    store.addPoint({ x: 10, y: 10 }, false);
    expect(useSelectionStore.getState().selectionView).toBe("add");
    store.cancelEditor();
    expect(useSelectionStore.getState()).toMatchObject({ selectionView: "find", candidates: [], positive: [], pointsPending: false, drafts: {} });
    expect(submitSegment).not.toHaveBeenCalled();
  });
  it("cancels a new subject without changing existing subjects or leaving hidden pending points", () => {
    useSelectionStore.setState({ selectionView: "subjects", candidates: [first, second], selectedIds: [first.id] });
    const store = useSelectionStore.getState();
    store.addSubject();
    expect(useSelectionStore.getState().selectionView).toBe("add");
    store.addPoint({ x: 80, y: 80 }, false);
    store.cancelEditor();
    expect(useSelectionStore.getState()).toMatchObject({ selectionView: "subjects", candidates: [first, second], selectedIds: [first.id], positive: [], pointsPending: false, drafts: {}, history: [] });
    expect(submitSegment).not.toHaveBeenCalled();
  });
  it("cancels mask editing and restores its saved points and inclusion", () => {
    const draft = { positive: [{ x: 10, y: 10 }], negative: [], pointsPending: false };
    useSelectionStore.setState({ selectionView: "subjects", candidates: [first], selectedIds: [first.id], drafts: { [first.id]: draft } });
    const store = useSelectionStore.getState();
    store.editSubject(first.id);
    store.addPoint({ x: 20, y: 20 }, false);
    store.cancelEditor();
    expect(useSelectionStore.getState()).toMatchObject({ selectionView: "subjects", candidates: [first], selectedIds: [first.id], drafts: { [first.id]: draft }, history: [] });
    store.editSubject(first.id);
    expect(useSelectionStore.getState().positive).toEqual(draft.positive);
  });
  it("returns to the list after applying and Undo restores the mask from before entering the editor", async () => {
    useSelectionStore.setState({ selectionView: "subjects", candidates: [first], selectedIds: [first.id] });
    const store = useSelectionStore.getState();
    store.editSubject(first.id);
    store.addPoint({ x: 10, y: 10 }, false);
    vi.mocked(watchJob).mockResolvedValue(result([refined]));
    await store.applyRefinement();
    expect(useSelectionStore.getState()).toMatchObject({ selectionView: "subjects", candidates: [refined], pointsPending: false });
    store.editSubject(refined.id);
    expect(useSelectionStore.getState().positive).toEqual([{ x: 10, y: 10 }]);
    store.cancelEditor();
    store.undo();
    expect(useSelectionStore.getState()).toMatchObject({ selectionView: "subjects", candidates: [first], selectedIds: [first.id], drafts: {}, pointsPending: false });
  });
  it("adding through text returns to the list and discards the temporary new-subject points", async () => {
    useSelectionStore.setState({ selectionView: "subjects", candidates: [first], selectedIds: [first.id] });
    const store = useSelectionStore.getState();
    store.addSubject(); store.setText("car"); store.addPoint({ x: 80, y: 80 }, false);
    vi.mocked(watchJob).mockResolvedValue(result([second]));
    await store.segment();
    expect(useSelectionStore.getState()).toMatchObject({ selectionView: "subjects", candidates: [first, second], selectedIds: [first.id, second.id], drafts: {}, pointsPending: false });
  });
  it("returns to the existing list when an in-flight new-subject job is cancelled", async () => {
    useSelectionStore.setState({ selectionView: "subjects", candidates: [first], selectedIds: [first.id] });
    const store = useSelectionStore.getState();
    store.addSubject(); store.addPoint({ x: 80, y: 80 }, false);
    vi.mocked(watchJob).mockResolvedValue({ ...result([]), status: "cancelled" });
    await store.applyRefinement();
    expect(useSelectionStore.getState()).toMatchObject({ selectionView: "subjects", candidates: [first], selectedIds: [first.id], drafts: {}, pointsPending: false });
  });
  it("does not collect refinement points while browsing the subject list", () => {
    useSelectionStore.setState({ selectionView: "subjects", candidates: [first], selectedIds: [first.id] });
    useSelectionStore.getState().addPoint({ x: 10, y: 10 }, false);
    expect(useSelectionStore.getState()).toMatchObject({ selectionView: "subjects", positive: [], pointsPending: false });
    expect(submitSegment).not.toHaveBeenCalled();
  });
  it("undoes a point inside the editor while keeping Cancel available", () => {
    useSelectionStore.setState({ selectionView: "subjects", candidates: [first], selectedIds: [first.id] });
    const store = useSelectionStore.getState();
    store.editSubject(first.id);
    store.addPoint({ x: 10, y: 10 }, false);
    store.addPoint({ x: 20, y: 20 }, true);
    store.undo();
    expect(useSelectionStore.getState()).toMatchObject({ selectionView: "edit", positive: [{ x: 10, y: 10 }], negative: [] });
    expect(useSelectionStore.getState().editorStart).not.toBeNull();
    store.cancelEditor();
    expect(useSelectionStore.getState()).toMatchObject({ selectionView: "subjects", candidates: [first], selectedIds: [first.id], drafts: {}, history: [] });
  });
  it("sends the explicit edit target's mask with exclude-only corrections", async () => {
    useSelectionStore.setState({ selectionView: "subjects", candidates: [first, second], selectedIds: [first.id, second.id] });
    useSelectionStore.getState().editSubject(second.id);
    useSelectionStore.getState().addPoint({ x: 70, y: 70 }, true);
    vi.mocked(watchJob).mockResolvedValue(result([refined]));
    await useSelectionStore.getState().applyRefinement();
    expect(submitSegment).toHaveBeenCalledExactlyOnceWith({ mode: "points", imageId: image.id, candidateId: second.id, positive: [], negative: [{ x: 70, y: 70 }] });
    expect(useSelectionStore.getState().candidates).toEqual([first, refined]);
  });
  it("recomputes from the starting mask after an applied point is removed", async () => {
    useSelectionStore.setState({ selectionView: "subjects", candidates: [first], selectedIds: [first.id] });
    const store = useSelectionStore.getState();
    store.editSubject(first.id); store.addPoint({ x: 4, y: 5 }, false);
    vi.mocked(watchJob).mockResolvedValueOnce(result([refined]));
    await store.applyRefinement();
    store.editSubject(refined.id); store.removePoint(0, false); store.addPoint({ x: 20, y: 30 }, false);
    vi.mocked(watchJob).mockResolvedValueOnce(result([second]));
    await store.applyRefinement();
    expect(submitSegment).toHaveBeenLastCalledWith({ mode: "points", imageId: image.id, candidateId: first.id, positive: [{ x: 20, y: 30 }], negative: [] });
    expect(useSelectionStore.getState().recipes[second.id].base).toEqual(first);
  });
  it("removing the last applied point restores the exact starting mask on Apply", async () => {
    useSelectionStore.setState({ selectionView: "subjects", candidates: [first], selectedIds: [first.id] });
    const store = useSelectionStore.getState();
    store.editSubject(first.id); store.addPoint({ x: 4, y: 5 }, false);
    vi.mocked(watchJob).mockResolvedValueOnce(result([refined]));
    await store.applyRefinement();
    store.editSubject(refined.id); store.removePoint(0, false);
    expect(useSelectionStore.getState().pointsPending).toBe(true);
    await store.applyRefinement();
    expect(submitSegment).toHaveBeenCalledTimes(1);
    expect(useSelectionStore.getState()).toMatchObject({ candidates: [first], selectedIds: [first.id], pointsPending: false });
    store.undo();
    expect(useSelectionStore.getState().candidates).toEqual([refined]);
    expect(useSelectionStore.getState().recipes[refined.id].base).toEqual(first);
  });
  it("rebuilds point-created subjects without a prior, and clearing their recipe removes them", async () => {
    const store = useSelectionStore.getState();
    store.addSubject(); store.addPoint({ x: 4, y: 5 }, false);
    vi.mocked(watchJob).mockResolvedValueOnce(result([first]));
    await store.applyRefinement();
    store.editSubject(first.id); store.addPoint({ x: 20, y: 30 }, false);
    vi.mocked(watchJob).mockResolvedValueOnce(result([refined]));
    await store.applyRefinement();
    expect(submitSegment).toHaveBeenLastCalledWith({ mode: "points", imageId: image.id, positive: [{ x: 4, y: 5 }, { x: 20, y: 30 }], negative: [] });
    store.editSubject(refined.id); store.clearPoints();
    expect(useSelectionStore.getState().pointsPending).toBe(true);
    await store.applyRefinement();
    expect(submitSegment).toHaveBeenCalledTimes(2);
    expect(useSelectionStore.getState()).toMatchObject({ selectionView: "find", candidates: [], selectedIds: [] });
    store.undo();
    expect(useSelectionStore.getState().candidates).toEqual([refined]);
    expect(useSelectionStore.getState().recipes[refined.id].base).toBeNull();
  });
  it("a stale activeId in Add mode never sends or replaces an old subject's mask", async () => {
    useSelectionStore.setState({ selectionView: "add", candidates: [first], selectedIds: [first.id], activeId: first.id });
    const store = useSelectionStore.getState();
    store.addPoint({ x: 80, y: 80 }, false);
    vi.mocked(watchJob).mockResolvedValueOnce(result([second]));
    await store.applyRefinement();
    expect(submitSegment).toHaveBeenCalledExactlyOnceWith({ mode: "points", imageId: image.id, positive: [{ x: 80, y: 80 }], negative: [] });
    expect(useSelectionStore.getState().candidates).toEqual([first, second]);
  });
  it("does not treat an Add-mode exclude point as an edit because of a stale activeId", async () => {
    useSelectionStore.setState({ selectionView: "add", candidates: [first], activeId: first.id });
    useSelectionStore.getState().addPoint({ x: 80, y: 80 }, true);
    await useSelectionStore.getState().applyRefinement();
    expect(submitSegment).not.toHaveBeenCalled();
  });
  it("invalidates confirmed masks when selection changes", () => {
    useSelectionStore.setState({ mask: image, phase: 1, candidates: [first], selectedIds: [first.id] });
    useSelectionStore.getState().toggleCandidate(first.id);
    expect(useSelectionStore.getState()).toMatchObject({ mask: null, phase: 0, selectedIds: [] });
  });
  it("unlocks controls after a failed job", async () => {
    vi.mocked(watchJob).mockResolvedValue({ ...result([]), status: "failed", error: "Missing SAM model" });
    await useSelectionStore.getState().segment();
    expect(useSelectionStore.getState()).toMatchObject({ busy: false, error: "Missing SAM model" });
  });
  it("does not enter isolate until the server confirms the union", async () => {
    useSelectionStore.setState({ candidates: [first], selectedIds: [first.id] });
    vi.mocked(apiRequest).mockResolvedValue({ mask: image });
    await useSelectionStore.getState().confirm();
    expect(useSelectionStore.getState()).toMatchObject({ phase: 1, mask: image, busy: false });
  });
  it("runs isolation for the confirmed selection and enables the Move phase only after success", async () => {
    useSelectionStore.getState().visitPhase(2);
    expect(useSelectionStore.getState().phase).toBe(0);
    useSelectionStore.setState({ mask: image, phase: 1 });
    vi.mocked(apiRequest).mockResolvedValue(isolationJob("queued"));
    vi.mocked(watchJob).mockResolvedValue(isolationJob("completed"));
    await useSelectionStore.getState().isolate();
    const sent = JSON.parse(vi.mocked(apiRequest).mock.calls[0][1]!.body as string);
    expect(sent).toEqual({ imageId: image.id, maskId: image.id, userText: "dog" });
    expect(useSelectionStore.getState()).toMatchObject({ isolation: isolated, busy: false });
    useSelectionStore.getState().visitPhase(2);
    expect(useSelectionStore.getState().phase).toBe(2);
    useSelectionStore.getState().visitPhase(1);
    expect(useSelectionStore.getState().isolation).toEqual(isolated);
  });
  it("retains the last background when a retry fails and sends its instruction without a fixed seed", async () => {
    useSelectionStore.setState({ mask: image, isolation: { ...isolated, instructionSource: "custom" }, phase: 1 });
    vi.mocked(apiRequest).mockResolvedValue(isolationJob("queued"));
    vi.mocked(watchJob).mockResolvedValue({ ...isolationJob("failed"), error: "GPU unavailable" });
    await useSelectionStore.getState().isolate();
    const sent = JSON.parse(vi.mocked(apiRequest).mock.calls[0][1]!.body as string);
    expect(sent.instruction).toBe(isolated.instruction);
    expect(sent).not.toHaveProperty("seed");
    expect(useSelectionStore.getState()).toMatchObject({ isolation: { ...isolated, instructionSource: "custom" }, busy: false, error: "GPU unavailable" });
  });
  it("keeps automatic retries automatic so a cached model phrase is not labelled custom", async () => {
    useSelectionStore.setState({ mask: image, isolation: isolated, phase: 1 });
    vi.mocked(apiRequest).mockResolvedValue(isolationJob("queued"));
    vi.mocked(watchJob).mockResolvedValue(isolationJob("completed"));
    await useSelectionStore.getState().isolate();
    expect(JSON.parse(vi.mocked(apiRequest).mock.calls[0][1]!.body as string)).not.toHaveProperty("instruction");
  });
  it("sends an edited instruction and invalidates the background when selection points change", async () => {
    useSelectionStore.setState({ mask: image, isolation: isolated, phase: 1 });
    vi.mocked(apiRequest).mockResolvedValue(isolationJob("queued"));
    vi.mocked(watchJob).mockResolvedValue(isolationJob("completed"));
    await useSelectionStore.getState().isolate("Remove only the dog.");
    expect(JSON.parse(vi.mocked(apiRequest).mock.calls[0][1]!.body as string).instruction).toBe("Remove only the dog.");
    useSelectionStore.getState().visitPhase(0);
    useSelectionStore.getState().addSubject();
    useSelectionStore.getState().addPoint({ x: 5, y: 5 }, false);
    expect(useSelectionStore.getState()).toMatchObject({ isolation: null, mask: null });
    useSelectionStore.getState().visitPhase(2);
    expect(useSelectionStore.getState().phase).toBe(0);
  });
  it("does not start isolation without a confirmed mask", async () => {
    await useSelectionStore.getState().isolate();
    expect(apiRequest).not.toHaveBeenCalled();
    expect(useSelectionStore.getState().busy).toBe(false);
  });
  it.each(["cat", ""])("keeps the selection's submitted name when the text field changes to %s", async text => {
    vi.mocked(watchJob).mockResolvedValue(result([first]));
    await useSelectionStore.getState().segment();
    useSelectionStore.getState().setText(text);
    useSelectionStore.setState({ mask: image, phase: 1 });
    vi.mocked(apiRequest).mockResolvedValue(isolationJob("queued"));
    vi.mocked(watchJob).mockResolvedValue(isolationJob("completed"));
    await useSelectionStore.getState().isolate();
    expect(JSON.parse(vi.mocked(apiRequest).mock.calls[0][1]!.body as string).userText).toBe("dog");
    expect(useSelectionStore.getState().selectionText).toBe("dog");
  });
  it("uses the submitted name for text detection and drops it after point refinement", async () => {
    useSelectionStore.getState().setText("cat");
    vi.mocked(watchJob).mockResolvedValue(result([first]));
    await useSelectionStore.getState().segment();
    expect(useSelectionStore.getState().selectionText).toBe("cat");
    useSelectionStore.getState().setText("dog");
    useSelectionStore.getState().editSubject(first.id);
    useSelectionStore.getState().addPoint({ x: 4, y: 5 }, false);
    vi.mocked(watchJob).mockResolvedValue(result([refined]));
    await useSelectionStore.getState().applyRefinement();
    expect(useSelectionStore.getState().selectionText).toBe("");
  });
  it("describes a newly pointed subject without the previous subject's name or removal instruction", async () => {
    useSelectionStore.setState({ mask: image, isolation: isolated, phase: 1, candidates: [first], selectedIds: [first.id] });
    useSelectionStore.getState().visitPhase(0);
    useSelectionStore.getState().editSubject(first.id);
    useSelectionStore.getState().addPoint({ x: 80, y: 80 }, false);
    vi.mocked(watchJob).mockResolvedValue(result([refined]));
    await useSelectionStore.getState().applyRefinement();
    expect(useSelectionStore.getState()).toMatchObject({ mask: null, isolation: null, selectionText: "", text: "dog" });
    const nextMask = { ...image, id: "fe2b7e67-cab8-4c40-862c-7d23ea250782" };
    vi.mocked(apiRequest).mockResolvedValueOnce({ mask: nextMask }).mockResolvedValueOnce(isolationJob("queued"));
    await useSelectionStore.getState().confirm();
    const nextIsolation = { ...isolated, maskId: nextMask.id, phrase: "the black cat", instruction: "Remove the black cat." };
    vi.mocked(watchJob).mockResolvedValue({ ...isolationJob("completed"), isolation: nextIsolation });
    await useSelectionStore.getState().isolate();
    const call = vi.mocked(apiRequest).mock.calls.find(([path]) => path === "/jobs/isolate")!;
    expect(JSON.parse(call[1]!.body as string)).toEqual({ imageId: image.id, maskId: nextMask.id, userText: "" });
    expect(useSelectionStore.getState().isolation?.instruction).toBe("Remove the black cat.");
  });
  it("does not reuse an instruction whose confirmed mask differs from the current one", async () => {
    const nextMask = { ...image, id: "fe2b7e67-cab8-4c40-862c-7d23ea250782" };
    useSelectionStore.setState({ mask: nextMask, isolation: isolated, phase: 1 });
    vi.mocked(apiRequest).mockResolvedValue(isolationJob("queued"));
    vi.mocked(watchJob).mockResolvedValue({ ...isolationJob("completed"), isolation: { ...isolated, maskId: nextMask.id } });
    await useSelectionStore.getState().isolate();
    expect(JSON.parse(vi.mocked(apiRequest).mock.calls[0][1]!.body as string)).not.toHaveProperty("instruction");
  });
  it.each(["imageId", "maskId"] as const)("rejects a stale isolation's %s for preview, navigation and retry", field => {
    useSelectionStore.setState({ mask: image, isolation: { ...isolated, [field]: crypto.randomUUID() }, phase: 1 });
    expect(currentIsolation(useSelectionStore.getState())).toBeNull();
    useSelectionStore.getState().visitPhase(2);
    expect(useSelectionStore.getState().phase).toBe(1);
  });
  it("allows manual recovery only for a failed isolation belonging to the current photo and mask", () => {
    const job = { ...isolationJob("failed"), imageId: image.id, maskId: image.id };
    useSelectionStore.setState({ mask: image, job });
    expect(canRecoverIsolation(useSelectionStore.getState())).toBe(true);
    useSelectionStore.setState({ job: { ...job, imageId: crypto.randomUUID() } });
    expect(canRecoverIsolation(useSelectionStore.getState())).toBe(false);
    useSelectionStore.setState({ job: { ...job, maskId: crypto.randomUUID() } });
    expect(canRecoverIsolation(useSelectionStore.getState())).toBe(false);
    useSelectionStore.setState({ job: { ...job, status: "completed" } });
    expect(canRecoverIsolation(useSelectionStore.getState())).toBe(false);
  });
});
