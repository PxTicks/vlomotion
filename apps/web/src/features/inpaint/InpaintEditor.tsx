import { useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";
import { Box, Button, Chip, Slider, Stack, ToggleButton, ToggleButtonGroup, Typography } from "@mui/material";
import { FPS, clampMask, inpaintSize, maskAt } from "@h3-motion/shared";
import type { MaskBox } from "@h3-motion/shared";
import { useInpaintStore } from "./useInpaintStore";

export function InpaintEditor() {
  const s = useInpaintStore();
  const video = useRef<HTMLVideoElement>(null);
  const drag = useRef<{ start: { x: number; y: number }; box: MaskBox | null; mode: "draw" | "move" | "resize" } | null>(null);
  const [draft, setDraft] = useState<MaskBox | null>(null);
  const busy = s.status !== "idle";
  const box = draft ?? maskAt(s.keys, s.playhead);
  const showResult = s.view === "result" && !!s.result;

  useEffect(() => {
    if (video.current && s.video && !s.playing) video.current.currentTime = s.video.startTime + s.playhead / FPS;
  }, [s.playhead, s.playing, s.video?.id, s.video?.startTime, showResult]);
  useEffect(() => {
    const element = video.current;
    if (!element || !s.playing || showResult) return;
    let handle = 0, disposed = false;
    const tick = () => {
      if (disposed) return;
      const state = useInpaintStore.getState();
      const frame = Math.max(0, Math.floor((element.currentTime - (state.video?.startTime ?? 0)) * FPS));
      state.setPlayhead(frame);
      if (frame >= state.frames - 1 || element.ended) { element.pause(); state.setPlaying(false); }
      else handle = requestAnimationFrame(tick);
    };
    void element.play().then(() => { if (!disposed) handle = requestAnimationFrame(tick); })
      .catch(() => { if (!disposed) useInpaintStore.getState().setPlaying(false); });
    return () => { disposed = true; cancelAnimationFrame(handle); element.pause(); };
  }, [s.playing, s.video?.id, showResult]);

  if (!s.video) return null;
  const size = inpaintSize(s.video.width, s.video.height);
  const point = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
  };
  const move = (event: PointerEvent<SVGSVGElement>) => {
    const active = drag.current;
    if (!active) return null;
    const p = point(event), dx = p.x - active.start.x, dy = p.y - active.start.y;
    const next = active.mode === "move" && active.box ? { ...active.box, x: active.box.x + dx, y: active.box.y + dy }
      : active.mode === "resize" && active.box ? { ...active.box, width: Math.max(0.01, Math.min(1 - active.box.x, active.box.width + dx)), height: Math.max(0.01, Math.min(1 - active.box.y, active.box.height + dy)) }
      : { x: Math.min(p.x, active.start.x), y: Math.min(p.y, active.start.y), width: Math.abs(dx), height: Math.abs(dy) };
    setDraft(clampMask(next));
    return { box: clampMask(next), changed: Math.abs(dx) + Math.abs(dy) > 0.008 };
  };

  return <Stack spacing={2}>
    <Stack direction="row" justifyContent="space-between" alignItems="center">
      <Typography variant="overline" color="text.secondary">{showResult ? "OUTPUT" : "MASK PREVIEW"}</Typography>
      {s.result && <ToggleButtonGroup exclusive size="small" value={s.view} aria-label="Video view" onChange={(_, value) => { if (value) { s.setPlaying(false); s.setView(value); } }}>
        <ToggleButton value="preview">Preview</ToggleButton><ToggleButton value="result">Result</ToggleButton>
      </ToggleButtonGroup>}
    </Stack>
    {showResult ? <Box component="video" key={s.result!.video.id} src={s.result!.video.url} controls autoPlay sx={{ width: "100%", maxHeight: 680, bgcolor: "#19151f", borderRadius: 1 }} />
      : <Box sx={{ position: "relative", width: "100%", maxWidth: 680 * s.video.width / s.video.height, mx: "auto", aspectRatio: `${s.video.width}/${s.video.height}`, bgcolor: "#19151f", borderRadius: 1, overflow: "hidden" }}>
        <video ref={video} key={s.video.id} src={s.video.url} muted playsInline preload="auto"
          onLoadedMetadata={() => {
            const state = useInpaintStore.getState();
            if (video.current && state.video) video.current.currentTime = state.video.startTime + state.playhead / FPS;
          }}
          onError={() => { useInpaintStore.setState({ error: "This browser can't preview this video. Try an H.264 MP4.", playing: false }); }}
          style={{ display: "block", width: "100%", height: "100%" }} />
        <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" role="img" aria-label="Video mask editor"
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", touchAction: "none", cursor: s.step === 0 ? "crosshair" : s.step === 1 ? "move" : "default" }}
          onPointerDown={event => {
            if (busy || s.step === 2 || event.button !== 0) return;
            event.preventDefault(); s.setPlaying(false);
            const p = point(event);
            const inside = box && p.x >= box.x && p.x <= box.x + box.width && p.y >= box.y && p.y <= box.y + box.height;
            const resizing = event.target instanceof Element && event.target.hasAttribute("data-resize");
            drag.current = { start: p, box, mode: s.step === 1 && resizing ? "resize" : s.step === 1 && inside ? "move" : "draw" };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={event => { if (drag.current) move(event); }}
          onPointerUp={event => {
            if (!drag.current) return;
            const next = move(event);
            if (next?.changed) s.setMask(next.box);
            drag.current = null; setDraft(null);
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => { drag.current = null; setDraft(null); }}>
          {box && <g fill="#f2ff5944" stroke="#f2ff59" strokeWidth={2}>
            {s.shape === "ellipse" ? <ellipse cx={(box.x + box.width / 2) * 1000} cy={(box.y + box.height / 2) * 1000} rx={box.width * 500} ry={box.height * 500} vectorEffect="non-scaling-stroke" />
              : <rect x={box.x * 1000} y={box.y * 1000} width={box.width * 1000} height={box.height * 1000} vectorEffect="non-scaling-stroke" />}
            {s.step === 1 && !busy && <rect data-resize="true" x={(box.x + box.width) * 1000 - 12} y={(box.y + box.height) * 1000 - 12} width={24} height={24} fill="#f2ff59" stroke="none" style={{ cursor: "nwse-resize" }} />}
          </g>}
        </svg>
      </Box>}
    {!showResult && s.step > 0 && <Stack spacing={1}>
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Button size="small" disabled={busy} onClick={() => {
          if (!s.playing && s.playhead === s.frames - 1) s.setPlayhead(0);
          s.setPlaying(!s.playing);
        }}>{s.playing ? "Pause" : "Play"}</Button>
        <Typography variant="caption" sx={{ fontVariantNumeric: "tabular-nums" }}>{(s.playhead / FPS).toFixed(2)} s / {((s.frames - 1) / FPS).toFixed(2)} s</Typography>
      </Stack>
      <Slider min={0} max={s.frames - 1} step={1} value={s.playhead} disabled={busy} aria-label="Video playhead"
        marks={s.keys.map(key => ({ value: key.frame }))} onChange={(_, value) => { s.setPlaying(false); s.setPlayhead(Number(value)); }} />
      <Stack direction="row" gap={1} flexWrap="wrap">
        {s.keys.map(key => <Chip key={key.frame} size="small" label={`${(key.frame / FPS).toFixed(2)} s`} variant={s.playhead === key.frame ? "filled" : "outlined"} color={s.playhead === key.frame ? "primary" : "default"}
          disabled={busy} onClick={() => { s.setPlaying(false); s.setPlayhead(key.frame); }}
          onDelete={s.step === 1 && key.frame !== 0 ? () => s.deleteKey(key.frame) : undefined} />)}
      </Stack>
    </Stack>}
    <Typography variant="caption" color="text.secondary">{size.width} × {size.height} · {(s.frames / FPS).toFixed(1)} s{s.video.duration > s.frames / FPS + 0.1 ? " · using the start of your video" : ""}</Typography>
  </Stack>;
}
