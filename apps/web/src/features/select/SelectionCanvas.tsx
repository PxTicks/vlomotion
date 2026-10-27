import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Box, Button, CircularProgress, Stack, Typography } from "@mui/material";
import { styled } from "@mui/material/styles";
import type { MaskCandidate, Point } from "@h3-motion/shared";
import { useSelectionStore } from "./useSelectionStore";

const Surface = styled("canvas")({ display: "block", width: "100%", height: "100%", objectFit: "contain", touchAction: "none" });
interface MaskPixels { candidate: MaskCandidate; pixels: Uint8ClampedArray }

interface RefinementPointProps {
  point: Point;
  scale: number;
  color: string;
  label: string;
  disabled: boolean;
  onRemove: () => void;
}

function RefinementPoint({ point, scale, color, label, disabled, onRemove }: RefinementPointProps) {
  return <g role="button" aria-label={label} aria-disabled={disabled} tabIndex={disabled ? -1 : 0}
    style={{ pointerEvents: disabled ? "none" : "all", cursor: "pointer" }}
    onClick={event => { event.stopPropagation(); if (!disabled) onRemove(); }}
    onContextMenu={event => { event.preventDefault(); event.stopPropagation(); if (!disabled) onRemove(); }}
    onKeyDown={event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault(); event.stopPropagation(); if (!disabled) onRemove();
      }
    }}><circle cx={point.x} cy={point.y} r={22 * scale} fill="transparent" /><circle cx={point.x} cy={point.y} r={10 * scale} fill={color} stroke="#211927" strokeWidth={2 * scale} />
      <text x={point.x} y={point.y} textAnchor="middle" dominantBaseline="central" fill="#211927" fontSize={16 * scale} fontWeight={700}>{label.includes("exclude") ? "−" : "+"}</text>
      <title>{label}</title></g>;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not load the image. Try uploading it again."));
    image.src = url;
  });
}

export function SelectionCanvas({ mediaAction }: { mediaAction?: ReactNode }) {
  const image = useSelectionStore(s => s.image);
  const candidates = useSelectionStore(s => s.candidates);
  const selectedIds = useSelectionStore(s => s.selectedIds);
  const selectionView = useSelectionStore(s => s.selectionView);
  const toggleCandidate = useSelectionStore(s => s.toggleCandidate);
  const editing = selectionView === "edit" || selectionView === "add";
  const [displayScale, setDisplayScale] = useState(1);
  const storedActiveId = useSelectionStore(s => s.activeId);
  const activeId = selectionView === "edit" ? storedActiveId : null;
  const labels = useSelectionStore(s => s.labels);
  const hoveredId = useSelectionStore(s => s.hoveredId);
  const setHoveredId = useSelectionStore(s => s.setHoveredId);
  const [hideOverlays, setHideOverlays] = useState(false);
  const positive = useSelectionStore(s => s.positive);
  const negative = useSelectionStore(s => s.negative);
  const busy = useSelectionStore(s => s.busy);
  const upload = useSelectionStore(s => s.upload);
  const addPoint = useSelectionStore(s => s.addPoint);
  const removePoint = useSelectionStore(s => s.removePoint);
  const phase = useSelectionStore(s => s.phase);
  const aspectRatio = useSelectionStore(s => s.aspectRatio);
  const canvas = useRef<HTMLCanvasElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const masks = useRef<MaskPixels[]>([]);
  const [assets, setAssets] = useState<{ imageId: string; photo: HTMLImageElement; loaded: MaskPixels[] } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    if (!image || !canvas.current) return;
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width;
      if (width) setDisplayScale(image.width / width);
    });
    observer.observe(canvas.current);
    return () => observer.disconnect();
  }, [image]);

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
      if (disposed) return;
      masks.current = loaded;
      setAssets({ imageId: image.id, photo, loaded });
    })().catch(error => { if (!disposed) setRenderError(error instanceof Error ? error.message : "Could not draw the selection."); });
    return () => { disposed = true; };
  }, [image, candidates]);

  useEffect(() => {
      if (!image || !canvas.current || !assets || assets.imageId !== image.id) return;
      const { photo, loaded } = assets;
      const context = canvas.current.getContext("2d")!;
      context.drawImage(photo, 0, 0);
      const radius = Math.max(1, Math.ceil(displayScale * 2));
      for (const { candidate, pixels } of [...loaded].sort((a, b) => Number(a.candidate.id === activeId) - Number(b.candidate.id === activeId))) {
        if (hideOverlays) break;
        const active = candidate.id === activeId;
        const hovered = candidate.id === hoveredId;
        const selected = selectedIds.includes(candidate.id);
        const overlay = context.createImageData(image.width, image.height);
        const [red, green, blue] = active ? [242, 255, 89] : selected ? [89, 219, 255] : [255, 255, 255];
        const at = (x: number, y: number) => x >= 0 && x < image.width && y >= 0 && y < image.height && pixels[(y * image.width + x) * 4] >= 128;
        const { bounds } = candidate;
        for (let y = Math.max(0, bounds.y - radius); y < Math.min(image.height, bounds.y + bounds.height + radius); y++) {
          for (let x = Math.max(0, bounds.x - radius); x < Math.min(image.width, bounds.x + bounds.width + radius); x++) {
            const i = (y * image.width + x) * 4;
            const inside = pixels[i] >= 128;
            const edge = inside && (!at(x - radius, y) || !at(x + radius, y) || !at(x, y - radius) || !at(x, y + radius));
            const outer = !inside && (at(x - radius, y) || at(x + radius, y) || at(x, y - radius) || at(x, y + radius));
            if (!inside && !outer) continue;
            const dash = selected || active || hovered || Math.floor((x + y) / (radius * 4)) % 2 === 0;
            overlay.data[i] = outer ? 20 : red; overlay.data[i + 1] = outer ? 20 : green; overlay.data[i + 2] = outer ? 20 : blue;
            overlay.data[i + 3] = outer ? (dash ? 255 : 0) : edge ? (dash ? 255 : 0) : active || hovered ? 75 : selected ? 40 : 0;
        }
        }
        const layer = document.createElement("canvas");
        layer.width = image.width; layer.height = image.height;
        layer.getContext("2d")!.putImageData(overlay, 0, 0);
        context.drawImage(layer, 0, 0);
      }
  }, [image, assets, selectedIds, activeId, hoveredId, hideOverlays, displayScale]);

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
        role="img" aria-label={selectionView === "subjects" ? "Photo with subject masks. Click a subject to include or exclude it." : "Photo with subject masks. Click to add points; right click to exclude."}
        style={{ cursor: busy ? "wait" : selectionView === "subjects" ? "pointer" : "crosshair" }}
        onMouseMove={event => {
          const point = imagePoint(event.clientX, event.clientY); if (!point) return;
          const hit = [...masks.current].reverse().find(mask => mask.pixels[(point.y * image.width + point.x) * 4] >= 128);
          const id = hit?.candidate.id ?? null;
          if (id !== hoveredId) setHoveredId(id);
        }} onMouseLeave={() => setHoveredId(null)}
        onClick={event => {
          if (busy || phase !== 0) return;
          const point = imagePoint(event.clientX, event.clientY); if (!point) return;
          if (selectionView === "subjects") {
            const hit = [...masks.current].reverse().find(mask => mask.pixels[(point.y * image.width + point.x) * 4] >= 128);
            if (hit) toggleCandidate(hit.candidate.id);
          } else addPoint(point, false);
        }} onContextMenu={event => {
          if (selectionView === "subjects") return;
          event.preventDefault(); if (busy || phase !== 0) return;
          const point = imagePoint(event.clientX, event.clientY); if (point) addPoint(point, true);
        }} /> : <Stack sx={{ position: "absolute", inset: 0, p: 3 }} alignItems="center" justifyContent="center" spacing={2}>
        <Typography sx={{ fontSize: 48, color: "primary.main", lineHeight: 1 }}>↥</Typography>
        <Typography variant="h2">Start with a photo</Typography>
        <Typography color="text.secondary" textAlign="center">Drop an image here, or choose one from your device.</Typography>
        <Button variant="contained" disabled={busy} onClick={() => fileInput.current?.click()}>Choose a photo</Button>
        <Typography variant="caption" color="text.secondary">JPEG, PNG or WebP · up to 20 MB</Typography>
      </Stack>}
      {image && !hideOverlays && <svg viewBox={`0 0 ${image.width} ${image.height}`} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
        {candidates.map((candidate, index) => <g key={candidate.id} aria-hidden="true">
          <g transform={`translate(${Math.min(candidate.bounds.x, Math.max(0, image.width - 30 * displayScale))}, ${Math.max(0, candidate.bounds.y - 28 * displayScale)}) scale(${displayScale})`}>
            <rect width={30} height={26} rx={4} fill={candidate.id === activeId ? "#f2ff59" : "#19151f"} stroke="white" strokeWidth={2} />
            <text x={15} y={18} textAnchor="middle" fontSize={18} fill={candidate.id === activeId ? "#19151f" : "white"}>{index + 1}</text>
          </g>
          <title>{labels[candidate.id] ?? `Subject ${index + 1}`}</title>
        </g>)}
        {editing && positive.map((point, i) => <RefinementPoint key={`p${i}`} point={point} scale={displayScale} color="#f2ff59" label={`Remove include point ${i + 1}`}
          disabled={busy || phase !== 0} onRemove={() => removePoint(i, false)} />)}
        {editing && negative.map((point, i) => <RefinementPoint key={`n${i}`} point={point} scale={displayScale} color="#ff3b3b" label={`Remove exclude point ${i + 1}`}
          disabled={busy || phase !== 0} onRemove={() => removePoint(i, true)} />)}
      </svg>}
      {busy && <Box sx={{ position: "absolute", top: 16, left: 16, bgcolor: "background.paper", borderRadius: 99, py: 1, px: 2, display: "flex", gap: 1, alignItems: "center" }}>
        <CircularProgress size={16} /><Typography variant="caption">Working…</Typography>
      </Box>}
      {image && mediaAction}
    </Box>
    <input ref={fileInput} hidden type="file" accept="image/jpeg,image/png,image/webp" aria-label="Upload a photo"
      onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void upload(file); }} />
    {image && <Stack direction="row" justifyContent="space-between" alignItems="center">
      <Typography variant="caption" color="text.secondary">{image.width} × {image.height}{editing ? activeId ? ` · Editing ${labels[activeId] ?? "subject"}` : " · New subject" : ""}</Typography>
      <Button size="small" disabled={busy} onClick={() => fileInput.current?.click()}>Replace photo</Button>
    </Stack>}
    {image && candidates.length > 0 && <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
      <Typography variant="caption" color="text.secondary">{activeId ? "Yellow: editing · " : ""}Blue: included · Dashed: suggestion</Typography>
      <Button size="small" onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); setHideOverlays(true); }} onPointerUp={() => setHideOverlays(false)} onPointerCancel={() => setHideOverlays(false)} onBlur={() => setHideOverlays(false)}
        onKeyDown={event => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); setHideOverlays(true); } }} onKeyUp={() => setHideOverlays(false)}>Hold to view photo</Button>
    </Stack>}
    {renderError && <Typography role="alert" color="error">{renderError}</Typography>}
  </Stack>;
}
