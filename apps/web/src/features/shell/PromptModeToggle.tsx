import { Alert, Button, Stack, ToggleButton, ToggleButtonGroup, Typography } from "@mui/material";

/** Formatted fills in the prompt's parts and lays them out for H3; raw is the whole prompt, sent as written. */
export type PromptMode = "formatted" | "raw";

const MODES = [
  ["formatted", "Formatted", "Fill in the prompt's parts, and they're laid out in the format MiniMax H3 expects."],
  ["raw", "Raw", "Edit the whole prompt in one box. It's sent to MiniMax H3 exactly as written."],
] as const;

/**
 * The Advanced toggle between the prompt's fields and the whole raw prompt. `unformattable` means the raw prompt no
 * longer splits into the fields, which offers to reset it to the formatted prompt it started from.
 */
export function PromptModeToggle({ mode, unformattable, disabled, onChange, onReset, onKeep }: {
  mode: PromptMode; unformattable: boolean; disabled: boolean; onChange(mode: PromptMode): void; onReset(): void; onKeep(): void;
}) {
  return <Stack spacing={1}>
    <Typography variant="caption" color="text.secondary">Prompt</Typography>
    <ToggleButtonGroup exclusive size="small" value={mode} disabled={disabled} aria-label="Prompt"
      onChange={(_, value: unknown) => { const next = MODES.find(([option]) => option === value); if (next) onChange(next[0]); }}>
      {MODES.map(([value, label]) => <ToggleButton key={value} value={value} sx={{ px: 1.5, py: .5, borderRadius: 99 }}>{label}</ToggleButton>)}
    </ToggleButtonGroup>
    <Typography variant="body2" color="text.secondary">{MODES.find(([value]) => value === mode)![2]}</Typography>
    {unformattable && <Alert severity="warning">
      This prompt no longer follows the format, so it can't be split back into fields. Reset it to return to the formatted prompt, losing your raw edits.
      <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
        <Button size="small" color="inherit" variant="outlined" disabled={disabled} onClick={onReset}>Reset prompt</Button>
        <Button size="small" color="inherit" onClick={onKeep}>Keep editing raw</Button>
      </Stack>
    </Alert>}
  </Stack>;
}
