import { useState } from "react";
import { Button, Slider, Stack, Typography } from "@mui/material";
import { CLIP_FRAMES, FPS, animationEnd, frameCountSchema, lastFrame } from "@h3-motion/shared";
import { KeyTimeline } from "./KeyTimeline";
import { SUBJECT_COLORS, useMotionStore } from "./useMotionStore";

const seconds = (frames: number) => `${(frames / FPS).toFixed(1)} s`;

/** The clip length, on H3's frame grid. It changes when the slider is released, so a drag past the animation's end fits it once. */
function ClipLength() {
  const frames = useMotionStore(s => s.motion?.frames ?? CLIP_FRAMES.default);
  const recording = useMotionStore(s => s.recording);
  const end = useMotionStore(s => Math.max(s.motion ? animationEnd(s.motion) : 0, ...s.subjects.map(subject => animationEnd(subject.motion))));
  const { setFrames, fitToLength } = useMotionStore.getState();
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? frames;
  const commit = (value: number | number[]) => {
    setDraft(null);
    const parsed = frameCountSchema.safeParse(Array.isArray(value) ? value[0] : value);
    if (parsed.success) setFrames(parsed.data);
  };

  return <Stack direction="row" alignItems="center" flexWrap="wrap" columnGap={2} rowGap={1}>
    <Typography variant="caption" color="text.secondary">Clip length</Typography>
    <Slider size="small" value={shown} min={CLIP_FRAMES.min} max={CLIP_FRAMES.max} step={CLIP_FRAMES.step}
      // Shift+Arrow and Page keys add shiftStep unsnapped, so it must stay on the grid: 4 steps, about 3 s.
      shiftStep={CLIP_FRAMES.step * 4} disabled={recording}
      aria-label="Clip length" getAriaValueText={seconds} valueLabelDisplay="auto" valueLabelFormat={seconds}
      onChange={(_, value) => setDraft(Array.isArray(value) ? value[0] : value)} onChangeCommitted={(_, value) => commit(value)}
      sx={{ flex: 1, minWidth: 160 }} />
    <Typography variant="body2" sx={{ fontVariantNumeric: "tabular-nums", minWidth: 44, textAlign: "right" }}>{seconds(shown)}</Typography>
    <Button size="small" variant="outlined" disabled={recording || !end || end === lastFrame({ frames })} onClick={fitToLength}>
      Fit animation to length
    </Button>
  </Stack>;
}

/** Read-only, the timeline only plays and scrubs: keys are shown but can't be moved, added or recorded. */
export function MotionTimeline({ readOnly = false }: { readOnly?: boolean }) {
  const motion = useMotionStore(s => s.motion);
  const color = useMotionStore(s => s.subjects.find(subject => subject.id === s.activeSubjectId)?.color ?? SUBJECT_COLORS[0]);
  const playhead = useMotionStore(s => s.playhead);
  const playing = useMotionStore(s => s.playing);
  const recording = useMotionStore(s => s.recording);
  const selectedKeyId = useMotionStore(s => s.selectedKeyId);
  if (!motion) return null;

  return <Stack spacing={2}>
    <KeyTimeline motion={motion} color={color} playhead={playhead} playing={playing} locked={recording} selectedKeyId={selectedKeyId}
      actions={useMotionStore.getState} startLabel="photo" readOnly={readOnly} />
    {!readOnly && <ClipLength />}
  </Stack>;
}
