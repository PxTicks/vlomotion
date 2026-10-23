"""Run with the Python environment from a ComfyUI installation."""

import importlib.util
import os
from pathlib import Path
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

comfy_path = os.environ.get("COMFYUI_PATH")
if not comfy_path:
    raise RuntimeError("Set COMFYUI_PATH to your ComfyUI checkout before running these tests.")
sys.path.insert(0, comfy_path)

import torch
import comfy.model_management as management

spec = importlib.util.spec_from_file_location("h3_motion", Path(__file__).parents[1] / "h3_motion" / "__init__.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RefineTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.prior = torch.tensor([[[1., 1., 0., 0.], [1., 1., 0., 0.]]])
        self.photo = torch.zeros(1, 2, 4, 3)

        def forward(**kwargs):
            self.calls.append(kwargs | { "mask_inputs": kwargs["mask_inputs"].clone() })
            mask_inputs = kwargs["mask_inputs"]
            result = mask_inputs.clone()
            result[..., 0, 2] = 10  # include the missing part
            result[..., 1, 0] = -10  # allow corrections to remove pixels too
            return None, result, None, None

        self.backbone = Mock(return_value=(None, None, [torch.zeros(1, 3, 4, 4), torch.ones(1, 3, 2, 2)], None))
        self.backbone.multiplex = True
        self.tracker = SimpleNamespace(interactivity_no_mem_embed=torch.full((1, 1, 3), 2.),
            no_mem_embed=torch.full((1, 1, 3), 4.), _forward_sam_heads=forward)
        self.sam = SimpleNamespace(detector=SimpleNamespace(backbone={"vision_backbone": self.backbone}, scalp=0), tracker=self.tracker)
        self.model = SimpleNamespace(model=SimpleNamespace(get_dtype=lambda: torch.float32, diffusion_model=self.sam))
        for name, value in [("load_model_gpu", None), ("get_torch_device", torch.device("cpu")),
                            ("intermediate_device", torch.device("cpu")),
                            ("throw_exception_if_processing_interrupted", None)]:
            patcher = patch.object(management, name, return_value=value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_prior_and_points_condition_every_pass(self):
        output = module.H3M_SAM3_Refine.execute(self.model, self.photo, self.prior,
            positive_coords='[{"x":2,"y":0}]', negative_coords='[{"x":0,"y":1}]')
        self.assertEqual(len(self.calls), 2)
        self.backbone.assert_called_once()
        self.assertEqual(tuple(self.backbone.call_args.args[0].shape), (1, 3, 1008, 1008))
        self.assertEqual(self.backbone.call_args.kwargs, {"tracker_mode": "interactive"})
        points, logits = self.calls[0]["point_inputs"], self.calls[0]["mask_inputs"]
        torch.testing.assert_close(self.calls[0]["backbone_features"], torch.full((1, 3, 2, 2), 3.))
        self.assertIs(self.calls[0]["backbone_features"], self.calls[1]["backbone_features"])
        self.assertTrue(all(call["multimask_output"] is False for call in self.calls))
        torch.testing.assert_close(logits, self.prior.unsqueeze(1) * 20 - 10)
        torch.testing.assert_close(points["point_coords"], torch.tensor([[[504., 0.], [0., 504.]]]))
        self.assertEqual(points["point_labels"].tolist(), [[1, 0]])
        self.assertIs(self.calls[1]["point_inputs"], points)
        self.assertEqual(self.calls[1]["mask_inputs"][0, 0, 0, 2].item(), 10)
        # It forwards the model's complete correction, rather than replacing it with a union.
        self.assertEqual(output[0].tolist(), [[[1., 1., 1., 0.], [0., 1., 0., 0.]]])

    def test_exclude_only_edit_still_receives_prior(self):
        module.H3M_SAM3_Refine.execute(self.model, self.photo, self.prior,
            negative_coords='[{"x":0,"y":1}]', refine_iterations=1)
        self.assertEqual(self.calls[0]["point_inputs"]["point_labels"].tolist(), [[0]])
        self.assertIs(self.calls[0]["multimask_output"], False)
        torch.testing.assert_close(self.calls[0]["mask_inputs"], self.prior.unsqueeze(1) * 20 - 10)

    def test_single_include_click_never_uses_multimask(self):
        module.H3M_SAM3_Refine.execute(self.model, self.photo, self.prior, positive_coords='[{"x":2,"y":0}]')
        self.assertEqual(len(self.calls), 2)
        self.assertTrue(all(call["multimask_output"] is False for call in self.calls))
        self.backbone.assert_called_once()

    def test_non_multiplex_features_use_the_matching_memory_embedding(self):
        self.backbone.multiplex = False
        module.H3M_SAM3_Refine.execute(self.model, self.photo, self.prior, negative_coords='[{"x":0,"y":1}]')
        self.backbone.assert_called_once()
        self.assertEqual(self.backbone.call_args.kwargs, {"need_tracker": True})
        torch.testing.assert_close(self.calls[0]["backbone_features"], torch.full((1, 3, 2, 2), 5.))

    def test_rejects_mismatched_mask_and_invalid_points(self):
        with self.assertRaisesRegex(ValueError, "matching subject mask"):
            module.H3M_SAM3_Refine.execute(self.model, self.photo, torch.zeros(1, 4, 4))
        with self.assertRaisesRegex(ValueError, "inside the photo"):
            module.H3M_SAM3_Refine.execute(self.model, self.photo, self.prior, positive_coords='[{"x":4,"y":0}]')
        with self.assertRaisesRegex(ValueError, "at least one"):
            module.H3M_SAM3_Refine.execute(self.model, self.photo, self.prior)
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
