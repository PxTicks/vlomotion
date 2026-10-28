import { Box, Button, Paper, Stack, Typography } from "@mui/material";
import { isStartKey } from "@h3-motion/shared";
import type { SubjectMotion } from "@h3-motion/shared";
import { formatScale, formatSeconds, signed } from "./format";

/** Details of the selected key with nudge, reset-size and delete controls. The fixed first key only explains itself. */
export function SelectedKeyCard({ motion, keyId, color, disabled, startNote, onRetime, onResetScale, onDelete }: {
  motion: SubjectMotion<number>; keyId: string | null; color: string; disabled: boolean; startNote: string;
  onRetime(id: string, frame: number): void; onResetScale(): void; onDelete(): void;
}) {
  const index = motion.keys.findIndex(key => key.id === keyId);
  const selected = motion.keys[index];
  if (!selected) return null;
  return <Paper variant="outlined" sx={{ p: 2, bgcolor: "#2b2040" }}>
    <Stack spacing={1.5}>
      <Stack direction="row" justifyContent="space-between" alignItems="baseline">
        <Typography variant="overline" sx={{ lineHeight: 1.4, whiteSpace: "nowrap", mr: 1 }}><Box component="span" sx={{ color }}>◆</Box> KEY {index + 1}</Typography>
        <Typography variant="body2" sx={{ fontVariantNumeric: "tabular-nums", textAlign: "right" }}>{formatSeconds(selected.frame)} · {signed(selected.x - motion.anchor.x)}, {signed(selected.y - motion.anchor.y)}
          {formatScale(selected) && ` · ${formatScale(selected)}`}</Typography>
      </Stack>
      {isStartKey(motion, selected.id) ? <Typography variant="caption" color="text.secondary">{startNote}</Typography>
        : <Stack direction="row" gap={1} flexWrap="wrap">
          <Button size="small" variant="outlined" disabled={disabled} onClick={() => onRetime(selected.id, selected.frame - 1)}>− 1 frame</Button>
          <Button size="small" variant="outlined" disabled={disabled} onClick={() => onRetime(selected.id, selected.frame + 1)}>+ 1 frame</Button>
          {formatScale(selected) && <Button size="small" variant="outlined" disabled={disabled} onClick={onResetScale}>Reset size</Button>}
          <Button size="small" color="error" disabled={disabled} onClick={onDelete}>Delete key</Button>
        </Stack>}
    </Stack>
  </Paper>;
}
