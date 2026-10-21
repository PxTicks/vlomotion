import { useState } from "react";
import { Alert, Box, ButtonBase, Stack, Typography } from "@mui/material";
import { currentIsolation, useSelectionStore } from "../select";

export function IsolatePreview() {
  const image = useSelectionStore(s => s.image);
  const result = useSelectionStore(currentIsolation);
  const [original, setOriginal] = useState(false);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (!image || !result) return null;
  const url = original ? image.url : result.plate.url;

  return <Stack spacing={1.5}>
    <ButtonBase disableRipple aria-label="Hold to compare with original" aria-pressed={original}
      onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); setOriginal(true); }}
      onPointerUp={() => setOriginal(false)} onPointerCancel={() => setOriginal(false)}
      onLostPointerCapture={() => setOriginal(false)} onBlur={() => setOriginal(false)}
      onKeyDown={event => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); setOriginal(true); } }}
      onKeyUp={event => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); setOriginal(false); } }}
      sx={{ position: "relative", borderRadius: 1, overflow: "hidden", width: "100%", maxWidth: image.height > image.width ? 420 : "100%", mx: "auto", bgcolor: "#19151f",
        aspectRatio: `${image.width}/${image.height}`, touchAction: "none", "&.Mui-focusVisible": { outline: "2px solid", outlineColor: "primary.main" } }}>
      <Box component="img" src={url} alt={original ? "Original photo" : "Clean background with the subject removed"} draggable={false}
        onError={() => setFailedUrl(url)} sx={{ display: "block", width: "100%", height: "100%", objectFit: "contain" }} />
      <Box sx={{ position: "absolute", top: 12, left: 12, borderRadius: 99, px: 1.5, py: .5, bgcolor: "background.paper" }}>
        <Typography variant="caption">{original ? "Original" : "Clean background"}</Typography>
      </Box>
    </ButtonBase>
    <Typography variant="caption" color="text.secondary" textAlign="center">Hold the preview to compare with the original. Keyboard: hold Space or Enter.</Typography>
    {failedUrl === url && <Alert severity="error">Could not load the background preview. Try isolating the subject again.</Alert>}
  </Stack>;
}
