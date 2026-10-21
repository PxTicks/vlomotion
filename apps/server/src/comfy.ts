import { Comfy } from "@comfyorg/sdk";
import { ComfyLow } from "@comfyorg/sdk/low";
import { COMFY_BASE_URL } from "./config.js";

export const comfy = new Comfy({ timeoutMs: 30_000, clientInfo: "h3-motion/0.0.0" });
export const comfyLow = new ComfyLow(COMFY_BASE_URL, process.env.COMFY_API_KEY, { timeoutMs: 3_000 });

export async function checkComfyHealth(): Promise<boolean> {
  try {
    const response = await comfyLow.request("GET", "/api/v2/health");
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}
