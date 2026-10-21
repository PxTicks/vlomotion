import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { Alert, Box, CircularProgress, Typography } from "@mui/material";
import { styled } from "@mui/material/styles";
import { FPS, buildMotionCurve, isStartKey } from "@h3-motion/shared";
import type { Point, RecordedSample } from "@h3-motion/shared";
import { currentIsolation, useSelectionStore } from "../select";
import { drawGhost, drawReference, hitsSubject, loadSubjectLayers, subjectKeyOf } from "./subjectLayers";
import type { SubjectLayers } from "./subjectLayers";
import { formatSeconds, signed } from "./format";
import { useMotionStore } from "./useMotionStore";

const Surface = styled("canvas")({ display: "block", width: "100%", height: "100%" });
type Drag = { pointerId: number; origin: Point; start: Point } & (
  | { kind: "subject" } | { kind: "key"; id: string } | { kind: "record"; startFrame: number; startTime: number });
type Hover = "key" | "subject" | "path" | null;


export function MotionCanvas() {
  const image = useSelectionStore(s => s.image);
  const mask = useSelectionStore(s => s.mask);
  const plateUrl = useSelectionStore(s => currentIsolation(s)?.plate.url);
  const motion = useMotionStore(s => s.motion);
  const subjectKey = useMotionStore(s => s.subjectKey);
  const playhead = useMotionStore(s => s.playhead);
  const playing = useMotionStore(s => s.playing);
  const armed = useMotionStore(s => s.armed);
  const recording = useMotionStore(s => s.recording);
  const selectedKeyId = useMotionStore(s => s.selectedKeyId);
  const prepare = useMotionStore(s => s.prepare);
  const canvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  const samples = useRef<RecordedSample[]>([]);
  const [layers, setLayers] = useState<SubjectLayers | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [live, setLive] = useState<Point | null>(null);
  const [hover, setHover] = useState<Hover>(null);
  const curve = useMemo(() => motion ? buildMotionCurve(motion) : null, [motion]);
  const ready = !!layers && !!curve && !!image && !!mask && subjectKey === subjectKeyOf(image.id, mask.id);

  useEffect(() => {
    if (!image || !mask || !plateUrl) return;
    let disposed = false;
    setError(null);
    loadSubjectLayers(image.url, plateUrl, mask.url).then(loaded => {
      if (disposed) return;
      setLayers(loaded);
      prepare(subjectKeyOf(image.id, mask.id), loaded.bounds, { width: loaded.width, height: loaded.height });
    }).catch(error => { if (!disposed) setError(error instanceof Error ? error.message : "Could not load the subject layers."); });
    return () => { disposed = true; };
  }, [image, mask, plateUrl, prepare]);

  useEffect(() => {
    const element = overlay.current;
    if (!element || !layers) return;
    const observer = new ResizeObserver(([entry]) => setScale(layers.width / Math.max(1, entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, [layers]);

  useEffect(() => {
    const context = canvas.current?.getContext("2d");
    if (!context || !layers || !curve || !ready) return;
    const { anchor, keys } = curve.motion;
    drawReference(context, layers, live ? { x: live.x - anchor.x, y: live.y - anchor.y } : curve.offsetAt(playhead));
    if (playing || recording) return;
    const current = curve.positionAt(playhead);
    for (const key of keys) {
      if (key.x !== current.x || key.y !== current.y) drawGhost(context, layers, { x: key.x - anchor.x, y: key.y - anchor.y }, .22);
    }
  }, [layers, curve, ready, playhead, playing, recording, live]);

  useEffect(() => {
    // Playback reaching the clip end stops a take that is still held.
    if (recording && !playing && drag.current?.kind === "record") finishTake();
  }, [recording, playing]);

  const path = useMemo(() => curve && curve.length > 0
    ? curve.samples.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join("") : "", [curve]);

  function finishTake() {
    const taken = samples.current;
    samples.current = []; drag.current = null; setLive(null);
    useMotionStore.getState().finishRecording(taken);
  }

  function toImage(event: ReactPointerEvent): Point {
    const rect = overlay.current!.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width * layers!.width, y: (event.clientY - rect.top) / rect.height * layers!.height };
  }

  /** On the subject, its own handles (the photo key and the key at the playhead) give way to dragging the subject. */
  function hitKey(point: Point, onSubject: boolean): string | null {
    const { keys } = curve!.motion;
    for (let i = keys.length - 1; i >= 0; i--) {
      if (onSubject && (i === 0 || keys[i].frame === playhead)) continue;
      if (Math.hypot(point.x - keys[i].x, point.y - keys[i].y) <= 11 * scale) return keys[i].id;
    }
    return null;
  }

  function hitTest(point: Point): Hover {
    const onSubject = hitsSubject(layers!, point, curve!.offsetAt(playhead));
    if (hitKey(point, onSubject)) return "key";
    if (onSubject) return "subject";
    return curve!.length > 0 && curve!.nearest(point).distance <= 8 * scale ? "path" : null;
  }

  function startDrag(event: ReactPointerEvent<SVGSVGElement>, next: Drag) {
    drag.current = next;
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (!ready || !curve || !layers || event.button !== 0 || drag.current) return;
    const store = useMotionStore.getState();
    const point = toImage(event), { pointerId } = event;
    const onSubject = hitsSubject(layers, point, curve.offsetAt(playhead));
    const keyId = hitKey(point, onSubject);
    if (keyId && !store.armed) {
      const key = curve.motion.keys.find(k => k.id === keyId)!;
      store.selectKey(keyId); store.setPlayhead(key.frame);
      if (!isStartKey(curve.motion, keyId)) startDrag(event, { kind: "key", id: keyId, pointerId, origin: point, start: { x: key.x, y: key.y } });
      return;
    }
    if (onSubject) {
      if (store.armed) {
        const startFrame = store.startRecording();
        if (startFrame === null) return;
        const start = curve.positionAt(startFrame);
        samples.current = [{ frame: startFrame, ...start }];
        setLive(start);
        startDrag(event, { kind: "record", pointerId, origin: point, start, startFrame, startTime: performance.now() });
        return;
      }
      const start = store.beginSubjectDrag();
      if (start) startDrag(event, { kind: "subject", pointerId, origin: point, start });
      return;
    }
    if (!store.armed && curve.length > 0) {
      const near = curve.nearest(point);
      if (near.distance <= 8 * scale) {
        const id = store.insertAtLength(near.length);
        const key = useMotionStore.getState().motion?.keys.find(k => k.id === id);
        if (id && key) startDrag(event, { kind: "key", id, pointerId, origin: point, start: { x: key.x, y: key.y } });
        return;
      }
    }
    store.selectKey(null);
  }

  function onPointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    if (!ready || !curve || !layers) return;
    const point = toImage(event), current = drag.current;
    if (!current) { setHover(hitTest(point)); return; }
    if (current.pointerId !== event.pointerId) return;
    const target = { x: current.start.x + point.x - current.origin.x, y: current.start.y + point.y - current.origin.y };
    const store = useMotionStore.getState();
    if (current.kind === "key") store.moveKey(current.id, target);
    else if (current.kind === "subject") store.placeSubject(target);
    else {
      samples.current.push({ frame: current.startFrame + (performance.now() - current.startTime) / 1000 * FPS, ...target });
      setLive(target);
    }
  }

  function onPointerUp(event: ReactPointerEvent<SVGSVGElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (current.kind === "record") {
      const point = toImage(event);
      samples.current.push({ frame: current.startFrame + (performance.now() - current.startTime) / 1000 * FPS,
        x: current.start.x + point.x - current.origin.x, y: current.start.y + point.y - current.origin.y });
      finishTake();
    } else drag.current = null;
  }

  if (!image) return null;
  const cursor = drag.current ? (drag.current.kind === "record" ? "crosshair" : "grabbing")
    : hover === "key" && !armed ? "grab" : hover === "subject" ? (armed ? "crosshair" : "move") : hover === "path" && !armed ? "copy" : "default";
  const selected = curve?.motion.keys.find(key => key.id === selectedKeyId);
  const showOverlay = ready && !playing && !recording;
  const size = 6 * scale;

  return <Box sx={{ position: "relative", borderRadius: 1, overflow: "hidden", width: "100%", maxWidth: image.height > image.width ? 420 : "100%",
    mx: "auto", bgcolor: "#19151f", aspectRatio: `${image.width}/${image.height}` }}>
    {layers && <Surface ref={canvas} width={layers.width} height={layers.height} aria-hidden />}
    {layers && <svg ref={overlay} viewBox={`0 0 ${layers.width} ${layers.height}`} role="application"
      aria-label="Motion editor. Drag the subject to place it at the playhead time, drag diamond keys to move them, or click the path to add a key."
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", touchAction: "none", cursor }}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      onPointerLeave={() => { if (!drag.current) setHover(null); }}>
      {showOverlay && path && <>
        <path d={path} fill="none" stroke="#211927" strokeOpacity={.7} strokeWidth={5 * scale} strokeLinecap="round" strokeLinejoin="round" />
        <path d={path} fill="none" stroke="#f2ff59" strokeWidth={2 * scale} strokeLinecap="round" strokeLinejoin="round" />
      </>}
      {showOverlay && curve && curve.motion.keys.map(key => {
        const start = isStartKey(curve.motion, key.id), active = key.id === selectedKeyId;
        return <rect key={key.id} x={key.x - size} y={key.y - size} width={size * 2} height={size * 2} transform={`rotate(45 ${key.x} ${key.y})`}
          fill={active ? "#f2ff59" : start ? "#7e7c78" : "#211927"} stroke={active ? "#f0efed" : start ? "#c2bfb9" : "#f2ff59"} strokeWidth={2 * scale} />;
      })}
      {showOverlay && curve && curve.length > 0 && (() => {
        const p = curve.positionAt(playhead);
        return <circle cx={p.x} cy={p.y} r={4 * scale} fill="none" stroke="#f0efed" strokeWidth={2 * scale} />;
      })()}
    </svg>}
    {showOverlay && selected && layers && curve && <Box sx={{ position: "absolute", left: `${selected.x / layers.width * 100}%`, top: `${selected.y / layers.height * 100}%`,
      transform: "translate(-50%, calc(-100% - 16px))", pointerEvents: "none", bgcolor: "background.paper", border: "1px solid", borderColor: "divider",
      borderRadius: 99, px: 1.25, py: .25, whiteSpace: "nowrap" }}>
      <Typography variant="caption"><Box component="span" sx={{ color: "primary.main" }}>◆</Box> {formatSeconds(selected.frame)}
        {" · "}{signed(selected.x - curve.motion.anchor.x)}, {signed(selected.y - curve.motion.anchor.y)}</Typography>
    </Box>}
    {ready && curve && !playing && (armed || curve.motion.keys.length === 1) && <Box sx={{ position: "absolute", bottom: 12, left: "50%", transform: "translateX(-50%)",
      pointerEvents: "none", bgcolor: "background.paper", borderRadius: 99, px: 2, py: .75, maxWidth: "calc(100% - 24px)" }}>
      <Typography variant="caption">{armed ? "Press on the subject and drag it while the clip plays" : "Drag the subject to where it should end up"}</Typography>
    </Box>}
    {recording && <Box sx={{ position: "absolute", top: 12, left: 12, bgcolor: "error.main", color: "#fff", borderRadius: 99, px: 1.5, py: .25 }}>
      <Typography variant="caption" sx={{ fontWeight: 600 }}>● REC</Typography>
    </Box>}
    {!ready && !error && <Box sx={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}><CircularProgress size={28} /></Box>}
    {error && <Alert severity="error" sx={{ position: "absolute", left: 12, right: 12, bottom: 12 }}>{error}</Alert>}
  </Box>;
}
