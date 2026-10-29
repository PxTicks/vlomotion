import { useEffect, useRef, useState } from "react";
import {
  Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, ButtonBase, IconButton, LinearProgress, ListItemText, Menu, MenuItem, Slider, Stack, Step, StepButton, Stepper,
  TextField, ToggleButton, ToggleButtonGroup, Tooltip, Typography,
} from "@mui/material";
import { MASK_FEATHER, MASK_GROW, VIDEO_TIERS } from "@h3-motion/shared";
import { MAX_MASKS, audioMode, inpaintPrompt, useInpaintStore } from "./useInpaintStore";
import { PromptModeToggle } from "../shell/PromptModeToggle";
import { RemoveMediaButton } from "../shell/RemoveMediaButton";
import { BackButton } from "../shell/BackButton";
import { SelectedKeyCard } from "../motion/SelectedKeyCard";
import { formatSeconds } from "../motion/format";
import { SelectPanel, SelectionStoreContext } from "../select";
import type { SelectPanelText } from "../select";
import { useFollowSelection } from "./useFollowSelection";

const INPAINT_STEPS = ["Draw masks", "Animate", "Generate"];
const GROW_HELP = "How far the mask is widened on every side before generating. More room lets the new content blend into its surroundings, and covers edges of what you're replacing that stick out of the mask.";
const FEATHER_HELP = "How softly the generated patch fades into the original video at the mask's edge. Higher values hide the seam, but blur the boundary further on each side of it.";
const AUDIO_OPTIONS = [
  ["preserve", "Preserve", "Keeps the original sound unchanged in the output. MiniMax H3 still hears it, so the new content can match it."],
  ["replace", "Replace", "Generates new sound from your prompt. The original sound is never sent to MiniMax H3, so it can't influence the result."],
  ["reference", "Reference", "Generates new sound, using the original sound as a reference for its ambience and style."],
] as const;

const FOLLOW_TEXT: SelectPanelText = {
  title: "What should the mask follow?", hint: "Name an object, or click one in the frame. Right-click to exclude part of it.",
  continueLabel: count => count === 1 ? "Follow this subject →" : `Follow these ${count} subjects together →`, emptyLabel: "Tick subjects to follow",
};

/** Selects the object to follow on the first frame, like the photo workflow's subjects, then tracks it. */
function FollowPanel() {
  const s = useInpaintStore();
  const selection = useFollowSelection();
  if (s.task === "frame") return <Stack spacing={1} aria-live="polite">
    <Typography variant="body2">{s.status === "uploading" ? "Uploading the first frame…" : "Reading the first frame…"}</Typography>
    <LinearProgress />
    <Button onClick={s.stopPicking}>Cancel</Button>
  </Stack>;
  return <SelectionStoreContext.Provider value={useFollowSelection}>
    <Stack spacing={2.5}>
      {selection.error && <Alert severity="error" onClose={selection.clearError}>{selection.error}</Alert>}
      <SelectPanel text={FOLLOW_TEXT} onContinue={() => void s.followObject()} />
      {selection.notice && <Typography role="status" variant="body2" color="text.secondary">{selection.notice}</Typography>}
      <Button disabled={selection.busy} onClick={s.stopPicking}>Back to the mask</Button>
    </Stack>
  </SelectionStoreContext.Provider>;
}

/** The masks in the order they were drawn, to select one to edit or animate, or remove it. */
function MaskList({ disabled }: { disabled: boolean }) {
  const s = useInpaintStore();
  return <Stack spacing={1}>
    <Stack direction="row" justifyContent="space-between" alignItems="baseline">
      <Typography variant="overline">Masks</Typography>
      <Typography variant="caption" color="text.secondary">{s.masks.length} of {MAX_MASKS}</Typography>
    </Stack>
    {s.masks.map((mask, index) => {
      const active = mask.id === s.activeMaskId, name = `Mask ${index + 1}`;
      return <Stack key={mask.id} direction="row" alignItems="center" spacing={.5}
        sx={{ p: .5, border: "1px solid", borderColor: active ? mask.color : "divider", borderRadius: 1 }}>
        <ButtonBase disabled={disabled} aria-label={`Select ${name}`} aria-pressed={active} onClick={() => s.selectMask(mask.id)}
          sx={{ flex: 1, minWidth: 0, gap: 1, justifyContent: "flex-start", p: .5, borderRadius: .5 }}>
          <Typography sx={{ color: mask.color }} aria-hidden="true">{mask.shape === "ellipse" ? "●" : "■"}</Typography>
          <Typography variant="body2" noWrap>{name}</Typography>
          <Typography variant="caption" color="text.secondary" noWrap>
            {mask.track ? "Follows an object" : mask.motion.keys.length > 1 ? "Moves" : "Still"}
          </Typography>
        </ButtonBase>
        <IconButton size="small" aria-label={`Remove ${name}`} disabled={disabled} onClick={() => s.removeMask(mask.id)}>×</IconButton>
      </Stack>;
    })}
  </Stack>;
}

export function InpaintPanel() {
  const s = useInpaintStore();
  const followBusy = useFollowSelection(state => state.busy);
  const busy = s.status !== "idle" || followBusy;
  const keyCount = s.motion?.keys.length ?? 0;
  const several = s.masks.length > 1, color = s.masks.find(mask => mask.id === s.activeMaskId)?.color;
  const audio = audioMode(s.video, s.audio), raw = s.promptMode === "raw";
  const [referenceUrl, setReferenceUrl] = useState<string | null>(null);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const upload = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!s.reference) { setReferenceUrl(null); return; }
    const url = URL.createObjectURL(s.reference); setReferenceUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [s.reference]);
  const referenceProgress = <Stack spacing={1} aria-live="polite">
    <Typography variant="body2">{s.status === "preparing" ? (s.creating === "frame" ? "Reading the frame…" : "Preparing…") : s.status === "uploading" ? "Uploading…" : s.job?.message ?? "Creating the reference…"}</Typography>
    <LinearProgress variant={s.progress === null ? "indeterminate" : "determinate"} value={(s.progress ?? 0) * 100} />
    <Button onClick={() => void s.cancel()}>Cancel</Button>
  </Stack>;
  return <>
    <Stepper activeStep={s.step} alternativeLabel sx={{ mb: 2, mx: -2, ".MuiStepLabel-label": { fontSize: 12 } }}>
      {INPAINT_STEPS.map((label, index) => <Step key={label}
        completed={index === 0 ? !!s.masks.length : index === 1 ? s.step === 2 || s.masks.some(mask => mask.motion.keys.length > 1) : !!s.result}>
        <StepButton disabled={busy || s.recording || (index > 0 && !s.masks.length)} onClick={() => s.visitStep(index as 0 | 1 | 2)}>{label}</StepButton>
      </Step>)}
    </Stepper>
    <BackButton to={s.step > 0 ? INPAINT_STEPS[s.step - 1] : null} disabled={busy || s.recording || s.picking}
      onBack={() => s.visitStep(s.step - 1 as 0 | 1 | 2)} />
    <Stack spacing={2.5}>
    {s.step === 0 ? <>
      <Stack spacing={1}>
        <Typography variant="h2">What do you want to replace?</Typography>
        <Typography variant="body2" color="text.secondary">Drag over each area to inpaint: drag on the video again to add another mask. Click a mask to select it, then drag it to move it or its box handles to resize it, or press Delete to remove it.</Typography>
      </Stack>
      <ToggleButtonGroup exclusive size="small" value={s.shape} aria-label={s.activeMaskId ? "Selected mask's shape" : "Mask shape"} onChange={(_, shape) => { if (shape) s.setShape(shape); }}>
        {(["rectangle", "ellipse"] as const).map(shape => <ToggleButton key={shape} value={shape} sx={{ px: 1.5, py: .5, borderRadius: 99, textTransform: "capitalize" }}>{shape}</ToggleButton>)}
      </ToggleButtonGroup>
      {s.masks.length > 0 && <MaskList disabled={busy} />}
      <Button variant="contained" size="large" disabled={!s.masks.length} onClick={() => s.visitStep(1)}>Continue →</Button>
    </> : s.step === 1 && s.picking ? <FollowPanel /> : s.step === 1 ? <>
      <Stack spacing={1}>
        <Typography variant="h2">{several ? "Drag them into motion" : "Drag it into motion"}</Typography>
        <Typography variant="body2" color="text.secondary">{several ? "Select a mask on the video or in the list to animate it. " : ""}Drag to create a path, or follow an object. Adjust by selecting and dragging ◆ on the video to fix positions, or on the timeline bar to fix timings.</Typography>
      </Stack>
      {s.task === "track" ? <Stack spacing={1} aria-live="polite">
        <Typography variant="body2">{s.status === "preparing" ? "Preparing the video…" : s.status === "uploading" ? "Uploading…" : s.job?.message ?? "Tracking the object…"}</Typography>
        <LinearProgress variant={s.progress === null ? "indeterminate" : "determinate"} value={(s.progress ?? 0) * 100} />
        <Button onClick={() => void s.cancel()}>Cancel</Button>
      </Stack> : <Button variant="outlined" disabled={busy || s.recording || keyCount > 1} onClick={() => void s.startPicking()}>Follow an object</Button>}
      {several && <MaskList disabled={busy || s.recording} />}
      {s.notice && <Typography role="status" variant="body2" color="text.secondary">{s.notice}</Typography>}
      {s.motion && color && <SelectedKeyCard motion={s.motion} keyId={s.selectedKeyId} color={color} disabled={busy || s.recording}
        onRetime={s.retimeKey} onResetScale={s.resetScale} onDelete={s.deleteSelected}
        startNote="The first key is the mask you drew. It stays at 0 s." />}
      <Button variant="outlined" disabled={busy || s.recording || keyCount < 2} onClick={s.clearPath}>Clear path</Button>
      <Button variant="contained" size="large" disabled={busy || s.recording} onClick={() => s.visitStep(2)}>Continue →</Button>
    </> : <>
      <Stack spacing={1}>
        <Typography variant="h2">Fill it in</Typography>
        <Typography variant="body2" color="text.secondary">Write a detailed prompt for what should appear in the {several ? "masks" : "mask"}.</Typography>
      </Stack>
      {s.reference ? <Stack spacing={1.5}>
        <Box sx={{ position: "relative", width: "fit-content", maxWidth: "100%", mx: "auto" }}>
          {referenceUrl && <Box component="img" src={referenceUrl} alt="Reference" sx={{ display: "block", maxWidth: "100%", maxHeight: 160, borderRadius: 1 }} />}
          <RemoveMediaButton label="Remove reference image" disabled={busy} onRemove={() => s.setReference(null)} />
        </Box>
        <Typography variant="caption" color="text.secondary" align="center">
          {s.referenceRole?.kind === "frame" ? `Edited frame at ${formatSeconds(s.referenceRole.frame)}` : "Object to add"}
        </Typography>
        {s.task === "reference" ? referenceProgress
          : s.created && <Button size="small" disabled={busy} onClick={() => void s.recreateReference()} sx={{ alignSelf: "center" }}>Try again</Button>}
        {/* The raw prompt holds the definition. */}
        {!raw && <TextField label="Reference definition" multiline minRows={2} value={s.definition} disabled={busy}
          onChange={event => s.setDefinition(event.target.value)} slotProps={{ htmlInput: { maxLength: 1000 } }}
          helperText={s.referenceRole?.kind === "frame" ? "Describe the edited frame. The shot is anchored to it."
            : "Describe what <Picture 1> shows. Use <Subject 1> in the prompt."} />}
      </Stack> : s.creating ? <Stack spacing={1.5}>
        <Typography variant="overline" color="text.secondary">{s.creating === "object" ? "Create an object" : "Create a frame"}</Typography>
        {s.creating === "frame" && <Typography variant="body2" color="text.secondary">
          Edits the frame at {formatSeconds(s.playhead)} inside the {several ? "masks" : "mask"}. Move the playhead on the timeline to pick another frame.
        </Typography>}
        <TextField label={s.creating === "object" ? "Describe the object" : "What should the mask show?"} multiline minRows={2} value={s.referenceText}
          placeholder={s.creating === "object" ? "A red paper lantern with gold tassels" : "A red umbrella, open and tilted to the left"}
          disabled={busy} onChange={event => s.setReferenceText(event.target.value)} slotProps={{ htmlInput: { maxLength: 500 } }} />
        {s.task === "reference" ? referenceProgress : <Stack direction="row" spacing={1} sx={{ justifyContent: "flex-end" }}>
          <Button disabled={busy} onClick={() => s.openCreator(null)}>Cancel</Button>
          <Button variant="contained" disabled={busy || !s.referenceText.trim()} onClick={() => void s.createReference()}>Create</Button>
        </Stack>}
      </Stack> : <Button variant="outlined" disabled={busy} onClick={event => setMenu(event.currentTarget)}>Add reference image [Optional]</Button>}
      <Menu anchorEl={menu} open={!!menu} onClose={() => setMenu(null)}>
        {([["upload", "Upload an image", "Use your own picture of what to add."],
          ["object", "Create an object", "Describe it, and Qwen Image draws it."],
          ["frame", "Create a frame", `Edit the frame at the playhead inside the ${several ? "masks" : "mask"}.`]] as const).map(([kind, label, detail]) =>
          <MenuItem key={kind} onClick={() => { setMenu(null); if (kind === "upload") upload.current?.click(); else s.openCreator(kind); }}>
            <ListItemText primary={label} secondary={detail} />
          </MenuItem>)}
      </Menu>
      <input ref={upload} hidden type="file" accept="image/jpeg,image/png,image/webp" onChange={event => {
        const file = event.target.files?.[0]; event.target.value = "";
        if (file && file.size > 20 * 1024 * 1024) { useInpaintStore.setState({ error: "Choose a reference image under 20 MB." }); return; }
        if (file) s.setReference(file);
      }} />
      {raw ? <TextField label="Raw prompt" multiline minRows={12} value={s.rawPrompt} disabled={busy}
        onChange={event => s.setRawPrompt(event.target.value)} slotProps={{ htmlInput: { maxLength: 8000 } }}
        helperText="Sent as written, so changing the reference or original sound doesn't change it." />
      : <TextField label="Main prompt" multiline minRows={6} value={s.prompt} disabled={busy}
        onChange={event => s.setPrompt(event.target.value)} slotProps={{ htmlInput: { maxLength: 4000 } }}
        helperText={s.referenceRole?.kind === "object" ? "Use <Subject 1> for your reference." : s.referenceRole ? "Describe the whole shot." : undefined} />}
      {/* A preserved sound is the whole soundtrack, so there is no new sound to describe. */}
      {!raw && audio !== "preserve" && <>
        <TextField label="Sound effects [Optional]" multiline minRows={3} value={s.soundEffects} disabled={busy}
          onChange={event => s.setSoundEffects(event.target.value)} slotProps={{ htmlInput: { maxLength: 500 } }} />
        <TextField label="Music [Optional]" multiline minRows={3} value={s.music} disabled={busy}
          onChange={event => s.setMusic(event.target.value)} slotProps={{ htmlInput: { maxLength: 250 } }} />
      </>}
      <Stack spacing={1}>
        <Typography variant="caption" color="text.secondary">Resolution</Typography>
        <ToggleButtonGroup exclusive size="small" value={s.tier} disabled={busy} aria-label="Resolution"
          onChange={(_, value: unknown) => { const next = VIDEO_TIERS.find(option => option === value); if (next) s.setTier(next); }}>
          {VIDEO_TIERS.map(value => <ToggleButton key={value} value={value} sx={{ px: 1.5, py: .5, borderRadius: 99 }}>{value}p</ToggleButton>)}
        </ToggleButtonGroup>
      </Stack>
      {busy && s.task !== "reference" ? <Stack spacing={1} aria-live="polite">
        <Typography variant="body2">{s.status === "preparing" ? "Preparing video and mask…" : s.status === "uploading" ? "Uploading…" : s.job?.message ?? "Inpainting…"}</Typography>
        <LinearProgress variant={s.progress === null ? "indeterminate" : "determinate"} value={(s.progress ?? 0) * 100} />
        <Button onClick={() => void s.cancel()}>Cancel</Button>
      </Stack> : <Button variant="contained" size="large" fullWidth disabled={busy || !inpaintPrompt(s)} onClick={() => void s.generate()}
        sx={{ minHeight: 56, fontFamily: "Barlow Condensed, sans-serif", fontSize: 22, letterSpacing: ".14em" }}>GENERATE</Button>}
      {s.notice && !busy && <Typography variant="body2" color="text.secondary" role="status">{s.notice}</Typography>}
      {s.result && <Stack spacing={1}>
        <Typography variant="overline" color="text.secondary">Output</Typography>
        <Button variant="outlined" component="a" href={s.result.video.url} download="h3-inpaint.mp4" sx={{ alignSelf: "start" }}>Download video</Button>
      </Stack>}
      <Accordion disableGutters elevation={0} sx={{ bgcolor: "transparent", border: "1px solid", borderColor: "divider", borderRadius: 1, "&::before": { display: "none" } }}>
        <AccordionSummary expandIcon={<Typography color="text.secondary">▾</Typography>}><Typography variant="overline">Advanced</Typography></AccordionSummary>
        <AccordionDetails>
          <Stack spacing={2.5}>
            <PromptModeToggle mode={s.promptMode} unformattable={s.unformattable} disabled={busy}
              onChange={s.setPromptMode} onReset={s.resetPrompt} onKeep={s.keepRawPrompt} />
            <Stack spacing={1}>
              <Typography variant="caption" color="text.secondary">Original sound</Typography>
              <ToggleButtonGroup exclusive size="small" value={audio} disabled={busy || !s.video?.audio} aria-label="Original sound"
                onChange={(_, value: unknown) => { const next = AUDIO_OPTIONS.find(([option]) => option === value); if (next) s.setAudio(next[0]); }}>
                {AUDIO_OPTIONS.map(([value, label]) => <ToggleButton key={value} value={value} sx={{ px: 1.5, py: .5, borderRadius: 99 }}>{label}</ToggleButton>)}
              </ToggleButtonGroup>
              <Typography variant="body2" color="text.secondary">
                {s.video?.audio ? AUDIO_OPTIONS.find(([value]) => value === audio)![2] : "This video has no sound, so MiniMax H3 generates new sound from your prompt."}
              </Typography>
            </Stack>
            {([["Mask grow", GROW_HELP, s.grow, MASK_GROW, s.setGrow], ["Mask feather", FEATHER_HELP, s.feather, MASK_FEATHER, s.setFeather]] as const)
              .map(([label, help, value, range, setValue]) => <Box key={label}>
                <Stack direction="row" justifyContent="space-between" alignItems="center">
                  <Tooltip title={help} placement="top-start">
                    <Typography variant="caption" color="text.secondary" tabIndex={0} sx={{ cursor: "help" }}>{label} ⓘ</Typography>
                  </Tooltip>
                  <Typography variant="body2" sx={{ fontVariantNumeric: "tabular-nums" }}>{value} px</Typography>
                </Stack>
                <Slider value={value} min={range.min} max={range.max} step={range.step} disabled={busy} aria-label={label}
                  onChange={(_, next) => setValue(Array.isArray(next) ? next[0] : next)} />
              </Box>)}
          </Stack>
        </AccordionDetails>
      </Accordion>
    </>}
    {s.notice && s.step === 0 && <Typography variant="body2" color="text.secondary" role="status">{s.notice}</Typography>}
    </Stack>
  </>;
}
