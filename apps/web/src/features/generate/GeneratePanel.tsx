import { Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, LinearProgress, Slider, Stack, TextField, ToggleButton, ToggleButtonGroup, Tooltip, Typography } from "@mui/material";
import { EDGE_FREEDOM, FPS, LOCK_IN, VIDEO_TIERS } from "@h3-motion/shared";
import { useSelectionStore } from "../select";
import { useGenerationInputs } from "./inputs";
import { useCurrentResult, useGenerateStore } from "./useGenerateStore";

const LOCK_IN_HELP = "How long the subject is held to your path. Higher values follow the path more tightly, but leave the model less room to blend the cut-out into the scene.";
const EDGE_FREEDOM_HELP = "How far inside its outline the subject is released from your animation. More freedom lets the model redraw the subject's edges, which helps when part of it is cut off, such as an arm reaching in from off-screen.";

export function GeneratePanel() {
  const lockIn = useGenerateStore(s => s.lockIn);
  const edgeFreedom = useGenerateStore(s => s.edgeFreedom);
  const tier = useGenerateStore(s => s.tier);
  const seed = useGenerateStore(s => s.seed);
  const prompt = useGenerateStore(s => s.prompt);
  const soundEffects = useGenerateStore(s => s.soundEffects);
  const music = useGenerateStore(s => s.music);
  const status = useGenerateStore(s => s.status);
  const progress = useGenerateStore(s => s.progress);
  const job = useGenerateStore(s => s.job);
  const error = useGenerateStore(s => s.error);
  const notice = useGenerateStore(s => s.notice);
  const { setLockIn, setEdgeFreedom, setTier, setSeed, setPrompt, setSoundEffects, setMusic, generate, cancel, clearError } = useGenerateStore.getState();
  const visitPhase = useSelectionStore(s => s.visitPhase);
  const inputs = useGenerationInputs({ tier, lockIn, edgeFreedom, prompt, soundEffects, music });
  const result = useCurrentResult();
  const busy = status !== "idle";
  const statusText = status === "rendering" ? `Rendering motion frames… ${Math.round((progress ?? 0) * 100)}%`
    : status === "uploading" ? "Uploading the motion videos…" : job?.message ?? "Waiting for ComfyUI…";

  return <Stack spacing={2.5}>
    <Stack spacing={1}>
      <Typography variant="h2">Bring it to life</Typography>
      <Typography variant="body2" color="text.secondary">MiniMax H3 animates the photo along your path, blending the moving subject into the scene and adding sound.</Typography>
    </Stack>
    <TextField multiline minRows={6} label="Main prompt" value={prompt ?? inputs?.promptFields.mainPrompt ?? ""} disabled={busy || !inputs}
      onChange={event => setPrompt(event.target.value)} slotProps={{ htmlInput: { maxLength: 3000 } }} />
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Tooltip title={LOCK_IN_HELP} placement="top-start">
          <Typography variant="overline" color="text.secondary" tabIndex={0} sx={{ cursor: "help" }}>Motion lock-in ⓘ</Typography>
        </Tooltip>
        <Typography variant="body2" sx={{ fontVariantNumeric: "tabular-nums" }}>{lockIn}</Typography>
      </Stack>
      <Slider value={lockIn} min={LOCK_IN.min} max={LOCK_IN.max} step={LOCK_IN.step} disabled={busy} aria-label="Motion lock-in"
        onChange={(_, value) => setLockIn(Array.isArray(value) ? value[0] : value)} />
      <Stack direction="row" justifyContent="space-between" sx={{ mt: -1 }}>
        <Typography variant="caption" color="text.secondary">Loose</Typography>
        <Typography variant="caption" color="text.secondary">Locked</Typography>
      </Stack>
    </Box>
    {busy ? <Stack spacing={1} aria-live="polite">
      <Typography variant="body2">{statusText}</Typography>
      <LinearProgress variant={progress == null ? "indeterminate" : "determinate"} value={(progress ?? 0) * 100} />
      <Typography variant="caption" color="text.secondary">Generation usually takes several minutes. Keep this tab open.</Typography>
      <Button onClick={() => void cancel()}>Cancel</Button>
    </Stack> : <Button variant="contained" size="large" fullWidth disabled={!inputs} onClick={() => void generate()}
      sx={{ minHeight: 56, fontFamily: "Barlow Condensed, sans-serif", fontSize: 22, letterSpacing: ".14em" }}>GENERATE</Button>}
    {error && <Alert severity="error" onClose={clearError}>{error}</Alert>}
    {notice && !busy && <Typography role="status" variant="body2" color="text.secondary">{notice}</Typography>}
    {result && <Stack spacing={1}>
      <Typography variant="overline" color="text.secondary">Output</Typography>
      <Typography variant="caption" color="text.secondary">
        {result.width} × {result.height} · {(result.frames / FPS).toFixed(1)} s · lock-in {result.lockIn} · edge freedom {result.edgeFreedom} px · seed {result.seed}
      </Typography>
      <Stack direction="row" gap={1} flexWrap="wrap">
        <Button variant="outlined" component="a" href={result.video.url} download="h3-motion.mp4">Download video</Button>
        <Button disabled={busy} onClick={() => void generate({ newSeed: true })}>Regenerate</Button>
        <Button disabled={busy} onClick={() => setSeed(String(result.seed))}>Reuse seed</Button>
      </Stack>
    </Stack>}
    <Accordion disableGutters elevation={0} sx={{ bgcolor: "transparent", border: "1px solid", borderColor: "divider", borderRadius: 1, "&::before": { display: "none" } }}>
      <AccordionSummary expandIcon={<Typography color="text.secondary">▾</Typography>}><Typography variant="overline">Advanced</Typography></AccordionSummary>
      <AccordionDetails>
        <Stack spacing={2.5}>
          <Stack spacing={1}>
            <Typography variant="caption" color="text.secondary">Resolution{inputs ? ` · ${inputs.size.width} × ${inputs.size.height}` : ""}</Typography>
            <ToggleButtonGroup exclusive size="small" value={tier} disabled={busy} aria-label="Resolution"
              onChange={(_, value: unknown) => { const next = VIDEO_TIERS.find(option => option === value); if (next) setTier(next); }}>
              {VIDEO_TIERS.map(value => <ToggleButton key={value} value={value} sx={{ px: 1.5, py: .5, borderRadius: 99 }}>{value}p</ToggleButton>)}
            </ToggleButtonGroup>
          </Stack>
          <Box>
            <Stack direction="row" justifyContent="space-between" alignItems="center">
              <Tooltip title={EDGE_FREEDOM_HELP} placement="top-start">
                <Typography variant="caption" color="text.secondary" tabIndex={0} sx={{ cursor: "help" }}>Edge freedom ⓘ</Typography>
              </Tooltip>
              <Typography variant="body2" sx={{ fontVariantNumeric: "tabular-nums" }}>{edgeFreedom} px</Typography>
            </Stack>
            <Slider value={edgeFreedom} min={EDGE_FREEDOM.min} max={EDGE_FREEDOM.max} step={EDGE_FREEDOM.step} disabled={busy} aria-label="Edge freedom"
              onChange={(_, value) => setEdgeFreedom(Array.isArray(value) ? value[0] : value)} />
          </Box>
          <TextField size="small" label="Seed" placeholder="Random" value={seed} disabled={busy} onChange={event => setSeed(event.target.value)}
            slotProps={{ htmlInput: { inputMode: "numeric" } }} helperText="Leave empty for a new random seed each time." />
          <TextField multiline minRows={3} label="Sound effects [Optional]" value={soundEffects ?? inputs?.promptFields.soundEffects ?? ""} disabled={busy || !inputs}
            onChange={event => setSoundEffects(event.target.value)} slotProps={{ htmlInput: { maxLength: 500 } }} />
          <TextField multiline minRows={3} label="Music [Optional]" value={music} disabled={busy || !inputs}
            onChange={event => setMusic(event.target.value)} slotProps={{ htmlInput: { maxLength: 250 } }} />
        </Stack>
      </AccordionDetails>
    </Accordion>
    <Button disabled={busy} onClick={() => visitPhase(2)}>Edit motion</Button>
  </Stack>;
}
