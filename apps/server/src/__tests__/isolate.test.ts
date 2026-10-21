import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Comfy } from "@comfyorg/sdk";
import type { Job } from "@comfyorg/sdk";
import { DEFAULT_CAPTION } from "@h3-motion/shared";
import { createApp } from "../app.js";
import { SessionStore } from "../sessions.js";
import { encodeMask } from "../media/masks.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const post = (cookie: string, body: unknown) => ({ method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "h3m-isolate-")); roots.push(root);
  const store = new SessionStore(root), client = new Comfy();
  const app = createApp({ store, client, health: async () => true });
  const response = await app.request("/api/sessions", { method: "POST" });
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  const session = [...store.sessions.values()][0];
  const png = await encodeMask(Uint8Array.from([0, 255, 0, 0]), 2, 2);
  session.image = { ...await store.savePng(session, png), width: 2, height: 2 };
  session.selection = { ...await store.savePng(session, png), width: 2, height: 2 };
  const request = { imageId: session.image.id, maskId: session.selection.id, userText: "dog", seed: 42 };
  return { app, store, client, session, cookie, png, request };
}

function remote(outputs: Record<string, Uint8Array[]>, wait: () => Promise<void> = async () => undefined): Job {
  return { status: "succeeded", result: vi.fn(wait), cancel: vi.fn(async () => undefined),
    async *events() { yield { kind: "progress", value: 0.5, message: null }; },
    getOutputs: vi.fn((id: string) => (outputs[id] ?? []).map(bytes => ({ toBytes: async () => bytes }))),
  } as unknown as Job;
}
const description = () => remote({ "5": [new TextEncoder().encode("the brown dog on the left")],
  "6": [new TextEncoder().encode('{"subject":"the brown dog","scene":"on a lawn"}')] });

describe("isolation pipeline", () => {
  it("chains description into removal, publishes a plate, and reuses the description for retries", async () => {
    const { app, client, session, cookie, png, request } = await setup();
    const submit = vi.spyOn(client, "submit").mockResolvedValueOnce(description()).mockResolvedValueOnce(remote({ "19": [png] }));
    expect((await app.request("/api/jobs/isolate", post(cookie, request))).status).toBe(202);
    await session.job!.done;
    expect(session.job!.snapshot).toMatchObject({ status: "completed", stage: "isolate", isolation: {
      imageId: request.imageId, maskId: request.maskId, seed: 42, phrase: "the brown dog on the left",
      caption: { subject: "the brown dog", scene: "on a lawn" }, instruction: expect.stringContaining("Remove the brown dog on the left from <image1>") } });
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[1][0].json["6"]).toMatchObject({ inputs: { prompt: session.isolation!.instruction } });
    expect((await app.request(session.isolation!.plate.url, { headers: { cookie } })).status).toBe(200);
    submit.mockResolvedValueOnce(remote({ "19": [png] }));
    await app.request("/api/jobs/isolate", post(cookie, { ...request, instruction: "Remove only the dog, keeping the grass.", seed: 43 }));
    await session.job!.done;
    expect(submit).toHaveBeenCalledTimes(3);
    expect(session.isolation).toMatchObject({ seed: 43, instruction: "Remove only the dog, keeping the grass." });
    expect(submit.mock.calls[2][0].json["3"]).toMatchObject({ class_type: "UNETLoader" });
  });
  it("does not let malformed caption JSON block the edit", async () => {
    const { app, client, session, cookie, png, request } = await setup();
    vi.spyOn(client, "submit").mockResolvedValueOnce(remote({ "5": [], "6": [new TextEncoder().encode("oops")] })).mockResolvedValueOnce(remote({ "19": [png] }));
    await app.request("/api/jobs/isolate", post(cookie, request)); await session.job!.done;
    expect(session.isolation).toMatchObject({ phrase: "the selected dog", caption: { style: DEFAULT_CAPTION.style } });
  });
  it("uses a custom instruction directly without requiring description generation", async () => {
    const { app, client, session, cookie, png, request } = await setup();
    const submit = vi.spyOn(client, "submit").mockResolvedValue(remote({ "19": [png] }));
    await app.request("/api/jobs/isolate", post(cookie, { ...request, instruction: "Remove the dog." })); await session.job!.done;
    expect(submit).toHaveBeenCalledOnce();
    expect(session.isolation?.instruction).toBe("Remove the dog.");
    expect(session.isolation?.descriptionSource).toBe("fallback");
    expect(session.description).toBeUndefined();
    submit.mockResolvedValueOnce(description()).mockResolvedValueOnce(remote({ "19": [png] }));
    await app.request("/api/jobs/isolate", post(cookie, request)); await session.job!.done;
    expect(submit).toHaveBeenCalledTimes(3);
    expect(session.description).toMatchObject({ phrase: "the brown dog on the left", userText: "dog" });
    expect(session.isolation?.descriptionSource).toBe("model");
  });
  it("regenerates a cached description when the subject hint changes", async () => {
    const { app, client, session, cookie, png, request } = await setup();
    const submit = vi.spyOn(client, "submit").mockResolvedValueOnce(description()).mockResolvedValueOnce(remote({ "19": [png] }));
    await app.request("/api/jobs/isolate", post(cookie, request)); await session.job!.done;
    submit.mockResolvedValueOnce(description()).mockResolvedValueOnce(remote({ "19": [png] }));
    await app.request("/api/jobs/isolate", post(cookie, { ...request, userText: "brown dog" })); await session.job!.done;
    expect(submit).toHaveBeenCalledTimes(4);
    expect(submit.mock.calls[2][0].json["3"]).toMatchObject({ inputs: { prompt: expect.stringContaining('"brown dog"') } });
    expect(session.description?.userText).toBe("brown dog");
  });
  it("rejects stale masks and unconfirmed selections before submitting", async () => {
    const { app, client, session, cookie, request } = await setup();
    const submit = vi.spyOn(client, "submit");
    expect((await app.request("/api/jobs/isolate", post(cookie, { ...request, maskId: crypto.randomUUID() }))).status).toBe(409);
    session.selection = undefined;
    expect((await app.request("/api/jobs/isolate", post(cookie, request))).status).toBe(409);
    expect(submit).not.toHaveBeenCalled();
  });
  it("reserves the session for the whole chain and cancels a second-stage submission in flight", async () => {
    const { app, client, session, cookie, request } = await setup();
    let resolveSubmit!: (job: Job) => void;
    const submit = vi.spyOn(client, "submit").mockResolvedValueOnce(description()).mockImplementationOnce(() => new Promise(resolve => { resolveSubmit = resolve; }));
    await app.request("/api/jobs/isolate", post(cookie, request));
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    const managed = session.job!;
    expect((await app.request("/api/jobs/segment", post(cookie, { mode: "text", imageId: request.imageId, text: "dog" }))).status).toBe(409);
    await app.request(`/api/jobs/${managed.snapshot.id}/cancel`, { method: "POST", headers: { cookie } });
    const edit = remote({}); resolveSubmit(edit); await managed.done;
    expect(edit.cancel).toHaveBeenCalledOnce();
    expect(managed.snapshot.status).toBe("cancelled");
    expect(session.isolation).toBeUndefined();
  });
  it("does not start removal when cancellation arrives between the two stages", async () => {
    const { app, client, session, cookie, request } = await setup();
    let release!: () => void;
    const text = description();
    const captionOutputs = text.getOutputs("6");
    vi.spyOn(text, "getOutputs").mockImplementation(id => {
      if (id !== "5") return captionOutputs;
      return [{ toBytes: () => new Promise<Uint8Array>(resolve => { release = () => resolve(new TextEncoder().encode("the dog")); }) }] as unknown as ReturnType<Job["getOutputs"]>;
    });
    const submit = vi.spyOn(client, "submit").mockResolvedValue(text);
    await app.request("/api/jobs/isolate", post(cookie, request));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const managed = session.job!;
    await app.request(`/api/jobs/${managed.snapshot.id}/cancel`, { method: "POST", headers: { cookie } });
    release(); await managed.done;
    expect(submit).toHaveBeenCalledOnce();
    expect(managed.snapshot.status).toBe("cancelled");
  });
  it("reports cancellation when result polling rejects before the remote status changes", async () => {
    const { app, client, session, cookie, request } = await setup();
    let rejectResult!: (error: Error) => void;
    const edit = remote({}, () => new Promise((_resolve, reject) => { rejectResult = reject; }));
    vi.spyOn(client, "submit").mockResolvedValue(edit);
    await app.request("/api/jobs/isolate", post(cookie, { ...request, instruction: "Remove the dog." }));
    await vi.waitFor(() => expect(rejectResult).toBeTypeOf("function"));
    const managed = session.job!;
    await app.request(`/api/jobs/${managed.snapshot.id}/cancel`, { method: "POST", headers: { cookie } });
    rejectResult(new TypeError("fetch failed"));
    await managed.done;
    expect(managed.snapshot).toMatchObject({ status: "cancelled", error: null });
  });
  it("reports cancellation when cancelling a pending submission's eventual handle throws", async () => {
    const { app, client, session, cookie, request } = await setup();
    let resolveSubmit!: (job: Job) => void;
    const submit = vi.spyOn(client, "submit").mockImplementation(() => new Promise(resolve => { resolveSubmit = resolve; }));
    await app.request("/api/jobs/isolate", post(cookie, { ...request, instruction: "Remove the dog." }));
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
    const managed = session.job!;
    await app.request(`/api/jobs/${managed.snapshot.id}/cancel`, { method: "POST", headers: { cookie } });
    const edit = remote({});
    vi.mocked(edit.cancel).mockRejectedValue(new Error("Cancel transport failed"));
    resolveSubmit(edit);
    await managed.done;
    expect(managed.snapshot).toMatchObject({ status: "cancelled", error: null });
    expect(edit.result).not.toHaveBeenCalled();
  });
  it("retains the last successful background when a retry fails", async () => {
    const { app, client, session, cookie, png, request } = await setup();
    const submit = vi.spyOn(client, "submit").mockResolvedValue(remote({ "19": [png] }));
    await app.request("/api/jobs/isolate", post(cookie, { ...request, instruction: "Remove the dog." })); await session.job!.done;
    const previous = session.isolation;
    submit.mockRejectedValue(new Error("GPU unavailable"));
    await app.request("/api/jobs/isolate", post(cookie, request)); await session.job!.done;
    expect(session.job!.snapshot).toMatchObject({ status: "failed", error: "GPU unavailable" });
    expect(session.isolation).toBe(previous);
  });
  it.each(["photo", "selection", "refinement"])("invalidates description and plate after changing the %s", async change => {
    const { app, client, session, cookie, png, request } = await setup();
    vi.spyOn(client, "submit").mockResolvedValueOnce(description()).mockResolvedValue(remote({ "19": [png] }));
    await app.request("/api/jobs/isolate", post(cookie, request));
    await session.job!.done;
    expect(session.description).toBeDefined();
    expect(session.isolation).toBeDefined();
    let response: Response;
    if (change === "photo") {
      const form = new FormData();
      form.set("image", new File([new Uint8Array(png)], "new.png", { type: "image/png" }));
      response = await app.request("/api/images", { method: "POST", headers: { cookie }, body: form });
    } else if (change === "selection") {
      const candidate = { ...session.selection!, imageId: request.imageId, bounds: { x: 1, y: 0, width: 1, height: 1 } };
      session.candidates.set(candidate.id, candidate);
      response = await app.request("/api/selection", post(cookie, { imageId: request.imageId, candidateIds: [candidate.id] }));
    } else {
      response = await app.request("/api/jobs/segment", post(cookie, { mode: "points", imageId: request.imageId, positive: [{ x: 1, y: 0 }], negative: [] }));
      await session.job!.done;
    }
    expect(response.ok).toBe(true);
    expect(session.description).toBeUndefined();
    expect(session.isolation).toBeUndefined();
  });
  it("rejects a plate with the wrong dimensions", async () => {
    const { app, client, session, cookie, request } = await setup();
    vi.spyOn(client, "submit").mockResolvedValue(remote({ "19": [await encodeMask(new Uint8Array(9), 3, 3)] }));
    await app.request("/api/jobs/isolate", post(cookie, { ...request, instruction: "Remove the dog." })); await session.job!.done;
    expect(session.job!.snapshot).toMatchObject({ status: "failed", error: expect.stringContaining("dimensions") });
  });
});
