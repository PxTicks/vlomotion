import type { EncodeInpaintMessage, EncodeInpaintRequest } from "./encode.worker";

export function renderInpaintVideos(request: EncodeInpaintRequest, onProgress: (value: number) => void, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<Extract<EncodeInpaintMessage, { kind: "done" }>>((resolve, reject) => {
    const worker = new Worker(new URL("./encode.worker.ts", import.meta.url), { type: "module" });
    const cleanup = () => { worker.terminate(); signal.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(new DOMException("Cancelled", "AbortError")); };
    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = (event: MessageEvent<EncodeInpaintMessage>) => {
      const message = event.data;
      if (message.kind === "progress") onProgress(message.value);
      else { cleanup(); if (message.kind === "error") reject(new Error(message.message)); else resolve(message); }
    };
    worker.onerror = event => { cleanup(); reject(new Error(event.message || "Could not prepare the video.")); };
    worker.postMessage(request);
  });
}
