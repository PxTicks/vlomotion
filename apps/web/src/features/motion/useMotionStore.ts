import { create } from "zustand";
import {
  applyRecording, buildMotionCurve, createMotion, deleteKey, evenSpeed, insertKeyAtLength, isStartKey, lastFrame,
  moveKey, retimeKey, setClipFrames, upsertKey,
} from "@h3-motion/shared";
import type { FrameCount, FrameSize, MotionTiming, Point, Rect, SubjectMotion, TimedSample } from "@h3-motion/shared";
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
  selectedKeyId: string | null; notice: string | null;
  /** Loaded subject images, keyed by the photo, mask and plate they came from. */
  layers: SubjectLayers | null; layersKey: string | null;
  prepare: (subjectKey: string, bounds: Rect, size: FrameSize) => void;
  prepareSubjects: (subjectKey: string, layersKey: string, sceneKey: string, layers: SubjectLayers, subjects: SubjectInput[]) => void;
  selectSubject: (id: string) => void; reorderSubject: (id: string, direction: -1 | 1) => void;
  setPlayhead: (frame: number) => void; togglePlay: () => void;
  /** Stops playback and drops an unfinished take, e.g. when the editor closes. */
  leave: () => void;
  /** Starts dragging the subject at the playhead; returns where it currently is, or null if this frame can't change. */
  beginSubjectDrag: () => Point | null;
  placeSubject: (point: Point) => void; addKey: () => void;
  selectKey: (id: string | null) => void; moveKey: (id: string, point: Point) => void;
  retimeKey: (id: string, frame: number) => void; insertAtLength: (length: number) => string | null;
  deleteSelected: () => void; evenSpeed: () => void; clearPath: () => void;
  setFrames: (frames: FrameCount) => void; setTiming: (timing: MotionTiming) => void;
  startRecording: () => number | null;
  /** Applies a take, timed to fill the clip from the playhead where it started. */
  finishRecording: (samples: TimedSample[]) => void;
}

const newId = () => globalThis.crypto.randomUUID();
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export const useMotionStore = create<MotionState>((set, get) => {
  /** Keeps dragged positions within one frame's width or height of the image, so keys stay reachable. */
  function bounded(point: Point): Point {
    const { size } = get();
    if (!size) return point;
    return { x: clamp(point.x, -size.width, size.width * 2), y: clamp(point.y, -size.height, size.height * 2) };
  }
  function edit(next: SubjectMotion, extra: Partial<MotionState> = {}) {
    if (next !== get().motion) set({ ...motionPatch(next), notice: null, ...extra });
  }
  function motionPatch(motion: SubjectMotion) {
    const { subjects, activeSubjectId } = get();
    return { motion, subjects: subjects.map(subject => subject.id === activeSubjectId ? { ...subject, motion } : subject) };
  }
  return {
    subjects: [], activeSubjectId: null, sceneKey: null,
    subjectKey: null, bounds: null, size: null, motion: null, playhead: 0, playing: false, recording: false,
    selectedKeyId: null, notice: null, layers: null, layersKey: null,
    prepare: (subjectKey, bounds, size) => {
      const state = get();
      if (state.subjectKey === subjectKey) return;
      const anchor = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      set({ subjectKey, bounds, size, motion: createMotion(anchor, state.motion?.frames),
        subjects: [], activeSubjectId: null, sceneKey: null,
        playhead: 0, playing: false, recording: false, selectedKeyId: null,
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
      set({ playhead: clamp(Math.round(frame), 0, lastFrame(motion)), playing: false });
    },
    togglePlay: () => {
      const { motion, playing, playhead, recording } = get();
      if (!motion || recording) return;
      set(playing ? { playing: false } : { playing: true, playhead: playhead >= lastFrame(motion) ? 0 : playhead });
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
        return { ...motion.anchor };
      }
      return buildMotionCurve(motion).positionAt(playhead);
    },
    placeSubject: point => {
      const { motion, playhead } = get();
      if (!motion) return;
      const result = upsertKey(motion, playhead, bounded(point), newId());
      if (!result) { set({ notice: "You've reached the key limit. Delete a key to add another." }); return; }
      edit(result.motion, { selectedKeyId: result.id });
    },
    addKey: () => {
      const { motion, playhead } = get();
      if (!motion) return;
      if (playhead === 0) { set({ notice: "The first frame is your photo and already has a key." }); return; }
      const existing = motion.keys.find(key => key.frame === playhead);
      if (existing) { set({ selectedKeyId: existing.id }); return; }
      const result = upsertKey(motion, playhead, buildMotionCurve(motion).positionAt(playhead), newId());
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
    evenSpeed: () => {
      const { motion } = get();
      if (!motion) return;
      edit(evenSpeed(motion), { notice: "Keys re-spaced for an even speed along the path." });
    },
    clearPath: () => {
      const { motion, recording } = get();
      if (!motion || recording) return;
      edit(createMotion(motion.anchor, motion.frames), { playhead: 0, playing: false, selectedKeyId: null });
    },
    setFrames: frames => {
      const { motion, playhead, subjects, activeSubjectId } = get();
      if (!motion || motion.frames === frames) return;
      const next = setClipFrames(motion, frames);
      const compressed = next.keys.some((key, i) => key.frame !== motion.keys[i].frame);
      const resized = subjects.map(subject => ({ ...subject, motion: setClipFrames(subject.motion, frames) }));
      set({ motion: resized.find(subject => subject.id === activeSubjectId)?.motion ?? next, subjects: resized, playing: false, playhead: Math.min(playhead, lastFrame(next)),
        notice: compressed ? "Keys were compressed to fit the shorter clip." : null });
    },
    setTiming: timing => { const { motion } = get(); if (motion && motion.timing !== timing) edit({ ...motion, timing }); },
    startRecording: () => {
      const { motion, recording, playhead } = get();
      if (!motion || recording || motion.keys.length > 1) return null;
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
