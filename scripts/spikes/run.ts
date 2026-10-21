import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Comfy } from "@comfyorg/sdk";
import type { Job, Workflow } from "@comfyorg/sdk";
import sharp from "sharp";
import { z } from "zod";
import { pointSchema, segmentRequestSchema } from "@h3-motion/shared";
import { buildSegmentWorkflow, loadTemplate } from "../../apps/server/src/workflows/templates.js";
import { DATA_ROOT } from "../../apps/server/src/config.js";

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  image: { type: "string" }, text: { type: "string", default: "dog" },
  positive: { type: "string" }, negative: { type: "string", default: "[]" },
  "clip-type": { type: "string", default: "qwen_image" },
} });
const spike = positionals[0];
if (!["s1", "s2", "s3"].includes(spike ?? "")) {
  console.info("Usage: npm run spike -- s1\n       npm run spike -- s2 --image photo.png --text dog\n       npm run spike -- s2 --image photo.png --positive '[{\"x\":100,\"y\":100}]'\n       npm run spike -- s3 --image highlight.png [--clip-type qwen_image|ideogram4]");
  process.exitCode = 1;
} else {
  const client = new Comfy({ timeoutMs: 30_000, clientInfo: "h3-motion-spikes" });
  const directory = join(DATA_ROOT, "spikes", `${spike}-${Date.now()}`);
  await mkdir(directory, { recursive: true });
  try {
    if (spike === "s1") {
      const fixture = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#f2ff59" } }).png().toBuffer();
      const graph = {
        "1": { class_type: "LoadImage", inputs: { image: "fixture.png" } },
        "2": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "h3m/spike_s1_image" } },
      };
      const workflow = client.workflows.fromJson(structuredClone(graph));
      workflow.setInput("1", "image", client.assets.fromBytes(fixture, { filename: "fixture.png", contentType: "image/png" }));
      const first = await client.run(workflow);
      assert.equal(first.getOutputs("2").length, 1, "SaveImage must return one output");
      const decoded = await sharp(await first.getOutputs("2")[0].toBytes()).raw().toBuffer();
      assert.deepEqual([...decoded.subarray(0, 3)], [242, 255, 89], "SDK asset round-trip must preserve PNG pixels");
      const fixturePath = join(directory, "input.png");
      await writeFile(fixturePath, fixture);
      const full = client.workflows.fromJson({ ...structuredClone(graph),
        "3": { class_type: "SaveText", inputs: { text: "", filename_prefix: "h3m/spike_s1_text", format: "json" } },
        "4": { class_type: "RepeatImageBatch", inputs: { image: ["1", 0], amount: 5 } },
        "5": { class_type: "CreateVideo", inputs: { images: ["4", 0], fps: 24 } },
        "6": { class_type: "SaveVideo", inputs: { video: ["5", 0], filename_prefix: "h3m/spike_s1_video", format: "mp4", "format.codec": "h264", "format.codec.encoding": "auto" } },
      });
      full.setInput("1", "image", client.assets.fromFile(fixturePath));
      full.setInput("3", "text", '{"sdk":"ok"}');
      const job = await execute(full);
      assert.equal(job.getOutputs("2").length, 1, "SaveImage output missing");
      assert.equal(job.getOutputs("3").length, 1, "SaveText file output missing");
      assert.equal(job.getOutputs("6").length, 1, "SaveVideo output missing");
      assert.deepEqual(JSON.parse(new TextDecoder().decode(await job.getOutputs("3")[0].toBytes())), { sdk: "ok" });
      console.info("PASS S1: SDK run, submit, assets, primitives, events, SaveImage/SaveText/SaveVideo outputs.");
    } else if (spike === "s2") {
      if (!values.image) throw new Error("S2 requires --image pointing to a real photo.");
      const points = z.array(pointSchema);
      const request = segmentRequestSchema.parse(values.positive
        ? { mode: "points", imageId: randomUUID(), positive: points.parse(JSON.parse(values.positive)), negative: points.parse(JSON.parse(values.negative!)) }
        : { mode: "text", imageId: randomUUID(), text: values.text });
      const job = await execute(await buildSegmentWorkflow(client, request, resolve(values.image)));
      console.info(`S2 ${request.mode}: ${job.getOutputs("6").length} mask files. Inspect overlays to judge segmentation quality.`);
    } else {
      if (!values.image) throw new Error("S3 requires --image pointing to a highlighted photo.");
      if (!["qwen_image", "ideogram4"].includes(values["clip-type"]!)) throw new Error("Use --clip-type qwen_image or ideogram4.");
      const workflow = client.workflows.fromJson(structuredClone(await loadTemplate("describe")));
      workflow.setInput("1", "type", values["clip-type"]);
      workflow.setInput("2", "image", client.assets.fromFile(resolve(values.image)));
      const job = await execute(workflow);
      for (const node of ["5", "6"]) {
        assert.equal(job.getOutputs(node).length, 1, `Text generation file missing for node ${node}`);
        const text = new TextDecoder().decode(await job.getOutputs(node)[0].toBytes());
        assert.ok(text.trim(), "TextGenerate returned empty text");
        console.info(node === "5" ? "Phrase:" : "Caption:", text);
      }
      console.info(`S3 completed using CLIP type ${values["clip-type"]}. Check caption validity and image grounding in the saved outputs.`);
    }
    await writeFile(join(directory, "result.json"), JSON.stringify({ spike, status: "completed", note: "Visual quality requires inspection for S2/S3." }, null, 2));
    console.info("Artifacts:", directory);
  } catch (error) {
    await writeFile(join(directory, "result.json"), JSON.stringify({ spike, status: "failed", error: error instanceof Error ? error.message : String(error) }, null, 2));
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }

  async function execute(workflow: Workflow): Promise<Job> {
    const job = await client.submit(workflow);
    console.info("Submitted job", job.id);
    const abort = new AbortController();
    const events = (async () => {
      try {
        for await (const event of job.events(abort.signal)) {
          if (event.kind === "progress") console.info(`Progress ${Math.round(event.value * 100)}%`, event.message ?? "");
          if (event.kind === "statusChange") console.info("Status", event.status);
        }
      } catch { /* Polling remains authoritative when live events are unavailable. */ }
    })();
    try {
      await job.result();
      for (const output of job.outputs) await output.toFile(join(directory, `${output.nodeId}-${basename(output.name)}`));
      return job;
    } finally { abort.abort(); await events; }
  }
}
