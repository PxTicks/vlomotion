import { FPS } from "@h3-motion/shared";

export const formatSeconds = (frame: number) => `${(frame / FPS).toFixed(2)} s`;
export const signed = (value: number) => `${value < 0 ? "−" : "+"}${Math.abs(Math.round(value))}`;
