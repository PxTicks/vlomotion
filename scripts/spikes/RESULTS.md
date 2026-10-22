# Compatibility spikes

2026-10-21: Windows ComfyUI `:8188` and the v2 proxy `:8189` are reachable from
WSL over localhost. The full Isolate chain passed on an RTX 5090 Laptop GPU
using ComfyUI 0.41.0 and proxy 0.1.0. Other checks remain explicitly listed below.
`npm run check-env` diagnoses service, node and model availability. The scripts
write artifacts and a machine-readable result under `.data/spikes/`.

| Spike | Implementation / evidence | Remaining validation |
| --- | --- | --- |
| S1 | `npm run spike -- s1` exercises SDK 0.5.0 assets, `fromJson`, `setInput`, `run`, `submit`, events, PNG pixel round-trip, text files and MP4 outputs. Real proxy upload/submission/events/SaveImage and SaveText file downloads passed through the Isolate chain; a separate model-free SaveText check also passed. | Run the complete S1 script, including PNG round-trip and MP4 outputs. No model downloads required. |
| S2 | `npm run spike -- s2 --image photo.png --text dog`, then repeat with `--positive '[{"x":100,"y":100}]' --negative '[]'`. Local core source declares `CheckpointLoaderSimple` compatible SAM3/3.1 targets and `SAM3_Detect` inputs. Text and points templates never mix conditioning modes. | Check score order, candidate masks, points behaviour and the zero-detection path with real weights. |
| S3 | `npm run spike -- s3 --image highlight.png`. The Isolate spike successfully ran both image-conditioned `TextGenerate` branches with `qwen3vl_8b_int8_convrot` loaded as `qwen_image`, and downloaded their `SaveText` outputs. | Broader grounding/phrase/caption quality across real scenes. No alternate CLIP type was needed. |
| S4 | `workflows/api/h3m_animate.api.json` is vlo's H3/TTM graph without resize, frame-trim, KJNodes, end-frame and invert nodes. Every input, link type and model filename was checked against the live ComfyUI schemas. A real app run (864 × 480, 124 frames) executed 20 of 21 nodes, including both `LoadVideo`s, `VAEEncode`, the TTM patch and H3 conditioning, and began sampling (step 1 of 20, live previews). | The session ended before that run finished, so no generated video was inspected. Run one generation to completion and compare against the original vlo graph. |
| S5 | The browser worker encodes with mediabunny (H.264 in headless Chromium). The uploaded reference and mask were H.264, 864 × 480, exactly 124 packets by both ffprobe and the server's mediabunny check. `npm run spike -- s5 --reference … --mask … --frames 124` checks ComfyUI's decode count and mask grey levels. | Run the S5 script on a pair of uploads (they're saved under `.data/<session>/`). |
| S6 | Prompt A/B comparison pending. | Implement motion description and I2VA prompts, then compare generations on the same scenes/seeds. |

## Isolate evidence

2026-10-22: Reproduced a proxy compatibility failure against an actual gloved-hand
selection. ComfyUI history contained valid phrase and caption files, but proxy
0.1.0 returned `status: succeeded` with `outputs: []`. With a temporary 0.1.6
proxy on a separate port, the SDK downloaded both files from the same existing
job, and `parseDescription` plus `removalInstruction` produced the expected
removal prompt. No new GPU run was needed. The launcher now pins 0.1.6; installed
or already running older proxies must be upgraded and restarted separately.
Missing description files now report the proxy problem rather than claiming
the highlighted subject could not be identified.

`npm run spike:isolate -- --fixture` passed the actual server lifecycle:
server-generated yellow highlight → phrase and caption → Qwen Image 2.1 edit
(25 Euler/simple steps, CFG 1) → grown/blurred mask composite → saved PNG.
The synthetic fixture is a 512 × 320 red ball against a plain wall and floor.
The VLM returned `orange circle with smaller inner circle`, plus valid caption
JSON. It identified the selected shape, though its wording was imperfect.
The plate removed the ball with some residual circular shading.

Artifact directory for the verified run:
`.data/spikes/isolate-1792585768283/` (ignored; regenerate with the command above).
An exact RGB comparison found 17,062 changed pixels and **zero changed pixels
outside the subject bounds expanded by the grow plus blur radii**. This checks
the composite's preservation of surrounding pixels on this fixture; it does not
establish removal quality on complex scenes, shadows or reflections.

Implementation details validated against the live schemas: opaque mask PNGs
must use `LoadImage`'s image output followed by `ImageToMask(red)`; Qwen 2.1
uses its encoder's latent output and a reference resized to multiples of 32;
the decoded edit is resized back to the exact working dimensions before
compositing. Core `ImageBlur` limits the radius to 31 and sigma to 10.

The API templates were authored against ComfyUI node schemas; describe/isolate
were executed on the real GPU. Standalone UI authoring copies of these trimmed
graphs remain to be saved. Binding tests catch changes to node IDs and classes;
they do not replace GPU execution or scene-quality review.
