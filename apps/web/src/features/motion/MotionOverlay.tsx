import { useMemo } from "react";
import type { ReactNode } from "react";
import { Box, Typography } from "@mui/material";
import { isStartKey } from "@h3-motion/shared";
import type { FrameSize, MotionCurve, MotionKey, Point, Pose, Rect, SubjectMotion } from "@h3-motion/shared";
import { HANDLES, handlePoint } from "./gizmo";
import type { Handle, ResizeCursor } from "./gizmo";
import { formatScale, formatSeconds, signed } from "./format";

/** A path the overlay draws: its keys, the curve through them and the colour that identifies it. */
export interface OverlayTrack { id: string; color: string; motion: SubjectMotion<number>; curve: MotionCurve }
const BOX_CORNERS: Handle[] = [{ hx: -1, hy: -1 }, { hx: 1, hy: -1 }, { hx: 1, hy: 1 }, { hx: -1, hy: 1 }];

/** SVG paths, ◆ keys and playhead rings, in working-image pixels; `scale` is image pixels per screen pixel. */
export function MotionPaths({ tracks, activeId, selectedKeyId, playhead, scale }: {
  tracks: OverlayTrack[]; activeId?: string; selectedKeyId: string | null; playhead: number; scale: number;
}) {
  const paths = useMemo(() => tracks.map(track => ({ ...track,
    path: track.curve.length > 0 ? track.curve.samples.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join("") : "" })), [tracks]);
  const size = 6 * scale;
  return <>{[...paths].reverse().map(track => <g key={track.id} opacity={track.id === activeId ? 1 : .65}>
    {track.path && <>
      <path d={track.path} fill="none" stroke="#211927" strokeOpacity={.7} strokeWidth={5 * scale} strokeLinecap="round" strokeLinejoin="round" />
      <path d={track.path} fill="none" stroke={track.color} strokeWidth={2 * scale} strokeLinecap="round" strokeLinejoin="round" />
    </>}
    {track.motion.keys.map(key => {
      const start = isStartKey(track.motion, key.id), selected = track.id === activeId && key.id === selectedKeyId;
      return <rect key={key.id} x={key.x - size} y={key.y - size} width={size * 2} height={size * 2} transform={`rotate(45 ${key.x} ${key.y})`}
        fill={selected ? track.color : "#211927"} stroke={selected ? "#f0efed" : track.color} strokeWidth={2 * scale} opacity={start ? .65 : 1} />;
    })}
    {track.curve.length > 0 && (() => {
      const point = track.curve.positionAt(playhead);
      return <circle cx={point.x} cy={point.y} r={4 * scale} fill="none" stroke={track.color} strokeWidth={2 * scale} />;
    })()}
  </g>)}</>;
}

/** The dashed box with corner and edge handles around `bounds` posed about `anchor`. */
export function ResizeBox({ bounds, anchor, pose, color, scale }: { bounds: Rect; anchor: Point; pose: Pose; color: string; scale: number }) {
  return <g pointerEvents="none">
    <polygon points={BOX_CORNERS.map(handle => handlePoint(bounds, anchor, pose, handle)).map(({ x, y }) => `${x},${y}`).join(" ")}
      fill="none" stroke={color} strokeOpacity={.8} strokeWidth={1.5 * scale} strokeDasharray={`${4 * scale} ${3 * scale}`} />
    {HANDLES.map(handle => {
      const { x, y } = handlePoint(bounds, anchor, pose, handle), half = (handle.hx && handle.hy ? 4.5 : 3.5) * scale;
      return <rect key={`${handle.hx},${handle.hy}`} x={x - half} y={y - half} width={half * 2} height={half * 2}
        fill="#f0efed" stroke="#211927" strokeWidth={1.5 * scale} />;
    })}
  </g>;
}

/** The selected key's time, offset from the anchor and size, floating above it. */
export function KeyBadge({ keyframe, anchor, color, size }: { keyframe: MotionKey; anchor: Point; color: string; size: FrameSize }) {
  return <Box sx={{ position: "absolute", left: `${keyframe.x / size.width * 100}%`, top: `${keyframe.y / size.height * 100}%`,
    transform: "translate(-50%, calc(-100% - 16px))", pointerEvents: "none", bgcolor: "background.paper", border: "1px solid", borderColor: "divider",
    borderRadius: 99, px: 1.25, py: .25, whiteSpace: "nowrap" }}>
    <Typography variant="caption"><Box component="span" sx={{ color }}>◆</Box> {formatSeconds(keyframe.frame)}
      {" · "}{signed(keyframe.x - anchor.x)}, {signed(keyframe.y - anchor.y)}
      {formatScale(keyframe) && ` · ${formatScale(keyframe)}`}</Typography>
  </Box>;
}

export function CanvasHint({ children }: { children: ReactNode }) {
  return <Box sx={{ position: "absolute", bottom: 12, left: "50%", transform: "translateX(-50%)",
    pointerEvents: "none", bgcolor: "background.paper", borderRadius: 99, px: 2, py: .75, maxWidth: "calc(100% - 24px)" }}>
    <Typography variant="caption">{children}</Typography>
  </Box>;
}

export function RecordingBadge() {
  return <Box sx={{ position: "absolute", top: 12, left: 12, bgcolor: "error.main", color: "#fff", borderRadius: 99, px: 1.5, py: .25 }}>
    <Typography variant="caption" sx={{ fontWeight: 600 }}>● REC</Typography>
  </Box>;
}

/** What the pointer is over while nothing is dragged; a resize cursor means a box handle. */
export type CanvasHover = "key" | "subject" | "record" | "path" | ResizeCursor | null;
/** The canvas cursor for an active drag, or else for what the pointer is over. */
export function canvasCursor(drag: { kind: string; cursor?: ResizeCursor } | null, hover: CanvasHover, idle = "default") {
  if (drag) return drag.kind === "record" || drag.kind === "draw" ? "crosshair" : drag.cursor ?? "grabbing";
  return hover === "key" ? "grab" : hover === "record" ? "crosshair" : hover === "subject" ? "move" : hover === "path" ? "copy" : hover ?? idle;
}
