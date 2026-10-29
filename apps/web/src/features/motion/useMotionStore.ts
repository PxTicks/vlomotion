import { create } from "zustand";
import {
  animationEnd, applyRecording, buildMotionCurve, createMotion, deleteKey, evenSpeed, insertKeyAtLength, isStartKey, lastFrame,
  moveKey, retimeKey, setClipFrames, upsertKey,
} from "@h3-motion/shared";
import type { FrameCount, FrameSize, MotionTiming, Point, Pose, Rect, Scale, SubjectMotion, TimedSample } from "@h3-motion/shared";
import type { SubjectLayers } from "./subjectLayers";

export const SUBJECT_COLORS = ["#f2ff59", "#65d9ff", "#ff91c7", "#a6e879", "#c5a0ff", "#ffb86b", "#7af0d2", "#ff7777",
  "#91a7ff", "#ffe1a3", "#dd89e8", "#85cfb0", "#b9dbff", "#e4d580", "#f7b4a0", "#b4c791"];

export interface MotionSubject { id: string; name: string; color: string; layers: SubjectLayers; motion: SubjectMotion }
export interface SubjectInput { id: string; name: string; layers: SubjectLayers }

interface MotionState {
  /** Subjects in front-to-back order. `motion` and `bounds` below mirror the active subject. */
  subjects: MotionSubject[]; activeSubjectId: string | null; sceneKey: string | null;
  subjectKey: string | null; bounds: Rect | null; size: FrameSize | null; motion: SubjectMotion | null;
  playhead: number; playing: boolean; recording: boolean;
  /** The user parked the playhead after the photo frame, so a subject without a path is keyframed there instead of recorded. */
  scrubbed: boolean;
  selectedKeyId: string | null; notice: string | null;
  /** Loaded subject images, keyed by the photo, mask and plate they came from. */
  layers: SubjectLayers | null; layersKey: string | null;
  prepare: (subjectKey: string, bounds: Rect, size: FrameSize) => void;
  prepareSubjects: (subjectKey: string, layersKey: string, sceneKey: string, layers: SubjectLayers, subjects: SubjectInput[]) => void;
  selectSubject: (id: string) => void; reorderSubject: (id: string, direction: -1 | 1) => void;
  /** Moves the playhead for the user; parking it after the photo frame switches path creation to keyframing. */
  setPlayhead: (frame: number) => void;
  /** Moves the playhead like setPlayhead and selects the last key it passed or landed on. */
  scrub: (frame: number) => void; togglePlay: () => void;
  /** Stops playback and selects the last key it passed since play started. */
  pause: () => void;
  /** Stops playback and drops an unfinished take, e.g. when the editor closes. */
  leave: () => void;
  /** Starts dragging or resizing the subject at the playhead; returns its pose there, or null if this frame can't change. */
  beginSubjectDrag: () => Pose | null;
  /** Keys the subject's position, and its scale when given, at the playhead. */
  placeSubject: (pose: Point & Partial<Scale>) => void; addKey: () => void;
  selectKey: (id: string | null) => void; moveKey: (id: string, point: Point) => void;
  retimeKey: (id: string, frame: number) => void; insertAtLength: (length: number) => string | null;
  deleteSelected: () => void; resetScale: () => void; evenSpeed: () => void; clearPath: () => void;
  /** Changes every subject's clip length. Shortening past where the animation ends fits it into the shorter clip. */
  setFrames: (frames: FrameCount) => void;
  /** Stretches or compresses every subject's key times alike, so the animation ends on the clip's last frame. */
  fitToLength: () => void;
  setTiming: (timing: MotionTiming) => void;
  /** Starts a take on a subject without a path, unless the user scrubbed first; returns the frame it starts at. */
  startRecording: () => number | null;
  /** Applies a take, timed to fill the clip from the playhead where it started. */
  finishRecording: (samples: TimedSample[]) => void;
}

const newId = () => globalThis.crypto.randomUUID();
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** The key nearest `to` among those passed moving the playhead from `from` to `to`, excluding where it started. */
function lastCrossed(motion: SubjectMotion, from: number, to: number) {
  const crossed = motion.keys.filter(key => to > from ? key.frame > from && key.frame <= to : key.frame < from && key.frame >= to);
  return crossed.reduce<typeof crossed[number] | null>((best, key) => !best || Math.abs(key.frame - to) < Math.abs(best.frame - to) ? key : best, null);
}

export const useMotionStore = create<MotionState>((set, get) => {
  let playStart = 0;
  /** Keeps dragged positions within one frame's width or height of the image, so keys stay reachable. */
  function bounded(point: Point): Point {
    const { size } = get();
    if (!size) return point;
    return { x: clamp(point.x, -size.width, size.width * 2), y: clamp(point.y, -size.height, size.height * 2) };
  }
  function edit(next: SubjectMotion, extra: Partial<MotionState> = {}) {
    if (next !== get().motion) set({ ...motionPatch(next), notice: null, ...extra });
  }
  /** Sets every subject's clip length, scaling their keys alike from where the latest one ends; returns whether keys moved. */
  function resize(frames: FrameCount, fit: boolean) {
    const { motion, playhead, subjects, activeSubjectId } = get();
    if (!motion) return false;
    const end = Math.max(animationEnd(motion), ...subjects.map(subject => animationEnd(subject.motion)));
    const next = setClipFrames(motion, frames, { fit, end });
    const resized = subjects.map(subject => ({ ...subject, motion: setClipFrames(subject.motion, frames, { fit, end }) }));
    const retimed = (before: SubjectMotion, after: SubjectMotion) => after.keys.some((key, i) => key.frame !== before.keys[i].frame);
    const moved = retimed(motion, next) || resized.some((subject, i) => retimed(subjects[i].motion, subject.motion));
    set({ motion: resized.find(subject => subject.id === activeSubjectId)?.motion ?? next, subjects: resized, playing: false,
      playhead: Math.min(playhead, lastFrame(next)) });
    return moved;
  }
  function motionPatch(motion: SubjectMotion) {
    const { subjects, activeSubjectId } = get();
    return { motion, subjects: subjects.map(subject => subject.id === activeSubjectId ? { ...subject, motion } : subject) };
  }
  return {
    subjects: [], activeSubjectId: null, sceneKey: null,
    subjectKey: null, bounds: null, size: null, motion: null, playhead: 0, playing: false, recording: false, scrubbed: false,
    selectedKeyId: null, notice: null, layers: null, layersKey: null,
    prepare: (subjectKey, bounds, size) => {
      const state = get();
      if (state.subjectKey === subjectKey) return;
      const anchor = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      set({ subjectKey, bounds, size, motion: createMotion(anchor, state.motion?.frames),
        subjects: [], activeSubjectId: null, sceneKey: null,
        playhead: 0, playing: false, recording: false, scrubbed: false, selectedKeyId: null,
        notice: state.motion && state.motion.keys.length > 1 ? "Your subject changed, so its motion path was reset." : null });
    },
    prepareSubjects: (subjectKey, layersKey, sceneKey, layers, inputs) => {
      const state = get();
      if (!inputs.length) return;
      const sameImage = state.subjectKey?.split(":")[0] === subjectKey.split(":")[0];
      const previous = sameImage ? state.subjects : [];
      const ordered = [...previous.map(subject => inputs.find(input => input.id === subject.id)).filter((input): input is SubjectInput => !!input),
        ...inputs.filter(input => !previous.some(subject => subject.id === input.id))];
      const usedColors = new Set(previous.filter(subject => inputs.some(input => input.id === subject.id)).map(subject => subject.color));
      const subjects = ordered.map(input => {
        const existing = previous.find(subject => subject.id === input.id);
        const { bounds } = input.layers;
        const anchor = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
        const color = existing?.color ?? SUBJECT_COLORS.find(color => !usedColors.has(color)) ?? SUBJECT_COLORS[0];
        usedColors.add(color);
        return { ...input, color, motion: existing?.motion ?? createMotion(anchor, state.motion?.frames) };
      });
      const active = subjects.find(subject => subject.id === state.activeSubjectId) ?? subjects[0];
      set({ subjectKey, layersKey, sceneKey, layers, subjects, activeSubjectId: active.id, motion: active.motion, bounds: active.layers.bounds,
        size: { width: layers.width, height: layers.height }, playhead: Math.min(state.playhead, lastFrame(active.motion)),
        playing: false, recording: false, selectedKeyId: active.id === state.activeSubjectId ? state.selectedKeyId : null, notice: null });
    },
    selectSubject: id => {
      const state = get(), subject = state.subjects.find(subject => subject.id === id);
      if (!subject || state.recording || state.activeSubjectId === id) return;
      set({ activeSubjectId: id, motion: subject.motion, bounds: subject.layers.bounds, selectedKeyId: null, playing: false, notice: null });
    },
    reorderSubject: (id, direction) => {
      const { subjects, recording } = get();
      const index = subjects.findIndex(subject => subject.id === id), next = index + direction;
      if (recording || index < 0 || next < 0 || next >= subjects.length) return;
      const reordered = [...subjects];
      [reordered[index], reordered[next]] = [reordered[next], reordered[index]];
      set({ subjects: reordered });
    },
    setPlayhead: frame => {
      const { motion, recording } = get();
      if (!motion || recording) return;
      const playhead = clamp(Math.round(frame), 0, lastFrame(motion));
      set({ playhead, playing: false, scrubbed: playhead > 0 });
    },
    scrub: frame => {
      const { playhead: from, setPlayhead } = get();
      setPlayhead(frame);
      const { motion, playhead: to } = get();
      const key = motion && lastCrossed(motion, from, to);
      if (key) set({ selectedKeyId: key.id });
    },
    togglePlay: () => {
      const { motion, playing, playhead, recording, pause } = get();
      if (!motion || recording) return;
      if (playing) { pause(); return; }
      playStart = playhead >= lastFrame(motion) ? 0 : playhead;
      set({ playing: true, scrubbed: false, playhead: playStart });
    },
    pause: () => {
      const { motion, playing, playhead } = get();
      if (!playing) return;
      const key = motion && lastCrossed(motion, playStart, playhead);
      set({ playing: false, ...(key ? { selectedKeyId: key.id } : {}) });
    },
    leave: () => set({ playing: false, recording: false }),
    beginSubjectDrag: () => {
      const { motion, playhead } = get();
      if (!motion) return null;
      set({ playing: false });
      if (playhead === 0) {
        if (motion.keys.length > 1) {
          set({ notice: "The first frame is your photo, so the subject can't move there. Move the playhead to a later time first." });
          return null;
        }
        // With no keys yet, the first drag sets where the subject ends up.
        set({ playhead: lastFrame(motion) });
        return { ...motion.anchor, sx: 1, sy: 1 };
      }
      const curve = buildMotionCurve(motion);
      return { ...curve.positionAt(playhead), ...curve.scaleAt(playhead) };
    },
    placeSubject: pose => {
      const { motion, playhead } = get();
      if (!motion) return;
      const result = upsertKey(motion, playhead, { ...pose, ...bounded(pose) }, newId());
      if (!result) { set({ notice: "You've reached the key limit. Delete a key to add another." }); return; }
      edit(result.motion, { selectedKeyId: result.id });
    },
    addKey: () => {
      const { motion, playhead } = get();
      if (!motion) return;
      if (playhead === 0) { set({ notice: "The first frame is your photo and already has a key." }); return; }
      const existing = motion.keys.find(key => key.frame === playhead);
      if (existing) { set({ selectedKeyId: existing.id }); return; }
      const curve = buildMotionCurve(motion);
      const result = upsertKey(motion, playhead, { ...curve.positionAt(playhead), ...curve.scaleAt(playhead) }, newId());
      if (!result) { set({ notice: "You've reached the key limit. Delete a key to add another." }); return; }
      edit(result.motion, { selectedKeyId: result.id });
    },
    selectKey: id => set({ selectedKeyId: id }),
    moveKey: (id, point) => { const { motion } = get(); if (motion) edit(moveKey(motion, id, bounded(point))); },
    retimeKey: (id, frame) => {
      const { motion } = get();
      if (!motion) return;
      const next = retimeKey(motion, id, frame);
      edit(next, { playhead: next.keys.find(key => key.id === id)?.frame ?? get().playhead });
    },
    insertAtLength: length => {
      const { motion } = get();
      if (!motion) return null;
      const result = insertKeyAtLength(motion, length, newId());
      if (!result) return null;
      edit(result.motion, { selectedKeyId: result.id, playing: false,
        playhead: result.motion.keys.find(key => key.id === result.id)!.frame });
      return result.id;
    },
    deleteSelected: () => {
      const { motion, selectedKeyId } = get();
      if (!motion || !selectedKeyId || isStartKey(motion, selectedKeyId)) return;
      edit(deleteKey(motion, selectedKeyId), { selectedKeyId: null });
    },
    resetScale: () => {
      const { motion, selectedKeyId } = get();
      const key = motion?.keys.find(key => key.id === selectedKeyId);
      if (motion && key) edit(moveKey(motion, key.id, { x: key.x, y: key.y, sx: 1, sy: 1 }));
    },
    evenSpeed: () => {
      const { motion } = get();
      if (!motion) return;
      edit(evenSpeed(motion), { notice: "Keys re-spaced for an even speed along the path." });
    },
    clearPath: () => {
      const { motion, recording } = get();
      if (!motion || recording) return;
      edit(createMotion(motion.anchor, motion.frames), { playhead: 0, playing: false, scrubbed: false, selectedKeyId: null });
    },
    setFrames: frames => {
      const { motion, recording } = get();
      if (!motion || recording || motion.frames === frames) return;
      const fitted = resize(frames, false);
      set({ notice: fitted ? "The animation was fitted to the shorter clip, so no keys were cut off." : null });
    },
    fitToLength: () => {
      const { motion, recording } = get();
      if (!motion || recording) return;
      if (resize(motion.frames, true)) set({ notice: "The animation was fitted to the clip length." });
    },
    setTiming: timing => { const { motion } = get(); if (motion && motion.timing !== timing) edit({ ...motion, timing }); },
    startRecording: () => {
      const { motion, recording, scrubbed, playhead } = get();
      if (!motion || recording || scrubbed || motion.keys.length > 1) return null;
      const start = playhead >= lastFrame(motion) ? 0 : playhead;
      set({ recording: true, playing: false, playhead: start, selectedKeyId: null, notice: null });
      return start;
    },
    finishRecording: samples => {
      const { motion, recording, playhead } = get();
      if (!motion || !recording) return;
      const next = applyRecording(motion, samples, playhead, newId);
      set({ ...motionPatch(next), recording: false, playing: false,
        notice: next === motion ? "Nothing was recorded. Press on the subject and drag it along its path." : null });
    },
  };
});
