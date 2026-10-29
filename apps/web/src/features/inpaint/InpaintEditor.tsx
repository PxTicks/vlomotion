import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { Box, Stack, ToggleButton, ToggleButtonGroup, Typography } from "@mui/material";
import { FPS, MAX_SCALE, buildMotionCurve, isStartKey, placeRect, scaleOf, trackedBounds } from "@h3-motion/shared";
import type { MaskShape, Placement, Point, Pose, Rect, TimedSample } from "@h3-motion/shared";
import { MAX_MASKS, nextMaskColor, videoFrame, useInpaintStore } from "./useInpaintStore";
import type { InpaintMask } from "./useInpaintStore";
import { RemoveMediaButton } from "../shell/RemoveMediaButton";
import { dragHandle, handleCursor, nearestHandle } from "../motion/gizmo";
import type { Handle, ResizeCursor } from "../motion/gizmo";
import { motionTargetAt } from "../motion/motionHitTest";
import type { HitsBody } from "../motion/motionHitTest";
import { CanvasHint, KeyBadge, MotionPaths, RecordingBadge, ResizeBox, canvasCursor } from "../motion/MotionOverlay";
import type { CanvasHover, OverlayTrack } from "../motion/MotionOverlay";
import { KeyTimeline } from "../motion/KeyTimeline";
import { useMotionShortcuts } from "../motion/useMotionShortcuts";
import { formatSeconds } from "../motion/format";
import { SelectionCanvas, SelectionStoreContext } from "../select";
import { useFollowSelection } from "./useFollowSelection";

/** Neutral, so the tracked object's bounds never read as one of the masks. */
const TRACK_COLOR = "#f0efed";
interface MaskTrack extends OverlayTrack { mask: InpaintMask }
type Drag = { pointerId: number; origin: Point; start: Point } & (
  | { kind: "draw" } | { kind: "subject" } | { kind: "key"; id: string } | { kind: "record"; startTime: number }
  | { kind: "scale"; handle: Handle; pose: Pose; cursor: ResizeCursor });

const centreOf = ({ x, y, width, height }: Rect): Point => ({ x: x + width / 2, y: y + height / 2 });
const atRest = (bounds: Rect): Pose => ({ ...centreOf(bounds), sx: 1, sy: 1 });
const placementOf = (anchor: Point, { x, y, sx, sy }: Pose): Placement => ({ anchor, offset: { x: x - anchor.x, y: y - anchor.y }, sx, sy });

/** Whether `point` falls inside the mask's shape drawn in `rect`. */
function insideMask(shape: MaskShape, { x, y, width, height }: Rect, point: Point) {
  if (shape === "rectangle") return point.x >= x && point.x <= x + width && point.y >= y && point.y <= y + height;
  const dx = (point.x - x - width / 2) / (width / 2 || 1), dy = (point.y - y - height / 2) / (height / 2 || 1);
  return dx * dx + dy * dy <= 1;
}

/** A mask as drawn: `dim` for one that isn't selected, `ghost` for where the selected one is keyed. */
function MaskShapeView({ shape, rect, color, scale, ghost = false, dim = false }: { shape: MaskShape; rect: Rect; color: string; scale: number; ghost?: boolean; dim?: boolean }) {
  const style = ghost ? { fill: "none", stroke: color, strokeOpacity: .35, strokeWidth: 1.5 * scale }
    : dim ? { fill: `${color}22`, stroke: color, strokeOpacity: .6, strokeWidth: 1.5 * scale } : { fill: `${color}44`, stroke: color, strokeWidth: 2 * scale };
  return shape === "ellipse" ? <ellipse cx={rect.x + rect.width / 2} cy={rect.y + rect.height / 2} rx={rect.width / 2} ry={rect.height / 2} {...style} />
    : <rect x={rect.x} y={rect.y} width={rect.width} height={rect.height} {...style} />;
}

export function InpaintEditor({ onRemove }: { onRemove(): void }) {
  const s = useInpaintStore();
  const followFrame = useFollowSelection(state => state.image);
  const video = useRef<HTMLVideoElement>(null);
  const overlay = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  const samples = useRef<TimedSample[]>([]);
  /** A first-frame mask while it is drawn (`adding`), or the active one while it is moved or resized; it is committed on release. */
  const [draft, setDraft] = useState<{ rect: Rect; adding: boolean } | null>(null);
  const [live, setLive] = useState<Point | null>(null);
  const [scale, setScale] = useState(1);
  const [hover, setHover] = useState<CanvasHover>(null);
  const busy = s.status !== "idle";
  const showResult = s.view === "result" && !!s.result;
  /** The first frame is shown for selecting the object to follow, in place of the video and its overlay. */
  const selecting = s.picking && !!followFrame;
  const curves = useMemo(() => new Map(s.masks.map(mask => [mask.id, buildMotionCurve(mask.motion)])), [s.masks]);
  const curve = s.activeMaskId ? curves.get(s.activeMaskId) ?? null : null;
  /** The masks topmost first: the active one, then the rest from the last drawn. Clicks find them in this order. */
  const tracks = useMemo<MaskTrack[]>(() => [...s.masks.filter(mask => mask.id === s.activeMaskId), ...s.masks.filter(mask => mask.id !== s.activeMaskId).reverse()]
    .map(mask => ({ id: mask.id, color: mask.color, motion: mask.motion, curve: curves.get(mask.id)!, mask })), [s.masks, s.activeMaskId, curves]);
  useMotionShortcuts(useInpaintStore.getState, { enabled: s.step > 0 && !showResult && !s.picking, readOnly: s.step === 2 });
  useEffect(() => () => useInpaintStore.getState().leave(), []);
  useEffect(() => {
    // The motion shortcuts start on the Animate step; while drawing, Delete removes the selected mask.
    if (s.step !== 0) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      if (event.metaKey || event.ctrlKey || event.altKey || target?.closest("input, textarea, select, [contenteditable='true']")) return;
      const { activeMaskId, removeMask } = useInpaintStore.getState();
      if (!activeMaskId || drag.current) return;
      event.preventDefault();
      removeMask(activeMaskId);
    };
    globalThis.addEventListener("keydown", onKeyDown);
    return () => globalThis.removeEventListener("keydown", onKeyDown);
  }, [s.step]);
  useEffect(() => {
    if (!s.picking) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !useFollowSelection.getState().busy) useInpaintStore.getState().stopPicking();
    };
    globalThis.addEventListener("keydown", onKeyDown);
    return () => globalThis.removeEventListener("keydown", onKeyDown);
  }, [s.picking]);

  useEffect(() => {
    const element = overlay.current;
    if (!element || !s.video) return;
    const width = s.video.width;
    const observer = new ResizeObserver(([entry]) => setScale(width / Math.max(1, entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, [s.video?.id, s.video?.width, showResult, selecting]);
  useEffect(() => {
    if (video.current && s.video && !s.playing) video.current.currentTime = s.video.startTime + s.playhead / FPS;
  }, [s.playhead, s.playing, s.video?.id, s.video?.startTime, showResult, selecting]);
  useEffect(() => {
    const element = video.current;
    if (!element || !s.playing || showResult) return;
    let handle = 0, disposed = false;
    const { video: asset, playhead } = useInpaintStore.getState();
    element.currentTime = (asset?.startTime ?? 0) + playhead / FPS;
    const tick = () => {
      if (disposed) return;
      const state = useInpaintStore.getState();
      const frame = Math.min(state.frames - 1, Math.max(0, Math.floor((element.currentTime - (state.video?.startTime ?? 0)) * FPS)));
      useInpaintStore.setState({ playhead: frame });
      if (frame >= state.frames - 1 || element.ended) { element.pause(); state.pause(); }
      else handle = requestAnimationFrame(tick);
    };
    void element.play().then(() => { if (!disposed) handle = requestAnimationFrame(tick); })
      .catch(() => { if (!disposed) useInpaintStore.getState().pause(); });
    return () => { disposed = true; cancelAnimationFrame(handle); element.pause(); };
  }, [s.playing, s.video?.id, showResult]);

  if (!s.video) return null;
  const frame = videoFrame(s.video);
  const { bounds, motion, shape, step, playhead } = s;
  const color = s.masks.find(mask => mask.id === s.activeMaskId)?.color ?? nextMaskColor(s.masks);
  const editing = !busy && !s.playing && !s.recording;
  // Like the photo in the motion editor, the drawn mask can't change on the first frame once it is animated.
  const lockedStart = playhead === 0 && !!motion && motion.keys.length > 1;
  const poseAt = (at: number): Pose => ({ ...curve!.positionAt(at), ...curve!.scaleAt(at) });
  const hitsMask: HitsBody<MaskTrack> = ({ mask }, point, placement) => insideMask(mask.shape, placeRect(mask.bounds, placement), point);
  /** The topmost mask whose first-frame shape is under `point`. */
  const drawnAt = (point: Point) => tracks.find(({ mask }) => insideMask(mask.shape, mask.bounds, point));
  /** Masks never need mirroring, but may need to grow past MAX_SCALE to cover the frame from a small first box. */
  const maxScaleOf = (bounds: Rect | null) => bounds ? Math.max(MAX_SCALE, frame.width / bounds.width, frame.height / bounds.height) : MAX_SCALE;
  const maxScale = maxScaleOf(bounds);

  /** Where the active mask sits on screen now: the draft while moved or resized, the live take while recording, else its curve. */
  const current: Rect | null = draft && !draft.adding ? draft.rect : !bounds ? null : step === 0 || !motion || !curve ? bounds
    : placeRect(bounds, live ? { anchor: motion.anchor, offset: { x: live.x - motion.anchor.x, y: live.y - motion.anchor.y }, ...curve.scaleAt(playhead) }
      : curve.placementAt(playhead));
  /** Where a mask sits on screen now. */
  const placed = ({ mask, curve }: MaskTrack): Rect | null => mask.id === s.activeMaskId ? current
    : step === 0 ? mask.bounds : placeRect(mask.bounds, curve.placementAt(playhead));
  const box = !editing || s.picking || !bounds || !motion || draft || step === 2 || (step === 1 && lockedStart) ? null
    : step === 0 ? { bounds, anchor: centreOf(bounds), pose: atRest(bounds) } : { bounds, anchor: motion.anchor, pose: poseAt(playhead) };

  function toImage(event: ReactPointerEvent): Point {
    const rect = overlay.current!.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width * frame.width, y: (event.clientY - rect.top) / rect.height * frame.height };
  }
  const handleAt = (point: Point) => box ? nearestHandle(box.bounds, box.anchor, box.pose, point, 9 * scale) : null;

  function startDrag(event: ReactPointerEvent<SVGSVGElement>, next: Drag) {
    drag.current = next;
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function finishTake() {
    const taken = samples.current;
    samples.current = []; drag.current = null; setLive(null);
    useInpaintStore.getState().finishRecording(taken);
  }

  function onPointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (!editing || step === 2 || s.picking || event.button !== 0 || drag.current) return;
    event.preventDefault();
    const store = useInpaintStore.getState(), point = toImage(event), { pointerId } = event;
    const handle = handleAt(point);
    if (step === 0) {
      const hit = drawnAt(point);
      if (handle && bounds) startDrag(event, { kind: "scale", handle, pose: atRest(bounds), cursor: handleCursor(handle, atRest(bounds)), pointerId, origin: point, start: point });
      else if (hit) { store.selectMask(hit.id); startDrag(event, { kind: "subject", pointerId, origin: point, start: centreOf(hit.mask.bounds) }); }
      else if (s.masks.length < MAX_MASKS) startDrag(event, { kind: "draw", pointerId, origin: point, start: point });
      // At the limit, this only explains why no mask is drawn.
      else store.addMask({ x: point.x, y: point.y, width: 0, height: 0 });
      return;
    }
    if (!motion || !curve) return;
    if (handle) {
      // Resizing always keys the mask at the playhead; it never records.
      const pose = store.beginMaskDrag();
      if (pose) startDrag(event, { kind: "scale", handle, pose, cursor: handleCursor(handle, pose), pointerId, origin: point, start: pose });
      return;
    }
    const target = motionTargetAt(tracks, point, playhead, scale, hitsMask);
    if (!target) { store.selectKey(null); return; }
    // Pressing another mask, its keys or its path selects it, and the press goes on to act on it.
    store.selectMask(target.subject.id);
    const { motion: targetMotion, curve: targetCurve } = target.subject;
    if (target.kind === "key") {
      store.selectKey(target.key.id); store.setPlayhead(target.key.frame);
      if (!isStartKey(targetMotion, target.key.id)) startDrag(event, { kind: "key", id: target.key.id, pointerId, origin: point, start: { x: target.key.x, y: target.key.y } });
    } else if (target.kind === "subject") {
      // Scrubbing before the first drag keyframes the path at the playhead instead of recording it.
      if (targetMotion.keys.length > 1 || store.scrubbed) {
        const start = store.beginMaskDrag();
        if (start) startDrag(event, { kind: "subject", pointerId, origin: point, start });
      } else {
        const startFrame = store.startRecording();
        if (startFrame === null) return;
        const start = targetCurve.positionAt(startFrame);
        samples.current = [{ time: 0, ...start }];
        setLive(start);
        startDrag(event, { kind: "record", pointerId, origin: point, start, startTime: performance.now() });
      }
    } else {
      const id = store.insertAtLength(target.length);
      const key = useInpaintStore.getState().motion?.keys.find(key => key.id === id);
      if (id && key) startDrag(event, { kind: "key", id, pointerId, origin: point, start: { x: key.x, y: key.y } });
    }
  }

  /** The first-frame mask a step 0 drag gives, kept inside the frame: a new one, or the active one moved or resized. */
  function drafted(current: Drag, point: Point, modifiers: { shiftKey: boolean; altKey: boolean }): Rect | null {
    // The drag may have just made a mask active, so its bounds are read from the store rather than this render.
    const { bounds } = useInpaintStore.getState();
    if (!bounds && current.kind !== "draw") return null;
    const delta = { x: point.x - current.origin.x, y: point.y - current.origin.y };
    if (current.kind === "draw") {
      const end = { x: Math.max(0, Math.min(frame.width, point.x)), y: Math.max(0, Math.min(frame.height, point.y)) };
      return { x: Math.min(end.x, current.start.x), y: Math.min(end.y, current.start.y), width: Math.abs(end.x - current.start.x), height: Math.abs(end.y - current.start.y) };
    }
    const anchor = centreOf(bounds!);
    const pose = current.kind === "scale"
      ? dragHandle(bounds!, anchor, current.pose, current.handle, delta, { free: modifiers.shiftKey, centred: modifiers.altKey }, maxScaleOf(bounds))
      : { x: current.start.x + delta.x, y: current.start.y + delta.y, sx: 1, sy: 1 };
    return placeRect(bounds!, placementOf(anchor, pose));
  }

  function onPointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    const point = toImage(event), current = drag.current;
    if (!current) {
      if (!editing || step === 2 || s.picking) { setHover(null); return; }
      const handle = handleAt(point);
      if (handle && box) { setHover(handleCursor(handle, box.pose)); return; }
      if (step === 0) { setHover(drawnAt(point) ? "subject" : null); return; }
      const target = motionTargetAt(tracks, point, playhead, scale, hitsMask);
      setHover(target?.kind === "subject" && motion?.keys.length === 1 && !s.scrubbed ? "record" : target?.kind ?? null);
      return;
    }
    if (current.pointerId !== event.pointerId) return;
    if (step === 0) { const rect = drafted(current, point, event); setDraft(rect && { rect, adding: current.kind === "draw" }); return; }
    const target = { x: current.start.x + point.x - current.origin.x, y: current.start.y + point.y - current.origin.y };
    const store = useInpaintStore.getState();
    if (current.kind === "key") store.moveKey(current.id, target);
    else if (current.kind === "subject") store.placeMask(target);
    else if (current.kind === "scale" && bounds && motion) {
      const delta = { x: point.x - current.origin.x, y: point.y - current.origin.y };
      const pose = dragHandle(bounds, motion.anchor, current.pose, current.handle, delta, { free: event.shiftKey, centred: event.altKey }, maxScale);
      // A mirrored mask covers the same pixels, so keep scales positive.
      store.placeMask({ ...pose, sx: Math.abs(pose.sx), sy: Math.abs(pose.sy) });
    } else if (current.kind === "record") { samples.current.push({ time: performance.now() - current.startTime, ...target }); setLive(target); }
  }

  function onPointerUp(event: ReactPointerEvent<SVGSVGElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const point = toImage(event);
    if (current.kind === "record") {
      samples.current.push({ time: performance.now() - current.startTime,
        x: current.start.x + point.x - current.origin.x, y: current.start.y + point.y - current.origin.y });
      finishTake();
      return;
    }
    drag.current = null;
    if (step === 0) {
      const next = drafted(current, point, event);
      setDraft(null);
      // A click without a drag only selects; it never adds a mask or moves one.
      if (next && Math.hypot(point.x - current.origin.x, point.y - current.origin.y) > 3 * scale) {
        if (current.kind === "draw") useInpaintStore.getState().addMask(next); else useInpaintStore.getState().drawMask(next);
      }
    }
  }

  function onPointerCancel(event: ReactPointerEvent<SVGSVGElement>) {
    if (drag.current?.kind === "record") { onPointerUp(event); return; }
    drag.current = null; setDraft(null);
  }

  const showPath = editing && step === 1 && !!motion && !s.picking;
  const selected = showPath ? motion.keys.find(key => key.id === s.selectedKeyId) : undefined;
  const ghosts = showPath && bounds && curve ? motion.keys.map(key => placeRect(bounds, { anchor: motion.anchor, offset: { x: key.x - motion.anchor.x, y: key.y - motion.anchor.y }, ...scaleOf(key) }))
    .filter(rect => !current || rect.x !== current.x || rect.y !== current.y || rect.width !== current.width || rect.height !== current.height) : [];
  const cursor = step === 2 || busy || s.picking ? "default" : canvasCursor(drag.current, hover, step === 0 && s.masks.length < MAX_MASKS ? "crosshair" : "default");
  const tracked = step === 1 && s.track && !s.picking ? trackedBounds(s.track, playhead, frame) : null;

  return <Stack spacing={2}>
    {step > 0 && <Typography variant="overline" color="text.secondary">{step === 2 ? "OUTPUT" : "MOTION PREVIEW"}</Typography>}
    {step === 2 && <ToggleButtonGroup exclusive size="small" value={showResult ? "result" : "preview"} aria-label="Preview" sx={{ alignSelf: "center" }}
      onChange={(_, value: unknown) => { if (value === "preview" || value === "result") { s.leave(); s.setView(value); } }}>
      <ToggleButton value="preview" sx={{ px: 2, py: .5, borderRadius: 99 }}>Source</ToggleButton>
      <ToggleButton value="result" disabled={!s.result} sx={{ px: 2, py: .5, borderRadius: 99 }}>Result</ToggleButton>
    </ToggleButtonGroup>}
    {showResult ? <Box sx={{ position: "relative", width: "100%", maxWidth: 680 * s.result!.width / s.result!.height, mx: "auto" }}>
        <Box component="video" key={s.result!.video.id} src={s.result!.video.url} controls autoPlay
          sx={{ display: "block", width: "100%", aspectRatio: `${s.result!.width}/${s.result!.height}`, bgcolor: "#19151f", borderRadius: 1 }} />
      </Box>
      // The object to follow is selected on the first frame as the tracker sees it, like a photo's subjects.
      : selecting ? <SelectionStoreContext.Provider value={useFollowSelection}>
        <Box sx={{ width: "100%", maxWidth: 680 * s.video.width / s.video.height, mx: "auto" }}><SelectionCanvas media="frame" /></Box>
      </SelectionStoreContext.Provider>
      : <Box sx={{ position: "relative", width: "100%", maxWidth: 680 * s.video.width / s.video.height, mx: "auto", aspectRatio: `${s.video.width}/${s.video.height}`, bgcolor: "#19151f", borderRadius: 1, overflow: "hidden" }}>
        <video ref={video} key={s.video.id} src={s.video.url} muted playsInline preload="auto"
          onLoadedMetadata={() => {
            const state = useInpaintStore.getState();
            if (video.current && state.video) video.current.currentTime = state.video.startTime + state.playhead / FPS;
          }}
          onError={() => { useInpaintStore.setState({ error: "This browser can't preview this video. Try an H.264 MP4.", playing: false }); }}
          style={{ display: "block", width: "100%", height: "100%" }} />
        <svg ref={overlay} viewBox={`0 0 ${frame.width} ${frame.height}`} role={step === 2 ? "img" : "application"}
          aria-label={step === 0 ? "Mask editor. Drag to draw a mask, and again elsewhere to add another. Click a mask to select it, drag inside it to move it, drag its box corners and edges to resize it, or press Delete to remove it."
            : step === 1 ? "Mask animator. Click a mask to select it. Drag it to create or adjust its path. Clear its path to record again. Drag diamond keys to adjust positions. Drag the box corners to resize the mask, or its edges to stretch it."
            : "Mask preview showing where the video will be inpainted."}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", touchAction: "none", cursor }}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel}
          onPointerLeave={() => { if (!drag.current) setHover(null); }}>
          {tracked && <rect x={tracked.x} y={tracked.y} width={tracked.width} height={tracked.height} fill="none" stroke={TRACK_COLOR}
            strokeOpacity={.8} strokeWidth={1.5 * scale} strokeDasharray={`${2 * scale} ${3 * scale}`} pointerEvents="none" />}
          {ghosts.map((rect, index) => <MaskShapeView key={index} shape={shape} rect={rect} color={color} scale={scale} ghost />)}
          {!s.picking && [...tracks].reverse().map(track => {
            const rect = placed(track);
            return rect && <MaskShapeView key={track.id} shape={track.mask.shape} rect={rect} color={track.color} scale={scale} dim={step < 2 && track.id !== s.activeMaskId} />;
          })}
          {draft?.adding && <MaskShapeView shape={shape} rect={draft.rect} color={nextMaskColor(s.masks)} scale={scale} />}
          {showPath && <MotionPaths tracks={tracks} activeId={s.activeMaskId ?? undefined} selectedKeyId={s.selectedKeyId} playhead={playhead} scale={scale} />}
          {box && <ResizeBox {...box} color={color} scale={scale} />}
        </svg>
        {selected && motion && <KeyBadge keyframe={selected} anchor={motion.anchor} color={color} size={frame} />}
        {step === 0 && !bounds && !draft && <CanvasHint>Drag to draw a mask.</CanvasHint>}
        {s.picking && <CanvasHint>Reading the first frame…</CanvasHint>}
        {showPath && motion.keys.length === 1 && <CanvasHint>{s.scrubbed ? `Drag to place a key at ${formatSeconds(playhead)}.` : "Drag to create a path."}</CanvasHint>}
        {s.recording && <RecordingBadge />}
        {step === 0 && <RemoveMediaButton label="Remove video" disabled={busy || s.uploading} onRemove={onRemove} />}
      </Box>}
    {!showResult && step > 0 && motion && <KeyTimeline motion={motion} color={color} playhead={playhead} playing={s.playing} locked={s.recording || s.picking}
      selectedKeyId={s.selectedKeyId} actions={useInpaintStore.getState} startLabel="drawn mask" readOnly={step === 2} />}
    {step === 0 && s.video.duration > s.frames / FPS + 0.1 && <Typography variant="caption" color="text.secondary">Uses the first {(s.frames / FPS).toFixed(1)} s of your video.</Typography>}
  </Stack>;
}
