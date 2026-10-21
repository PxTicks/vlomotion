import { ComfyLow } from "@comfyorg/sdk/low";
import { z } from "zod";
import { DEFAULT_PROXY_URL, probeProxy, resolveComfyUi, serviceUrl } from "./lib/connection.js";

const nodes = [
  "CheckpointLoaderSimple", "CLIPTextEncode", "SAM3_Detect", "LoadImage", "MaskToImage", "SaveImage",
  "CLIPLoader", "TextGenerate", "SaveText", "UNETLoader", "VAELoader", "TextEncodeQwenImage21",
  "QwenImage21Cache", "GrowMask", "ImageBlur", "ImageToMask", "ImageCompositeMasked",
  "LoadVideo", "GetVideoComponents", "MiniMaxH3ImageToVideo", "vloTimeToMove", "CreateVideo", "SaveVideo",
];
const models = [
  ["CheckpointLoaderSimple", "ckpt_name", "sam3.1_multiplex_fp16.safetensors"],
  ["UNETLoader", "unet_name", "qwen_image_2.1_int8_convrot.safetensors"],
  ["CLIPLoader", "clip_name", "qwen3vl_8b_int8_convrot.safetensors"],
  ["VAELoader", "vae_name", "qwen_image_2.1_vae_bf16.safetensors"],
  ["UNETLoader", "unet_name", "minimax_h3_fl2va_pruned_int8_convrot.safetensors"],
  ["CLIPLoader", "clip_name", "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"],
  ["VAELoader", "vae_name", "minimax_h3_video_vae_int8_convrot.safetensors"],
  ["VAELoader", "vae_name", "minimax_h3_audio_vae_fp32.safetensors"],
] as const;

let failures = 0;
function report(ok: boolean, message: string) {
  console.info(`${ok ? "OK" : "MISSING"}  ${message}`);
  if (!ok) failures++;
}

report(Number(process.versions.node.split(".")[0]) >= 22, "Node >=22");
const proxyUrl = serviceUrl(process.env.COMFY_BASE_URL ?? DEFAULT_PROXY_URL);
const proxyHealth = await probeProxy(proxyUrl, process.env.COMFY_API_KEY);
report(!!proxyHealth, proxyHealth ? "Comfy API v2 proxy health" : "Comfy API v2 proxy is unavailable. Start it with npm run dev or set COMFY_BASE_URL.");
try {
  const comfyUiUrl = await resolveComfyUi({ proxyUrl, proxyHealth, explicitUrl: process.env.COMFY_UI_URL });
  if (!comfyUiUrl) throw new Error("Set COMFY_UI_URL to a reachable ComfyUI address to inspect the remote deployment's inventory.");
  console.info(`OK  ComfyUI ${comfyUiUrl}`);
  const ui = new ComfyLow(comfyUiUrl, undefined, { timeoutMs: 5000 });
  // Relative SDK paths gain /api/v2; the native ComfyUI inventory needs an absolute URL.
  const response = await ui.request("GET", new URL("/object_info", comfyUiUrl).href);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const info = z.record(z.string(), z.object({ input: z.object({ required: z.record(z.string(), z.unknown()).optional() }).optional() })).parse(await response.json());
  for (const name of nodes) report(name in info, `node ${name}`);
  for (const [loader, input, filename] of models) {
    const widget = info[loader]?.input?.required?.[input];
    const options: unknown = Array.isArray(widget) ? widget[0] : undefined;
    const available = z.array(z.string()).safeParse(options);
    // ComfyUI's loader list also includes extra_model_paths and nested model directories.
    report(available.success && available.data.some(path => path.replaceAll("\\", "/").split("/").at(-1) === filename), `model ${filename}`);
  }
} catch (error) {
  report(false, "ComfyUI node/model inventory is unavailable. Start ComfyUI or set COMFY_UI_URL.");
  console.info(error instanceof Error ? error.message : String(error));
  console.info("NOT CHECKED  Node classes and models (inventory unavailable).");
}
console.info(failures ? `\n${failures} environment checks need attention.` : "\nEnvironment is ready for the GPU spikes.");
process.exitCode = failures ? 1 : 0;
