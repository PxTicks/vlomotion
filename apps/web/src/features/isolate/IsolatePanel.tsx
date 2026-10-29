import { useState } from "react";
import { Button, Chip, LinearProgress, Stack, TextField, Typography } from "@mui/material";
import { canRecoverIsolation, currentIsolation, useSelectionStore } from "../select";

export function IsolatePanel() {
  const result = useSelectionStore(currentIsolation);
  const recovery = useSelectionStore(canRecoverIsolation);
  const image = useSelectionStore(s => s.image);
  const mask = useSelectionStore(s => s.mask);
  const selectionText = useSelectionStore(s => s.selectionText || s.text);
  const busy = useSelectionStore(s => s.busy);
  const job = useSelectionStore(s => s.job);
  const isolate = useSelectionStore(s => s.isolate);
  const cancel = useSelectionStore(s => s.cancel);
  const visitPhase = useSelectionStore(s => s.visitPhase);
  const selectionKey = `${image?.id}:${mask?.id}:${result?.plate.id}`;
  const [draft, setDraft] = useState<{ selectionKey: string; instruction: string } | null>(null);
  const instruction = draft?.selectionKey === selectionKey ? draft.instruction
    : result?.instruction ?? "";
  const showPrompt = !!result || draft?.selectionKey === selectionKey;
  const subject = selectionText.trim().replace(/^the\s+/i, "") || "foreground";

  return <Stack spacing={2.5}>
    <Stack spacing={1}>
      <Typography variant="h2">Isolate the subject</Typography>
      <Typography variant="body2" color="text.secondary">Lifts it out and fills in the background behind it.</Typography>
    </Stack>
    {result && <Chip label={result.instructionSource === "custom" ? "Custom removal instruction" : `Removed: ${result.phrase}`} color="primary" sx={{ alignSelf: "start", height: "auto", ".MuiChip-label": { whiteSpace: "normal", py: 1 } }} />}
    {!showPrompt && <Button size="small" disabled={busy} sx={{ alignSelf: "start" }}
      onClick={() => setDraft({ selectionKey, instruction: "" })}>+ add prompt [optional]</Button>}
    {showPrompt && <TextField multiline minRows={5} fullWidth label="Prompt (for subject removal)" value={instruction}
      disabled={busy} onChange={event => setDraft({ selectionKey, instruction: event.target.value })} inputProps={{ maxLength: 2000 }}
      slotProps={{ inputLabel: { shrink: true } }}
      placeholder={`[e.g. Remove the ${subject} from the image]`} />}
    {busy && <Stack spacing={1} aria-live="polite">
      <Typography variant="body2">{job?.message ?? "Preparing background removal…"}</Typography>
      <LinearProgress variant={job?.progress == null ? "indeterminate" : "determinate"} value={(job?.progress ?? 0) * 100} />
      <Typography variant="caption" color="text.secondary">{job?.stage === "describe" ? "Identifying the subject" : "Creating the background"} · This can take a few minutes.</Typography>
      {job && <Button onClick={() => void cancel()}>Cancel isolation</Button>}
    </Stack>}
    <Button variant={result ? "outlined" : "contained"} size="large" disabled={busy} onClick={() => {
      const prompt = instruction.trim();
      void isolate(prompt === result?.instruction ? undefined : prompt);
    }}>
      {result ? "Try again" : "Isolate"}
    </Button>
    {!result && recovery && <Typography variant="caption" color="text.secondary">Isolation failed. Retry to generate a removal prompt from the highlighted subject.</Typography>}
    {result && <Button variant="contained" size="large" disabled={busy} onClick={() => visitPhase(2)}>Continue →</Button>}
  </Stack>;
}
