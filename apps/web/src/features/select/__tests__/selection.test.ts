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
    useSelectionStore.getState().setRefine(true);
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
    useSelectionStore.getState().setRefine(true);
    useSelectionStore.getState().addPoint({ x: 4, y: 5 }, false);
    vi.mocked(watchJob).mockResolvedValue(result([refined]));
    await useSelectionStore.getState().applyRefinement();
    expect(useSelectionStore.getState().selectionText).toBe("");
  });
  it("describes a newly pointed subject without the previous subject's name or removal instruction", async () => {
    useSelectionStore.setState({ mask: image, isolation: isolated, phase: 1, candidates: [first], selectedIds: [first.id] });
    useSelectionStore.getState().visitPhase(0);
    useSelectionStore.getState().setRefine(true);
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
