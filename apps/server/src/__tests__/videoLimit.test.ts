import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_VIDEO_UPLOAD_BYTES } from "@h3-motion/shared";
import { createApp } from "../app.js";
import { SessionStore } from "../sessions.js";

// Exercise both sides of the boundary without allocating a 200 MB request for each test.
vi.mock("@h3-motion/shared", async importOriginal => ({
  ...await importOriginal<typeof import("@h3-motion/shared")>(), MAX_VIDEO_UPLOAD_BYTES: 16 * 1024,
}));

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "h3m-video-limit-")); roots.push(root);
  const store = new SessionStore(root);
  const app = createApp({ store, health: async () => true });
  const response = await app.request("/api/sessions", { method: "POST" });
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  const fixture = await readFile(new URL("./fixtures/black-480-124.mp4", import.meta.url));
  const file = (size: number) => {
    const bytes = new Uint8Array(size); bytes.set(fixture);
    return new File([bytes], "clip.mp4", { type: "video/mp4" });
  };
  return { app, cookie, store, file };
}

describe("video upload file size limits", () => {
  it.each([MAX_VIDEO_UPLOAD_BYTES - 1, MAX_VIDEO_UPLOAD_BYTES])("accepts a %s-byte file plus its multipart framing", async size => {
    const { app, cookie, file } = await setup();
    const form = new FormData(); form.set("video", file(size));
    const response = await app.request("/api/videos", { method: "POST", headers: { cookie }, body: form });
    expect(response.status).toBe(201);
  });
  it("rejects a source file one byte over the limit", async () => {
    const { app, cookie, store, file } = await setup();
    const form = new FormData(); form.set("video", file(MAX_VIDEO_UPLOAD_BYTES + 1));
    const response = await app.request("/api/videos", { method: "POST", headers: { cookie }, body: form });
    expect(response.status).toBe(413);
    expect([...store.sessions.values()][0].video).toBeUndefined();
  });
  it.each(["inpaint", "animate"])("enforces the combined file limit for %s jobs", async stage => {
    const { app, cookie, store, file } = await setup();
    const form = new FormData(); form.set("request", "{}");
    form.set("source", file(MAX_VIDEO_UPLOAD_BYTES / 2));
    form.set("mask", file(MAX_VIDEO_UPLOAD_BYTES / 2 + 1));
    const response = await app.request(`/api/jobs/${stage}`, { method: "POST", headers: { cookie }, body: form });
    expect(response.status).toBe(413);
    expect([...store.sessions.values()][0].job).toBeUndefined();
  });
});
