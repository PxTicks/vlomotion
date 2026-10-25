import { Box, ButtonBase, IconButton, Stack, Typography } from "@mui/material";
import { useSelectionStore } from "../select";
import { useMotionStore } from "./useMotionStore";

export function MotionSubjects() {
  const image = useSelectionStore(state => state.image);
  const subjects = useMotionStore(state => state.subjects);
  const activeId = useMotionStore(state => state.activeSubjectId);
  const recording = useMotionStore(state => state.recording);
  const selectSubject = useMotionStore(state => state.selectSubject);
  const reorderSubject = useMotionStore(state => state.reorderSubject);
  if (subjects.length < 2) return null;

  return <Stack spacing={1}>
    <Stack direction="row" justifyContent="space-between" alignItems="baseline">
      <Typography variant="overline">Subjects</Typography>
      <Typography variant="caption" color="text.secondary">Front to back</Typography>
    </Stack>
    {subjects.map((subject, index) => {
      const active = subject.id === activeId, bounds = subject.layers.bounds;
      return <Stack key={subject.id} direction="row" alignItems="center" spacing={.5}
        sx={{ p: .5, border: "1px solid", borderColor: active ? subject.color : "divider", borderRadius: 1 }}>
        <ButtonBase disabled={recording} aria-label={`Select ${subject.name}`} aria-pressed={active} onClick={() => selectSubject(subject.id)}
          sx={{ flex: 1, minWidth: 0, gap: 1, justifyContent: "flex-start", p: .5, borderRadius: .5 }}>
          <Box component="svg" viewBox={`${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`} aria-hidden="true"
            sx={{ width: 44, height: 44, flexShrink: 0, borderRadius: .5, bgcolor: "background.default" }}>
            <image href={image?.url} width={image?.width} height={image?.height} />
          </Box>
          <Typography sx={{ color: subject.color }} aria-hidden="true">◆</Typography>
          <Typography variant="body2" noWrap>{subject.name}</Typography>
        </ButtonBase>
        <IconButton size="small" aria-label={`Move ${subject.name} forward`} disabled={recording || index === 0} onClick={() => reorderSubject(subject.id, -1)}>↑</IconButton>
        <IconButton size="small" aria-label={`Move ${subject.name} backward`} disabled={recording || index === subjects.length - 1} onClick={() => reorderSubject(subject.id, 1)}>↓</IconButton>
      </Stack>;
    })}
  </Stack>;
}
