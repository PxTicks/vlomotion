import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { Comfy } from "@comfyorg/sdk";
import { ComfyLow } from "@comfyorg/sdk/low";
import { DATA_ROOT } from "../../apps/server/src/config.js";
import { SessionStore } from "../../apps/server/src/sessions.js";
import { startIsolate } from "../../apps/server/src/jobs/isolate.js";
import { cancelJob } from "../../apps/server/src/jobs/runtime.js";

const { values } = parseArgs({ options: { fixture: { type: "boolean" }, image: { type: "string" }, mask: { type: "string" },
  text: { type: "string", default: "red ball" }, instruction: { type: "string" } } });
const directory = join(DATA_ROOT, "spikes", `isolate-${Date.now()}`);
await mkdir(directory, { recursive: true });

try {
  const uiUrl = process.env.COMFY_UI_URL ?? "http://127.0.0.1:8188";
  const low = new ComfyLow(uiUrl, undefined, { timeoutMs: 5000 });
  const queue = await (await low.request("GET", `${uiUrl.replace(/\/$/, "")}/queue`)).json() as { queue_running?: unknown[]; queue_pending?: unknown[] };
  if (queue.queue_running?.length || queue.queue_pending?.length) throw new Error("ComfyUI already has queued work. No isolation spike was submitted.");
  const store = new SessionStore(directory), session = store.create();
  let original: Buffer, mask: Buffer;
  if (values.fixture) {
    original = await sharp(Buffer.from('<svg width="512" height="320"><rect width="512" height="320" fill="#eee9dd"/><rect y="220" width="512" height="100" fill="#bcb6a8"/><circle cx="255" cy="151" r="64" fill="#c4382e"/><ellipse cx="235" cy="131" rx="17" ry="21" fill="#e75c49"/></svg>')).png().toBuffer();
    mask = await sharp(Buffer.from('<svg width="512" height="320"><rect width="512" height="320" fill="black"/><circle cx="255" cy="151" r="64" fill="white"/></svg>')).png().toBuffer();
  } else {
    if (!values.image || !values.mask) throw new Error("Use --fixture or --image original.png --mask subject.png [--text dog].");
    original = await readFile(resolve(values.image)); mask = await readFile(resolve(values.mask));
  }
  const info = await sharp(original).metadata();
  const width = info.width!, height = info.height!;
  session.image = { ...await store.savePng(session, original), width, height };
  session.selection = { ...await store.savePng(session, mask), width, height };
  const managed = startIsolate(new Comfy({ timeoutMs: 30_000, clientInfo: "h3-motion-isolate-spike" }), store, session,
    { imageId: session.image.id, maskId: session.selection.id, userText: values.text!, instruction: values.instruction, seed: 6332 });
  const cancel = () => { void cancelJob(managed); };
  process.on("SIGINT", cancel);
  let previous = "";
  const timer = setInterval(() => {
    const status = `${managed.snapshot.stage ?? "prepare"}: ${managed.snapshot.message} (${Math.round((managed.snapshot.progress ?? 0) * 100)}%)`;
    if (status !== previous) { console.info(status); previous = status; }
  }, 1000);
  try { await managed.done; } finally { clearInterval(timer); process.off("SIGINT", cancel); }
  await writeFile(join(directory, "result.json"), JSON.stringify(managed.snapshot, null, 2));
  if (managed.snapshot.status !== "completed") throw new Error(managed.snapshot.error ?? managed.snapshot.message);
  const plate = managed.snapshot.isolation!.plate;
  await writeFile(join(directory, "plate.png"), await readFile(session.files.get(plate.id)!));
  await writeFile(join(directory, "original.png"), original);
  await writeFile(join(directory, "mask.png"), mask);
  console.info("PASS: description → Qwen removal → masked composite.");
  console.info("Subject:", managed.snapshot.isolation!.phrase);
  console.info("Artifacts:", directory);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
