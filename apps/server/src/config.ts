import { fileURLToPath } from "node:url";
import { DEFAULT_PROXY_URL } from "@h3-motion/shared";

export const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
export const DATA_ROOT = fileURLToPath(new URL("../../../.data/", import.meta.url));
export const COMFY_BASE_URL = process.env.COMFY_BASE_URL ?? DEFAULT_PROXY_URL;
// The SDK resolves the deployment from this environment variable.
process.env.COMFY_BASE_URL = COMFY_BASE_URL;
