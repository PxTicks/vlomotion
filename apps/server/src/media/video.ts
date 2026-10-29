import { BufferSource, Input, MP4, WEBM } from "mediabunny";

export interface VideoInfo { container: "mp4" | "webm"; width: number; height: number; frames: number; startTime: number; duration: number; audio: boolean }

/** Reads container metadata only; no decoding. Frame count is the video packet count. */
export async function inspectVideo(bytes: Uint8Array): Promise<VideoInfo> {
  const input = new Input({ source: new BufferSource(bytes), formats: [MP4, WEBM] });
  try {
    const format = await input.getFormat();
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("No video track");
    // MediaBunny reports the absolute end timestamp, rather than elapsed playback time.
    const startTime = Math.max(0, await track.getFirstTimestamp());
    return { container: format === MP4 ? "mp4" : "webm", width: await track.getDisplayWidth(), height: await track.getDisplayHeight(),
      frames: (await track.computePacketStats()).packetCount, startTime, duration: await track.computeDuration() - startTime,
      audio: await input.getPrimaryAudioTrack() !== null };
  } finally { input.dispose(); }
}
