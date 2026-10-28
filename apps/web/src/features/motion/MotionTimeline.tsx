import { Stack, ToggleButton, ToggleButtonGroup } from "@mui/material";
import { CLIP_FRAMES, frameCountSchema } from "@h3-motion/shared";
import { KeyTimeline } from "./KeyTimeline";
import { SUBJECT_COLORS, useMotionStore } from "./useMotionStore";

/** Read-only, the timeline only plays and scrubs: keys are shown but can't be moved, added or recorded. */
export function MotionTimeline({ readOnly = false }: { readOnly?: boolean }) {
  const motion = useMotionStore(s => s.motion);
  const color = useMotionStore(s => s.subjects.find(subject => subject.id === s.activeSubjectId)?.color ?? SUBJECT_COLORS[0]);
  const playhead = useMotionStore(s => s.playhead);
  const playing = useMotionStore(s => s.playing);
  const recording = useMotionStore(s => s.recording);
  const selectedKeyId = useMotionStore(s => s.selectedKeyId);
  const setFrames = useMotionStore(s => s.setFrames);
  if (!motion) return null;

  return <KeyTimeline motion={motion} color={color} playhead={playhead} playing={playing} recording={recording} selectedKeyId={selectedKeyId}
    actions={useMotionStore.getState} startLabel="photo" readOnly={readOnly}>
    {!readOnly && <Stack direction="row" alignItems="center" gap={1}>
      <ToggleButtonGroup exclusive size="small" value={motion.frames} disabled={recording} aria-label="Clip length"
        onChange={(_, value: unknown) => { const parsed = frameCountSchema.safeParse(value); if (parsed.success) setFrames(parsed.data); }}>
        {Object.entries(CLIP_FRAMES).map(([seconds, frames]) => <ToggleButton key={frames} value={frames} sx={{ px: 1.5, py: .5, borderRadius: 99 }}>{seconds} s</ToggleButton>)}
      </ToggleButtonGroup>
    </Stack>}
  </KeyTimeline>;
}
