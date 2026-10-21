# H3 Motion

Lift a subject out of a photo and drag it into motion. A standalone React app
using the Comfy SDK and self-hosted ComfyUI. This is an early implementation.

Currently implemented: npm workspaces, the themed app shell, photo upload with
centre crop, text-based SAM 3.1 candidates, multiple selection, point refinement,
mask union/confirmation, session-scoped files, job progress and cancellation.
The Isolate phase describes the confirmed subject locally with Qwen3-VL, removes
it with Qwen Image 2.1, and previews the clean background. Retry with a new seed,
edit the removal instruction, or hold the preview to compare with the original.
**Motion editing and H3 generation are not implemented yet.**
The description/removal chain has passed a real GPU run against Windows ComfyUI;
broader scene-quality checks remain. No detections or generated results are simulated.

## Local development

Requires Node **22.12+** (or 24+) and npm. Start ComfyUI yourself, including on
Windows when developing in WSL. Install `uv` in WSL, or put `comfy-api-proxy`
on your PATH, so the launcher can manage the API proxy.
The automatic launcher supports WSL, Linux and macOS. Run it inside WSL when
using Windows; native Windows process supervision is not supported.

```sh
npm install
npm run dev
```

Configuration in `.env` is optional; copy `.env.example` when you want to
override the defaults.

The launcher connects to an **already running** ComfyUI. It tries
`http://127.0.0.1:8188` first (including Windows with WSL mirrored networking),
then the Windows gateway in WSL NAT mode. An explicit `COMFY_UI_URL` overrides
detection. If ComfyUI is stopped or unreachable, the launcher exits with the
addresses it checked; it never launches ComfyUI or downloads models. NAT mode
requires the Windows ComfyUI to listen on an address reachable from WSL.

It reuses a healthy API proxy, or starts a local one on `8189`. With `uv`, the
proxy package (`comfy-api-proxy==0.1.0`) is downloaded and cached automatically
on first use. Ctrl+C stops the app and only the proxy started by that invocation;
Windows ComfyUI and pre-existing proxies stay running. A failed remote proxy is
not started locally, and an occupied port is left alone.
Terminal-close signals also trigger cleanup. Shutdown gives owned process groups
up to three seconds to finish; another Ctrl+C force-stops them immediately.

For a custom setup:

```dotenv
COMFY_UI_URL=http://your-windows-host:8188
COMFY_BASE_URL=http://127.0.0.1:8189
```

Use `npm run dev:app` to launch just the app, including when developing with
ComfyUI offline or managing the proxy separately.
`PORT` (API) and `WEB_PORT` (Vite) can select different app ports if needed.
Both commands read those ports from the repository's `.env`, with shell
environment variables taking precedence. `npm run check-env` uses the same
ComfyUI discovery and proxy health checks as the automatic launcher.

Open http://127.0.0.1:5180. Vite forwards `/api` to the Hono server on `8790`.
The photo canvas works while ComfyUI is offline; selecting a subject needs the
GPU services below. Images are centre-cropped to the working ratio and a working
size of twice the generation dimensions. Changing the crop or selection clears
the confirmed mask and background. After confirming, choose **Isolate subject**.
Retries reuse the subject description; editing the instruction reruns only removal.
You can also supply an instruction before the first run to skip description.
The editor starts with the name used for selection, or stays empty for an unnamed
point selection. A manual run without a model description is labelled **Custom
removal instruction** and doesn't populate the description cache. The selection's
subject hint stays tied to the submitted search; typing a new name alone doesn't
change it. Submit **Find subject** to create a selection with the new name.
Cancellation or a failed retry keeps the last successful background.

```sh
npm test
npm run build             # tsc -b (including scripts), then Vite production build
npm start                 # serves the production app and API on 127.0.0.1:8790
```

The app binds to localhost. Session state lives in server memory; uploads and
mask files are saved under ignored `.data/`. Restarting the server expires all
sessions. Old files are not yet pruned automatically; `.data/` can be removed
after stopping the app. Reloading starts a new editing view; project persistence
is a later feature.

## GPU services

Use a current ComfyUI with the core SAM 3.1, Qwen Image 2.1, TextGenerate and
MiniMax H3 nodes. Install [ComfyUI-vlo](https://github.com/PxTicks/ComfyUI-vlo)
for the planned Time-to-Move stage. Its H3 support needs ComfyUI's per-token
mask support (upstream since August 2026). Selection requires the SAM checkpoint.
Isolation also requires the Qwen diffusion model, Qwen3-VL encoder and Qwen VAE
listed below.

Start ComfyUI on `8188`, then install and run the
[v2 proxy](https://github.com/Comfy-Org/comfy-api-proxy) manually if you prefer.
The proxy can run in WSL while ComfyUI runs on Windows; it communicates over HTTP:

```sh
pip install comfy-api-proxy
comfy-api-proxy --comfyui http://127.0.0.1:8188 --port 8189 --max-upload-mb 500
```

Configure `COMFY_BASE_URL` in `.env` for the v2 endpoint. `COMFY_API_KEY` is
optional for local use. Credentials stay on the Node server. `COMFY_UI_URL`
overrides the launcher's ComfyUI detection and lets the environment checker
inspect the GPU's node/model list. If `COMFY_API_KEY` is set, start the
authenticated proxy yourself; the launcher reuses it but will not start an
unauthenticated replacement.
The server uses `@comfyorg/sdk` for workflow submission, asset transfers,
progress and cancellation; it does not use Router or partner nodes.

```sh
npm run check-env
npm run spike -- s1
npm run spike -- s2 --image /path/to/photo.png --text dog
npm run spike -- s3 --image /path/to/highlight.png
npm run spike:isolate -- --fixture
# Or test your own photo and white-subject/black-background mask:
npm run spike:isolate -- --image /path/to/photo.png --mask /path/to/mask.png --text dog
```

See [spike evidence and remaining checks](scripts/spikes/RESULTS.md). S1 uses
only core image/text/video nodes. S2 requires SAM; S3 requires Qwen's encoder.
The isolation spike exercises the full description → removal → composite chain,
refuses to start while ComfyUI's queue is busy, and saves its inputs, plate and
result JSON under `.data/spikes/`.

## Models

Download the appropriate files from the linked model repositories into the
ComfyUI folders below. Extra model paths and nested folders are recognized by
the environment checker. The workflow templates currently use the exact widget
filenames shown; if your models are in subfolders, edit the template filenames
to match ComfyUI's loader options. Model downloads are intentionally not automatic.

| Folder | File | Repository |
| --- | --- | --- |
| checkpoints | `sam3.1_multiplex_fp16.safetensors` | [SAM 3.1](https://huggingface.co/Comfy-Org/sam3.1) |
| diffusion_models | `qwen_image_2.1_int8_convrot.safetensors` | [Qwen Image 2.1](https://huggingface.co/Comfy-Org/Qwen-Image-2.1) |
| text_encoders | `qwen3vl_8b_int8_convrot.safetensors` | Qwen Image 2.1 |
| vae | `qwen_image_2.1_vae_bf16.safetensors` | Qwen Image 2.1 |
| diffusion_models | `minimax_h3_fl2va_pruned_int8_convrot.safetensors` | [MiniMax H3](https://huggingface.co/Comfy-Org/MiniMax-H3) |
| text_encoders | `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | MiniMax H3 |
| vae | `minimax_h3_video_vae_int8_convrot.safetensors` | MiniMax H3 |
| vae | `minimax_h3_audio_vae_fp32.safetensors` | MiniMax H3 |

## Project structure

```text
apps/web/          React, Vite, MUI, Zustand; feature-based UI
apps/server/       Hono, Comfy SDK, session files and jobs
packages/shared/   Zod API schemas and media conventions
workflows/api/     Fixed API templates used by the server and spikes
workflows/source/  Original vlo UI graphs for the later isolate/animate stages
scripts/           Environment checks and compatibility spikes
```

The original UI graphs cannot be submitted to the v2 API. Each bound API node
has a class/name contract covered by tests. SAM masks use white for the subject;
the server derives candidate bounds directly from their pixels because v2
returns file outputs, rather than SAM's bounding-box node data. It creates the
yellow VLM highlight from the confirmed union mask, so the description matches
the exact selection. Qwen edits are composited over the original only inside a
grown, softly blurred subject mask, preserving pixels outside that region.
Shadows beyond that region can remain; retry or refine the selection as needed.

The next implementation step is the Move phase: motion keys, path editing and
preview playback. The browser compositor, encoding and H3/TTM generation follow.

## License and acknowledgements

[AGPL-3.0](LICENSE), matching the vlo source workflows and dimension-search
logic carried into this project. Dependencies and model weights retain their
own licenses. The app is independent and is not an official Comfy product.

SDK integration follows the
[official TypeScript SDK](https://github.com/Comfy-Org/comfy-typescript-sdk).
