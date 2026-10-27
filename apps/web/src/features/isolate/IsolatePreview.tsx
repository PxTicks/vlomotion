import { useState } from "react";
import type { PointerEvent, ReactNode } from "react";
import { Alert, Box, Stack, Typography } from "@mui/material";
import { currentIsolation, useSelectionStore } from "../select";

export function IsolatePreview({ mediaAction }: { mediaAction?: ReactNode }) {
  const image = useSelectionStore(s => s.image);
  const result = useSelectionStore(currentIsolation);
  const [split, setSplit] = useState(50);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (!image || !result) return null;

  function moveSplit(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width) setSplit(Math.round(Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) * 100));
  }

  return <Stack spacing={1.5}>
    <Box sx={{ position: "relative", width: "100%", maxWidth: image.height > image.width ? 420 : "100%", mx: "auto" }}>
    <Box role="slider" tabIndex={0} aria-label="Compare original photo with clean background"
      aria-orientation="horizontal" aria-valuemin={0} aria-valuemax={100} aria-valuenow={split}
      aria-valuetext={`${split}% original photo, ${100 - split}% clean background`}
      onPointerDown={event => {
        if (!event.isPrimary || event.button !== 0) return;
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        moveSplit(event);
      }}
      onPointerMove={event => { if (event.isPrimary) moveSplit(event); }}
      onKeyDown={event => {
        const step = event.shiftKey ? 10 : 1;
        const next = event.key === "ArrowLeft" || event.key === "ArrowDown" ? split - step
          : event.key === "ArrowRight" || event.key === "ArrowUp" ? split + step
          : event.key === "Home" ? 0 : event.key === "End" ? 100 : null;
        if (next === null) return;
        event.preventDefault();
        setSplit(Math.min(100, Math.max(0, next)));
      }}
      sx={{ position: "relative", borderRadius: 1, overflow: "hidden", width: "100%", maxWidth: image.height > image.width ? 420 : "100%", mx: "auto", bgcolor: "#19151f",
        aspectRatio: `${image.width}/${image.height}`, touchAction: "pan-y", cursor: "ew-resize", userSelect: "none",
        "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main", outlineOffset: 3 } }}>
      <Box component="img" src={result.plate.url} alt="Clean background with the subject removed" draggable={false}
        onError={() => setFailedUrl(result.plate.url)} sx={{ display: "block", width: "100%", height: "100%", objectFit: "contain", pointerEvents: "none" }} />
      <Box sx={{ position: "absolute", inset: 0, clipPath: `inset(0 0 0 ${split}%)`, pointerEvents: "none" }}>
        <Box sx={{ position: "absolute", top: 12, right: mediaAction ? 48 : 12, borderRadius: 99, px: 1.5, py: .5, bgcolor: "background.paper" }}>
          <Typography variant="caption">Clean background</Typography>
        </Box>
      </Box>
      <Box sx={{ position: "absolute", inset: 0, clipPath: `inset(0 ${100 - split}% 0 0)`, pointerEvents: "none" }}>
        <Box component="img" src={image.url} alt="Original photo" draggable={false}
          onError={() => setFailedUrl(image.url)} sx={{ display: "block", width: "100%", height: "100%", objectFit: "contain" }} />
        <Box sx={{ position: "absolute", top: 12, left: 12, borderRadius: 99, px: 1.5, py: .5, bgcolor: "background.paper" }}>
          <Typography variant="caption">Original</Typography>
        </Box>
      </Box>
      <Box aria-hidden="true" sx={{ position: "absolute", left: `${split}%`, top: 0, bottom: 0, width: 2, transform: "translateX(-50%)", bgcolor: "primary.main", pointerEvents: "none" }}>
        <Box sx={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)", width: 40, height: 40,
          display: "grid", placeItems: "center", borderRadius: "50%", bgcolor: "primary.main", color: "primary.contrastText", boxShadow: "0 2px 8px rgba(0,0,0,.4)" }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m8 7-5 5 5 5m8-10 5 5-5 5M12 5v14" /></svg>
        </Box>
      </Box>
    </Box>
    {mediaAction}
    </Box>
    {(failedUrl === image.url || failedUrl === result.plate.url) && <Alert severity="error">Could not load the comparison preview. Try isolating the subject again.</Alert>}
  </Stack>;
}
