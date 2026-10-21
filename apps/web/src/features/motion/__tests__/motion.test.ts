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
  it("records only when armed, without playing, and fits the take to the clip", () => {
    expect(state().startRecording()).toBeNull();
    state().setArmed(true);
    expect(state().startRecording()).toBe(0);
    expect(state().playing).toBe(false);
    state().setPlayhead(50);
    expect(state().playhead).toBe(0);
    state().finishRecording([{ time: 0, x: 100, y: 200 }, { time: 300, x: 300, y: 200 }, { time: 600, x: 300, y: 400 }]);
    expect(state()).toMatchObject({ recording: false, armed: false, playing: false });
    expect(state().motion?.keys.map(key => [key.frame, key.x, key.y])).toEqual([[0, 100, 200], [62, 300, 200], [123, 300, 400]]);
  });
  it("drops an unfinished take when the editor closes", () => {
    state().setArmed(true); state().startRecording();
    state().leave();
    expect(state()).toMatchObject({ recording: false, armed: false, playing: false });
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
