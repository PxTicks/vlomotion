import { useEffect, useRef, useState } from "react";
import { Box, Button, CircularProgress, Stack, Typography } from "@mui/material";
import { styled } from "@mui/material/styles";
import type { MaskCandidate, Point } from "@h3-motion/shared";
import { useSelectionStore } from "./useSelectionStore";

const Surface = styled("canvas")({ display: "block", width: "100%", height: "100%", objectFit: "contain", touchAction: "none" });
interface MaskPixels { candidate: MaskCandidate; pixels: Uint8ClampedArray }

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not load the image. Try uploading it again."));
    image.src = url;
  });
}

export function SelectionCanvas() {
  const image = useSelectionStore(s => s.image);
  const candidates = useSelectionStore(s => s.candidates);
  const selectedIds = useSelectionStore(s => s.selectedIds);
  const refine = useSelectionStore(s => s.refine);
  const positive = useSelectionStore(s => s.positive);
  const negative = useSelectionStore(s => s.negative);
  const busy = useSelectionStore(s => s.busy);
  const upload = useSelectionStore(s => s.upload);
  const toggle = useSelectionStore(s => s.toggleCandidate);
  const addPoint = useSelectionStore(s => s.addPoint);
  const phase = useSelectionStore(s => s.phase);
  const aspectRatio = useSelectionStore(s => s.aspectRatio);
  const canvas = useRef<HTMLCanvasElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const masks = useRef<MaskPixels[]>([]);
  const [dragging, setDragging] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    masks.current = [];
    setRenderError(null);
    if (!image) return;
    void (async () => {
      const photo = await loadImage(image.url);
      const loaded = await Promise.all(candidates.map(async candidate => {
        const bitmap = await loadImage(candidate.url);
        const offscreen = document.createElement("canvas");
        offscreen.width = image.width; offscreen.height = image.height;
        const context = offscreen.getContext("2d")!;
        context.drawImage(bitmap, 0, 0);
        return { candidate, pixels: context.getImageData(0, 0, image.width, image.height).data };
      }));
      if (disposed || !canvas.current) return;
      masks.current = loaded;
      const context = canvas.current.getContext("2d")!;
      context.drawImage(photo, 0, 0);
      for (const { candidate, pixels } of loaded) {
        const selected = selectedIds.includes(candidate.id);
        const overlay = context.createImageData(image.width, image.height);
        const [red, green, blue] = selected ? [242, 255, 89] : [126, 124, 120];
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i] < 128) continue;
          const index = i / 4, x = index % image.width, y = Math.floor(index / image.width);
          const edge = x === 0 || y === 0 || x === image.width - 1 || y === image.height - 1
            || pixels[i - 4] < 128 || pixels[i + 4] < 128
            || pixels[i - image.width * 4] < 128 || pixels[i + image.width * 4] < 128;
          overlay.data[i] = red; overlay.data[i + 1] = green; overlay.data[i + 2] = blue;
          overlay.data[i + 3] = edge ? 255 : selected ? 115 : 80;
        }
        const layer = document.createElement("canvas");
        layer.width = image.width; layer.height = image.height;
        layer.getContext("2d")!.putImageData(overlay, 0, 0);
        context.drawImage(layer, 0, 0);
      }
    })().catch(error => { if (!disposed) setRenderError(error instanceof Error ? error.message : "Could not draw the selection."); });
    return () => { disposed = true; };
  }, [image, candidates, selectedIds]);

  function imagePoint(clientX: number, clientY: number): Point | null {
    if (!canvas.current || !image) return null;
    const rect = canvas.current.getBoundingClientRect();
    return { x: Math.min(image.width - 1, Math.max(0, Math.floor((clientX - rect.left) / rect.width * image.width))),
      y: Math.min(image.height - 1, Math.max(0, Math.floor((clientY - rect.top) / rect.height * image.height))) };
  }

  return <Stack spacing={2}>
    <Box onDragOver={event => { event.preventDefault(); if (!busy) setDragging(true); }}
      onDragLeave={() => setDragging(false)} onDrop={event => {
        event.preventDefault(); setDragging(false);
        const file = event.dataTransfer.files[0]; if (file && !busy) void upload(file);
      }} sx={{ position: "relative", borderRadius: 1, overflow: "hidden", bgcolor: "#19151f",
        border: "1px solid", borderColor: dragging ? "primary.main" : "divider",
        aspectRatio: image ? `${image.width}/${image.height}` : aspectRatio.replace(":", "/"),
        maxWidth: aspectRatio === "9:16" ? 420 : "100%", mx: "auto", width: "100%" }}>
      {image ? <Surface ref={canvas} width={image.width} height={image.height}
        role="img" aria-label="Photo with subject masks. Use the candidate buttons to select, or enable Refine to add points."
        style={{ cursor: busy ? "wait" : refine ? "crosshair" : "pointer" }}
        onClick={event => {
          if (busy || phase !== 0) return;
          const point = imagePoint(event.clientX, event.clientY); if (!point) return;
          if (refine) { void addPoint(point, false); return; }
          const hit = [...masks.current].reverse().find(mask => mask.pixels[(point.y * image.width + point.x) * 4] >= 128);
          if (hit) toggle(hit.candidate.id);
        }} onContextMenu={event => {
          if (!refine) return;
          event.preventDefault(); if (busy || phase !== 0) return;
          const point = imagePoint(event.clientX, event.clientY); if (point) void addPoint(point, true);
        }} /> : <Stack sx={{ position: "absolute", inset: 0, p: 3 }} alignItems="center" justifyContent="center" spacing={2}>
        <Typography sx={{ fontSize: 48, color: "primary.main", lineHeight: 1 }}>↥</Typography>
        <Typography variant="h2">Start with a photo</Typography>
        <Typography color="text.secondary" textAlign="center">Drop an image here, or choose one from your device.</Typography>
        <Button variant="contained" disabled={busy} onClick={() => fileInput.current?.click()}>Choose a photo</Button>
        <Typography variant="caption" color="text.secondary">JPEG, PNG or WebP · up to 20 MB</Typography>
      </Stack>}
      {image && refine && <svg viewBox={`0 0 ${image.width} ${image.height}`} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
        {positive.map((point, i) => <circle key={`p${i}`} cx={point.x} cy={point.y} r={8} fill="#f2ff59" stroke="#211927" strokeWidth={3} />)}
        {negative.map((point, i) => <circle key={`n${i}`} cx={point.x} cy={point.y} r={8} fill="#ff3b3b" stroke="#211927" strokeWidth={3} />)}
      </svg>}
      {busy && <Box sx={{ position: "absolute", top: 16, left: 16, bgcolor: "background.paper", borderRadius: 99, py: 1, px: 2, display: "flex", gap: 1, alignItems: "center" }}>
        <CircularProgress size={16} /><Typography variant="caption">Working…</Typography>
      </Box>}
    </Box>
    <input ref={fileInput} hidden type="file" accept="image/jpeg,image/png,image/webp" aria-label="Upload a photo"
      onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void upload(file); }} />
    {image && <Stack direction="row" justifyContent="space-between" alignItems="center">
      <Typography variant="caption" color="text.secondary">{image.width} × {image.height} · {refine ? "Left click to include · right click to exclude" : "Click a subject to toggle it"}</Typography>
      <Button size="small" disabled={busy} onClick={() => fileInput.current?.click()}>Replace photo</Button>
    </Stack>}
    {renderError && <Typography role="alert" color="error">{renderError}</Typography>}
  </Stack>;
}
