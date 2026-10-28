import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { Alert, Box, CircularProgress, Typography } from "@mui/material";
import { styled } from "@mui/material/styles";
import { buildMotionCurve, isStartKey } from "@h3-motion/shared";
import type { Point, TimedSample } from "@h3-motion/shared";
import { useSelectionStore } from "../select";
import { drawGhost, drawSceneReference, subjectKeyOf } from "./subjectLayers";
import { motionTargetAt } from "./motionHitTest";
import { useSubjectLayers } from "./useSubjectLayers";
import { formatSeconds, signed } from "./format";
import { SUBJECT_COLORS, useMotionStore } from "./useMotionStore";

const Surface = styled("canvas")({ display: "block", width: "100%", height: "100%" });
type Drag = { pointerId: number; origin: Point; start: Point } & (
  | { kind: "subject" } | { kind: "key"; id: string } | { kind: "record"; startTime: number });
type Hover = "key" | "subject" | "record" | "path" | null;

/** Composites all subjects; read-only previews match the frames sent to generation. */
export function MotionCanvas({ readOnly = false, mediaAction }: { readOnly?: boolean; mediaAction?: ReactNode }) {
  const image = useSelectionStore(s => s.image);
  const mask = useSelectionStore(s => s.mask);
  const motion = useMotionStore(s => s.motion);
  const subjects = useMotionStore(s => s.subjects);
  const activeSubjectId = useMotionStore(s => s.activeSubjectId);
  const subjectKey = useMotionStore(s => s.subjectKey);
  const playhead = useMotionStore(s => s.playhead);
  const playing = useMotionStore(s => s.playing);
  const recording = useMotionStore(s => s.recording);
  const scrubbed = useMotionStore(s => s.scrubbed);
  const selectedKeyId = useMotionStore(s => s.selectedKeyId);
  const canvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  const samples = useRef<TimedSample[]>([]);
  const { layers, error } = useSubjectLayers();
  const [scale, setScale] = useState(1);
  const [live, setLive] = useState<Point | null>(null);
  const [hover, setHover] = useState<Hover>(null);
  const tracks = useMemo(() => (subjects.length ? subjects : motion && layers
    ? [{ id: mask?.id ?? "subject", name: "Subject", color: SUBJECT_COLORS[0], motion, layers }] : [])
    .map(subject => ({ ...subject, curve: buildMotionCurve(subject.motion) })), [subjects, motion, layers, mask?.id]);
  const active = tracks.find(subject => subject.id === activeSubjectId) ?? tracks[0];
  const ready = !!layers && tracks.length > 0 && !!image && !!mask && subjectKey === subjectKeyOf(image.id, mask.id);
  const paths = useMemo(() => tracks.map(subject => ({ ...subject,
    path: subject.curve.length > 0 ? subject.curve.samples.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join("") : "" })), [tracks]);

  useEffect(() => {
    const element = overlay.current;
    if (!element || !layers) return;
    const observer = new ResizeObserver(([entry]) => setScale(layers.width / Math.max(1, entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, [layers]);

  useEffect(() => {
    const context = canvas.current?.getContext("2d");
    if (!context || !layers || !active || !ready) return;
    drawSceneReference(context, layers, tracks.map(subject => ({ layers: subject.layers,
      offset: live && subject.id === active.id ? { x: live.x - subject.motion.anchor.x, y: live.y - subject.motion.anchor.y } : subject.curve.offsetAt(playhead) })),
    playhead === 0 && !live);
    if (playing || recording || readOnly) return;
    const current = active.curve.positionAt(playhead);
    for (const key of active.motion.keys) {
      if (key.x !== current.x || key.y !== current.y) drawGhost(context, active.layers, { x: key.x - active.motion.anchor.x, y: key.y - active.motion.anchor.y }, .22);
    }
  }, [layers, tracks, active, ready, playhead, playing, recording, live, readOnly]);

  function finishTake() {
    const taken = samples.current;
    samples.current = []; drag.current = null; setLive(null);
    useMotionStore.getState().finishRecording(taken);
  }

  function toImage(event: ReactPointerEvent): Point {
    const rect = overlay.current!.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width * layers!.width, y: (event.clientY - rect.top) / rect.height * layers!.height };
  }

  function startDrag(event: ReactPointerEvent<SVGSVGElement>, next: Drag) {
    drag.current = next;
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (!ready || !layers || event.button !== 0 || drag.current) return;
    const store = useMotionStore.getState();
    const point = toImage(event), { pointerId } = event;
    const target = motionTargetAt(tracks, point, playhead, scale);
    if (!target) { store.selectKey(null); return; }
    store.selectSubject(target.subject.id);
    if (target.kind === "key") {
      const { key } = target;
      store.selectKey(key.id); store.setPlayhead(key.frame);
      if (!isStartKey(target.subject.motion, key.id)) startDrag(event, { kind: "key", id: key.id, pointerId, origin: point, start: { x: key.x, y: key.y } });
    } else if (target.kind === "subject") {
      // Scrubbing before the first drag keyframes the path at the playhead instead of recording it.
      if (target.subject.motion.keys.length > 1 || store.scrubbed) {
        const start = store.beginSubjectDrag();
        if (start) startDrag(event, { kind: "subject", pointerId, origin: point, start });
      } else {
        const startFrame = store.startRecording();
        if (startFrame === null) return;
        const start = target.subject.curve.positionAt(startFrame);
        samples.current = [{ time: 0, ...start }];
        setLive(start);
        startDrag(event, { kind: "record", pointerId, origin: point, start, startTime: performance.now() });
      }
    } else {
      const id = store.insertAtLength(target.length);
      const key = useMotionStore.getState().motion?.keys.find(key => key.id === id);
      if (id && key) startDrag(event, { kind: "key", id, pointerId, origin: point, start: { x: key.x, y: key.y } });
    }
  }

  function onPointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    if (!ready || !layers) return;
    const point = toImage(event), current = drag.current;
    if (!current) {
      const target = motionTargetAt(tracks, point, playhead, scale);
      setHover(target?.kind === "subject" && target.subject.motion.keys.length === 1 && !scrubbed ? "record" : target?.kind ?? null);
      return;
    }
    if (current.pointerId !== event.pointerId) return;
    const target = { x: current.start.x + point.x - current.origin.x, y: current.start.y + point.y - current.origin.y };
    const store = useMotionStore.getState();
    if (current.kind === "key") store.moveKey(current.id, target);
    else if (current.kind === "subject") store.placeSubject(target);
    else { samples.current.push({ time: performance.now() - current.startTime, ...target }); setLive(target); }
  }

  function onPointerUp(event: ReactPointerEvent<SVGSVGElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (current.kind === "record") {
      const point = toImage(event);
      samples.current.push({ time: performance.now() - current.startTime,
        x: current.start.x + point.x - current.origin.x, y: current.start.y + point.y - current.origin.y });
      finishTake();
    } else drag.current = null;
  }

  if (!image) return null;
  const cursor = drag.current ? (drag.current.kind === "record" ? "crosshair" : "grabbing")
    : hover === "key" ? "grab" : hover === "record" ? "crosshair" : hover === "subject" ? "move" : hover === "path" ? "copy" : "default";
  const selected = active?.motion.keys.find(key => key.id === selectedKeyId);
  const showOverlay = ready && !playing && !recording && !readOnly;
  const size = 6 * scale;

  return <Box sx={{ position: "relative", borderRadius: 1, overflow: "hidden", width: "100%", maxWidth: image.height > image.width ? 420 : "100%",
    mx: "auto", bgcolor: "#19151f", aspectRatio: `${image.width}/${image.height}` }}>
    {layers && <Surface ref={canvas} width={layers.width} height={layers.height} aria-hidden />}
    {layers && <svg ref={overlay} viewBox={`0 0 ${layers.width} ${layers.height}`} role={readOnly ? "img" : "application"}
      aria-label={readOnly ? "Motion preview showing the frames that will be generated." : "Motion editor. Click a subject to select it. Drag to create or adjust its path. Clear its path to record again. Drag diamond keys to adjust positions."}
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", touchAction: "none", cursor }}
      {...(readOnly ? {} : { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp,
        onPointerLeave: () => { if (!drag.current) setHover(null); } })}>
      {showOverlay && [...paths].reverse().map(subject => <g key={subject.id} opacity={subject.id === active?.id ? 1 : .65}>
        {subject.path && <>
          <path d={subject.path} fill="none" stroke="#211927" strokeOpacity={.7} strokeWidth={5 * scale} strokeLinecap="round" strokeLinejoin="round" />
          <path d={subject.path} fill="none" stroke={subject.color} strokeWidth={2 * scale} strokeLinecap="round" strokeLinejoin="round" />
        </>}
        {subject.motion.keys.map(key => {
          const start = isStartKey(subject.motion, key.id), selected = subject.id === active?.id && key.id === selectedKeyId;
          return <rect key={key.id} x={key.x - size} y={key.y - size} width={size * 2} height={size * 2} transform={`rotate(45 ${key.x} ${key.y})`}
            fill={selected ? subject.color : "#211927"} stroke={selected ? "#f0efed" : subject.color} strokeWidth={2 * scale} opacity={start ? .65 : 1} />;
        })}
        {subject.curve.length > 0 && (() => {
          const point = subject.curve.positionAt(playhead);
          return <circle cx={point.x} cy={point.y} r={4 * scale} fill="none" stroke={subject.color} strokeWidth={2 * scale} />;
        })()}
      </g>)}
    </svg>}
    {showOverlay && selected && layers && active && <Box sx={{ position: "absolute", left: `${selected.x / layers.width * 100}%`, top: `${selected.y / layers.height * 100}%`,
      transform: "translate(-50%, calc(-100% - 16px))", pointerEvents: "none", bgcolor: "background.paper", border: "1px solid", borderColor: "divider",
      borderRadius: 99, px: 1.25, py: .25, whiteSpace: "nowrap" }}>
      <Typography variant="caption"><Box component="span" sx={{ color: active.color }}>◆</Box> {formatSeconds(selected.frame)}
        {" · "}{signed(selected.x - active.motion.anchor.x)}, {signed(selected.y - active.motion.anchor.y)}</Typography>
    </Box>}
    {ready && active && !playing && !recording && !readOnly && active.motion.keys.length === 1 && <Box sx={{ position: "absolute", bottom: 12, left: "50%", transform: "translateX(-50%)",
      pointerEvents: "none", bgcolor: "background.paper", borderRadius: 99, px: 2, py: .75, maxWidth: "calc(100% - 24px)" }}>
      <Typography variant="caption">{scrubbed ? `Drag to place a key at ${formatSeconds(playhead)}.` : "Drag to create a path."}</Typography>
    </Box>}
    {recording && <Box sx={{ position: "absolute", top: 12, left: 12, bgcolor: "error.main", color: "#fff", borderRadius: 99, px: 1.5, py: .25 }}>
      <Typography variant="caption" sx={{ fontWeight: 600 }}>● REC</Typography>
    </Box>}
    {!ready && !error && <Box sx={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}><CircularProgress size={28} /></Box>}
    {error && <Alert severity="error" sx={{ position: "absolute", left: 12, right: 12, bottom: 12 }}>{error}</Alert>}
    {mediaAction}
  </Box>;
}
