import { useState } from "react";
import { Button, Chip, LinearProgress, Stack, TextField, Typography } from "@mui/material";
import { canRecoverIsolation, currentIsolation, useSelectionStore } from "../select";

export function IsolatePanel() {
  const result = useSelectionStore(currentIsolation);
  const recovery = useSelectionStore(canRecoverIsolation);
  const image = useSelectionStore(s => s.image);
  const mask = useSelectionStore(s => s.mask);
  const busy = useSelectionStore(s => s.busy);
  const job = useSelectionStore(s => s.job);
  const isolate = useSelectionStore(s => s.isolate);
  const cancel = useSelectionStore(s => s.cancel);
  const visitPhase = useSelectionStore(s => s.visitPhase);
  const selectionKey = `${image?.id}:${mask?.id}`;
  const [draft, setDraft] = useState<{ selectionKey: string; instruction: string } | null>(null);
  const editor = draft?.selectionKey === selectionKey ? draft : null;

  return <Stack spacing={2.5}>
    <Stack spacing={1}>
      <Typography variant="h2">Lift the subject out</Typography>
      <Typography variant="body2" color="text.secondary">Remove the selected subject and fill in the background behind it. Your selection stays available for motion editing.</Typography>
    </Stack>
    {result && <Chip label={result.instructionSource === "custom" ? "Custom removal instruction" : `Removed: ${result.phrase}`} color="primary" sx={{ alignSelf: "start", height: "auto", ".MuiChip-label": { whiteSpace: "normal", py: 1 } }} />}
    {busy && <Stack spacing={1} aria-live="polite">
      <Typography variant="body2">{job?.message ?? "Preparing background removal…"}</Typography>
      <LinearProgress variant={job?.progress == null ? "indeterminate" : "determinate"} value={(job?.progress ?? 0) * 100} />
      <Typography variant="caption" color="text.secondary">{job?.stage === "describe" ? "Identifying the subject" : "Creating the background"} · This can take a few minutes.</Typography>
      {job && <Button onClick={() => void cancel()}>Cancel isolation</Button>}
    </Stack>}
    {!editor && <Button variant={result ? "outlined" : "contained"} size="large" disabled={busy} onClick={() => void isolate()}>
      {result ? "Retry with a new seed" : "Isolate subject"}
    </Button>}
    {!result && <Typography variant="caption" color="text.secondary">{recovery
      ? "Isolation failed. Retry, or write an instruction to skip automatic description."
      : "Isolate this selection to generate its removal instruction from the highlighted subject."}</Typography>}
    {!editor ? <Button disabled={busy || (!result && !recovery)} onClick={() => {
      setDraft({ selectionKey, instruction: result?.instruction ?? "" });
    }}>{result || !recovery ? "Edit instruction" : "Write removal instruction"}</Button> : <Stack spacing={1.5}>
      <TextField multiline minRows={5} fullWidth label="Removal instruction" value={editor.instruction}
        disabled={busy} onChange={event => setDraft({ selectionKey, instruction: event.target.value })} inputProps={{ maxLength: 2000 }}
        placeholder="Remove the red car from <image1>. Keep the rest of the scene unchanged."
        helperText={!result ? "Name the object directly. Applying your instruction skips automatic description." : "Name the object directly; the edit model sees the original photo."} />
      <Button variant="outlined" disabled={busy || !editor.instruction.trim()} onClick={async () => {
        await isolate(editor.instruction.trim());
        const state = useSelectionStore.getState();
        if (state.job?.status === "completed" && !state.error) setDraft(previous => previous?.selectionKey === selectionKey ? null : previous);
      }}>Apply instruction</Button>
      <Button disabled={busy} onClick={() => setDraft(null)}>Cancel editing</Button>
    </Stack>}
    {result && <Button variant="contained" size="large" disabled={busy} onClick={() => visitPhase(2)}>Continue →</Button>}
    {result && <Button component="a" href={result.plate.url} download="h3-motion-background.png">Download background</Button>}
    {mask && <Button component="a" href={mask.url} download="h3-motion-subject-mask.png">Download subject mask</Button>}
    <Button disabled={busy} onClick={() => visitPhase(0)}>Edit subject selection</Button>
  </Stack>;
}
