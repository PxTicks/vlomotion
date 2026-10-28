import { useEffect, useState } from "react";
import { Box, Button, LinearProgress, Stack, Step, StepButton, Stepper, TextField, ToggleButton, ToggleButtonGroup, Typography } from "@mui/material";
import { useInpaintStore } from "./useInpaintStore";
import { RemoveMediaButton } from "../shell/RemoveMediaButton";
import { SelectedKeyCard } from "../motion/SelectedKeyCard";
import { SUBJECT_COLORS } from "../motion/useMotionStore";

export function InpaintPanel() {
  const s = useInpaintStore();
  const busy = s.status !== "idle";
  const keyCount = s.motion?.keys.length ?? 0;
  const [referenceUrl, setReferenceUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!s.reference) { setReferenceUrl(null); return; }
    const url = URL.createObjectURL(s.reference); setReferenceUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [s.reference]);
  return <Stack spacing={2.5}>
    <Stepper activeStep={s.step} alternativeLabel sx={{ mx: -2, ".MuiStepLabel-label": { fontSize: 12 } }}>
      {["Draw mask", "Animate", "Generate"].map((label, index) => <Step key={label} completed={index === 0 ? !!s.bounds : index === 1 ? s.step === 2 || keyCount > 1 : !!s.result}>
        <StepButton disabled={busy || s.recording || (index > 0 && !s.bounds)} onClick={() => s.visitStep(index as 0 | 1 | 2)}>{label}</StepButton>
      </Step>)}
    </Stepper>
    {s.step === 0 ? <>
      <Typography variant="h2">Draw a mask</Typography>
      <Typography variant="body2" color="text.secondary">Drag over the area to inpaint. Drag inside the mask to move it, or drag its box corners and edges to resize it.</Typography>
      <ToggleButtonGroup exclusive fullWidth value={s.shape} aria-label="Mask shape" onChange={(_, shape) => { if (shape) s.setShape(shape); }}>
        <ToggleButton value="rectangle">Rectangle</ToggleButton><ToggleButton value="ellipse">Ellipse</ToggleButton>
      </ToggleButtonGroup>
      <Button variant="contained" disabled={!s.bounds} onClick={() => s.visitStep(1)}>Animate mask →</Button>
    </> : s.step === 1 ? <>
      <Stack spacing={1}>
        <Typography variant="h2">Animate the mask</Typography>
        <Typography variant="body2" color="text.secondary">Leave the mask still, or drag it to create a path. Adjust by selecting and dragging ◆ on the video to fix positions, or on the timeline bar to fix timings. Drag the box corners to resize the mask, or its edges to stretch it.</Typography>
      </Stack>
      {s.notice && <Typography role="status" variant="body2" color="text.secondary">{s.notice}</Typography>}
      {s.motion && <SelectedKeyCard motion={s.motion} keyId={s.selectedKeyId} color={SUBJECT_COLORS[0]} disabled={s.recording}
        onRetime={s.retimeKey} onResetScale={s.resetScale} onDelete={s.deleteSelected}
        startNote="The first key is the mask you drew. Change it in Draw mask." />}
      <Button variant="outlined" disabled={s.recording || keyCount < 2} onClick={s.clearPath}>Clear path</Button>
      <Button variant="contained" disabled={s.recording} onClick={() => s.visitStep(2)}>Continue →</Button>
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
      {s.reference && <Box sx={{ position: "relative", width: "fit-content", maxWidth: "100%", mx: "auto" }}>
        {referenceUrl && <Box component="img" src={referenceUrl} alt="Reference" sx={{ display: "block", maxWidth: "100%", maxHeight: 160, borderRadius: 1 }} />}
        <RemoveMediaButton label="Remove reference image" disabled={busy} onRemove={() => s.setReference(null)} />
      </Box>}
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
    {s.notice && s.step !== 1 && <Typography variant="body2" color="text.secondary" role="status">{s.notice}</Typography>}
  </Stack>;
}
