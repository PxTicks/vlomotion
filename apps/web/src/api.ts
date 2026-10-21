import { imageAssetSchema, jobSnapshotSchema } from "@h3-motion/shared";
import type { JobSnapshot, SegmentRequest } from "@h3-motion/shared";
import { z } from "zod";

export async function apiRequest(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`/api${path}`, { credentials: "same-origin", ...init });
  const data: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const parsed = z.object({ error: z.string() }).safeParse(data);
    throw new Error(parsed.success ? parsed.data.error : `Request failed (${response.status}).`);
  }
  if (data === undefined) throw new Error(`The server returned an invalid JSON response (${response.status}).`);
  return data;
}

export async function uploadImage(blob: Blob) {
  const form = new FormData();
  form.set("image", blob, "original.png");
  return imageAssetSchema.parse(await apiRequest("/images", { method: "POST", body: form }));
}

export async function submitSegment(request: SegmentRequest) {
  return jobSnapshotSchema.parse(await apiRequest("/jobs/segment", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request),
  }));
}

/** SSE gives live progress; polling also catches terminal jobs after a lost stream. */
export function watchJob(initial: JobSnapshot, onSnapshot: (job: JobSnapshot) => void): Promise<JobSnapshot> {
  return new Promise((resolve, reject) => {
    const events = new EventSource(`/api/jobs/${initial.id}/events`);
    let finished = false, polling = false, failures = 0;
    const cleanup = () => { finished = true; events.close(); globalThis.clearInterval(timer); };
    const update = (snapshot: JobSnapshot) => {
      if (finished) return;
      onSnapshot(snapshot);
      if (!["queued", "running"].includes(snapshot.status)) { cleanup(); resolve(snapshot); }
    };
    events.addEventListener("snapshot", event => {
      const parsed = jobSnapshotSchema.safeParse(JSON.parse((event as MessageEvent<string>).data));
      if (parsed.success) update(parsed.data);
    });
    const timer = globalThis.setInterval(async () => {
      if (polling || finished) return;
      polling = true;
      try {
        update(jobSnapshotSchema.parse(await apiRequest(`/jobs/${initial.id}`)));
        failures = 0;
      } catch (error) {
        // Keep the UI cancellable during brief disconnects; surface sustained failures.
        if (++failures >= 5 && !finished) { cleanup(); reject(error); }
      } finally { polling = false; }
    }, 2000);
    update(initial);
  });
}
