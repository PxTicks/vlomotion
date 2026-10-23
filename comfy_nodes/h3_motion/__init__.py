"""Mask-conditioned SAM 3.1 corrections for H3 Motion."""

import json
import math

import torch
import torch.nn.functional as F

import comfy.model_management
import comfy.utils
from comfy.ops import cast_to_input
from comfy_api.latest import ComfyExtension, io


class H3M_SAM3_Refine(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="H3M_SAM3_Refine",
            display_name="H3 Motion SAM3 Refine",
            category="image/detection",
            inputs=[
                io.Model.Input("model"),
                io.Image.Input("image"),
                io.Mask.Input("prior_mask"),
                io.String.Input("positive_coords", default="[]"),
                io.String.Input("negative_coords", default="[]"),
                io.Int.Input("refine_iterations", default=2, min=1, max=5),
            ],
            outputs=[io.Mask.Output("masks")],
        )

    @classmethod
    def execute(cls, model, image, prior_mask, positive_coords="[]", negative_coords="[]", refine_iterations=2):
        batch, height, width, _ = image.shape
        if batch != 1 or tuple(prior_mask.shape) != (1, height, width):
            raise ValueError("Refinement needs one photo and a matching subject mask.")
        positive = json.loads(positive_coords)
        negative = json.loads(negative_coords)
        if not positive and not negative:
            raise ValueError("Add at least one include or exclude point.")
        if len(positive) > 64 or len(negative) > 64:
            raise ValueError("Use at most 64 include and 64 exclude points.")
        coords = []
        for point in positive + negative:
            x, y = point["x"], point["y"]
            if not math.isfinite(x) or not math.isfinite(y) or not (0 <= x < width and 0 <= y < height):
                raise ValueError("Refinement points must be inside the photo.")
            coords.append([x / width * 1008, y / height * 1008])

        comfy.model_management.load_model_gpu(model)
        device = comfy.model_management.get_torch_device()
        dtype = model.model.get_dtype()
        sam = model.model.diffusion_model
        frame = comfy.utils.common_upscale(image[..., :3].movedim(-1, 1), 1008, 1008, "bilinear", crop="disabled").to(device=device, dtype=dtype)
        points = {
            "point_coords": torch.tensor([coords], device=device, dtype=dtype),
            "point_labels": torch.tensor([[1] * len(positive) + [0] * len(negative)], device=device, dtype=torch.int32),
        }
        # Use ComfyUI's interactive feature setup once, bypassing its one-click multimask heuristic.
        backbone = sam.detector.backbone["vision_backbone"]
        if backbone.multiplex:
            _, _, features, _ = backbone(frame, tracker_mode="interactive")
            no_mem = sam.tracker.interactivity_no_mem_embed
        else:
            _, _, features, _ = backbone(frame, need_tracker=True)
            if sam.detector.scalp > 0:
                features = features[:-sam.detector.scalp]
            no_mem = sam.tracker.no_mem_embed
        high_res = list(features[:-1])
        backbone_features = features[-1]
        batch, channels, grid_height, grid_width = backbone_features.shape
        flat = backbone_features.flatten(2).permute(0, 2, 1)
        flat = flat + cast_to_input(no_mem, flat)
        backbone_features = flat.view(batch, grid_height, grid_width, channels).permute(0, 3, 1, 2)

        # Saved masks are binary, not logits. Use the same signed scale as SAM's mask-as-output path.
        logits = prior_mask.unsqueeze(1).to(device=device, dtype=dtype) * 20.0 - 10.0
        for _ in range(refine_iterations):
            comfy.model_management.throw_exception_if_processing_interrupted()
            _, logits, _, _ = sam.tracker._forward_sam_heads(
                backbone_features=backbone_features, high_res_features=high_res,
                point_inputs=points, mask_inputs=logits, box_inputs=None, multimask_output=False)
        mask = F.interpolate(logits, size=(height, width), mode="bilinear", align_corners=False)
        return io.NodeOutput((mask[:, 0] > 0).float().to(comfy.model_management.intermediate_device()))


class H3MotionExtension(ComfyExtension):
    async def get_node_list(self):
        return [H3M_SAM3_Refine]


async def comfy_entrypoint():
    return H3MotionExtension()
