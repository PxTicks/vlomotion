import { useEffect } from "react";
import { Stack } from "@mui/material";
import { FPS, lastFrame } from "@h3-motion/shared";
import { MotionCanvas } from "./MotionCanvas";
import { MotionTimeline } from "./MotionTimeline";
import { useMotionShortcuts } from "./useMotionShortcuts";
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
      useMotionStore.setState({ playhead: frame });
      if (frame >= last) useMotionStore.getState().pause();
      if (frame < last) request = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(request);
  }, [playing, frames]);
}

export function MotionEditor({ readOnly = false }: { readOnly?: boolean }) {
  usePlayback();
  useMotionShortcuts(useMotionStore.getState, { readOnly });
  useEffect(() => () => useMotionStore.getState().leave(), []);
  return <Stack spacing={2}>
    <MotionCanvas readOnly={readOnly} />
    <MotionTimeline readOnly={readOnly} />
  </Stack>;
}
