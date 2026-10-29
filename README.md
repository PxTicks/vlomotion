# H3 Motion

Lift a subject out of a photo and drag it into motion. A standalone React app
using the Comfy SDK and self-hosted ComfyUI. This is an early implementation.

Start by uploading an image or video. Images open the existing Select → Isolate →
Move → Generate workflow. MP4/WebM videos open Draw mask → Animate → Generate:
draw a rectangle or ellipse, then animate it with the same path, key and resize
tools as Move, or have it follow an object, then add a prompt and optional
reference image (`<Picture 1>`). The reference can be uploaded, created as an
object from a description (Qwen Image text-to-image), or created as a frame: the
frame at the playhead, edited by Qwen Image inside the mask. With a reference,
the prompt is laid out in MiniMax's full-reference sections: an object is
defined as `<Subject 1>`, and an edited frame as a `<Picture 1>` keyframe anchor
of the shot. Video preparation keeps the source ratio at a
480p short edge, at 24 fps and up to the first 362 frames (15 s), trimmed to H3's 17k+5
frame grid. ComfyUI stretches source and mask onto a nearby model-valid canvas,
then restores the output ratio before saving.

Video inpainting uses the main masked-latent pass from `~/vlo`'s
`vlo_minimax_h3_inpaint.json`, with the `minimax_h3_ref2va_pruned_int8_convrot.safetensors`
model and `vloMaskToLatentMask` from ComfyUI-vlo. There is one sampling pass;
the seam-correction pass is omitted. Source pixels are resized onto the model
canvas and VAE encoded without a prefill step. The browser grows the animated mask
(24 px by default) before it drives both the latent mask and the composite. Generated
pixels are resized back and composited into the source through that mask, blurred
by the feather radius (16 px by default).

**Original sound** under Advanced decides what happens to the source's sound. **Reference**
(the default) sends it to H3 as `<Audio 1>` (`ref_audio_1`), so the generated sound takes
on its ambience and style; the prompt defines it with an `audio reference` retention line.
**Preserve** also lets H3 hear it, as `audio reuse`, but the delivered video keeps the
original sound unchanged instead of the generated one, so the sound effect and music boxes
are hidden. **Replace** leaves the sound out of the prepared source video altogether, so H3
never hears it and generates sound from the prompt alone; the server rejects a source that
doesn't match the chosen option. For Reference and Preserve, the browser trims the sound to
the prepared frames and re-encodes it as AAC or Opus. A video without sound is always replaced.

Compared with vlo's reference-based inpainting workflow, this shares the ref2va
model, source-video VAE encoding, a joint video/audio latent, `vloMaskToLatentMask`,
masked sampling, and a 20-step simple scheduler with the `er_sde` sampler. Important
differences:

- The app uses the whole frame resized to 480p or 768p. vlo defaults to a crop around the
  mask with 10% padding, then positions and masks the generated patch in its editor.
- The app has no prefill step. vlo uses `vloFillMaskedArea`, a pull-push fill that
  smoothly extrapolates surrounding colors, enabled by default at full denoise.
- The app maps the mask with `nearest-exact` and a one-cell grid. vlo uses spatial
  max coverage and snaps outward to two-cell (32-pixel) model tokens.
- The app feathers the pixel composite spatially with `ImageBlur`. It omits vlo's
  explicit latent blanking, seam-correction pass, and temporal mask-feather controls.

Sampling still uses full denoise. Using the source directly keeps its pixels during
VAE encoding, but the model regenerates the masked region; it does not guarantee
that the original content inside the mask survives.

Currently implemented: npm workspaces, the themed app shell, photo upload that
keeps the full image and its native ratio, text-based SAM 3.1 candidates, multiple selection, point refinement,
mask union/confirmation, session-scoped files, job progress and cancellation.
Selection starts with a prompt; clicking the photo reveals the point editor.
Search results show the subject list, where checkboxes include subjects and pencil
buttons open their mask editor. **Add subject** temporarily opens the prompt and
points for a separate selection. **Apply** always submits points explicitly and
returns to the list on success; **Cancel** discards the temporary changes. Applied
points stay with each subject as its recipe. Mask edits recompute from the starting
mask and the full current point list, so removing a point removes its effect.
Applying an empty recipe restores a text-found mask or removes a point-created
subject. Point-created subjects recompute from points without a prior mask. Delete
and Ctrl+Z (Cmd+Z on Mac) manage the collection without inference. Dashed outlines
show suggestions, blue shows included subjects, and yellow marks the editing target.
The Isolate phase describes the confirmed subject locally with Qwen3-VL, removes
it with Qwen Image 2.1, and previews the clean background. Retry with a new seed,
edit the removal instruction, or hold the preview to compare with the original.
The Move phase keyframes the subject along a path with a timeline and real-time
preview playback. The Generate phase renders those frames in the browser and
animates them with MiniMax H3 and Time-to-Move, with sound.
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

Use `npm run dev:app` to launch just the app, including when developing with
ComfyUI offline or managing the proxy separately.
`PORT` (API) and `WEB_PORT` (Vite) can select different app ports if needed.
Both commands read those ports from the repository's `.env`, with shell
environment variables taking precedence. `npm run check-env` uses the same
ComfyUI discovery and proxy health checks as the automatic launcher.

Open http://127.0.0.1:5180. Vite forwards `/api` to the Hono server on `8790`.
The photo canvas works while ComfyUI is offline; selecting a subject needs the
GPU services below. Images keep their native ratio, with no aspect-ratio picker
or crop. Large photos are downscaled to a working short edge of at most 960 px
and a long edge of at most 2560 px; smaller photos are not enlarged. Replacing
the photo or changing the selection clears the confirmed mask and background.
After confirming, choose **Isolate**.
Retries reuse the subject description; editing the instruction reruns only removal.
The instruction editor becomes available after isolation and shows the exact
prompt used for that confirmed mask. If isolation fails, **Write removal instruction**
opens a blank editor so you can supply an instruction and skip description.
An invalid VLM phrase can use a valid subject from the VLM caption; if neither
identifies the subject, automatic removal stops and offers this manual recovery.
The search hint is never used as an automatic fallback removal target.
Changing the selection clears the old prompt;
isolate again to describe the new highlighted subject. Point edits drop the old
search hint because they can select a different object. For text detections, the
hint stays tied to the submitted search; typing a new name alone doesn't change it.
Submit **Find subject** to create a selection with the new name. User-written
instructions are labelled **Custom removal instruction**, including when a VLM
caption is cached. Manual runs without a model description don't populate that
cache. Missing caption fields use defaults without blocking a valid removal phrase.

**Continue** opens the Move phase. Every included subject has its own path and
colour. Click a subject on the canvas to activate it; overlapping subjects receive
clicks from front to back. The **Subjects** menu also selects subjects, and its
arrows change the layer order. The top row is in front. Paths, diamond keys and
the active subject's timeline use that subject's colour.
Drag the subject to record a path automatically. Recording is available only
while that subject has no path; use **Clear path** to record again. This clears
only the active subject's path. To keyframe instead, scrub the timeline before
the first drag. Each drag then places a key at the playhead, so you can scrub,
drag, scrub and drag again. Scrubbing back to 0 s or pressing play switches
recording back on. Dragging a subject along an existing path adjusts its position
at the playhead without replacing its other keys.
Drag a ◆ on the canvas to adjust its position, or on the timeline to adjust its
timing. The box around the active subject keys its size at the playhead: drag a
corner to resize it evenly, or an edge to stretch one axis. The opposite side
stays put; hold Alt to resize about the centre, or Shift to free a corner's
aspect ratio. Drag an edge past the opposite edge to mirror the subject, for a
crude turn or flip. Sizes range up to 400% either way and change at a steady
rate between keys, passing straight through zero when an axis flips. Resizing
never records, and **Reset size** on a selected key restores 100%. Click the path to insert a key. Motion uses smooth timing by default.
**Clear path** restores the subject's starting position and removes the path,
keeping the chosen clip length. Each recorded drag is simplified into keys and
timed to fill the clip from the playhead to the end, however long the drag took;
pauses and speed changes keep their proportions.
The first frame is always the original photo. Clips are 5, 7 or 10 s (124, 175
or 243 frames at 24 fps), and keys sit on those frames. Shortcuts: Space plays,
K adds a key, Delete removes the selected key, and arrow keys step frames.
Retrying the background keeps the paths and layer order. Unchanged subjects keep
their paths when the selection changes; a new photo resets all paths. Preview and
video rendering composite every subject using its own path and the chosen order.

**Continue** opens Generate. The workflow uses **25 sampling steps**.
**Motion lock-in** uses a slider from **2 to 15** in whole steps, default **6**, setting the step
at which the subject is released from your path. Higher values hold it longer but
leave H3 less room to blend the cut-out into the scene. **GENERATE** renders the
reference and mask videos in a Web Worker, encodes exactly 124, 175 or 243
frames with mediabunny (H.264 MP4, or VP9 WebM where H.264 isn't available),
uploads them with the start frame and runs the animate workflow. **Source |
Result** switches between the frames H3 receives and the generated video.
**Main prompt** is always visible and starts with the generated subject and path
description. Edit it to change the visual instructions. **Advanced** holds the
resolution (480p or 768p, measured on the output's short edge), fixed seed, **Sound effects
[Optional]**, and **Music [Optional]**. Sound effects start with the suggested
scene ambience; music starts blank. The H3 header and section labels are added
when submitting the prompt, so they do not appear in the text boxes.
**Regenerate** runs again with a new seed. A result is marked out of date when
the motion or settings change afterwards.
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
for its Time-to-Move (`vloTimeToMove`) and SAM refinement (`vloSAM3RefineMask`)
nodes. Use a pack revision containing both nodes; `npm run check-env` checks
their availability. Its H3 support needs ComfyUI's
per-token mask support (upstream since August 2026). Selection requires the SAM
checkpoint. Isolation also requires the Qwen diffusion model, Qwen3-VL encoder
and Qwen VAE listed below; generation requires the four MiniMax H3 files. Both
H3 workflows use Comfy Kitchen INT8 attention, which needs an NVIDIA or AMD
GPU. Core sol-attn sparse attention (`BlockSparseAttention`) is layered on top
at the node's defaults: from 20% of sampling, long sequences run sparse and
everything else falls back to Kitchen attention. Set `H3M_SOL=0` to turn it
off; the node is upstream since September 2026. Set `H3M_SPECTRUM=1` to splice in the third-party
[Spectrum H3](https://github.com/xmarre/ComfyUI-Spectrum-MiniMax-H3) speed-up;
it is off by default; generation needs no other node pack.

Point selection and mask editing use ComfyUI-vlo's `vloSAM3RefineMask` with
`mask_selection=reference` and one decoder pass. Existing subjects supply their
saved binary mask alongside the full include/exclude point recipe. The node
converts the mask to signed scores for conditioning; native logits are not saved
between edits. Text discovery uses core `SAM3_Detect`.

On verified ComfyUI versions, refinement uses multimask selection for one point
and a stability fallback for multiple points. If ComfyUI's decoder internals
change, `if_core_changed=native` uses its native segmentation method instead.
The mask guides SAM; it does not guarantee that every previously selected pixel
remains selected. Update ComfyUI-vlo and restart ComfyUI if the refinement node
is missing. No app-specific custom nodes need installing.

Following an object in the video workflow segments the clicked object on the
prepared first frame with `vloSAM3RefineMask`, then propagates it with core
`SAM3_VideoTrack` and `SAM3_TrackToMask`, saving one mask per frame. The server
measures each frame's area, pixel median and bounds. The app then rejects frames
whose area or position jumps from their neighbours, holds the size and follows
the visible side while the object is clipped by the frame edge, fills gaps
(coasting briefly at the end), smooths with a zero-lag local quadratic fit and
simplifies the result into editable mask keys. The mask keeps its offset from the
object and scales with it.

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
packages/shared/   Zod API schemas, media conventions and the motion model
workflows/api/     Fixed API templates used by the server and spikes
workflows/source/  Original vlo UI graphs the isolate/animate templates were trimmed from
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

Motion is stored as keys with frame times. The subject follows a centripetal
Catmull-Rom path through the key positions, and a monotone cubic through
(frame, distance travelled) sets its speed, so it never backtracks and holds stay
still. The preview draws each frame from the background plate plus the feathered
cut-out at its offset; at rest it draws the original photo. Generation draws
the same frames at the output size, plus a mask video with the subject in white,
and the server checks each upload's size and frame count before submitting.
Generation uses MiniMax H3's canonical canvas, the rule in SGLang's
`adapt_shape_v1` and ComfyUI's `adapt_canvas`: the short edge at the selected
resolution, the area capped at 768 × 1344, then each side rounded to 32 pixels.
16:9 generates at 864 × 480 or 1344 × 768, matching MiniMax's 768p reference
outputs; 21:9 at 768p generates at 1536 × 672. MiniMax only publishes 768p
results, so 480p is outside its verified configuration.
As in vlo, driven core `ImageScale` nodes stretch the start image, reference
video and mask onto that canvas with cropping disabled, and another resize
restores the source ratio at the selected short edge after decoding, before
video encoding. The delivered size is rounded up to even dimensions for
H.264/yuv420p: a 16:9 input at 768p is delivered at 1366 × 768. Ratios wider
than 7:4 are generated below the selected short edge and upscaled on delivery.
The browser does not decode and re-encode the generated output. The animate graph omits vlo's
frame-trimming, end-frame and inversion nodes: the app sends exact frame counts.
Inpainting follows the same sizing pipeline, restoring the generated pixels
before compositing them with the original prepared source and mask at delivery size.
Before TTM, ComfyUI erodes the binary white subject mask by the **Edge freedom**
setting (Advanced, 0–64 generation-canvas pixels, default 16) using negative
`GrowMask` expansion, then TTM downsamples it to the latent grid. The default
inset matches H3's 16× spatial VAE compression at every resolution, leaving the
subject's edges flexible and reducing background leakage into the held region.
Raise it when a cut-off subject, such as an arm reaching in from off-screen,
keeps its cut edge instead of being completed.

## License and acknowledgements

[AGPL-3.0](LICENSE), matching the vlo source workflows carried into this
project. Dependencies and model weights retain their
own licenses. The app is independent and is not an official Comfy product.

SDK integration follows the
[official TypeScript SDK](https://github.com/Comfy-Org/comfy-typescript-sdk).
