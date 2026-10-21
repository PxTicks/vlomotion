import { Button, Chip, FormControlLabel, LinearProgress, Stack, Switch, TextField, Typography } from "@mui/material";
import { useSelectionStore } from "./useSelectionStore";

export function SelectPanel() {
  const image = useSelectionStore(s => s.image);
  const text = useSelectionStore(s => s.text);
  const setText = useSelectionStore(s => s.setText);
  const candidates = useSelectionStore(s => s.candidates);
  const selectedIds = useSelectionStore(s => s.selectedIds);
  const toggle = useSelectionStore(s => s.toggleCandidate);
  const refine = useSelectionStore(s => s.refine);
  const setRefine = useSelectionStore(s => s.setRefine);
  const positive = useSelectionStore(s => s.positive);
  const negative = useSelectionStore(s => s.negative);
  const pointsPending = useSelectionStore(s => s.pointsPending);
  const applyRefinement = useSelectionStore(s => s.applyRefinement);
  const clearPoints = useSelectionStore(s => s.clearPoints);
  const segment = useSelectionStore(s => s.segment);
  const confirm = useSelectionStore(s => s.confirm);
  const busy = useSelectionStore(s => s.busy);
  const job = useSelectionStore(s => s.job);
  const cancel = useSelectionStore(s => s.cancel);

  return <Stack spacing={2.5}>
    <Stack spacing={1}><Typography variant="h2">What do you want to move?</Typography>
      <Typography variant="body2" color="text.secondary">Name a subject, then choose which instances to lift out of the photo.</Typography></Stack>
    <Stack component="form" spacing={1.5} onSubmit={event => { event.preventDefault(); void segment(); }}>
      <TextField label="Subject" placeholder="e.g. red car" value={text} onChange={event => setText(event.target.value)}
        disabled={!image || busy} inputProps={{ maxLength: 160 }} helperText="Short names work best: dog, red car. SAM has a 32-token limit." fullWidth />
      <Button type="submit" variant="outlined" disabled={!image || !text.trim() || busy}>Find subject</Button>
    </Stack>
    {candidates.length > 0 && <Stack spacing={1}>
      <Typography variant="overline" color="text.secondary">SUBJECTS · {selectedIds.length} selected</Typography>
      <Stack direction="row" flexWrap="wrap" gap={1}>{candidates.map((candidate, index) =>
        <Chip key={candidate.id} label={`Subject ${index + 1}`} component="button" clickable disabled={busy}
          aria-pressed={selectedIds.includes(candidate.id)} color={selectedIds.includes(candidate.id) ? "primary" : "default"}
          variant={selectedIds.includes(candidate.id) ? "filled" : "outlined"} onClick={() => toggle(candidate.id)} />)}</Stack>
    </Stack>}
    <Stack><FormControlLabel control={<Switch checked={refine} onChange={(_, checked) => setRefine(checked)} disabled={!image || busy} />} label="Refine with points" />
      {refine && <Stack spacing={1.5}>
        <Typography variant="caption" color="text.secondary">Add all your points, then apply refinement. Left click to include; right click to exclude. Click an existing point to remove it. Refines the first selected subject; other selections stay in place.</Typography>
        <Typography variant="caption" color="text.secondary" role="status">{positive.length} include · {negative.length} exclude{pointsPending ? " · Unapplied changes" : ""}</Typography>
        <Button variant="outlined" disabled={busy || !positive.length || !pointsPending} onClick={() => void applyRefinement()}>Apply refinement</Button>
        <Button disabled={busy || (!positive.length && !negative.length)} onClick={clearPoints}>Clear points</Button>
        {pointsPending && <Typography variant="caption" color="text.secondary">{positive.length ? "Apply or clear your points before confirming selection." : "Add at least one include point to apply refinement."}</Typography>}
      </Stack>}</Stack>
    {busy && job && <Stack spacing={1} aria-live="polite">
      <Typography variant="body2">{job.message}</Typography>
      <LinearProgress variant={job.progress === null ? "indeterminate" : "determinate"} value={(job.progress ?? 0) * 100} />
      <Button onClick={() => void cancel()}>Cancel selection</Button>
    </Stack>}
    <Button variant="contained" size="large" disabled={!selectedIds.length || busy || pointsPending} onClick={() => void confirm()}>Confirm selection →</Button>
  </Stack>;
}
