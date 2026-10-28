import { DEFAULT_CAPTION } from "./description.js";
import type { Caption } from "./description.js";
import { FPS } from "./media.js";
import type { FrameSize } from "./media.js";
import { buildMotionCurve } from "./motion.js";
import type { Rect, SubjectMotion } from "./motion.js";

const DIRECTIONS = ["to the right", "toward the upper right", "upward", "toward the upper left",
  "to the left", "toward the lower left", "downward", "toward the lower right"];
/** Holds at least this long read as a pause; shorter ones are part of the movement. */
const PAUSE_FRAMES = 12;
const MAX_MOVES = 3;

interface Move { from: number; to: number; start: number; end: number }

/**
 * Describes the keyed path in screen terms for the video prompt: compass direction, extent,
 * speed and its profile, pauses and arcs. Deterministic, so the same path always reads the same.
 */
export function describeMotion(motion: SubjectMotion, size: FrameSize, verb = "moves", bounds?: Rect): string {
  const curve = buildMotionCurve(motion);
  const { keys } = motion, lengths = curve.keyLengths;
  const diagonal = Math.hypot(size.width, size.height);
  if (curve.length < diagonal * 0.01) return "stays still";

  const moves: Move[] = [];
  for (let i = 1; i < keys.length; i++) {
    if (lengths[i] === lengths[i - 1]) continue;
    const previous = moves[moves.length - 1];
    if (previous && keys[i - 1].frame - previous.to < PAUSE_FRAMES) { previous.to = keys[i].frame; previous.end = lengths[i]; }
    else moves.push({ from: keys[i - 1].frame, to: keys[i].frame, start: lengths[i - 1], end: lengths[i] });
  }
  if (moves.length > MAX_MOVES) return `${verb} around the frame, pausing along the way`;

  const phrases = moves.map((move, index) => {
    const a = curve.pointAtLength(move.start), b = curve.pointAtLength(move.end);
    const path = move.end - move.start, chord = Math.hypot(b.x - a.x, b.y - a.y);
    let far = b, farDistance = chord;
    for (const sample of curve.samples) {
      if (sample.length < move.start || sample.length > move.end) continue;
      const d = Math.hypot(sample.x - a.x, sample.y - a.y);
      if (d > farDistance) { far = sample; farDistance = d; }
    }
    // A move that ends near where it began is described by its farthest point, "and back".
    const returns = chord < farDistance * 0.4;
    const target = returns ? far : b;
    const dx = target.x - a.x, dy = target.y - a.y;
    const direction = DIRECTIONS[(Math.round(Math.atan2(-dy, dx) / (Math.PI / 4)) + 8) % 8];
    const reach = Math.hypot(dx / size.width, dy / size.height);
    const extent = reach < 0.15 ? "a short way" : reach >= 0.5 ? "across the frame" : "";
    const shape = returns ? "and back" : path > chord * 2 ? "along a winding path" : path > chord * 1.3 ? "in a wide arc" : "";
    const seconds = (move.to - move.from) / FPS;
    const speed = path / seconds / diagonal;
    const pace = speed < 0.08 ? "slowly" : speed > 0.3 ? "quickly" : "";
    const third = (move.to - move.from) / 3;
    const early = curve.lengthAt(move.from + third) - move.start, late = move.end - curve.lengthAt(move.to - third);
    // Smooth timing eases into and out of every hold; that easing isn't worth a mention next to a pause.
    const fromRest = move.from > 0, intoPause = index < moves.length - 1;
    const profile = late > early * 1.8 && !fromRest ? ", speeding up" : early > late * 1.8 && !intoPause ? ", slowing to a stop" : "";
    return [verb, pace, direction, extent, shape].filter(Boolean).join(" ") + profile;
  });

  let text = phrases.join(", pauses, then ");
  if (moves[0].from >= PAUSE_FRAMES) text = `waits a moment, then ${text}`;
  const last = keys[keys.length - 1];
  if (bounds) {
    const x = bounds.x + last.x - motion.anchor.x, y = bounds.y + last.y - motion.anchor.y;
    if (x >= size.width || x + bounds.width <= 0 || y >= size.height || y + bounds.height <= 0) text += " and leaves the frame";
  }
  return text;
}

const clean = (text: string) => text.trim().replace(/[\s.,;:]+$/, "");

export interface H3PromptFields { mainPrompt: string; soundEffects: string; music: string }

/** Editable parts of the prompt, without the model's section labels. */
export function buildH3PromptFields(caption: Caption, motionPhrase: string): H3PromptFields {
  const soundscape = clean(caption.soundscape);
  // A still image has no audio track; an automatic caption must not turn that into a request for silence.
  const silent = /^(?:silent|silence|none|n\/a|no (?:sounds?|audio|audible sounds?))$/i.test(soundscape);
  return {
    mainPrompt: `${clean(caption.style)}, ${clean(caption.subject)} in <Picture 1> ${clean(motionPhrase)}, ${clean(caption.scene)}. The camera stays still.`,
    soundEffects: !soundscape || silent ? DEFAULT_CAPTION.soundscape : `${soundscape}.`,
    music: "",
  };
}

/** Packages the editable text into the I2VA format expected by H3. */
export function composeH3Prompt(fields: H3PromptFields): string {
  return [
    "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.",
    `integrated_multimodal_description: [Shot 1] ${fields.mainPrompt.trim()}`,
    `overall_soundscape: ${fields.soundEffects.trim() || "N/A"}`,
    `non_diegetic_music: ${fields.music.trim() || "N/A"}`,
  ].join("\n\n");
}

export function buildH3Prompt(caption: Caption, motionPhrase: string): string {
  return composeH3Prompt(buildH3PromptFields(caption, motionPhrase));
}
