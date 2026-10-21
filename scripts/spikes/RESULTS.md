# Compatibility spikes

2026-10-21: ComfyUI `:8188` and the v2 proxy `:8189` were unreachable from the
implementation environment. GPU-dependent checks below are **not verified**.
`npm run check-env` diagnoses service, node and model availability. The scripts
write artifacts and a machine-readable result under `.data/spikes/`.

| Spike | Implementation / evidence | Remaining validation |
| --- | --- | --- |
| S1 | `npm run spike -- s1` exercises SDK 0.5.0 assets, `fromJson`, `setInput`, `run`, `submit`, events, PNG pixel round-trip, text files and MP4 outputs. | Run against the real proxy. No model downloads required. |
| S2 | `npm run spike -- s2 --image photo.png --text dog`, then repeat with `--positive '[{"x":100,"y":100}]' --negative '[]'`. Local core source declares `CheckpointLoaderSimple` compatible SAM3/3.1 targets and `SAM3_Detect` inputs. Text and points templates never mix conditioning modes. | Check score order, candidate masks, points behaviour and the zero-detection path with real weights. |
| S3 | `npm run spike -- s3 --image highlight.png`. Local `QwenImage21TEModel` inherits `SD1ClipModel.generate`, and its wrapped Qwen3-VL model implements generation. Two `TextGenerate` outputs are saved through `SaveText`. | Execute with `qwen_image`; if needed repeat with `--clip-type ideogram4`. Check the actual checkpoint's generation weights and image grounding. |
| S4 | Original H3/TTM UI graph is retained in `workflows/source/`. | Trim/export the API graph and compare SDK output with the original graph. |
| S5 | Shared frame-grid and binary-mask PNG tests pass. | Implement the browser compositor/mediabunny encoder and measure the real video decode round-trip. PNG tests do not establish video correctness. |
| S6 | Prompt A/B comparison pending. | Implement motion description and I2VA prompts, then compare generations on the same scenes/seeds. |

The API templates were authored against the local ComfyUI node schemas. They
still need to be opened/validated in a running ComfyUI and saved alongside their
UI-format authoring graphs. Binding tests catch changes to node IDs and classes;
they do not prove model compatibility or GPU execution.
