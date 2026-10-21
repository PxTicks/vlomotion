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

export function defaultDescription(): SubjectDescription {
  return { phrase: DEFAULT_CAPTION.subject, caption: { ...DEFAULT_CAPTION } };
}

function shortPhrase(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const phrase = value.trim();
  if (phrase && phrase.length <= 160 && !/[\r\n]/.test(phrase) && phrase.split(/\s+/).length <= 8) return phrase;
}

/** Caption fields have defaults; automatic removal still needs a model-identified subject. */
export function parseDescription(phraseText: string, captionText: string): SubjectDescription {
  let phrase: unknown = unfence(phraseText);
  try { phrase = JSON.parse(phrase as string); } catch { /* A noun phrase is normally plain text. */ }
  let rawCaption: unknown = {};
  try { rawCaption = JSON.parse(unfence(captionText)); } catch { /* Use defaults for malformed captions. */ }
  const captionSubject = rawCaption !== null && typeof rawCaption === "object" && "subject" in rawCaption ? rawCaption.subject : undefined;
  const subject = shortPhrase(phrase) ?? shortPhrase(captionSubject);
  if (!subject) throw new Error("Could not identify the highlighted subject. Retry isolation or write a removal instruction.");
  const parsed = captionSchema.extend({ subject: field(subject) }).safeParse(rawCaption);
  return { phrase: subject,
    caption: parsed.success ? parsed.data : { ...DEFAULT_CAPTION, subject } };
}

export function removalInstruction(phrase: string): string {
  return `Remove ${phrase} from <image1>, including its shadow and reflection. Fill the area with the background that would naturally be behind it. Keep everything else exactly the same.`;
}
