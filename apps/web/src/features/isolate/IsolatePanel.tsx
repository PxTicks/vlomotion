import { useState } from "react";
import { Button, Chip, LinearProgress, Stack, TextField, Typography } from "@mui/material";
import { removalInstruction } from "@h3-motion/shared";
import { useSelectionStore } from "../select";

export function IsolatePanel() {
  const result = useSelectionStore(s => s.isolation);
  const mask = useSelectionStore(s => s.mask);
  const selectionText = useSelectionStore(s => s.selectionText);
  const busy = useSelectionStore(s => s.busy);
  const job = useSelectionStore(s => s.job);
  const isolate = useSelectionStore(s => s.isolate);
  const cancel = useSelectionStore(s => s.cancel);
  const visitPhase = useSelectionStore(s => s.visitPhase);
  const [editing, setEditing] = useState(false);
  const [instruction, setInstruction] = useState("");

  return <Stack spacing={2.5}>
    <Stack spacing={1}>
      <Typography variant="h2">Lift the subject out</Typography>
      <Typography variant="body2" color="text.secondary">Remove the selected subject and fill in the background behind it. Your selection stays available for motion editing.</Typography>
    </Stack>
    {result && <Chip label={result.descriptionSource === "model" ? `Removed: ${result.phrase}` : "Custom removal instruction"} color="primary" sx={{ alignSelf: "start", height: "auto", ".MuiChip-label": { whiteSpace: "normal", py: 1 } }} />}
    {busy && <Stack spacing={1} aria-live="polite">
      <Typography variant="body2">{job?.message ?? "Preparing background removal…"}</Typography>
      <LinearProgress variant={job?.progress == null ? "indeterminate" : "determinate"} value={(job?.progress ?? 0) * 100} />
      <Typography variant="caption" color="text.secondary">{job?.stage === "describe" ? "Identifying the subject" : "Creating the background"} · This can take a few minutes.</Typography>
      {job && <Button onClick={() => void cancel()}>Cancel isolation</Button>}
    </Stack>}
    {!editing && <Button variant={result ? "outlined" : "contained"} size="large" disabled={busy} onClick={() => void isolate()}>
      {result ? "Retry with a new seed" : "Isolate subject"}
    </Button>}
    {!editing ? <Button disabled={busy} onClick={() => {
      setInstruction(result?.instruction ?? (selectionText ? removalInstruction(selectionText) : "")); setEditing(true);
    }}>Edit instruction</Button> : <Stack spacing={1.5}>
      <TextField multiline minRows={5} fullWidth label="Removal instruction" value={instruction}
        disabled={busy} onChange={event => setInstruction(event.target.value)} inputProps={{ maxLength: 2000 }}
        placeholder="Remove the red car from <image1>. Keep the rest of the scene unchanged."
        helperText="Name the object directly; the edit model sees the original photo." />
      <Button variant="outlined" disabled={busy || !instruction.trim()} onClick={async () => {
        await isolate(instruction.trim());
        const state = useSelectionStore.getState();
        if (state.job?.status === "completed" && !state.error) setEditing(false);
      }}>Apply instruction</Button>
      <Button disabled={busy} onClick={() => setEditing(false)}>Cancel editing</Button>
    </Stack>}
    {result && <Button variant="contained" size="large" disabled={busy} onClick={() => visitPhase(2)}>Continue →</Button>}
    {result && <Button component="a" href={result.plate.url} download="h3-motion-background.png">Download background</Button>}
    {mask && <Button component="a" href={mask.url} download="h3-motion-subject-mask.png">Download subject mask</Button>}
    <Button disabled={busy} onClick={() => visitPhase(0)}>Edit subject selection</Button>
  </Stack>;
}
