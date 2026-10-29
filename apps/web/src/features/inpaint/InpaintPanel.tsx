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
  return <>
    <Stepper activeStep={s.step} alternativeLabel sx={{ mb: 4, mx: -2, ".MuiStepLabel-label": { fontSize: 12 } }}>
      {["Draw mask", "Animate", "Generate"].map((label, index) => <Step key={label} completed={index === 0 ? !!s.bounds : index === 1 ? s.step === 2 || keyCount > 1 : !!s.result}>
        <StepButton disabled={busy || s.recording || (index > 0 && !s.bounds)} onClick={() => s.visitStep(index as 0 | 1 | 2)}>{label}</StepButton>
      </Step>)}
    </Stepper>
    <Stack spacing={2.5}>
    {s.step === 0 ? <>
      <Stack spacing={1}>
        <Typography variant="h2">What do you want to replace?</Typography>
        <Typography variant="body2" color="text.secondary">Drag over the area to inpaint.</Typography>
      </Stack>
      <ToggleButtonGroup exclusive size="small" value={s.shape} aria-label="Mask shape" onChange={(_, shape) => { if (shape) s.setShape(shape); }}>
        {(["rectangle", "ellipse"] as const).map(shape => <ToggleButton key={shape} value={shape} sx={{ px: 1.5, py: .5, borderRadius: 99, textTransform: "capitalize" }}>{shape}</ToggleButton>)}
      </ToggleButtonGroup>
      <Button variant="contained" size="large" disabled={!s.bounds} onClick={() => s.visitStep(1)}>Continue →</Button>
    </> : s.step === 1 ? <>
      <Stack spacing={1}>
        <Typography variant="h2">Drag it into motion</Typography>
        <Typography variant="body2" color="text.secondary">Drag to create a path, or follow an object. Adjust by selecting and dragging ◆ on the video to fix positions, or on the timeline bar to fix timings. Drag the box corners to resize the mask, or its edges to stretch it.</Typography>
      </Stack>
      {s.task === "track" ? <Stack spacing={1} aria-live="polite">
        <Typography variant="body2">{s.status === "preparing" ? "Preparing the video…" : s.status === "uploading" ? "Uploading…" : s.job?.message ?? "Tracking the object…"}</Typography>
        <LinearProgress variant={s.progress === null ? "indeterminate" : "determinate"} value={(s.progress ?? 0) * 100} />
        <Button onClick={() => void s.cancel()}>Cancel</Button>
      </Stack> : s.picking ? <Button variant="outlined" onClick={s.stopPicking}>Cancel following</Button> : <Button variant="outlined" disabled={busy || s.recording || keyCount > 1} onClick={s.startPicking}>Follow an object</Button>}
      {s.notice && <Typography role="status" variant="body2" color="text.secondary">{s.notice}</Typography>}
      {s.motion && <SelectedKeyCard motion={s.motion} keyId={s.selectedKeyId} color={SUBJECT_COLORS[0]} disabled={busy || s.recording}
        onRetime={s.retimeKey} onResetScale={s.resetScale} onDelete={s.deleteSelected}
        startNote="The first key is the mask you drew. It stays at 0 s." />}
      <Button variant="outlined" disabled={busy || s.recording || keyCount < 2} onClick={s.clearPath}>Clear path</Button>
      <Button variant="contained" size="large" disabled={busy || s.recording || s.picking} onClick={() => s.visitStep(2)}>Continue →</Button>
      <Button disabled={busy || s.recording} onClick={() => s.visitStep(0)}>Edit mask</Button>
    </> : <>
      <Stack spacing={1}>
        <Typography variant="h2">Fill it in</Typography>
        <Typography variant="body2" color="text.secondary">Write a detailed prompt for what should appear in the mask.</Typography>
      </Stack>
      <Button component="label" variant="outlined" disabled={busy}>
        {s.reference ? "Replace reference image" : "Add reference image [Optional]"}
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
      <TextField label="Main prompt" multiline minRows={6} value={s.prompt} disabled={busy}
        onChange={event => s.setPrompt(event.target.value)} slotProps={{ htmlInput: { maxLength: 4000 } }}
        helperText={s.reference ? "Use <Picture 1> to refer to your image." : undefined} />
      {busy ? <Stack spacing={1} aria-live="polite">
        <Typography variant="body2">{s.status === "preparing" ? "Preparing video and mask…" : s.status === "uploading" ? "Uploading…" : s.job?.message ?? "Inpainting…"}</Typography>
        <LinearProgress variant={s.progress === null ? "indeterminate" : "determinate"} value={(s.progress ?? 0) * 100} />
        <Button onClick={() => void s.cancel()}>Cancel</Button>
      </Stack> : <Button variant="contained" size="large" fullWidth disabled={!s.prompt.trim()} onClick={() => void s.generate()}
        sx={{ minHeight: 56, fontFamily: "Barlow Condensed, sans-serif", fontSize: 22, letterSpacing: ".14em" }}>GENERATE</Button>}
      {s.notice && !busy && <Typography variant="body2" color="text.secondary" role="status">{s.notice}</Typography>}
      {s.result && <Stack spacing={1}>
        <Typography variant="overline" color="text.secondary">Output</Typography>
        <Button variant="outlined" component="a" href={s.result.video.url} download="h3-inpaint.mp4" sx={{ alignSelf: "start" }}>Download video</Button>
      </Stack>}
      <Button disabled={busy} onClick={() => s.visitStep(1)}>Edit motion</Button>
    </>}
    {s.notice && s.step === 0 && <Typography variant="body2" color="text.secondary" role="status">{s.notice}</Typography>}
    </Stack>
  </>;
}
