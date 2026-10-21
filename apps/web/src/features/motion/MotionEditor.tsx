import { useEffect } from "react";
import { Stack } from "@mui/material";
import { FPS, lastFrame } from "@h3-motion/shared";
import { MotionCanvas } from "./MotionCanvas";
import { MotionTimeline } from "./MotionTimeline";
import { useMotionStore } from "./useMotionStore";

/** Plays the clip in real time on the 24 fps grid, so the preview shows exactly the frames that will be rendered. */
function usePlayback() {
  const playing = useMotionStore(s => s.playing);
  const frames = useMotionStore(s => s.motion?.frames);
  useEffect(() => {
    if (!playing || !frames) return;
    const last = lastFrame({ frames }), startFrame = useMotionStore.getState().playhead, startTime = performance.now();
    let request = requestAnimationFrame(function tick(now) {
      const frame = Math.min(last, startFrame + Math.floor((now - startTime) / 1000 * FPS));
      useMotionStore.setState(frame >= last ? { playhead: last, playing: false } : { playhead: frame });
      if (frame < last) request = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(request);
  }, [playing, frames]);
}

function useShortcuts() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.metaKey || event.ctrlKey || event.altKey || target?.closest("input, textarea, select, [contenteditable='true']")) return;
      const store = useMotionStore.getState();
      if (event.key === " " && !target?.closest("button, [role='slider']")) { event.preventDefault(); store.togglePlay(); }
      else if (event.key === "k" || event.key === "K") store.addKey();
      else if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); store.deleteSelected(); }
      else if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && !target?.closest("[role='slider'], [role='group']")) {
        event.preventDefault();
        store.setPlayhead(store.playhead + (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? FPS : 1));
      }
    };
    globalThis.addEventListener("keydown", onKeyDown);
    return () => globalThis.removeEventListener("keydown", onKeyDown);
  }, []);
}

export function MotionEditor() {
  usePlayback();
  useShortcuts();
  useEffect(() => () => useMotionStore.getState().leave(), []);
  return <Stack spacing={2}>
    <MotionCanvas />
    <MotionTimeline />
  </Stack>;
}
