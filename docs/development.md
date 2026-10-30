# Development

Requires Node **22.12+** (or 24+) and npm. Start ComfyUI yourself, including on
Windows when developing in WSL. Install `uv` in WSL, or put `comfy-api-proxy`
on your PATH, so the launcher can manage the API proxy.
The automatic launcher supports WSL, Linux and macOS. It also runs on native
Windows, which is **not yet tested** end to end. There it looks for `uv.exe`
or `comfy-api-proxy.exe`. Windows has no process groups, so a PowerShell helper
puts the launcher in a job object, which every later descendant joins. Shutdown
waits the same grace period, then ends everything left in the job. If the
launcher dies, the job ends its processes when the helper closes.

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
proxy package (`comfy-api-proxy==0.1.6`) is downloaded and cached automatically
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

A remote `COMFY_BASE_URL`, such as a hosted Comfy deployment, is used directly:
the launcher starts no proxy, looks for no local ComfyUI, and only warns if
the health check fails (not yet tested).

Use `npm run dev:app` to launch just the app, including when developing with
ComfyUI offline or managing the proxy separately.
`PORT` (API) and `WEB_PORT` (Vite) can select different app ports if needed.
Both commands read those ports from the repository's `.env`, with shell
environment variables taking precedence. `npm run check-env` uses the same
ComfyUI discovery and proxy health checks as the automatic launcher.

Open http://127.0.0.1:5180. Vite forwards `/api` to the Hono server on `8790`.

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

## Running the API proxy yourself

Start ComfyUI on `8188`, then install and run the
[v2 proxy](https://github.com/Comfy-Org/comfy-api-proxy) manually if you prefer.
The proxy can run in WSL while ComfyUI runs on Windows; it communicates over HTTP:

```sh
pip install 'comfy-api-proxy==0.1.6'
comfy-api-proxy --comfyui http://127.0.0.1:8188 --port 8189 --max-upload-mb 500
```

Configure `COMFY_BASE_URL` in `.env` for the v2 endpoint. `COMFY_API_KEY` is
optional for local use. Credentials stay on the Node server. `COMFY_UI_URL`
overrides the launcher's ComfyUI detection and lets the environment checker
inspect the GPU's node/model list. If `COMFY_API_KEY` is set, start the
authenticated proxy yourself; the launcher reuses it but will not start an
unauthenticated replacement.
Use proxy **0.1.6 or later**: 0.1.0 drops `SaveText` file outputs, so the subject
can be identified successfully in ComfyUI while isolation receives no description.
If you use an installed or already running proxy, upgrade it and restart it;
the launcher reuses existing proxies without replacing them.
The server uses `@comfyorg/sdk` for workflow submission, asset transfers,
progress and cancellation; it does not use Router or partner nodes.

## Spikes

```sh
npm run check-env
npm run spike -- s1
npm run spike -- s2 --image /path/to/photo.png --text dog
# Refine an existing white-subject/black-background mask with points:
npm run spike -- s2 --image /path/to/photo.png --prior-mask /path/to/mask.png --positive '[{"x":100,"y":100}]'
# Exclude-only edits do not need --positive:
npm run spike -- s2 --image /path/to/photo.png --prior-mask /path/to/mask.png --negative '[{"x":100,"y":100}]'
npm run spike -- s3 --image /path/to/highlight.png
npm run spike:isolate -- --fixture
# Or test your own photo and white-subject/black-background mask:
npm run spike:isolate -- --image /path/to/photo.png --mask /path/to/mask.png --text dog
# Check that ComfyUI decodes the app's MP4s to exactly N frames (S5):
npm run spike -- s5 --reference reference.mp4 --mask mask.mp4 --frames 124
```

See [spike evidence and remaining checks](../scripts/spikes/RESULTS.md). S1 uses
only core image/text/video nodes. S2 requires SAM; S3 requires Qwen's encoder.
The isolation spike exercises the full description → removal → composite chain,
refuses to start while ComfyUI's queue is busy, and saves its inputs, plate and
result JSON under `.data/spikes/`.
