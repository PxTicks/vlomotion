import { useEffect, useState } from "react";
import { Box, Button, LinearProgress, Stack, Step, StepButton, Stepper, TextField, ToggleButton, ToggleButtonGroup, Typography } from "@mui/material";
import { FPS } from "@h3-motion/shared";
import { useInpaintStore } from "./useInpaintStore";

export function InpaintPanel() {
  const s = useInpaintStore();
  const busy = s.status !== "idle";
  const [referenceUrl, setReferenceUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!s.reference) { setReferenceUrl(null); return; }
    const url = URL.createObjectURL(s.reference); setReferenceUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [s.reference]);
  return <Stack spacing={2.5}>
    <Stepper activeStep={s.step} alternativeLabel sx={{ mx: -2, ".MuiStepLabel-label": { fontSize: 12 } }}>
      {["Draw mask", "Animate", "Generate"].map((label, index) => <Step key={label} completed={index === 0 ? !!s.keys.length : index === 1 ? s.step === 2 || s.keys.length > 1 : !!s.result}>
        <StepButton disabled={busy || (index > 0 && !s.keys.length)} onClick={() => s.visitStep(index as 0 | 1 | 2)}>{label}</StepButton>
      </Step>)}
    </Stepper>
    {s.step === 0 ? <>
      <Typography variant="h2">Draw a mask</Typography>
      <Typography variant="body2" color="text.secondary">Drag over the area to inpaint.</Typography>
      <ToggleButtonGroup exclusive fullWidth value={s.shape} aria-label="Mask shape" onChange={(_, shape) => { if (shape) s.setShape(shape); }}>
        <ToggleButton value="rectangle">Rectangle</ToggleButton><ToggleButton value="ellipse">Ellipse</ToggleButton>
      </ToggleButtonGroup>
      <Button variant="contained" disabled={!s.keys.length} onClick={() => s.visitStep(1)}>Animate mask →</Button>
    </> : s.step === 1 ? <>
      <Typography variant="h2">Animate the mask</Typography>
      <Typography variant="body2" color="text.secondary">Keep one keyframe for a stationary mask, or scrub to a time and move or resize the mask to animate it.</Typography>
      <Stack direction="row" spacing={1}>
        <Button variant="outlined" disabled={s.keys.some(key => key.frame === s.playhead)} onClick={s.addKey}>Add keyframe</Button>
        <Button onClick={() => { s.setPlaying(false); s.setPlayhead(s.frames - 1); }}>Go to end</Button>
      </Stack>
      <Typography variant="caption" color="text.secondary">{s.keys.length} keyframe{s.keys.length === 1 ? "" : "s"} · {(s.playhead / FPS).toFixed(2)} s</Typography>
      <Button variant="contained" disabled={!s.keys.length} onClick={() => s.visitStep(2)}>Continue →</Button>
    </> : <>
      <Typography variant="h2">Inpaint the video</Typography>
      <Button component="label" variant="outlined" disabled={busy}>
        {s.reference ? "Replace reference image" : "Add reference image (optional)"}
        <input hidden type="file" accept="image/jpeg,image/png,image/webp" onChange={event => {
          const file = event.target.files?.[0]; event.target.value = "";
          if (file && file.size > 20 * 1024 * 1024) { useInpaintStore.setState({ error: "Choose a reference image under 20 MB." }); return; }
          if (file) s.setReference(file);
        }} />
      </Button>
      {s.reference && <Stack spacing={0.5}>
        {referenceUrl && <Box component="img" src={referenceUrl} alt="Reference" sx={{ width: "100%", maxHeight: 160, objectFit: "contain", borderRadius: 1 }} />}
        <Button size="small" disabled={busy} onClick={() => s.setReference(null)}>Remove reference</Button>
      </Stack>}
      <TextField label="Prompt" placeholder="Describe what should appear in the mask" multiline minRows={5} value={s.prompt} disabled={busy}
        onChange={event => s.setPrompt(event.target.value)} slotProps={{ htmlInput: { maxLength: 4000 } }}
        helperText={s.reference ? "Use <Picture 1> to refer to your image." : undefined} />
      {busy ? <Stack spacing={1} aria-live="polite">
        <Typography variant="body2">{s.status === "preparing" ? "Preparing video and mask…" : s.status === "uploading" ? "Uploading…" : s.job?.message ?? "Inpainting…"}</Typography>
        <LinearProgress variant={s.progress === null ? "indeterminate" : "determinate"} value={(s.progress ?? 0) * 100} />
        <Button onClick={() => void s.cancel()}>Cancel</Button>
      </Stack> : <Button variant="contained" size="large" disabled={!s.prompt.trim()} onClick={() => void s.generate()}>{s.result ? "Generate again" : "Generate"}</Button>}
      {s.result && <Button component="a" href={s.result.video.url} download="h3-inpaint.mp4" variant="outlined">Download video</Button>}
      <Button disabled={busy} onClick={() => s.visitStep(1)}>Edit mask animation</Button>
    </>}
    {s.notice && <Typography variant="body2" color="text.secondary" role="status">{s.notice}</Typography>}
  </Stack>;
}
