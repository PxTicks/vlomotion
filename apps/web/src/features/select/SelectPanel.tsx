import { Box, Button, Checkbox, Chip, LinearProgress, Stack, TextField, ToggleButton, ToggleButtonGroup, Typography } from "@mui/material";
import { hasPendingPoints, useSelectionStore } from "./useSelectionStore";

export function SelectPanel() {
  const s = useSelectionStore();
  const pending = hasPendingPoints(s);
  const activeName = s.activeId ? s.labels[s.activeId] ?? "Subject" : "New subject";
  return <Stack spacing={2.5}>
    <Stack spacing={1}><Typography variant="h2">What do you want to move?</Typography>
      <Typography variant="body2" color="text.secondary">Name a subject or click one in the photo. Include as many subjects as you like.</Typography></Stack>
    <Stack component="form" spacing={1.5} onSubmit={event => { event.preventDefault(); void s.segment(); }}>
      <TextField label="Find subjects" placeholder="e.g. red car" value={s.text} onChange={event => s.setText(event.target.value)}
        disabled={!s.image || s.busy} inputProps={{ maxLength: 160 }} helperText="Search adds suggestions and keeps your existing subjects." fullWidth />
      <Button type="submit" variant="outlined" disabled={!s.image || !s.text.trim() || s.busy}>Find subjects</Button>
    </Stack>
    <Stack spacing={1}>
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Typography variant="overline">Subjects · {s.selectedIds.length} included</Typography>
        <Button size="small" disabled={!s.image || s.busy} onClick={s.addSubject}>+ Add subject</Button>
      </Stack>
      {s.candidates.length > 1 && <Button size="small" disabled={s.busy || s.selectedIds.length === s.candidates.length} onClick={s.includeAll}>Include all {s.candidates.length}</Button>}
      {s.candidates.map((candidate, index) => {
        const name = s.labels[candidate.id] ?? `Subject ${index + 1}`;
        const active = s.activeId === candidate.id;
        const { bounds } = candidate;
        return <Stack key={candidate.id} direction="row" alignItems="center" spacing={0.5}
          onMouseEnter={() => s.setHoveredId(candidate.id)} onMouseLeave={() => s.setHoveredId(null)}
          sx={{ p: 0.5, border: "1px solid", borderColor: active ? "primary.main" : s.hoveredId === candidate.id ? "text.primary" : "divider", borderRadius: 1, bgcolor: active ? "action.selected" : "transparent" }}>
          <Checkbox checked={s.selectedIds.includes(candidate.id)} disabled={s.busy} onChange={() => s.toggleCandidate(candidate.id)} inputProps={{ "aria-label": `Include ${name}` }} />
          <Button disabled={s.busy} onClick={() => s.editSubject(candidate.id)} aria-label={`Edit ${name}`} aria-pressed={active}
            sx={{ flex: 1, justifyContent: "flex-start", textAlign: "left", gap: 1, minWidth: 0 }}>
            <Box component="svg" viewBox={`${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`} aria-hidden="true" sx={{ width: 44, height: 44, flexShrink: 0, borderRadius: 0.5, bgcolor: "background.default" }}>
              <image href={s.image?.url} width={s.image?.width} height={s.image?.height} />
            </Box>
            <Stack sx={{ minWidth: 0 }}><Typography variant="body2" noWrap>{index + 1}. {name}</Typography>
              <Typography variant="caption" color="text.secondary">{active ? "Editing" : "Edit mask"}{s.drafts[candidate.id]?.pointsPending ? " · Unapplied points" : ""}</Typography></Stack>
          </Button>
          <Button size="small" disabled={s.busy} aria-label={`Delete ${name}`} onClick={() => s.deleteSubject(candidate.id)} sx={{ minWidth: 32 }}>×</Button>
        </Stack>;
      })}
      {!s.candidates.length && <Typography variant="body2" color="text.secondary">Your subjects will appear here. Clicks add points; Apply creates the mask.</Typography>}
    </Stack>
    <Stack spacing={1.5} sx={{ p: 2, border: "1px solid", borderColor: "primary.main", borderRadius: 1 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center"><Typography fontWeight={600}>{s.activeId ? `Editing ${activeName}` : activeName}</Typography>
        <Chip size="small" label={s.activeId ? "One mask" : "Fresh selection"} /></Stack>
      <Typography variant="caption" color="text.secondary">{s.activeId ? "Points change this mask only. Other subjects stay in place." : "Place points for a new subject, then apply. Existing subjects stay in place."} Right-click to exclude. Click a point to remove it.</Typography>
      <ToggleButtonGroup exclusive value={s.pointTool} size="small" disabled={!s.image || s.busy} onChange={(_, tool) => { if (tool) s.setPointTool(tool); }} aria-label="Point type">
        <ToggleButton value="include">+ Include</ToggleButton><ToggleButton value="exclude">− Exclude</ToggleButton>
      </ToggleButtonGroup>
      <Typography variant="caption" role="status">{s.positive.length} include · {s.negative.length} exclude{s.pointsPending ? " · Unapplied changes" : ""}</Typography>
      <Button variant="outlined" disabled={!s.image || s.busy || !s.positive.length || !s.pointsPending} onClick={() => void s.applyRefinement()}>{s.activeId ? "Apply points" : "Apply new subject"}</Button>
      <Button disabled={s.busy || (!s.positive.length && !s.negative.length)} onClick={s.clearPoints}>Clear points</Button>
      {s.pointsPending && !s.positive.length && <Typography variant="caption">Add at least one include point to apply.</Typography>}
      {s.activeId && !s.selectedIds.includes(s.activeId) && <Typography variant="caption">This subject is not included. Check its box to include it.</Typography>}
    </Stack>
    <Button disabled={s.busy || !s.history.length} onClick={s.undo}>Undo last change</Button>
    {s.busy && s.job && <Stack spacing={1} aria-live="polite"><Typography variant="body2">{s.job.message}</Typography>
      <LinearProgress variant={s.job.progress === null ? "indeterminate" : "determinate"} value={(s.job.progress ?? 0) * 100} />
      <Button onClick={() => void s.cancel()}>Cancel selection</Button></Stack>}
    {pending && <Typography variant="caption" role="status">Apply or clear unapplied points on each subject before continuing.{s.activeId && s.drafts.new?.pointsPending ? " New subject also has unapplied points." : ""}</Typography>}
    <Button variant="contained" size="large" disabled={!s.selectedIds.length || s.busy || pending} onClick={() => void s.confirm()}>Continue with {s.selectedIds.length} {s.selectedIds.length === 1 ? "subject" : "subjects"} →</Button>
  </Stack>;
}
