import { useMemo } from "react";
import { buildH3PromptFields, composeH3Prompt, describeMotion, videoGeometry } from "@h3-motion/shared";
import type { VideoTier, FrameSize, H3PromptFields, ImageAsset, IsolationResult, Rect, SubjectMotion } from "@h3-motion/shared";
import { currentIsolation, useSelectionStore } from "../select";
import { layersKeyOf, subjectKeyOf, useMotionStore } from "../motion";
import type { MotionSubject, SubjectLayers } from "../motion";

export type Tier = VideoTier;
interface Parts {
  image: ImageAsset | null; mask: ImageAsset | null; isolation: IsolationResult | null;
  motion: SubjectMotion | null; subjectKey: string | null; bounds: Rect | null;
  layers: SubjectLayers | null; layersKey: string | null; tier: Tier; lockIn: number; edgeFreedom: number; prompt: string | null;
  subjects: MotionSubject[];
  soundEffects?: string | null; music?: string;
}
type PromptSettings = Pick<Parts, "tier" | "lockIn" | "edgeFreedom" | "prompt" | "soundEffects" | "music">;
export interface GenerationInputs {
  image: ImageAsset; mask: ImageAsset; isolation: IsolationResult; motion: SubjectMotion; layers: SubjectLayers;
  size: FrameSize; lockIn: number; edgeFreedom: number; autoPrompt: string; prompt: string;
  promptFields: H3PromptFields;
  /** Changes whenever anything that affects the video changes, except the seed. */
  signature: string;
  subjects: MotionSubject[];
}

export function resolveInputs(parts: Parts): GenerationInputs | null {
  const { image, mask, isolation, layers, subjects } = parts;
  const motion = subjects[0]?.motion ?? parts.motion;
  if (!image || !mask || !isolation || !motion || !layers || parts.subjectKey !== subjectKeyOf(image.id, mask.id)
    || parts.layersKey !== layersKeyOf(image.url, mask.url, isolation.plate.url)) return null;
  const size = videoGeometry(image, parts.tier).output;
  const caption = isolation.caption;
  const automatic = subjects.length > 1
    ? buildH3PromptFields({ ...caption, subject: "the subjects" }, `move independently: ${subjects.map(subject =>
      `${subject.name} ${describeMotion(subject.motion, subject.layers, "moves", subject.layers.bounds)}`).join("; ")}`)
    : buildH3PromptFields(caption, describeMotion(motion, layers, caption.motion_verb, subjects[0]?.layers.bounds ?? parts.bounds ?? undefined));
  const autoPrompt = composeH3Prompt(automatic);
  const promptFields = { mainPrompt: parts.prompt?.trim() || automatic.mainPrompt,
    soundEffects: parts.soundEffects ?? automatic.soundEffects, music: parts.music ?? "" };
  const prompt = composeH3Prompt(promptFields);
  const signature = JSON.stringify([image.id, mask.id, isolation.plate.id,
    subjects.length ? subjects.map(subject => [subject.id, subject.motion]) : motion, size, parts.lockIn, parts.edgeFreedom, prompt]);
  const renderLayers = subjects.length ? { ...layers, subjects: subjects.map(subject => ({ layers: subject.layers, motion: subject.motion })) } : layers;
  return { image, mask, isolation, motion, layers: renderLayers, subjects, size, lockIn: parts.lockIn, edgeFreedom: parts.edgeFreedom, autoPrompt, promptFields, prompt, signature };
}

export function currentParts(settings: PromptSettings): Parts {
  const selection = useSelectionStore.getState(), motion = useMotionStore.getState();
  return { image: selection.image, mask: selection.mask, isolation: currentIsolation(selection),
    motion: motion.motion, subjects: motion.subjects, subjectKey: motion.subjectKey, bounds: motion.bounds, layers: motion.layers, layersKey: motion.layersKey, ...settings };
}

export function useGenerationInputs(settings: PromptSettings): GenerationInputs | null {
  const image = useSelectionStore(s => s.image);
  const mask = useSelectionStore(s => s.mask);
  const isolation = useSelectionStore(currentIsolation);
  const motion = useMotionStore(s => s.motion);
  const subjects = useMotionStore(s => s.subjects);
  const subjectKey = useMotionStore(s => s.subjectKey);
  const bounds = useMotionStore(s => s.bounds);
  const layers = useMotionStore(s => s.layers);
  const layersKey = useMotionStore(s => s.layersKey);
  const { tier, lockIn, edgeFreedom, prompt, soundEffects, music } = settings;
  return useMemo(() => resolveInputs({ image, mask, isolation, motion, subjects, subjectKey, bounds, layers, layersKey, tier, lockIn, edgeFreedom, prompt, soundEffects, music }),
    [image, mask, isolation, motion, subjects, subjectKey, bounds, layers, layersKey, tier, lockIn, edgeFreedom, prompt, soundEffects, music]);
}
