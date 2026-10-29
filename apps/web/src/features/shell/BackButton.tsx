import { Box, Button } from "@mui/material";

/** Sits under the stepper on every step. Step one keeps the space empty so the panel heading doesn't jump between steps. */
export function BackButton({ to, disabled, onBack }: { to: string | null; disabled: boolean; onBack(): void }) {
  return <Box sx={{ height: 32, mb: 1.5 }}>
    {to && <Button size="small" disabled={disabled} aria-label={`Back to ${to}`} title={`Back to ${to}`} onClick={onBack}
      sx={{ minHeight: 32, ml: -1, px: 1, color: "text.secondary" }}>‹ Back</Button>}
  </Box>;
}
