import { FPS, scaleOf } from "@h3-motion/shared";
import type { Scale } from "@h3-motion/shared";

export const formatSeconds = (frame: number) => `${(frame / FPS).toFixed(2)} s`;
export const signed = (value: number) => `${value < 0 ? "−" : "+"}${Math.abs(Math.round(value))}`;
const percent = (value: number) => `${value < 0 ? "−" : ""}${Math.abs(Math.round(value * 100))}%`;
/** A key's size as a percentage, or one per axis when they differ; empty at full size. */
export function formatScale(key: Partial<Scale>) {
  const { sx, sy } = scaleOf(key);
  return sx === 1 && sy === 1 ? "" : sx === sy ? percent(sx) : `${percent(sx)} × ${percent(sy)}`;
}
