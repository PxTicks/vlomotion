import { beforeEach, describe, expect, it } from "vitest";
import { binaryMask, featherMask, maskBounds } from "../subjectLayers";
import { useMotionStore } from "../useMotionStore";

const bounds = { x: 80, y: 180, width: 40, height: 40 };
const size = { width: 1000, height: 500 };
const state = () => useMotionStore.getState();

beforeEach(() => {
  useMotionStore.setState(useMotionStore.getInitialState(), true);
  state().prepare("image:mask", bounds, size);
});

describe("motion store", () => {
  it("anchors a new motion at the subject's centre", () => {
    expect(state().motion?.keys).toEqual([{ id: "start", frame: 0, x: 100, y: 200 }]);
    expect(state().motion?.timing).toBe("smooth");
    expect(state().notice).toBeNull();
  });
  it("makes the first drag from the photo frame set the end position", () => {
    expect(state().beginSubjectDrag()).toEqual({ x: 100, y: 200 });
    expect(state().playhead).toBe(123);
    state().placeSubject({ x: 600, y: 250 });
    expect(state().motion?.keys.map(key => [key.frame, key.x, key.y])).toEqual([[0, 100, 200], [123, 600, 250]]);
    expect(state().selectedKeyId).toBe(state().motion?.keys[1].id);
  });
  it("refuses to move the subject on the photo frame once it has keys", () => {
    state().beginSubjectDrag(); state().placeSubject({ x: 600, y: 250 });
    state().setPlayhead(0);
    expect(state().beginSubjectDrag()).toBeNull();
    expect(state().notice).toMatch(/first frame is your photo/);
  });
  it("adds a key at the playhead without changing the path, then deletes it", () => {
    state().beginSubjectDrag(); state().placeSubject({ x: 600, y: 200 });
    state().setPlayhead(60);
    state().addKey();
    const added = state().motion!.keys[1];
    expect(added.frame).toBe(60);
    expect(added.y).toBeCloseTo(200, 6);
    state().deleteSelected();
    expect(state().motion?.keys).toHaveLength(2);
  });
  it("keeps the photo key when it is selected for deletion", () => {
    state().selectKey("start");
    state().deleteSelected();
    expect(state().motion?.keys).toHaveLength(1);
  });
  it("keeps keys inside one frame of the image when dragged far away", () => {
    state().beginSubjectDrag(); state().placeSubject({ x: 99_999, y: -99_999 });
    expect(state().motion?.keys[1]).toMatchObject({ x: 2000, y: -500 });
  });
  it("resets the motion and says so when the subject changes", () => {
    state().beginSubjectDrag(); state().placeSubject({ x: 600, y: 250 });
    state().setFrames(243);
    state().prepare("image:mask", bounds, size);
    expect(state().motion?.keys).toHaveLength(2);
    state().prepare("image:other", { ...bounds, x: 0 }, size);
    expect(state().motion).toMatchObject({ frames: 243, keys: [{ frame: 0, x: 20, y: 200 }] });
    expect(state().notice).toMatch(/motion path was reset/);
  });
  it("pauses playback when the user scrubs and restarts from 0 at the end", () => {
    state().setPlayhead(123);
    state().togglePlay();
    expect(state()).toMatchObject({ playing: true, playhead: 0 });
    state().setPlayhead(40);
    expect(state()).toMatchObject({ playing: false, playhead: 40 });
  });
  it("records without arming, pauses playback, and fits the take to the clip", () => {
    state().togglePlay();
    expect(state().startRecording()).toBe(0);
    expect(state().playing).toBe(false);
    state().setPlayhead(50);
    expect(state().playhead).toBe(0);
    state().finishRecording([{ time: 0, x: 100, y: 200 }, { time: 300, x: 300, y: 200 }, { time: 600, x: 300, y: 400 }]);
    expect(state()).toMatchObject({ recording: false, playing: false });
    expect(state().motion?.keys.map(key => [key.frame, key.x, key.y])).toEqual([[0, 100, 200], [62, 300, 200], [123, 300, 400]]);
  });
  it("keyframes instead of recording when the user scrubs before the first drag", () => {
    state().setPlayhead(40);
    expect(state().scrubbed).toBe(true);
    expect(state().startRecording()).toBeNull();
    expect(state().beginSubjectDrag()).toEqual({ x: 100, y: 200 });
    state().placeSubject({ x: 300, y: 200 });
    state().setPlayhead(123);
    state().beginSubjectDrag(); state().placeSubject({ x: 300, y: 400 });
    expect(state().recording).toBe(false);
    expect(state().motion?.keys.map(key => [key.frame, key.x, key.y])).toEqual([[0, 100, 200], [40, 300, 200], [123, 300, 400]]);
  });
  it.each([
    ["scrubbing back to the photo frame", () => state().setPlayhead(0)],
    ["playing the clip", () => state().togglePlay()],
    ["clearing the path", () => state().clearPath()],
  ])("records again after %s", (_, reset) => {
    state().setPlayhead(60);
    reset();
    expect(state().scrubbed).toBe(false);
    expect(state().startRecording()).not.toBeNull();
  });
  it("selects the last key the playhead crosses while scrubbing", () => {
    for (const frame of [40, 80, 123]) { state().setPlayhead(frame); state().beginSubjectDrag(); state().placeSubject({ x: 100 + frame, y: 200 }); }
    const [start, at40, at80, at123] = state().motion!.keys;
    state().setPlayhead(10); state().selectKey(null);
    state().scrub(30);
    expect(state().selectedKeyId).toBeNull();
    state().scrub(90);
    expect(state().selectedKeyId).toBe(at80.id);
    state().scrub(100);
    expect(state().selectedKeyId).toBe(at80.id);
    state().scrub(123);
    expect(state().selectedKeyId).toBe(at123.id);
    state().scrub(60);
    expect(state().selectedKeyId).toBe(at80.id);
    state().scrub(20);
    expect(state().selectedKeyId).toBe(at40.id);
    state().scrub(0);
    expect(state().selectedKeyId).toBe(start.id);
  });
  it("selects the last key crossed since play started when playback pauses", () => {
    for (const frame of [40, 80]) { state().setPlayhead(frame); state().beginSubjectDrag(); state().placeSubject({ x: 100 + frame, y: 200 }); }
    const [, at40, at80] = state().motion!.keys;
    state().setPlayhead(50); state().selectKey(null);
    state().togglePlay();
    useMotionStore.setState({ playhead: 70 });
    state().togglePlay();
    expect(state()).toMatchObject({ playing: false, selectedKeyId: null });
    state().setPlayhead(10);
    state().togglePlay();
    useMotionStore.setState({ playhead: 90 });
    state().togglePlay();
    expect(state().selectedKeyId).toBe(at80.id);
    state().setPlayhead(10);
    state().togglePlay();
    useMotionStore.setState({ playhead: 60 });
    state().pause();
    expect(state()).toMatchObject({ playing: false, selectedKeyId: at40.id });
  });
  it("drops an unfinished take when the editor closes", () => {
    state().startRecording();
    state().leave();
    expect(state()).toMatchObject({ recording: false, playing: false });
  });
  it.each([0, 60, 123])("protects an existing path from recording again at frame %s", frame => {
    state().startRecording();
    state().finishRecording([{ time: 0, x: 100, y: 200 }, { time: 300, x: 300, y: 200 }, { time: 600, x: 300, y: 400 }]);
    state().setPlayhead(frame);
    state().selectKey(state().motion!.keys[1].id);
    const before = state();
    expect(state().startRecording()).toBeNull();
    state().finishRecording([{ time: 0, x: 100, y: 200 }, { time: 300, x: 200, y: 400 }]);
    expect(state()).toBe(before);
  });
  it.each([40, 62])("preserves other diamonds when the subject is dragged at frame %s", frame => {
    state().startRecording();
    state().finishRecording([{ time: 0, x: 100, y: 200 }, { time: 300, x: 300, y: 200 }, { time: 600, x: 300, y: 400 }]);
    const originalKeys = state().motion!.keys;
    state().setPlayhead(frame);
    expect(state().beginSubjectDrag()).not.toBeNull();
    state().placeSubject({ x: 400, y: 250 });
    expect(state().recording).toBe(false);
    expect(state().motion!.keys.filter(key => key.frame !== frame)).toEqual(originalKeys.filter(key => key.frame !== frame));
    expect(state().motion!.keys.find(key => key.frame === frame)).toMatchObject({ x: 400, y: 250 });
  });
  it("can record again when a drag did not create a path", () => {
    state().startRecording();
    expect(state().startRecording()).toBeNull();
    state().finishRecording([{ time: 0, x: 100, y: 200 }, { time: 300, x: 100, y: 200 }]);
    expect(state().motion?.keys).toHaveLength(1);
    expect(state().startRecording()).toBe(0);
  });
  it("lets recorded keys be moved on the canvas and retimed without recording another path", () => {
    state().startRecording();
    state().finishRecording([{ time: 0, x: 100, y: 200 }, { time: 300, x: 300, y: 200 }, { time: 600, x: 300, y: 400 }]);
    const key = state().motion!.keys[1];
    state().selectKey(key.id);
    state().moveKey(key.id, { x: 400, y: 250 });
    state().retimeKey(key.id, 40);
    expect(state().motion?.keys[1]).toMatchObject({ id: key.id, frame: 40, x: 400, y: 250 });
    expect(state().motion?.keys[0]).toMatchObject({ frame: 0, x: 100, y: 200 });
    expect(state()).toMatchObject({ recording: false, selectedKeyId: key.id, playhead: 40 });
  });
  it("clears the path and resets playback while preserving the subject and clip length", () => {
    state().setFrames(243);
    state().startRecording();
    state().finishRecording([{ time: 0, x: 100, y: 200 }, { time: 300, x: 300, y: 400 }]);
    state().selectKey(state().motion!.keys[1].id);
    state().setPlayhead(100);
    state().togglePlay();
    state().clearPath();
    expect(state()).toMatchObject({ subjectKey: "image:mask", bounds, size, playhead: 0, playing: false, recording: false, selectedKeyId: null, notice: null });
    expect(state().motion).toEqual({ anchor: { x: 100, y: 200 }, frames: 243, timing: "smooth", keys: [{ id: "start", frame: 0, x: 100, y: 200 }] });
    expect(state().startRecording()).toBe(0);
  });
  it("does not clear the path during an active recording", () => {
    const motion = state().motion;
    state().startRecording();
    state().clearPath();
    expect(state().recording).toBe(true);
    expect(state().motion).toBe(motion);
  });
});

describe("subject mask pixels", () => {
  const width = 4, height = 3;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (const index of [5, 6]) rgba[index * 4] = 255;
  const mask = binaryMask(rgba);
  it("thresholds and bounds the subject", () => {
    expect([...mask]).toEqual([0, 0, 0, 0, 0, 255, 255, 0, 0, 0, 0, 0]);
    expect(maskBounds(mask, width, height)).toEqual({ x: 1, y: 1, width: 2, height: 1 });
    expect(maskBounds(new Uint8ClampedArray(12), width, height)).toBeNull();
  });
  it("feathers the edge by one pixel", () => {
    const feathered = featherMask(mask, width, height);
    expect(feathered[5]).toBe(Math.round(510 / 9));
    expect(feathered[0]).toBe(Math.round(255 / 4));
    expect(feathered[3]).toBe(Math.round(255 / 4));
  });
});
