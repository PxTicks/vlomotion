import { useEffect, useState } from "react";
import { Alert, Box, Button, Chip, Container, Paper, Stack, Step, StepButton, Stepper, Typography } from "@mui/material";
import { healthSchema } from "@h3-motion/shared";
import { apiRequest } from "../../api";
import { currentIsolation, SelectPanel, SelectionCanvas, useSelectionStore } from "../select";
import type { Phase } from "../select";
import { IsolatePanel, IsolatePreview } from "../isolate";
import { MotionEditor, MotionPanel, subjectKeyOf, useMotionStore } from "../motion";
import { GeneratePanel, GenerateStage, useCurrentResult, useGenerateStore } from "../generate";
import { InpaintEditor } from "../inpaint/InpaintEditor";
import { InpaintPanel } from "../inpaint/InpaintPanel";
import { useInpaintStore } from "../inpaint/useInpaintStore";
import { resetFollowSelection, useFollowSelection } from "../inpaint/useFollowSelection";
import { MediaUpload } from "./MediaUpload";
import type { Workflow } from "./MediaUpload";
import { RemoveMediaButton } from "./RemoveMediaButton";

let sessionPromise: Promise<unknown> | undefined;

export function App() {
  const [workflow, setWorkflow] = useState<Workflow>("upload");
  const [lastWorkflow, setLastWorkflow] = useState<Workflow | null>(null);
  const [ready, setReady] = useState(false);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [comfyAvailable, setComfyAvailable] = useState<boolean | null>(null);
  const generating = useGenerateStore(s => s.status !== "idle");
  const followBusy = useFollowSelection(s => s.busy);
  const inpaintBusy = useInpaintStore(s => s.status !== "idle" || s.uploading) || followBusy;
  const inpaintError = useInpaintStore(s => s.error);
  const busy = useSelectionStore(s => s.busy) || generating || inpaintBusy;
  const generated = !!useCurrentResult();
  const phase = useSelectionStore(s => s.phase);
  const mask = useSelectionStore(s => s.mask);
  const isolation = useSelectionStore(currentIsolation);
  const image = useSelectionStore(s => s.image);
  const moved = useMotionStore(s => !!image && !!mask && s.subjectKey === subjectKeyOf(image.id, mask.id)
    && (s.subjects.length ? s.subjects.some(subject => subject.motion.keys.length > 1) : (s.motion?.keys.length ?? 0) > 1));
  const visitPhase = useSelectionStore(s => s.visitPhase);
  const error = useSelectionStore(s => s.error);
  const notice = useSelectionStore(s => s.notice);
  const clearError = useSelectionStore(s => s.clearError);

  function removeUpload() {
    if (busy) return;
    if (workflow === "image") {
      useSelectionStore.setState(useSelectionStore.getInitialState(), true);
      useMotionStore.setState(useMotionStore.getInitialState(), true);
      useGenerateStore.setState(useGenerateStore.getInitialState(), true);
    } else if (workflow === "video") {
      useInpaintStore.setState(useInpaintStore.getInitialState(), true);
      resetFollowSelection();
    }
    setLastWorkflow(null);
    setWorkflow("upload");
  }

  useEffect(() => {
    let disposed = false;
    sessionPromise ??= apiRequest("/sessions", { method: "POST" }).catch(error => { sessionPromise = undefined; throw error; });
    void sessionPromise.then(() => { if (!disposed) setReady(true); }).catch(error => { if (!disposed) setStartupError(error instanceof Error ? error.message : "Could not start a session."); });
    const health = async () => {
      try {
        const data = healthSchema.parse(await apiRequest("/health"));
        if (!disposed) setComfyAvailable(data.comfy === "ok");
      } catch { if (!disposed) setComfyAvailable(false); }
    };
    void health();
    const timer = globalThis.setInterval(() => void health(), 15_000);
    return () => { disposed = true; globalThis.clearInterval(timer); };
  }, []);

  return <Container maxWidth="xl" sx={{ py: { xs: 3, md: 5 }, px: { xs: 2, md: 6 } }}>
    <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: { xs: 4, md: 6 } }}>
      <Typography sx={{ letterSpacing: ".14em", fontSize: 14, fontWeight: 600 }}>H3 <Box component="span" sx={{ color: "primary.main" }}>MOTION</Box></Typography>
      <Chip size="small" variant="outlined" label={comfyAvailable === null ? "Checking connection…" : comfyAvailable ? "● ComfyUI connected" : "○ ComfyUI offline"} sx={{ color: comfyAvailable ? "primary.main" : "text.secondary" }} />
    </Stack>
    <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={2} sx={{ mb: 4 }}>
      <Stack spacing={1.5}><Typography variant="h1">{workflow === "video" ? "Inpaint a video" : workflow === "image" ? "Move a subject" : "Start with an image or video"}</Typography>
        {workflow === "image" && <Typography color="text.secondary" sx={{ fontSize: { xs: 15, md: 18 } }}>Lift anything out of a photo and drag it into motion.</Typography>}</Stack>
      {workflow !== "upload" && <Button disabled={busy} onClick={() => { clearError(); useInpaintStore.getState().clearError(); useInpaintStore.getState().leave(); setWorkflow("upload"); }}>New upload</Button>}
      {workflow === "upload" && lastWorkflow && <Button disabled={busy} onClick={() => setWorkflow(lastWorkflow)}>Return to editor</Button>}
    </Stack>
    {startupError && <Alert severity="error" sx={{ mb: 3 }} action={<Button onClick={() => globalThis.location.reload()}>Retry</Button>}>{startupError}</Alert>}
    {error && workflow !== "video" && <Alert severity="error" onClose={clearError} sx={{ mb: 3 }}>{error}</Alert>}
    {inpaintError && workflow !== "image" && <Alert severity="error" onClose={() => useInpaintStore.getState().clearError()} sx={{ mb: 3 }}>{inpaintError}</Alert>}
    {notice && workflow === "image" && <Typography role="status" color="text.secondary" sx={{ mb: 2, fontSize: 14 }}>{notice}</Typography>}
    {!ready && !startupError && <Typography role="status" sx={{ mb: 2 }}>Starting your session…</Typography>}
    {workflow === "upload" ? <Paper sx={{ p: { xs: 2, md: 3 }, pointerEvents: ready ? "auto" : "none", opacity: ready ? 1 : .45 }} inert={!ready}>
      <MediaUpload onUploaded={next => { setWorkflow(next); setLastWorkflow(next); }} />
    </Paper> : <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "minmax(0, 1fr) 360px" }, gap: 3, alignItems: "start",
      pointerEvents: ready ? "auto" : "none", opacity: ready ? 1 : .45 }} inert={!ready}>
      <Paper sx={{ p: { xs: 1.5, md: 2.5 }, overflow: "hidden" }}>
        {workflow === "video" ? <InpaintEditor onRemove={removeUpload} /> : <>
        {phase > 0 && isolation && <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1} sx={{ mb: 2 }}>
          <Typography variant="overline" color="text.secondary">{phase === 3 ? "OUTPUT" : phase === 2 ? "MOTION PREVIEW" : "BACKGROUND PREVIEW"}</Typography>
        </Stack>}
        {phase === 3 && isolation ? <GenerateStage /> : phase === 2 && isolation ? <MotionEditor />
          : phase > 0 && isolation ? <IsolatePreview />
          : <SelectionCanvas mediaAction={<RemoveMediaButton label="Remove image" disabled={busy} onRemove={removeUpload} />} />}
        </>}
      </Paper>
      <Paper sx={{ p: 3 }}>
        {workflow === "video" ? <InpaintPanel /> : <>
        <Stepper activeStep={phase} alternativeLabel sx={{ mb: 4, mx: -2, ".MuiStepLabel-label": { fontSize: 12 } }}>
          {["Select", "Isolate", "Move", "Generate"].map((label, index) => <Step key={label} completed={index === 0 ? !!mask : index === 1 ? !!isolation : index === 2 ? moved : generated}>
            <StepButton disabled={busy || (index === 1 && !mask) || (index >= 2 && !isolation) || (index === 3 && !moved)}
              onClick={() => visitPhase(index as Phase)}>{label}</StepButton>
          </Step>)}
        </Stepper>
        {phase === 0 ? <SelectPanel /> : phase === 1 ? <IsolatePanel /> : phase === 2 ? <MotionPanel /> : <GeneratePanel />}
        </>}
      </Paper>
    </Box>}
  </Container>;
}
