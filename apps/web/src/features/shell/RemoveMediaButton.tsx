import { IconButton, Tooltip } from "@mui/material";

export function RemoveMediaButton({ label, disabled, onRemove }: { label: string; disabled: boolean; onRemove(): void }) {
  return <Tooltip title={label}>
    <span style={{ position: "absolute", top: 8, right: 8, zIndex: 2, display: "inline-flex" }}>
      <IconButton size="small" aria-label={label} disabled={disabled} onClick={onRemove}
        sx={{ width: 28, height: 28, bgcolor: "background.paper", border: "1px solid", borderColor: "divider",
          "&:hover": { bgcolor: "action.hover" } }}>
        <span aria-hidden="true" style={{ fontSize: 20, lineHeight: 1 }}>×</span>
      </IconButton>
    </span>
  </Tooltip>;
}
