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
    await useSelectionStore.getState().addPoint({ x: 4, y: 5 }, false);
    expect(submitSegment).toHaveBeenCalledWith({ mode: "points", imageId: image.id, positive: [{ x: 4, y: 5 }], negative: [] });
    expect(useSelectionStore.getState().selectedIds).toEqual([refined.id, second.id]);
    const again = candidate("again");
    vi.mocked(watchJob).mockResolvedValue(result([again]));
    await useSelectionStore.getState().addPoint({ x: 8, y: 9 }, true);
    expect(useSelectionStore.getState().candidates).toEqual([again, second]);
    expect(useSelectionStore.getState().selectedIds).toEqual([again.id, second.id]);
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
