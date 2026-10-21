import { z } from "zod";

export const DEFAULT_CAPTION = {
  style: "Live-action, cinematic",
  subject: "the selected subject",
  motion_verb: "moves",
  scene: "in the original scene",
  soundscape: "Natural ambient sounds from the scene.",
};
const field = (fallback: string) => z.string().trim().min(1).max(600).catch(fallback);
export const captionSchema = z.object({
  style: field(DEFAULT_CAPTION.style), subject: field(DEFAULT_CAPTION.subject),
  motion_verb: field(DEFAULT_CAPTION.motion_verb), scene: field(DEFAULT_CAPTION.scene),
  soundscape: field(DEFAULT_CAPTION.soundscape),
});
export type Caption = z.infer<typeof captionSchema>;
export interface SubjectDescription { phrase: string; caption: Caption }

function unfence(text: string): string {
  return text.trim().replace(/^```(?:json|text)?\s*/i, "").replace(/\s*```$/, "").trim();
}

export function defaultDescription(userText: string): SubjectDescription {
  const name = userText.trim().replace(/\s+/g, " ").split(" ").slice(0, 5).join(" ");
  const phrase = name ? `the selected ${name}` : DEFAULT_CAPTION.subject;
  return { phrase, caption: { ...DEFAULT_CAPTION, subject: phrase } };
}

/** Malformed VLM JSON never prevents removal; each caption field has a fallback. */
export function parseDescription(phraseText: string, captionText: string, userText: string): SubjectDescription {
  const fallback = defaultDescription(userText);
  let phrase: unknown = unfence(phraseText);
  try { phrase = JSON.parse(phrase as string); } catch { /* A noun phrase is normally plain text. */ }
  const validPhrase = typeof phrase === "string" && phrase.trim().length > 0
    && phrase.trim().length <= 160 && !phrase.includes("\n") && phrase.trim().split(/\s+/).length <= 8;
  let rawCaption: unknown = {};
  try { rawCaption = JSON.parse(unfence(captionText)); } catch { /* Use defaults for malformed captions. */ }
  const subject = validPhrase ? (phrase as string).trim() : fallback.phrase;
  const parsed = captionSchema.extend({ subject: field(subject) }).safeParse(rawCaption);
  return { phrase: subject,
    caption: parsed.success ? parsed.data : { ...fallback.caption, subject } };
}

export function removalInstruction(phrase: string): string {
  return `Remove ${phrase} from <image1>, including its shadow and reflection. Fill the area with the background that would naturally be behind it. Keep everything else exactly the same.`;
}
