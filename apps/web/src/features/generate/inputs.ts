import { useMemo } from "react";
import { buildH3Prompt, describeMotion, generationSize } from "@h3-motion/shared";
import type { AspectRatio, FrameSize, ImageAsset, IsolationResult, Rect, SubjectMotion } from "@h3-motion/shared";
import { currentIsolation, useSelectionStore } from "../select";
import { layersKeyOf, subjectKeyOf, useMotionStore } from "../motion";
import type { SubjectLayers } from "../motion";

export type Tier = 480 | 720;
interface Parts {
  image: ImageAsset | null; mask: ImageAsset | null; isolation: IsolationResult | null; aspectRatio: AspectRatio;
  motion: SubjectMotion | null; subjectKey: string | null; bounds: Rect | null;
  layers: SubjectLayers | null; layersKey: string | null; tier: Tier; lockIn: number; prompt: string | null;
}
export interface GenerationInputs {
  image: ImageAsset; mask: ImageAsset; isolation: IsolationResult; motion: SubjectMotion; layers: SubjectLayers;
  size: FrameSize; lockIn: number; autoPrompt: string; prompt: string;
  /** Changes whenever anything that affects the video changes, except the seed. */
  signature: string;
}

export function resolveInputs(parts: Parts): GenerationInputs | null {
  const { image, mask, isolation, motion, layers } = parts;
  if (!image || !mask || !isolation || !motion || !layers || parts.subjectKey !== subjectKeyOf(image.id, mask.id)
    || parts.layersKey !== layersKeyOf(image.url, mask.url, isolation.plate.url)) return null;
  const size = generationSize(parts.aspectRatio, parts.tier);
  const caption = isolation.caption;
  const autoPrompt = buildH3Prompt(caption, describeMotion(motion, layers, caption.motion_verb, parts.bounds ?? undefined));
  const prompt = parts.prompt?.trim() || autoPrompt;
  const signature = JSON.stringify([image.id, mask.id, isolation.plate.id, motion, size, parts.lockIn, prompt]);
  return { image, mask, isolation, motion, layers, size, lockIn: parts.lockIn, autoPrompt, prompt, signature };
}

export function currentParts(settings: Pick<Parts, "tier" | "lockIn" | "prompt">): Parts {
  const selection = useSelectionStore.getState(), motion = useMotionStore.getState();
  return { image: selection.image, mask: selection.mask, isolation: currentIsolation(selection), aspectRatio: selection.aspectRatio,
    motion: motion.motion, subjectKey: motion.subjectKey, bounds: motion.bounds, layers: motion.layers, layersKey: motion.layersKey, ...settings };
}

export function useGenerationInputs(settings: Pick<Parts, "tier" | "lockIn" | "prompt">): GenerationInputs | null {
  const image = useSelectionStore(s => s.image);
  const mask = useSelectionStore(s => s.mask);
  const isolation = useSelectionStore(currentIsolation);
  const aspectRatio = useSelectionStore(s => s.aspectRatio);
  const motion = useMotionStore(s => s.motion);
  const subjectKey = useMotionStore(s => s.subjectKey);
  const bounds = useMotionStore(s => s.bounds);
  const layers = useMotionStore(s => s.layers);
  const layersKey = useMotionStore(s => s.layersKey);
  const { tier, lockIn, prompt } = settings;
  return useMemo(() => resolveInputs({ image, mask, isolation, aspectRatio, motion, subjectKey, bounds, layers, layersKey, tier, lockIn, prompt }),
    [image, mask, isolation, aspectRatio, motion, subjectKey, bounds, layers, layersKey, tier, lockIn, prompt]);
}
