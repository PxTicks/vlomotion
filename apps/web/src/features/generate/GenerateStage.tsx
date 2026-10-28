import { Alert, Box, Stack, ToggleButton, ToggleButtonGroup } from "@mui/material";
import { MotionEditor } from "../motion";
import { useGenerationInputs } from "./inputs";
import { useCurrentResult, useGenerateStore } from "./useGenerateStore";

/** Source plays the exact frames sent to H3; Result plays the generated video. */
export function GenerateStage() {
  const view = useGenerateStore(s => s.view);
  const setView = useGenerateStore(s => s.setView);
  const tier = useGenerateStore(s => s.tier);
  const lockIn = useGenerateStore(s => s.lockIn);
  const edgeFreedom = useGenerateStore(s => s.edgeFreedom);
  const prompt = useGenerateStore(s => s.prompt);
  const soundEffects = useGenerateStore(s => s.soundEffects);
  const music = useGenerateStore(s => s.music);
  const inputs = useGenerationInputs({ tier, lockIn, edgeFreedom, prompt, soundEffects, music });
  const result = useCurrentResult();
  const showing = view === "result" && result ? "result" : "source";
  const stale = !!result && !!inputs && result.signature !== inputs.signature;

  return <Stack spacing={2}>
    <ToggleButtonGroup exclusive size="small" value={showing} aria-label="Preview" sx={{ alignSelf: "center" }}
      onChange={(_, value: unknown) => { if (value === "source" || value === "result") setView(value); }}>
      <ToggleButton value="source" sx={{ px: 2, py: .5, borderRadius: 99 }}>Source</ToggleButton>
      <ToggleButton value="result" disabled={!result} sx={{ px: 2, py: .5, borderRadius: 99 }}>Result</ToggleButton>
    </ToggleButtonGroup>
    {showing === "result" && result
      ? <Box sx={{ position: "relative", width: "100%", maxWidth: result.height > result.width ? 420 : "100%", mx: "auto" }}>
          <Box component="video" key={result.video.id} src={result.video.url} controls autoPlay loop playsInline aria-label="Generated video"
            sx={{ display: "block", width: "100%", aspectRatio: `${result.width}/${result.height}`, borderRadius: 1, bgcolor: "#19151f" }} />
        </Box>
      : <MotionEditor readOnly />}
    {showing === "result" && stale && <Alert severity="info">The motion or settings have changed since this video was made. Generate again to see them.</Alert>}
  </Stack>;
}
