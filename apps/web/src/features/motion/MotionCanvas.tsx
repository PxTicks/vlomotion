import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { Alert, Box, CircularProgress } from "@mui/material";
import { styled } from "@mui/material/styles";
import { buildMotionCurve, isStartKey, scaleOf } from "@h3-motion/shared";
import type { Point, Pose, TimedSample } from "@h3-motion/shared";
import { useSelectionStore } from "../select";
import { drawGhost, drawSceneReference, subjectKeyOf } from "./subjectLayers";
import { useGhosts } from "./useGhosts";
import { hitsLayers, motionTargetAt } from "./motionHitTest";
import { useSubjectLayers } from "./useSubjectLayers";
import { dragHandle, handleCursor, nearestHandle } from "./gizmo";
import type { Handle, ResizeCursor } from "./gizmo";
import { formatSeconds } from "./format";
import { CanvasHint, KeyBadge, MotionPaths, RecordingBadge, ResizeBox, canvasCursor } from "./MotionOverlay";
import type { CanvasHover } from "./MotionOverlay";
import { SUBJECT_COLORS, useMotionStore } from "./useMotionStore";

const Surface = styled("canvas")({ display: "block", width: "100%", height: "100%" });
type Drag = { pointerId: number; origin: Point; start: Point } & (
  | { kind: "subject" } | { kind: "key"; id: string } | { kind: "record"; startTime: number }
  | { kind: "scale"; handle: Handle; pose: Pose; cursor: ResizeCursor });

/** Composites all subjects; read-only previews match the frames sent to generation. */
export function MotionCanvas({ readOnly = false }: { readOnly?: boolean }) {
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
  const [hover, setHover] = useState<CanvasHover>(null);
  const showGhosts = useGhosts(s => s.show);
  const tracks = useMemo(() => (subjects.length ? subjects : motion && layers
    ? [{ id: mask?.id ?? "subject", name: "Subject", color: SUBJECT_COLORS[0], motion, layers }] : [])
    .map(subject => ({ ...subject, curve: buildMotionCurve(subject.motion) })), [subjects, motion, layers, mask?.id]);
  const active = tracks.find(subject => subject.id === activeSubjectId) ?? tracks[0];
  const ready = !!layers && tracks.length > 0 && !!image && !!mask && subjectKey === subjectKeyOf(image.id, mask.id);

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
    drawSceneReference(context, layers, tracks.map(subject => {
      const placement = subject.curve.placementAt(playhead), { anchor } = subject.motion;
      return { layers: subject.layers, placement: live && subject.id === active.id ? { ...placement, offset: { x: live.x - anchor.x, y: live.y - anchor.y } } : placement };
    }), playhead === 0 && !live);
    if (playing || recording || readOnly || !showGhosts) return;
    const current = active.curve.placementAt(playhead), { anchor } = active.motion;
    for (const key of active.motion.keys) {
      const placement = { anchor, offset: { x: key.x - anchor.x, y: key.y - anchor.y }, ...scaleOf(key) };
      if (placement.offset.x !== current.offset.x || placement.offset.y !== current.offset.y || placement.sx !== current.sx || placement.sy !== current.sy) {
        drawGhost(context, active.layers, placement, .22);
      }
    }
  }, [layers, tracks, active, ready, playhead, playing, recording, live, readOnly, showGhosts]);

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

  /** The nearest active-subject box handle under the pointer, while its pose at the playhead can be edited. */
  function handleAt(point: Point): Handle | null {
    if (!active || !showOverlay || (playhead === 0 && active.motion.keys.length > 1)) return null;
    return nearestHandle(active.layers.bounds, active.motion.anchor, poseAt(playhead), point, 9 * scale);
  }

  function poseAt(frame: number): Pose {
    return { ...active!.curve.positionAt(frame), ...active!.curve.scaleAt(frame) };
  }

  function onPointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (!ready || !layers || event.button !== 0 || drag.current) return;
    const store = useMotionStore.getState();
    const point = toImage(event), { pointerId } = event;
    const handle = handleAt(point);
    if (handle) {
      // Resizing always keys the pose at the playhead; it never records.
      const pose = store.beginSubjectDrag();
      if (pose) startDrag(event, { kind: "scale", handle, pose, cursor: handleCursor(handle, pose), pointerId, origin: point, start: pose });
      return;
    }
    const target = motionTargetAt(tracks, point, playhead, scale, hitsLayers);
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
      const handle = handleAt(point);
      if (handle) { setHover(handleCursor(handle, poseAt(playhead))); return; }
      const target = motionTargetAt(tracks, point, playhead, scale, hitsLayers);
      setHover(target?.kind === "subject" && target.subject.motion.keys.length === 1 && !scrubbed ? "record" : target?.kind ?? null);
      return;
    }
    if (current.pointerId !== event.pointerId) return;
    const target = { x: current.start.x + point.x - current.origin.x, y: current.start.y + point.y - current.origin.y };
    const store = useMotionStore.getState();
    if (current.kind === "key") store.moveKey(current.id, target);
    else if (current.kind === "subject") store.placeSubject(target);
    else if (current.kind === "scale") {
      if (!active) return;
      const delta = { x: point.x - current.origin.x, y: point.y - current.origin.y };
      store.placeSubject(dragHandle(active.layers.bounds, active.motion.anchor, current.pose, current.handle, delta, { free: event.shiftKey, centred: event.altKey }));
    }
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

  const showOverlay = ready && !playing && !recording && !readOnly;
  if (!image) return null;
  const cursor = canvasCursor(drag.current, hover);
  const selected = active?.motion.keys.find(key => key.id === selectedKeyId);
  const box = active && showOverlay && !(playhead === 0 && active.motion.keys.length > 1)
    ? { pose: poseAt(playhead), bounds: active.layers.bounds, anchor: active.motion.anchor } : null;

  return <Box sx={{ position: "relative", borderRadius: 1, overflow: "hidden", width: "100%", maxWidth: image.height > image.width ? 420 : "100%",
    mx: "auto", bgcolor: "#19151f", aspectRatio: `${image.width}/${image.height}` }}>
    {layers && <Surface ref={canvas} width={layers.width} height={layers.height} aria-hidden />}
    {layers && <svg ref={overlay} viewBox={`0 0 ${layers.width} ${layers.height}`} role={readOnly ? "img" : "application"}
      aria-label={readOnly ? "Motion preview showing the frames that will be generated." : "Motion editor. Click a subject to select it. Drag to create or adjust its path. Clear its path to record again. Drag diamond keys to adjust positions. Drag the box corners to resize the subject, or its edges to stretch or flip it."}
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", touchAction: "none", cursor }}
      {...(readOnly ? {} : { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp,
        onPointerLeave: () => { if (!drag.current) setHover(null); } })}>
      {showOverlay && <MotionPaths tracks={tracks} activeId={active?.id} selectedKeyId={selectedKeyId} playhead={playhead} scale={scale} />}
      {box && active && <ResizeBox {...box} color={active.color} scale={scale} />}
    </svg>}
    {showOverlay && selected && layers && active && <KeyBadge keyframe={selected} anchor={active.motion.anchor} color={active.color} size={layers} />}
    {ready && active && !playing && !recording && !readOnly && active.motion.keys.length === 1
      && <CanvasHint>{scrubbed ? `Drag to place a key at ${formatSeconds(playhead)}.` : "Drag to create a path."}</CanvasHint>}
    {recording && <RecordingBadge />}
    {!ready && !error && <Box sx={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}><CircularProgress size={28} /></Box>}
    {error && <Alert severity="error" sx={{ position: "absolute", left: 12, right: 12, bottom: 12 }}>{error}</Alert>}
  </Box>;
}
