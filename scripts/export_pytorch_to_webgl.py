import argparse
import json
from pathlib import Path

import torch
import torch.nn as nn


class TextureNCA(nn.Module):
    """
    Compatibility shim for checkpoints saved with torch.save(model, ...).

    The exporter only needs access to the layer weights after loading, so this
    minimal class mirrors the parameter names used by the training model.
    """

    def __init__(self, hidden_channels=5, genome_channels=0, hidden_layer_size=96, perc="sobel"):
        super().__init__()
        self.perc = perc
        self.genome_channels = genome_channels
        self.img_channels = 3 + hidden_channels + genome_channels
        self.conv2d_1 = nn.Conv2d(
            in_channels=self.img_channels * 4,
            out_channels=hidden_layer_size,
            kernel_size=1,
        )
        self.conv2d_2 = nn.Conv2d(
            in_channels=hidden_layer_size,
            out_channels=self.img_channels,
            kernel_size=1,
            bias=False,
        )

    def forward(self, x, fire_rate=0.5):
        raise RuntimeError("TextureNCA compatibility shim is for checkpoint export only.")


def parse_bits(value, genome_channels):
    value = value.strip()
    if "," in value:
        bits = [int(part.strip()) for part in value.split(",") if part.strip()]
    else:
        bits = [int(ch) for ch in value if ch in "01"]
    if len(bits) != genome_channels:
        raise ValueError(f"Expected {genome_channels} genome bits, got {bits}")
    return bits


def parse_target(value, genome_channels):
    label, image_path, bits = value.split(":", 2)
    return {
        "id": label.lower().replace(" ", "-"),
        "label": label,
        "image": image_path,
        "genome": parse_bits(bits, genome_channels),
    }


def parse_preset(value, genome_channels):
    label, bits, color = value.split(":", 2)
    return {
        "id": label.lower().replace(" ", "-"),
        "label": label,
        "bits": parse_bits(bits, genome_channels),
        "color": color,
    }


def extract_state_dict(checkpoint_obj):
    if isinstance(checkpoint_obj, torch.nn.Module):
        return checkpoint_obj.state_dict()
    if isinstance(checkpoint_obj, dict):
        if "state_dict" in checkpoint_obj:
            return checkpoint_obj["state_dict"]
        if "model_state_dict" in checkpoint_obj:
            return checkpoint_obj["model_state_dict"]
        if "model" in checkpoint_obj and hasattr(checkpoint_obj["model"], "state_dict"):
            return checkpoint_obj["model"].state_dict()
    if hasattr(checkpoint_obj, "state_dict"):
        return checkpoint_obj.state_dict()
    raise ValueError("Unsupported checkpoint format. Expected a torch.nn.Module or a dict with a state_dict.")


def find_tensor(state_dict, suffix):
    matches = [value for key, value in state_dict.items() if key.endswith(suffix)]
    if not matches:
        raise KeyError(f"Could not find tensor ending with '{suffix}' in checkpoint")
    if len(matches) > 1:
        raise KeyError(f"Found multiple tensors ending with '{suffix}'. Please adapt the exporter for your checkpoint format.")
    return matches[0]


def tensor_to_matrix(weight):
    if weight.ndim != 4 or weight.shape[2:] != (1, 1):
        raise ValueError("Only 1x1 conv weights are supported by this exporter.")
    return weight[:, :, 0, 0].detach().cpu().tolist()


def remap_conv1_weights_for_webgl(conv1_weight, state_channels):
    """
    PyTorch perception ordering:
      [state0_ident, state0_dx, state0_dy, state0_lap, state1_ident, ...]

    WebGL perception ordering:
      [ident_pack0_rgba, ident_pack1_rgba, ..., dx_pack0_rgba, ..., lap_packN_rgba]

    When state_channels is not divisible by 4, the WebGL layout pads the final
    pack with zeros, so conv1 must be expanded from 4*state_channels to
    4*ceil(state_channels/4)*4 inputs.
    """
    out_channels, in_channels = conv1_weight.shape[:2]
    expected_in = state_channels * 4
    if in_channels != expected_in:
        raise ValueError(
            f"Expected conv1 to have {expected_in} inputs for {state_channels} state channels, got {in_channels}."
        )

    state_depth4 = (state_channels + 3) // 4
    webgl_in_channels = state_depth4 * 16
    remapped = torch.zeros((out_channels, webgl_in_channels), dtype=conv1_weight.dtype)

    flat = conv1_weight[:, :, 0, 0]
    for filter_idx in range(4):
        for pack_idx in range(state_depth4):
            for component in range(4):
                state_idx = pack_idx * 4 + component
                webgl_idx = filter_idx * state_depth4 * 4 + pack_idx * 4 + component
                if state_idx < state_channels:
                    pytorch_idx = state_idx * 4 + filter_idx
                    remapped[:, webgl_idx] = flat[:, pytorch_idx]
    return remapped


def main():
    parser = argparse.ArgumentParser(description="Export a PyTorch genomic texture NCA checkpoint to the browser JSON format.")
    parser.add_argument("--checkpoint", required=True, help="Path to a .pth checkpoint saved with torch.save.")
    parser.add_argument("--output", required=True, help="Destination JSON file, usually under public/my_models/.")
    parser.add_argument("--name", required=True, help="Human-readable model name.")
    parser.add_argument("--genome-channels", required=True, type=int, help="Number of genome channels appended to the state.")
    parser.add_argument("--state-quantization-scale", type=float, default=4.0, help="Scale used to encode state tensors into RGBA8 textures.")
    parser.add_argument("--hidden-quantization-scale", type=float, default=8.0, help="Scale used to encode hidden layer activations.")
    parser.add_argument("--perception-quantization-scale", type=float, default=12.0, help="Scale used to encode fixed-filter perception tensors.")
    parser.add_argument("--update-probability", type=float, default=0.5, help="Per-cell stochastic update probability.")
    parser.add_argument("--genome-preset", action="append", default=[], help="Preset in the form Label:bits:color, for example 'Genome 011:0,1,1:#4f8bd8'.")
    parser.add_argument("--target", action="append", default=[], help="Target entry in the form Label:image_path:bits.")
    args = parser.parse_args()

    checkpoint = torch.load(args.checkpoint, map_location="cpu", weights_only=False)
    state_dict = extract_state_dict(checkpoint)

    conv1_weight = find_tensor(state_dict, "conv2d_1.weight")
    conv1_bias = find_tensor(state_dict, "conv2d_1.bias")
    conv2_weight = find_tensor(state_dict, "conv2d_2.weight")
    conv2_bias = torch.zeros(conv2_weight.shape[0], dtype=conv2_weight.dtype)

    state_channels = conv2_weight.shape[0]
    hidden_channels = state_channels - 3 - args.genome_channels
    if hidden_channels < 0:
        raise ValueError("The exported state has fewer than 3 + genome_channels channels. Please verify the checkpoint.")

    remapped_conv1 = remap_conv1_weights_for_webgl(conv1_weight, state_channels)

    model_json = {
        "name": args.name,
        "state_channels": int(state_channels),
        "genome_channels": int(args.genome_channels),
        "hidden_channels": int(hidden_channels),
        "state_quantization_scale": args.state_quantization_scale,
        "hidden_quantization_scale": args.hidden_quantization_scale,
        "perception_quantization_scale": args.perception_quantization_scale,
        "update_probability": args.update_probability,
        "layers": [
            {
                "name": "conv1",
                "in_channels": int(remapped_conv1.shape[1]),
                "out_channels": int(conv1_weight.shape[0]),
                "activation": "relu",
                "weights": remapped_conv1.detach().cpu().tolist(),
                "bias": conv1_bias.detach().cpu().tolist(),
            },
            {
                "name": "conv2",
                "in_channels": int(conv2_weight.shape[1]),
                "out_channels": int(conv2_weight.shape[0]),
                "weights": tensor_to_matrix(conv2_weight),
                "bias": conv2_bias.tolist(),
            },
        ],
        "genome_presets": [parse_preset(value, args.genome_channels) for value in args.genome_preset],
        "targets": [parse_target(value, args.genome_channels) for value in args.target],
    }

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(model_json, indent=2))

    print(f"Wrote {output_path}")
    print()
    print("Suggested my_models.json entry:")
    print(json.dumps({
        "id": output_path.stem,
        "name": args.name,
        "model_path": f"./my_models/{output_path.name}",
        "state_channels": int(state_channels),
        "genome_channels": int(args.genome_channels),
        "genome_presets": model_json["genome_presets"],
        "targets": model_json["targets"],
    }, indent=2))


if __name__ == "__main__":
    main()
