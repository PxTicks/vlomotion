# Source acknowledgements

The source workflow JSON files under `workflows/source/` and the strided
dimension search in `packages/shared/src/media.ts` are derived from
[vlo](https://github.com/PxTicks/vlo), licensed under AGPL-3.0. The dimension
search preserves vlo's candidate ordering and Python rounding behaviour; the
app constrains its search window to preserve the selected resolution tier.

ComfyUI-vlo is a separate runtime dependency, not vendored into this repository.
All npm dependencies retain their respective licenses as distributed in their
packages. Inter and Barlow Condensed are distributed through Fontsource under
the SIL Open Font License.
