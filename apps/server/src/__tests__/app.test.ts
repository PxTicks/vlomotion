import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Comfy } from "@comfyorg/sdk";
import type { Job } from "@comfyorg/sdk";
import { createApp } from "../app.js";
import { SessionStore } from "../sessions.js";
import { decodeMask, encodeMask } from "../media/masks.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "h3m-test-")); roots.push(root);
  const store = new SessionStore(root);
  const client = new Comfy();
  const app = createApp({ store, client, health: async () => false });
  const created = await app.request("/api/sessions", { method: "POST" });
  const cookie = created.headers.get("set-cookie")!.split(";")[0];
  const session = [...store.sessions.values()][0];
  const png = await encodeMask(Uint8Array.from([255, 0, 0, 255]), 2, 2);
  const form = new FormData(); form.set("image", new File([new Uint8Array(png)], "photo.png", { type: "image/png" }));
  const uploaded = await app.request("/api/images", { method: "POST", headers: { cookie }, body: form });
  expect(uploaded.status).toBe(201);
  return { app, store, client, cookie, session, png };
}

function post(cookie: string, data: unknown) {
  return { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify(data) };
}

function remoteJob(outputs: Uint8Array[], result: () => Promise<unknown> = async () => undefined) {
  return {
    status: "succeeded", cancel: vi.fn(async () => undefined),
    result: vi.fn(result),
    async *events() { yield { kind: "progress", value: 0.5, message: "Segmenting…" }; },
    getOutputs: vi.fn(() => outputs.map(bytes => ({ toBytes: async () => bytes }))),
  } as unknown as Job;
}

describe("session API and segmentation lifecycle", () => {
  it("reports offline ComfyUI without preventing photo upload", async () => {
    const { app, session } = await setup();
    expect(await (await app.request("/api/health")).json()).toEqual({ server: "ok", comfy: "unavailable" });
    expect(session.image).toMatchObject({ width: 2, height: 2 });
    expect((await app.request("/api/images", { method: "POST" })).status).toBe(401);
  });
  it("does not serve another session's photo", async () => {
    const { app, session, cookie } = await setup();
    expect((await app.request(session.image!.url, { headers: { cookie } })).status).toBe(200);
    const second = await app.request("/api/sessions", { method: "POST" });
    const otherCookie = second.headers.get("set-cookie")!.split(";")[0];
    expect((await app.request(session.image!.url, { headers: { cookie: otherCookie } })).status).toBe(404);
    expect((await app.request("/api/files/..%2F..%2F.env", { headers: { cookie } })).status).toBe(404);
  });
  it("rejects stale photos and out-of-frame refinement before SDK submission", async () => {
    const { app, session, client, cookie } = await setup();
    const submit = vi.spyOn(client, "submit");
    expect((await app.request("/api/jobs/segment", post(cookie, { mode: "text", text: "dog", imageId: crypto.randomUUID() }))).status).toBe(409);
    expect((await app.request("/api/jobs/segment", post(cookie, { mode: "points", imageId: session.image!.id,
      positive: [{ x: 2, y: 0 }], negative: [] }))).status).toBe(400);
    expect(submit).not.toHaveBeenCalled();
  });
  it("stores nonempty candidates in score order and unions selected masks", async () => {
    const { app, session, client, cookie, png } = await setup();
    const secondMask = await encodeMask(Uint8Array.from([0, 255, 0, 0]), 2, 2);
    const empty = await encodeMask(new Uint8Array(4), 2, 2);
    const remote = remoteJob([png, secondMask, empty]);
    vi.spyOn(client, "submit").mockResolvedValue(remote);
    const response = await app.request("/api/jobs/segment", post(cookie, { mode: "text", text: "dog", imageId: session.image!.id }));
    expect(response.status).toBe(202);
    const managed = session.job!;
    await managed.done;
    expect(managed.snapshot.status).toBe("completed");
    expect(managed.snapshot.candidates).toHaveLength(2);
    expect(managed.snapshot.candidates.map(c => c.bounds)).toEqual([
      { x: 0, y: 0, width: 2, height: 2 }, { x: 1, y: 0, width: 1, height: 1 },
    ]);
    const confirmed = await app.request("/api/selection", post(cookie, { imageId: session.image!.id,
      candidateIds: managed.snapshot.candidates.map(candidate => candidate.id) }));
    expect(confirmed.status).toBe(200);
    const maskFile = await app.request(session.selection!.url, { headers: { cookie } });
    const decoded = await decodeMask(new Uint8Array(await maskFile.arrayBuffer()), 2, 2);
    expect([...decoded.pixels]).toEqual([255, 255, 0, 255]);
    expect((await app.request("/api/selection", post(cookie, { imageId: session.image!.id, candidateIds: [crypto.randomUUID()] }))).status).toBe(400);
  });
  it("reuses identical masks across independent SAM jobs without duplicating subjects", async () => {
    const { app, session, client, cookie, png } = await setup();
    const submit = vi.spyOn(client, "submit").mockImplementation(async () => remoteJob([png, png]));
    const request = { mode: "text", text: "dog", imageId: session.image!.id };
    await app.request("/api/jobs/segment", post(cookie, request));
    await session.job!.done;
    const original = session.job!.snapshot.candidates;
    expect(original).toHaveLength(1);
    await app.request("/api/jobs/segment", post(cookie, request));
    await session.job!.done;
    expect(submit).toHaveBeenCalledTimes(2);
    expect(session.job!.snapshot.candidates).toEqual(original);
    expect(session.candidates.size).toBe(1);
  });
  it("reserves one active job while submission is pending and cancels its eventual handle", async () => {
    const { app, session, client, cookie } = await setup();
    let resolveSubmit!: (job: Job) => void;
    const submit = vi.spyOn(client, "submit").mockImplementation(() => new Promise(resolve => { resolveSubmit = resolve; }));
    await app.request("/api/jobs/segment", post(cookie, { mode: "text", text: "dog", imageId: session.image!.id }));
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
    const managed = session.job!;
    expect((await app.request("/api/jobs/segment", post(cookie, { mode: "text", text: "cat", imageId: session.image!.id }))).status).toBe(409);
    await app.request(`/api/jobs/${managed.snapshot.id}/cancel`, { method: "POST", headers: { cookie } });
    const remote = remoteJob([]);
    resolveSubmit(remote);
    await managed.done;
    expect(remote.cancel).toHaveBeenCalledOnce();
    expect(managed.snapshot.status).toBe("cancelled");
  });
  it("finishes through polling when the progress stream fails", async () => {
    const { app, session, client, cookie } = await setup();
    const remote = remoteJob([]);
    vi.spyOn(remote, "events").mockImplementation(async function* () { throw new Error("SSE offline"); });
    vi.spyOn(client, "submit").mockResolvedValue(remote);
    await app.request("/api/jobs/segment", post(cookie, { mode: "text", text: "dog", imageId: session.image!.id }));
    await session.job!.done;
    expect(session.job!.snapshot).toMatchObject({ status: "completed", candidates: [], message: expect.stringContaining("Nothing found") });
  });
  it("surfaces SDK submission errors as a terminal job", async () => {
    const { app, session, client, cookie } = await setup();
    vi.spyOn(client, "submit").mockRejectedValue(new Error("Proxy is unavailable"));
    await app.request("/api/jobs/segment", post(cookie, { mode: "text", text: "dog", imageId: session.image!.id }));
    await session.job!.done;
    expect(session.job!.snapshot).toMatchObject({ status: "failed", error: "Proxy is unavailable" });
  });
});
