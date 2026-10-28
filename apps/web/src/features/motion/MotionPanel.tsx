import { useMemo } from "react";
import { Alert, Button, Stack, Typography } from "@mui/material";
import { buildMotionCurve, firstFrameOutside, validateMotion } from "@h3-motion/shared";
import { useSelectionStore } from "../select";
import { formatSeconds } from "./format";
import { subjectKeyOf } from "./subjectLayers";
import { useMotionStore } from "./useMotionStore";
import { SUBJECT_COLORS } from "./useMotionStore";
import { MotionSubjects } from "./MotionSubjects";
import { SelectedKeyCard } from "./SelectedKeyCard";

export function MotionPanel() {
  const image = useSelectionStore(s => s.image);
  const mask = useSelectionStore(s => s.mask);
  const visitPhase = useSelectionStore(s => s.visitPhase);
  const subjectKey = useMotionStore(s => s.subjectKey);
  const motion = useMotionStore(s => s.motion);
  const subjects = useMotionStore(s => s.subjects);
  const activeSubjectId = useMotionStore(s => s.activeSubjectId);
  const bounds = useMotionStore(s => s.bounds);
  const size = useMotionStore(s => s.size);
  const selectedKeyId = useMotionStore(s => s.selectedKeyId);
  const recording = useMotionStore(s => s.recording);
  const notice = useMotionStore(s => s.notice);
  const retimeKey = useMotionStore(s => s.retimeKey);
  const deleteSelected = useMotionStore(s => s.deleteSelected);
  const resetScale = useMotionStore(s => s.resetScale);
  const clearPath = useMotionStore(s => s.clearPath);
  const ready = !!image && !!mask && subjectKey === subjectKeyOf(image.id, mask.id) && !!motion;
  const curve = useMemo(() => motion ? buildMotionCurve(motion) : null, [motion]);
  const outside = useMemo(() => curve && bounds && size ? firstFrameOutside(curve, bounds, size) : null, [curve, bounds, size]);

  const heading = <Stack spacing={1}>
    <Typography variant="h2">Drag it into motion</Typography>
    <Typography variant="body2" color="text.secondary">Drag to create a path. Adjust by selecting and dragging ◆ on the canvas to fix positions, or on the timeline bar to fix timings. Drag the box corners to resize the subject, or its edges to stretch or flip it.</Typography>
  </Stack>;
  if (!ready || !curve) return <Stack spacing={2.5}>{heading}<Typography role="status" variant="body2">Preparing your subject…</Typography></Stack>;

  const errors = subjects.length ? subjects.flatMap(subject => validateMotion(subject.motion).map(error => `${subject.name}: ${error}`)) : validateMotion(motion);
  const moving = subjects.length ? subjects.some(subject => buildMotionCurve(subject.motion).animated) : curve.animated;
  const color = subjects.find(subject => subject.id === activeSubjectId)?.color ?? SUBJECT_COLORS[0];

  return <Stack spacing={2.5}>
    {heading}
    <MotionSubjects />
    {notice && <Typography role="status" variant="body2" color="text.secondary">{notice}</Typography>}
    <SelectedKeyCard motion={motion} keyId={selectedKeyId} color={color} disabled={recording} onRetime={retimeKey} onResetScale={resetScale} onDelete={deleteSelected}
      startNote="The first key is your photo. It stays at 0 s in its original position." />
    <Button variant="outlined" disabled={recording || motion.keys.length < 2} onClick={clearPath}>Clear path</Button>
    {outside !== null && <Alert severity="warning">The subject is completely out of frame from {formatSeconds(outside)}. That's fine for an exit, but the video model can't see it there.</Alert>}
    {errors.map(error => <Alert key={error} severity="error">{error}</Alert>)}
    <Button variant="contained" size="large" disabled={recording || !moving || errors.length > 0} onClick={() => visitPhase(3)}>Continue →</Button>
    <Button disabled={recording} onClick={() => visitPhase(1)}>Edit background</Button>
  </Stack>;
}
