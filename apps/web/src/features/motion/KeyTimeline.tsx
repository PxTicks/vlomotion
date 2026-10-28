import { useRef } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { Box, Button, IconButton, Stack, Typography } from "@mui/material";
import { FPS, isStartKey, lastFrame } from "@h3-motion/shared";
import type { SubjectMotion } from "@h3-motion/shared";
import { formatSeconds } from "./format";

/** The store actions a key timeline drives; the motion and inpainting stores both provide them. */
export interface TimelineActions {
  togglePlay(): void; setPlayhead(frame: number): void; addKey(): void;
  /** Moves the playhead like setPlayhead and selects the last key it passed or landed on. */
  scrub(frame: number): void;
  selectKey(id: string | null): void; retimeKey(id: string, frame: number): void;
}
type TrackDrag = { pointerId: number } & ({ kind: "scrub" } | { kind: "key"; id: string });

/** Read-only, the timeline only plays and scrubs: keys are shown but can't be moved, added or recorded. */
export function KeyTimeline({ motion, color, playhead, playing, recording, selectedKeyId, actions, startLabel, readOnly = false, children }: {
  motion: SubjectMotion<number>; color: string; playhead: number; playing: boolean; recording: boolean; selectedKeyId: string | null;
  /** Reads the store's current actions, so drags never act on a stale render. */
  actions: () => TimelineActions; readOnly?: boolean;
  /** What the fixed first key stands for, e.g. the photo. */
  startLabel: string;
  /** Controls shown opposite the time readout. */
  children?: ReactNode;
}) {
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<TrackDrag | null>(null);
  const last = lastFrame(motion);
  const percent = (frame: number) => `${frame / last * 100}%`;

  function frameAt(clientX: number) {
    const rect = track.current!.getBoundingClientRect();
    return Math.round(Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * last);
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (recording || event.button !== 0) return;
    const store = actions();
    const keyId = readOnly ? null : (event.target as HTMLElement).closest("[data-key-id]")?.getAttribute("data-key-id");
    // Stops the press selecting nearby text, which the browser would then start dragging and cancel this drag.
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    if (keyId) {
      const key = motion.keys.find(k => k.id === keyId);
      store.selectKey(keyId);
      if (key) store.setPlayhead(key.frame);
      drag.current = isStartKey(motion, keyId) ? null : { kind: "key", id: keyId, pointerId: event.pointerId };
      return;
    }
    store.setPlayhead(frameAt(event.clientX));
    drag.current = { kind: "scrub", pointerId: event.pointerId };
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const store = actions();
    if (current.kind === "key") store.retimeKey(current.id, frameAt(event.clientX));
    else if (readOnly) store.setPlayhead(frameAt(event.clientX));
    else store.scrub(frameAt(event.clientX));
  }

  const ticks = Array.from({ length: Math.floor(last / FPS) + 1 }, (_, second) => second);
  const keyAtPlayhead = motion.keys.some(key => key.frame === playhead);

  return <Stack spacing={1.5}>
    <Stack direction="row" alignItems="center" spacing={1.5}>
      <IconButton aria-label={playing ? "Pause" : "Play"} onClick={() => actions().togglePlay()} disabled={recording}
        sx={{ bgcolor: "primary.main", color: "primary.contrastText", width: 40, height: 40, fontSize: 14, "&:hover": { bgcolor: "#e2ef4c" } }}>
        {playing ? "❚❚" : "▶"}
      </IconButton>
      <Box ref={track} role="slider" tabIndex={0} aria-label="Playhead" aria-valuemin={0} aria-valuemax={last} aria-valuenow={playhead}
        aria-valuetext={formatSeconds(playhead)} onPointerDown={onPointerDown} onPointerMove={onPointerMove}
        onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
        onLostPointerCapture={() => { drag.current = null; }} onDragStart={event => event.preventDefault()}
        onKeyDown={event => {
          const step = event.shiftKey ? FPS : 1;
          const next = event.key === "ArrowLeft" ? playhead - step : event.key === "ArrowRight" ? playhead + step
            : event.key === "Home" ? 0 : event.key === "End" ? last : null;
          if (next === null) return;
          event.preventDefault(); event.stopPropagation(); actions().setPlayhead(next);
        }}
        sx={{ position: "relative", flex: 1, height: 44, mx: 1, cursor: recording ? "default" : "pointer", touchAction: "none", userSelect: "none",
          "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main", outlineOffset: 4, borderRadius: 1 } }}>
        <Box sx={{ position: "absolute", left: 0, right: 0, top: "50%", height: 4, mt: "-2px", borderRadius: 99, bgcolor: "rgba(255,255,255,.12)" }} />
        {ticks.map(second => <Box key={second} sx={{ position: "absolute", left: percent(second * FPS), bottom: 0, width: "1px", height: 6, bgcolor: "rgba(255,255,255,.2)" }} />)}
        <Box sx={{ position: "absolute", left: percent(playhead), top: 2, bottom: 2, width: 2, ml: "-1px", bgcolor: "#f0efed", borderRadius: 1, pointerEvents: "none" }} />
        {motion.keys.map(key => {
          const start = isStartKey(motion, key.id), active = key.id === selectedKeyId;
          return <Box key={key.id} data-key-id={key.id} title={`Key at ${formatSeconds(key.frame)}${start ? ` (${startLabel})` : ""}`}
            sx={{ position: "absolute", left: percent(key.frame), top: "50%", width: 14, height: 14, transform: "translate(-50%, -50%) rotate(45deg)",
              bgcolor: active ? color : "#211927", border: "2px solid", borderRadius: "2px", opacity: start ? .65 : 1,
              borderColor: active ? "#f0efed" : color, cursor: readOnly ? "inherit" : start ? "pointer" : "ew-resize" }} />;
        })}
      </Box>
      {!readOnly && <Button variant="outlined" size="small" onClick={() => actions().addKey()} disabled={recording || playhead === 0 || keyAtPlayhead} sx={{ minWidth: 0, px: 1.5 }}>◆ Key</Button>}
    </Stack>
    <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" gap={1}>
      <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: "tabular-nums" }}>
        {formatSeconds(playhead)} / {formatSeconds(last)} · frame {playhead}
      </Typography>
      {children}
    </Stack>
  </Stack>;
}
