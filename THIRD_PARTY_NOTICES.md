# Source acknowledgements

The source workflow JSON files under `workflows/source/` are derived from
[vlo](https://github.com/PxTicks/vlo), licensed under AGPL-3.0, as is the
stretch-and-restore approach to video aspect ratios. The H3 canvas size in
`packages/shared/src/media.ts` follows the rule in SGLang's `adapt_shape_v1`
and ComfyUI's `adapt_canvas` (`comfy_extras/nodes_minimax_h3.py`), checked
against MiniMax's published H3 reference outputs.

ComfyUI-vlo is a separate runtime dependency, not vendored into this repository.
All npm dependencies retain their respective licenses as distributed in their
packages. Inter and Barlow Condensed are distributed through Fontsource under
the SIL Open Font License.
