# How it works

## GPU services

The app uses the core SAM 3.1, Qwen Image 2.1, TextGenerate and MiniMax H3
nodes, and [ComfyUI-vlo](https://github.com/PxTicks/ComfyUI-vlo) for its
Time-to-Move (`vloTimeToMove`), SAM refinement (`vloSAM3RefineMask`) and
latent-mask (`vloMaskToLatentMask`) nodes; `npm run check-env` checks their
availability. ComfyUI-vlo's H3 support needs ComfyUI's
per-token mask support (upstream since August 2026). Selection requires the SAM
checkpoint. Isolation also requires the Qwen diffusion model, Qwen3-VL encoder
and Qwen VAE listed in the [README](../README.md#2-models); photo generation
requires the fl2va MiniMax H3 model and video inpainting the ref2va one, each
with the shared H3 text encoder and VAEs. Both
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

## Following an object

Following an object in the video workflow segments the clicked object on the
prepared first frame with `vloSAM3RefineMask`, then propagates it with core
`SAM3_VideoTrack` and `SAM3_TrackToMask`, saving one mask per frame. The server
measures each frame's area, pixel median and bounds. The app then rejects frames
whose area or position jumps from their neighbours, holds the size and follows
the visible side while the object is clipped by the frame edge, fills gaps
(coasting briefly at the end), smooths with a zero-lag local quadratic fit and
simplifies the result into editable mask keys. The mask keeps its offset from the
object and scales with it.

## Video inpainting

Video inpainting uses the main masked-latent pass from `~/vlo`'s
`vlo_minimax_h3_inpaint.json`, with the `minimax_h3_ref2va_pruned_int8_convrot.safetensors`
model and `vloMaskToLatentMask` from ComfyUI-vlo. There is one sampling pass;
the seam-correction pass is omitted. Source pixels are resized onto the model
canvas and VAE encoded without a prefill step. The browser grows the animated mask
(24 px by default) before it drives both the latent mask and the composite. Generated
pixels are resized back and composited into the source through that mask, blurred
by the feather radius (16 px by default).

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

## Architecture

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
yellow VLM outline from the confirmed union mask, so the description matches
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

## Verification

The description/removal chain has passed a real GPU run against Windows ComfyUI;
broader scene-quality checks remain. No detections or generated results are simulated. See [spike evidence and remaining checks](../scripts/spikes/RESULTS.md).
