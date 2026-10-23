import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { serveStatic } from "@hono/node-server/serve-static";
import { ZodError } from "zod";
import sharp from "sharp";
import type { Comfy } from "@comfyorg/sdk";
import { animateRequestSchema, aspectRatioSchema, generationSize, isolateRequestSchema, segmentRequestSchema, selectionRequestSchema } from "@h3-motion/shared";
import type { AnimateRequest } from "@h3-motion/shared";
import { comfy, checkComfyHealth } from "./comfy.js";
import { REPO_ROOT } from "./config.js";
import { SessionStore, clearIsolation, isBusy } from "./sessions.js";
import type { Session } from "./sessions.js";
import { startSegment } from "./jobs/segment.js";
import { startIsolate } from "./jobs/isolate.js";
import { startAnimate } from "./jobs/animate.js";
import { cancelJob } from "./jobs/runtime.js";
import { decodeMask, encodeMask } from "./media/masks.js";
import { inspectVideo } from "./media/video.js";

type AppEnvironment = { Variables: { session: Session } };
interface AppOptions { store?: SessionStore; client?: Comfy; health?: () => Promise<boolean> }
const GENERATION_SIZES = aspectRatioSchema.options.flatMap(ratio => ([480, 720] as const).map(tier => generationSize(ratio, tier)));
const CONTENT_TYPES: Record<string, string> = { ".png": "image/png", ".mp4": "video/mp4", ".webm": "video/webm" };

async function readVideoUpload(value: FormDataEntryValue | null, request: AnimateRequest, label: string) {
  if (!(value instanceof File)) throw new HTTPException(400, { message: `The ${label} video is missing.` });
  const bytes = new Uint8Array(await value.arrayBuffer());
  const info = await inspectVideo(bytes).catch(() => { throw new HTTPException(400, { message: `The ${label} video can't be read. Use MP4 or WebM.` }); });
  if (info.width !== request.width || info.height !== request.height || info.frames !== request.frames) {
    throw new HTTPException(400, { message: `The ${label} video must be ${request.width} × ${request.height} with exactly ${request.frames} frames; it is ${info.width} × ${info.height} with ${info.frames}.` });
  }
  return { bytes, container: info.container };
}

export function createApp(options: AppOptions = {}) {
  const store = options.store ?? new SessionStore();
  const client = options.client ?? comfy;
  const app = new Hono<AppEnvironment>();

  const photoLimit = bodyLimit({ maxSize: 20 * 1024 * 1024,
    onError: c => c.json({ error: "Photo is too large. Choose an image under 20 MB." }, 413) });
  const videoLimit = bodyLimit({ maxSize: 200 * 1024 * 1024,
    onError: c => c.json({ error: "The motion videos are too large to upload." }, 413) });
  app.use("/api/*", (c, next) => (c.req.path === "/api/jobs/animate" ? videoLimit : photoLimit)(c, next));
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    if (c.req.path === "/api/health" || (c.req.path === "/api/sessions" && c.req.method === "POST")) return next();
    const id = getCookie(c, "h3m_session");
    const session = id ? store.sessions.get(id) : undefined;
    if (!session) throw new HTTPException(401, { message: "Session expired. Reload the page to start again." });
    c.set("session", session);
    await next();
  });
  app.get("/api/health", async c => c.json({ server: "ok", comfy: await (options.health ?? checkComfyHealth)() ? "ok" : "unavailable" }));
  app.post("/api/sessions", c => {
    const id = getCookie(c, "h3m_session");
    const session = (id && store.sessions.get(id)) || store.create();
    setCookie(c, "h3m_session", session.id, { httpOnly: true, sameSite: "Strict", path: "/", secure: c.req.url.startsWith("https:") });
    return c.json({ id: session.id });
  });
  app.post("/api/images", async c => {
    const session = c.get("session");
    if (isBusy(session)) throw new HTTPException(409, { message: "Cancel the active job before changing the photo." });
    const form = await c.req.formData();
    const file = form.get("image");
    if (!(file instanceof File)) throw new HTTPException(400, { message: "Choose a photo to upload." });
    let png: Buffer;
    let width: number, height: number;
    try {
      const image = sharp(new Uint8Array(await file.arrayBuffer()), { limitInputPixels: 8_000_000 });
      const metadata = await image.metadata();
      if (!["png", "jpeg", "webp"].includes(metadata.format ?? "")) throw new Error("Unsupported format");
      const normalized = await image.rotate().removeAlpha().png().toBuffer({ resolveWithObject: true });
      png = normalized.data;
      width = normalized.info.width; height = normalized.info.height;
      if (width > 2560 || height > 2560) throw new Error("Image too large");
    } catch {
      throw new HTTPException(400, { message: "Use a PNG, JPEG or WebP photo with a working size no larger than 2560 pixels per side." });
    }
    if (isBusy(session)) throw new HTTPException(409, { message: "A job is already running." });
    const saved = await store.savePng(session, png);
    if (isBusy(session)) throw new HTTPException(409, { message: "A job started while the photo was uploading. Wait for it to finish or cancel it before replacing the photo." });
    session.image = { ...saved, width, height };
    session.candidates.clear(); session.selection = undefined; session.job = undefined;
    clearIsolation(session);
    return c.json({ id: saved.id, url: saved.url, width, height }, 201);
  });
  app.get("/api/files/:id", async c => {
    const path = c.get("session").files.get(c.req.param("id"));
    if (!path) throw new HTTPException(404, { message: "File not found in this session." });
    const bytes = await readFile(path);
    const type = CONTENT_TYPES[extname(path)] ?? "application/octet-stream";
    if (!type.startsWith("video/")) return c.body(new Uint8Array(bytes), 200, { "Content-Type": type });
    // Video elements seek with byte ranges.
    const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header("Range") ?? "");
    if (!range) return c.body(new Uint8Array(bytes), 200, { "Content-Type": type, "Accept-Ranges": "bytes" });
    const start = range[1] ? Number(range[1]) : Math.max(0, bytes.length - Number(range[2] || 0));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
    if ((!range[1] && !range[2]) || start > end) return c.body(null, 416, { "Content-Range": `bytes */${bytes.length}` });
    return c.body(new Uint8Array(bytes.subarray(start, end + 1)), 206,
      { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${bytes.length}` });
  });
  app.post("/api/jobs/segment", async c => {
    const session = c.get("session");
    const request = segmentRequestSchema.parse(await c.req.json());
    if (!session.image || request.imageId !== session.image.id) throw new HTTPException(409, { message: "The photo has changed. Select the subject again." });
    if (isBusy(session)) throw new HTTPException(409, { message: "A job is already running in this session." });
    let prior: { path: string } | undefined;
    if (request.mode === "points") {
      if (request.candidateId) {
        const candidate = session.candidates.get(request.candidateId);
        if (!candidate || candidate.imageId !== session.image.id) {
          throw new HTTPException(409, { message: "The subject mask no longer belongs to this photo. Find the subject again." });
        }
        prior = { path: candidate.path };
      }
      const { width, height } = session.image;
      if ([...request.positive, ...request.negative].some(p => p.x >= width || p.y >= height)) {
        throw new HTTPException(400, { message: "Refinement points must be inside the photo." });
      }
    }
    session.selection = undefined;
    clearIsolation(session);
    return c.json(startSegment(client, store, session, request, prior).snapshot, 202);
  });
  app.post("/api/jobs/isolate", async c => {
    const session = c.get("session");
    const request = isolateRequestSchema.parse(await c.req.json());
    if (isBusy(session)) throw new HTTPException(409, { message: "A job is already running in this session." });
    if (!session.image || session.image.id !== request.imageId || !session.selection || session.selection.id !== request.maskId) {
      throw new HTTPException(409, { message: "The photo or selection changed. Confirm your selection before isolating it." });
    }
    if (Math.min(session.image.width, session.image.height) < 2) throw new HTTPException(400, { message: "The working photo is too small to isolate." });
    return c.json(startIsolate(client, store, session, request).snapshot, 202);
  });
  app.post("/api/jobs/animate", async c => {
    const session = c.get("session");
    if (isBusy(session)) throw new HTTPException(409, { message: "A job is already running in this session." });
    const form = await c.req.formData().catch(() => { throw new HTTPException(400, { message: "Send the motion videos as a multipart form." }); });
    const request = animateRequestSchema.parse(JSON.parse(String(form.get("request") ?? "")));
    const { image, selection, isolation } = session;
    if (!image || !selection || !isolation || image.id !== request.imageId || selection.id !== request.maskId || isolation.plate.id !== request.plateId) {
      throw new HTTPException(409, { message: "The subject or background changed. Isolate it again before generating." });
    }
    if (!GENERATION_SIZES.some(size => size.width === request.width && size.height === request.height)
      || Math.abs(request.width / request.height / (image.width / image.height) - 1) > 0.02) {
      throw new HTTPException(400, { message: "The video size doesn't match the photo's aspect ratio. Reload and try again." });
    }
    const reference = await readVideoUpload(form.get("reference"), request, "reference");
    const mask = await readVideoUpload(form.get("mask"), request, "mask");
    const start = form.get("start");
    const startBytes = start instanceof File ? new Uint8Array(await start.arrayBuffer()) : undefined;
    const startInfo = startBytes ? await sharp(startBytes).metadata().catch(() => undefined) : undefined;
    if (!startBytes || startInfo?.format !== "png" || startInfo.width !== request.width || startInfo.height !== request.height) {
      throw new HTTPException(400, { message: `The start frame must be a ${request.width} × ${request.height} PNG.` });
    }
    const unchanged = () => !isBusy(session) && session.image === image && session.selection === selection && session.isolation === isolation;
    if (!unchanged()) throw new HTTPException(409, { message: "The subject changed while uploading. Generate again." });
    const [startFile, referenceFile, maskFile] = await Promise.all([store.savePng(session, startBytes),
      store.saveFile(session, reference.bytes, reference.container), store.saveFile(session, mask.bytes, mask.container)]);
    if (!unchanged()) throw new HTTPException(409, { message: "The subject changed while uploading. Generate again." });
    return c.json(startAnimate(client, store, session, request,
      { startPath: startFile.path, referencePath: referenceFile.path, maskPath: maskFile.path }).snapshot, 202);
  });
  app.get("/api/jobs/:id", c => {
    const job = c.get("session").job;
    if (!job || job.snapshot.id !== c.req.param("id")) throw new HTTPException(404, { message: "Job not found." });
    return c.json(job.snapshot);
  });
  app.post("/api/jobs/:id/cancel", async c => {
    const job = c.get("session").job;
    if (!job || job.snapshot.id !== c.req.param("id")) throw new HTTPException(404, { message: "Job not found." });
    if (isBusy(c.get("session"))) await cancelJob(job);
    return c.json(job.snapshot);
  });
  app.get("/api/jobs/:id/events", c => {
    const job = c.get("session").job;
    if (!job || job.snapshot.id !== c.req.param("id")) throw new HTTPException(404, { message: "Job not found." });
    return streamSSE(c, async stream => {
      let previous = "";
      while (!stream.aborted) {
        const data = JSON.stringify(job.snapshot);
        if (data !== previous) { await stream.writeSSE({ event: "snapshot", data }); previous = data; }
        if (!["queued", "running"].includes(job.snapshot.status)) break;
        await stream.sleep(400);
      }
    });
  });
  app.post("/api/selection", async c => {
    const session = c.get("session");
    const request = selectionRequestSchema.parse(await c.req.json());
    const image = session.image;
    if (isBusy(session)) throw new HTTPException(409, { message: "Wait for the active job to finish." });
    if (!image || request.imageId !== image.id) throw new HTTPException(409, { message: "The photo has changed. Select the subject again." });
    const pixels = Buffer.alloc(image.width * image.height);
    for (const id of new Set(request.candidateIds)) {
      const candidate = session.candidates.get(id);
      if (!candidate || candidate.imageId !== image.id) throw new HTTPException(400, { message: "One of the selected masks no longer belongs to this photo." });
      const decoded = await decodeMask(await readFile(candidate.path), image.width, image.height);
      for (let i = 0; i < pixels.length; i++) pixels[i] |= decoded.pixels[i];
    }
    if (session.image !== image || isBusy(session)) throw new HTTPException(409, { message: "Selection changed. Confirm it again." });
    const saved = await store.savePng(session, await encodeMask(pixels, image.width, image.height));
    if (session.image !== image || isBusy(session)) throw new HTTPException(409, { message: "Selection changed. Confirm it again." });
    session.selection = { ...saved, width: image.width, height: image.height };
    clearIsolation(session);
    return c.json({ mask: { id: saved.id, url: saved.url, width: image.width, height: image.height } });
  });
  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
    if (error instanceof ZodError) return c.json({ error: error.issues[0]?.message ?? "Invalid request." }, 400);
    if (error instanceof SyntaxError) return c.json({ error: "Invalid JSON request." }, 400);
    console.error(error);
    return c.json({ error: "Something went wrong. Check the server log and try again." }, 500);
  });
  app.get("/api/*", c => c.json({ error: "Route not found." }, 404));
  const webRoot = join(REPO_ROOT, "apps/web/dist");
  app.use("*", serveStatic({ root: webRoot }));
  app.get("*", serveStatic({ path: join(webRoot, "index.html") }));
  return app;
}
