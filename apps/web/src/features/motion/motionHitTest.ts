import { isStartKey } from "@h3-motion/shared";
import type { MotionCurve, MotionKey, Point, SubjectMotion } from "@h3-motion/shared";
import { hitsSubject } from "./subjectLayers";
import type { SubjectLayers } from "./subjectLayers";

interface HitSubject { motion: SubjectMotion; curve: MotionCurve; layers: SubjectLayers }
export type MotionTarget<T> = { subject: T } & (
  | { kind: "key"; key: MotionKey } | { kind: "subject" } | { kind: "path"; length: number });

/** Opaque subjects intercept clicks before keys or paths belonging to obscured subjects. */
export function motionTargetAt<T extends HitSubject>(subjects: T[], point: Point, frame: number, scale: number): MotionTarget<T> | null {
  const body = subjects.find(subject => hitsSubject(subject.layers, point, subject.curve.offsetAt(frame)));
  for (const subject of body ? [body] : subjects) {
    for (const key of [...subject.motion.keys].reverse()) {
      if (body && isStartKey(subject.motion, key.id)) continue;
      if (Math.hypot(point.x - key.x, point.y - key.y) <= 11 * scale) return { kind: "key", subject, key };
    }
  }
  if (body) return { kind: "subject", subject: body };
  let nearest: { subject: T; length: number; distance: number } | null = null;
  for (const subject of subjects) {
    if (subject.curve.length === 0) continue;
    const near = subject.curve.nearest(point);
    if (near.distance <= 8 * scale && (!nearest || near.distance < nearest.distance)) nearest = { subject, ...near };
  }
  return nearest ? { kind: "path", subject: nearest.subject, length: nearest.length } : null;
}
