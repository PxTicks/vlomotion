import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildMotionCurve } from "@h3-motion/shared";
import { drawSceneMask, drawSceneReference } from "../subjectLayers";
import type { SubjectLayers } from "../subjectLayers";
import { motionTargetAt } from "../motionHitTest";
import { useMotionStore } from "../useMotionStore";

function layers(x: number, name: string): SubjectLayers {
  const mask = new Uint8ClampedArray(200 * 100);
  for (let y = 20; y < 50; y++) for (let column = x; column < x + 30; column++) mask[y * 200 + column] = 255;
  return { width: 200, height: 100, bounds: { x, y: 20, width: 30, height: 30 }, mask,
    photo: { name: "photo" }, plate: { name: "plate" }, cutout: { name }, matte: { name: `${name} mask` } } as unknown as SubjectLayers;
}
const first = layers(10, "first"), second = layers(100, "second");
const inputs = [{ id: "first", name: "First", layers: first }, { id: "second", name: "Second", layers: second }];
const state = () => useMotionStore.getState();
const tracks = () => state().subjects.map(subject => ({ ...subject, curve: buildMotionCurve(subject.motion) }));
const record = (id: string, x: number, y: number) => {
  state().selectSubject(id);
  state().setPlayhead(0);
  const anchor = state().motion!.anchor;
  expect(state().startRecording()).toBe(0);
  state().finishRecording([{ time: 0, ...anchor }, { time: 100, x, y }]);
};

beforeEach(() => {
  useMotionStore.setState(useMotionStore.getInitialState(), true);
  state().prepareSubjects("image:mask", "layers", "scene", first, inputs);
});

describe("independent subject paths", () => {
  it("preserves each subject's path when switching and clearing the active path", () => {
    record("first", 80, 70);
    const firstMotion = state().motion;
    record("second", 140, 70);
    const secondMotion = state().motion;
    state().selectSubject("first");
    expect(state().motion).toBe(firstMotion);
    expect(state().startRecording()).toBeNull();
    state().clearPath();
    expect(state().subjects[0].motion.keys).toHaveLength(1);
    expect(state().subjects[1].motion).toBe(secondMotion);
    expect(state().startRecording()).toBe(0);
  });
  it("edits and retimes only the active subject's keys", () => {
    record("first", 80, 70);
    const firstMotion = state().motion;
    record("second", 140, 70);
    const key = state().motion!.keys[1];
    state().moveKey(key.id, { x: 160, y: 60 });
    state().retimeKey(key.id, 100);
    expect(state().subjects[0].motion).toBe(firstMotion);
    expect(state().subjects[1].motion.keys[1]).toMatchObject({ frame: 100, x: 160, y: 60 });
  });
  it("uses one clip length for every subject", () => {
    record("first", 80, 70);
    record("second", 140, 70);
    state().setFrames(243);
    expect(state().subjects.map(subject => subject.motion.frames)).toEqual([243, 243]);
    state().selectSubject("first");
    expect(state().motion!.frames).toBe(243);
  });
  it("keeps paths, colours and layer order when the background is regenerated", () => {
    record("first", 80, 70);
    state().reorderSubject("second", -1);
    const before = state().subjects;
    state().prepareSubjects("image:mask", "new layers", "new scene", first, inputs);
    expect(state().subjects.map(subject => [subject.id, subject.color, subject.motion])).toEqual(before.map(subject => [subject.id, subject.color, subject.motion]));
    expect(new Set(state().subjects.map(subject => subject.color)).size).toBe(2);
  });
  it("preserves remaining subjects when the selection changes, and resets paths for a new photo", () => {
    record("first", 80, 70);
    const motion = state().motion;
    state().prepareSubjects("image:new-mask", "new layers", "new scene", first, [inputs[0]]);
    expect(state().motion).toBe(motion);
    state().prepareSubjects("other-image:mask", "other layers", "other scene", first, inputs);
    expect(state().subjects.every(subject => subject.motion.keys.length === 1)).toBe(true);
  });
  it("keeps the active subject and layer order fixed during recording", () => {
    state().startRecording();
    state().selectSubject("second");
    state().reorderSubject("second", -1);
    expect(state().activeSubjectId).toBe("first");
    expect(state().subjects.map(subject => subject.id)).toEqual(["first", "second"]);
  });
});

describe("canvas subject interception", () => {
  it("selects the subject at the click rather than whichever subject was previously active", () => {
    expect(motionTargetAt(tracks(), { x: 105, y: 25 }, 0, .1)?.subject.id).toBe("second");
    expect(state().activeSubjectId).toBe("first");
  });
  it("picks the frontmost opaque subject at its moved position, respecting reordering", () => {
    record("second", 25, 35);
    expect(motionTargetAt(tracks(), { x: 25, y: 35 }, 123, .1)?.subject.id).toBe("first");
    state().reorderSubject("second", -1);
    const target = motionTargetAt(tracks(), { x: 25, y: 35 }, 123, .1);
    expect(target?.subject.id).toBe("second");
    expect(target?.kind).toBe("key");
  });
  it("allows a click through transparent mask pixels to the subject below", () => {
    record("second", 25, 35);
    const transparent = { ...first, mask: new Uint8ClampedArray(first.mask.length) };
    state().prepareSubjects("image:mask", "layers", "scene", first, [{ ...inputs[0], layers: transparent }, inputs[1]]);
    expect(motionTargetAt(tracks(), { x: 25, y: 35 }, 123, .1)?.subject.id).toBe("second");
  });
  it("selects the owner of a path clicked away from the subject and keys", () => {
    record("first", 180, 35);
    const target = motionTargetAt(tracks(), { x: 80, y: 35 }, 0, .1);
    expect(target).toMatchObject({ kind: "path", subject: { id: "first" } });
  });
});

describe("scene compositing", () => {
  function context() {
    return { canvas: { width: 200, height: 100 }, drawImage: vi.fn(), fillRect: vi.fn(), fillStyle: "" };
  }
  it("draws the background once and independently positioned subjects from back to front", () => {
    const drawing = context();
    const positioned = [{ layers: first, offset: { x: 10, y: 5 } }, { layers: second, offset: { x: -20, y: 15 } }];
    drawSceneReference(drawing as unknown as CanvasRenderingContext2D, first, positioned);
    expect(drawing.drawImage.mock.calls).toEqual([
      [first.plate, 0, 0, 200, 100], [second.cutout, -20, 15, 200, 100], [first.cutout, 10, 5, 200, 100],
    ]);
  });
  it("preserves the original photo as frame zero", () => {
    const drawing = context();
    drawSceneReference(drawing as unknown as CanvasRenderingContext2D, first, [{ layers: second, offset: { x: 0, y: 0 } }], true);
    expect(drawing.drawImage.mock.calls).toEqual([[first.photo, 0, 0, 200, 100]]);
  });
  it("keeps the full photo and mask aligned when the output ratio is rounded for encoding", () => {
    const source = { ...first, width: 1000, height: 701 };
    const drawing = context();
    drawing.canvas = { width: 686, height: 480 };
    drawSceneReference(drawing as unknown as CanvasRenderingContext2D, source, [], true);
    expect(drawing.drawImage.mock.calls).toEqual([[source.photo, 0, 0, 686, 480]]);
    drawing.drawImage.mockClear();
    drawSceneMask(drawing as unknown as CanvasRenderingContext2D, [{ layers: source, offset: { x: 100, y: 70.1 } }]);
    expect(drawing.drawImage.mock.calls).toEqual([[source.matte, 68.6, 48, 686, 480]]);
  });
  it("combines independently shifted mattes for the mask video", () => {
    const drawing = context();
    drawSceneMask(drawing as unknown as CanvasRenderingContext2D, [{ layers: first, offset: { x: 10, y: 5 } }, { layers: second, offset: { x: -20, y: 15 } }]);
    expect(drawing.fillRect).toHaveBeenCalledWith(0, 0, 200, 100);
    expect(drawing.drawImage.mock.calls).toEqual([[second.matte, -20, 15, 200, 100], [first.matte, 10, 5, 200, 100]]);
  });
});
