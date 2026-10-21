import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobSnapshot, MaskCandidate } from "@h3-motion/shared";
import { apiRequest, submitSegment, watchJob } from "../../../api";
import { useSelectionStore } from "../useSelectionStore";

vi.mock("../../../api", () => ({ apiRequest: vi.fn(), submitSegment: vi.fn(), uploadImage: vi.fn(), watchJob: vi.fn() }));
const image = { id: "f4c8a75f-2c99-4d89-b30e-fe18d97ede92", url: "/api/files/photo", width: 100, height: 100 };
const candidate = (id: string): MaskCandidate => ({ id, url: `/api/files/${id}`, bounds: { x: 0, y: 0, width: 10, height: 10 } });
const first = candidate("first"), second = candidate("second"), refined = candidate("refined");
const result = (candidates: MaskCandidate[]): JobSnapshot => ({ id: "job", status: "completed", message: "Done", progress: 1, candidates, error: null });

beforeEach(() => {
  vi.resetAllMocks();
  useSelectionStore.setState(useSelectionStore.getInitialState(), true);
  useSelectionStore.setState({ image, text: "dog" });
  vi.mocked(submitSegment).mockResolvedValue({ ...result([]), status: "queued" });
});

describe("selection transitions", () => {
  it("selects the highest-ranked candidate after text detection", async () => {
    vi.mocked(watchJob).mockResolvedValue(result([first, second]));
    await useSelectionStore.getState().segment();
    expect(useSelectionStore.getState()).toMatchObject({ candidates: [first, second], selectedIds: [first.id], busy: false });
  });
  it("switches to points when no text candidates are returned", async () => {
    vi.mocked(watchJob).mockResolvedValue(result([]));
    await useSelectionStore.getState().segment();
    expect(useSelectionStore.getState()).toMatchObject({ refine: true, candidates: [], selectedIds: [] });
  });
  it("replaces only the first selected candidate and keeps it as the refinement target", async () => {
    useSelectionStore.setState({ candidates: [first, second], selectedIds: [first.id, second.id], refine: true });
    vi.mocked(watchJob).mockResolvedValue(result([refined]));
    useSelectionStore.getState().addPoint({ x: 4, y: 5 }, false);
    await useSelectionStore.getState().applyRefinement();
    expect(submitSegment).toHaveBeenCalledWith({ mode: "points", imageId: image.id, positive: [{ x: 4, y: 5 }], negative: [] });
    expect(useSelectionStore.getState().selectedIds).toEqual([refined.id, second.id]);
    const again = candidate("again");
    vi.mocked(watchJob).mockResolvedValue(result([again]));
    useSelectionStore.getState().addPoint({ x: 8, y: 9 }, true);
    await useSelectionStore.getState().applyRefinement();
    expect(useSelectionStore.getState().candidates).toEqual([again, second]);
    expect(useSelectionStore.getState().selectedIds).toEqual([again.id, second.id]);
  });
  it("collects multiple include/exclude points without submitting or locking the canvas", async () => {
    useSelectionStore.setState({ refine: true, candidates: [first], selectedIds: [first.id] });
    const store = useSelectionStore.getState();
    store.addPoint({ x: 4, y: 5 }, false);
    store.addPoint({ x: 6, y: 7 }, false);
    store.addPoint({ x: 8, y: 9 }, true);
    expect(submitSegment).not.toHaveBeenCalled();
    expect(useSelectionStore.getState()).toMatchObject({ busy: false, pointsPending: true,
      positive: [{ x: 4, y: 5 }, { x: 6, y: 7 }], negative: [{ x: 8, y: 9 }] });
    vi.mocked(watchJob).mockResolvedValue(result([refined]));
    await store.applyRefinement();
    expect(submitSegment).toHaveBeenCalledExactlyOnceWith({ mode: "points", imageId: image.id,
      positive: [{ x: 4, y: 5 }, { x: 6, y: 7 }], negative: [{ x: 8, y: 9 }] });
    expect(useSelectionStore.getState()).toMatchObject({ pointsPending: false, selectedIds: [refined.id] });
    await store.applyRefinement();
    expect(submitSegment).toHaveBeenCalledTimes(1);
  });
  it("requires an include point but allows exclude points to be placed first", async () => {
    useSelectionStore.setState({ refine: true });
    useSelectionStore.getState().addPoint({ x: 8, y: 9 }, true);
    await useSelectionStore.getState().applyRefinement();
    expect(useSelectionStore.getState().negative).toEqual([{ x: 8, y: 9 }]);
    expect(submitSegment).not.toHaveBeenCalled();
  });
  it("removes individual include and exclude points without submitting refinement", () => {
    useSelectionStore.setState({ refine: true, candidates: [first], selectedIds: [first.id] });
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
    useSelectionStore.setState({ refine: true, candidates: [first], selectedIds: [first.id], positive, pointsPending: false });
    useSelectionStore.getState().removePoint(0, false);
    expect(useSelectionStore.getState().pointsPending).toBe(true);
    vi.mocked(watchJob).mockResolvedValue(result([refined]));
    await useSelectionStore.getState().applyRefinement();
    expect(submitSegment).toHaveBeenCalledExactlyOnceWith({ mode: "points", imageId: image.id, positive: [positive[1]], negative: [] });
  });
  it("ignores invalid point removals and prevents editing during refinement", () => {
    const positive = [{ x: 4, y: 5 }];
    useSelectionStore.setState({ refine: true, positive, pointsPending: false });
    const store = useSelectionStore.getState();
    for (const index of [-1, 1, 0.5]) store.removePoint(index, false);
    useSelectionStore.setState({ busy: true });
    store.removePoint(0, false);
    expect(useSelectionStore.getState()).toMatchObject({ positive, pointsPending: false });
    expect(submitSegment).not.toHaveBeenCalled();
  });
  it("blocks confirmation until pending points are applied or cleared", async () => {
    useSelectionStore.setState({ refine: true, candidates: [first], selectedIds: [first.id] });
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
    useSelectionStore.setState({ refine: true, candidates: [first, second], selectedIds: [first.id, second.id] });
    useSelectionStore.getState().addPoint({ x: 4, y: 5 }, false);
    vi.mocked(watchJob).mockResolvedValue(status === "empty" ? result([])
      : { ...result([]), status: status as "failed" | "cancelled", error: "Refinement failed" });
    await useSelectionStore.getState().applyRefinement();
    expect(useSelectionStore.getState()).toMatchObject({ pointsPending: true, busy: false,
      candidates: [first, second], selectedIds: [first.id, second.id], positive: [{ x: 4, y: 5 }] });
  });
  it("clears pending points when changing the target or leaving refinement mode", () => {
    useSelectionStore.setState({ refine: true, candidates: [first, second], selectedIds: [first.id] });
    useSelectionStore.getState().addPoint({ x: 4, y: 5 }, false);
    useSelectionStore.getState().toggleCandidate(second.id);
    expect(useSelectionStore.getState()).toMatchObject({ pointsPending: false, positive: [], negative: [] });
    useSelectionStore.getState().addPoint({ x: 4, y: 5 }, false);
    useSelectionStore.getState().setRefine(false);
    expect(useSelectionStore.getState()).toMatchObject({ pointsPending: false, positive: [], negative: [], refine: false });
  });
  it("invalidates confirmed masks when selection changes", () => {
    useSelectionStore.setState({ mask: image, phase: 1, selectedIds: [first.id] });
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
});
