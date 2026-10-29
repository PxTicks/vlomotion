import { FPS } from "./media.js";

/**
 * What the inpaint reference image is to H3, following MiniMax's full-reference guide: an object is visible content,
 * cited inside a `<Subject 1>` definition; an edited frame of the source is a concrete frame anchor, its own `<Picture 1>`.
 * https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md
 */
export type ReferenceRole = { kind: "object" } | { kind: "frame"; frame: number; frames: number };

const clean = (text: string) => text.trim().replace(/[\s.,;:]+$/, "");

/** `MM:SS.mmm`, the guide's timestamp form. */
export function formatTimestamp(frame: number): string {
  const ms = Math.round(frame / FPS * 1000);
  const minutes = Math.floor(ms / 60_000), seconds = (ms % 60_000) / 1000;
  return `${String(minutes).padStart(2, "0")}:${seconds.toFixed(3).padStart(6, "0")}`;
}

/** Which frame of [Shot 1] the edited frame anchors, in the guide's words: its `scope` in retention and its `phrase` in prose. */
function anchorOf(role: Extract<ReferenceRole, { kind: "frame" }>) {
  if (role.frame <= 0) return { scope: "first frame", phrase: "first frame of [Shot 1]", sentence: "The shot begins from <Picture 1>." };
  if (role.frame >= role.frames - 1) return { scope: "last frame", phrase: "last frame of [Shot 1]", sentence: "The shot ends on <Picture 1>." };
  const at = formatTimestamp(role.frame);
  return { scope: `keyframe at ${at}`, phrase: `keyframe of [Shot 1] at ${at}`, sentence: `At ${at}, the shot's keyframe corresponds to <Picture 1>.` };
}

/** The editable `subject_definitions` line, from what the reference shows when that is known. */
export function referenceDefinition(role: ReferenceRole, description = ""): string {
  const text = clean(description);
  if (role.kind === "object") return `<Subject 1> is the ${text.replace(/^(?:the|an?)\s+/i, "") || "object"} in <Picture 1>.`;
  const showing = text ? `, showing ${text.replace(/^(?:The|A|An)\b/, article => article.toLowerCase())}` : "";
  return `<Picture 1> is the edited ${anchorOf(role).phrase}${showing}.`;
}

/** A Qwen Image text-to-image prompt for a clean picture of the object alone. */
export function objectInstruction(description: string): string {
  return `A reference photo of ${clean(description)}: the whole object, centred on a plain white background, in soft even light, with nothing else in the picture.`;
}

/** A Qwen Image edit of a video frame (`<image1>`), placed by the same frame with the mask highlighted (`<image2>`). */
export function frameInstruction(description: string): string {
  return `In <image1>, make the area highlighted in yellow in <image2> show ${clean(description)}. Match the lighting, perspective, scale and style of <image1>, and leave everything outside that area unchanged. Do not draw the yellow highlight.`;
}

/**
 * The inpaint prompt. Without a reference it is the user's text. With one, it is laid out in the guide's full-reference
 * sections, so H3 reads `<Picture 1>` in its role: the definition, a summary and retention line for that role, then the
 * user's text as the description of [Shot 1]. The source video reaches H3 as the sampled latent rather than as a
 * reference, so no `<Video 1>` label exists to cite. A prompt already in that layout is sent as written. Sound effects
 * and music close the prompt in the guide's sound sections, either way.
 */
export function composeInpaintPrompt(prompt: string, reference?: { role: ReferenceRole; definition: string }, audio?: InpaintAudio): string {
  const text = prompt.trim(), sounds = audioSections(text, audio);
  if (!reference || /^subject_definitions:/m.test(text)) return [text, ...sounds].join("\n\n");
  const { role } = reference, anchor = role.kind === "frame" ? anchorOf(role) : null;
  const definition = reference.definition.trim() || referenceDefinition(role);
  // A user who split the description into shots keeps them; otherwise it is all [Shot 1].
  const shots = /^\[Shot \d+\]/m.test(text) ? text : `[Shot 1] ${text}`;
  const sections = !anchor ? {
    summary: "[video editing + reference generation] The target video is an edited version of the source video in which <Subject 1> appears.",
    retention: "<Subject 1> (appears in [Shot 1]): fully_preserved - the appearance of <Subject 1> from <Picture 1> is retained.",
    description: shots,
  } : {
    summary: `[video editing + keyframe completion] The target video is an edited version of the source video, with <Picture 1> as the edited ${anchor.phrase}.`,
    retention: `<Picture 1> ([Shot 1] ${anchor.scope}): fully_preserved - the edited frame is retained.`,
    description: `${shots} ${anchor.sentence}`,
  };
  return [`subject_definitions:\n${definition}`, `summary:\n${sections.summary}`,
    `retention_analysis:\n${sections.retention}`, `detailed_description:\n${sections.description}`, ...sounds].join("\n\n");
}

export interface InpaintAudio { soundEffects: string; music: string }

/**
 * The guide's `overall_soundscape` and `non_diegetic_music` sections, for the fields filled in. A blank field is left
 * out rather than sent as N/A, so H3 still chooses that sound, and a prompt that already has sound sections keeps its own.
 */
function audioSections(text: string, audio?: InpaintAudio): string[] {
  if (!audio || /^(?:overall_soundscape|non_diegetic_music):/m.test(text)) return [];
  const soundEffects = audio.soundEffects.trim(), music = audio.music.trim();
  return [...(soundEffects ? [`overall_soundscape:\n${soundEffects}`] : []), ...(music ? [`non_diegetic_music:\n${music}`] : [])];
}
