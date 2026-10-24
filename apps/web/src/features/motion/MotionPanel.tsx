import { useMemo } from "react";
import { Alert, Box, Button, Paper, Stack, Typography } from "@mui/material";
import { buildMotionCurve, firstFrameOutside, isStartKey, validateMotion } from "@h3-motion/shared";
import { useSelectionStore } from "../select";
import { formatSeconds, signed } from "./format";
import { subjectKeyOf } from "./subjectLayers";
import { useMotionStore } from "./useMotionStore";

export function MotionPanel() {
  const image = useSelectionStore(s => s.image);
  const mask = useSelectionStore(s => s.mask);
  const visitPhase = useSelectionStore(s => s.visitPhase);
  const subjectKey = useMotionStore(s => s.subjectKey);
  const motion = useMotionStore(s => s.motion);
  const bounds = useMotionStore(s => s.bounds);
  const size = useMotionStore(s => s.size);
  const selectedKeyId = useMotionStore(s => s.selectedKeyId);
  const recording = useMotionStore(s => s.recording);
  const notice = useMotionStore(s => s.notice);
  const retimeKey = useMotionStore(s => s.retimeKey);
  const deleteSelected = useMotionStore(s => s.deleteSelected);
  const clearPath = useMotionStore(s => s.clearPath);
  const ready = !!image && !!mask && subjectKey === subjectKeyOf(image.id, mask.id) && !!motion;
  const curve = useMemo(() => motion ? buildMotionCurve(motion) : null, [motion]);
  const outside = useMemo(() => curve && bounds && size ? firstFrameOutside(curve, bounds, size) : null, [curve, bounds, size]);

  const heading = <Stack spacing={1}>
    <Typography variant="h2">Drag it into motion</Typography>
    <Typography variant="body2" color="text.secondary">Drag to create a path. Adjust by selecting and dragging ◆ on the canvas to fix positions, or on the timeline bar to fix timings.</Typography>
  </Stack>;
  if (!ready || !curve) return <Stack spacing={2.5}>{heading}<Typography role="status" variant="body2">Preparing your subject…</Typography></Stack>;

  const index = motion.keys.findIndex(key => key.id === selectedKeyId);
  const selected = motion.keys[index];
  const errors = validateMotion(motion);
  const moving = curve.length > 0;

  return <Stack spacing={2.5}>
    {heading}
    {notice && <Typography role="status" variant="body2" color="text.secondary">{notice}</Typography>}
    {selected ? <Paper variant="outlined" sx={{ p: 2, bgcolor: "#2b2040" }}>
      <Stack spacing={1.5}>
        <Stack direction="row" justifyContent="space-between" alignItems="baseline">
          <Typography variant="overline" sx={{ lineHeight: 1.4 }}><Box component="span" sx={{ color: "primary.main" }}>◆</Box> KEY {index + 1}</Typography>
          <Typography variant="body2" sx={{ fontVariantNumeric: "tabular-nums" }}>{formatSeconds(selected.frame)} · {signed(selected.x - motion.anchor.x)}, {signed(selected.y - motion.anchor.y)}</Typography>
        </Stack>
        {isStartKey(motion, selected.id) ? <Typography variant="caption" color="text.secondary">The first key is your photo. It stays at 0 s in its original position.</Typography>
          : <Stack direction="row" gap={1} flexWrap="wrap">
            <Button size="small" variant="outlined" disabled={recording} onClick={() => retimeKey(selected.id, selected.frame - 1)}>− 1 frame</Button>
            <Button size="small" variant="outlined" disabled={recording} onClick={() => retimeKey(selected.id, selected.frame + 1)}>+ 1 frame</Button>
            <Button size="small" color="error" disabled={recording} onClick={deleteSelected}>Delete key</Button>
          </Stack>}
      </Stack>
    </Paper> : <Typography variant="caption" color="text.secondary">Select a ◆ key on the canvas or timeline to edit it. Click the path to insert one.</Typography>}
    <Button variant="outlined" disabled={recording || motion.keys.length < 2} onClick={clearPath}>Clear path</Button>
    {outside !== null && <Alert severity="warning">The subject is completely out of frame from {formatSeconds(outside)}. That's fine for an exit, but the video model can't see it there.</Alert>}
    {errors.map(error => <Alert key={error} severity="error">{error}</Alert>)}
    <Button variant="contained" size="large" disabled={recording || !moving || errors.length > 0} onClick={() => visitPhase(3)}>Continue →</Button>
    <Button disabled={recording} onClick={() => visitPhase(1)}>Edit background</Button>
  </Stack>;
}
