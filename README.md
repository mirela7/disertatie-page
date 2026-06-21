# Self-Organising Textures

This repository now contains both the original Distill article assets and a genome-aware browser demo for running exported PyTorch Neural Cellular Automata models locally in WebGL.

## Local demo

Start the local server from the repo root:

```bash
python bin/dev.py
```

Then open:

- `http://localhost:8000/genomic-demo.html` for the new genome-aware demo
- `http://localhost:8000/` for the original article/demo page

## Added structure

- `public/genomic-demo.html`: dedicated local browser app for genomic NCA interaction
- `public/genomic-demo.js`: UI controller for model loading, target selection, sketch mode, damage, and genome painting
- `public/ca.js`: extended with a `GenomicCA` WebGL runtime that keeps genome channels editable and preserved across updates
- `public/my_models.json`: model registry loaded by the browser app
- `public/my_models/`: per-model exported JSON files
- `public/my_targets/`: target previews associated with genome presets
- `scripts/export_pytorch_to_webgl.py`: PyTorch checkpoint exporter

## Export a PyTorch checkpoint

The exporter assumes the checkpoint contains the same architecture shape as your `TextureNCA` class:

- fixed 4-filter perception stack: identity, `sobel_x`, `sobel_y`, laplacian
- `conv2d_1`: `1x1` convolution from `4 * state_channels` to `hidden_layer_size`
- ReLU
- `conv2d_2`: `1x1` convolution from `hidden_layer_size` back to `state_channels`
- no Python backend at inference

The browser runtime currently assumes:

- genome channels are the last `g` channels in the state
- genome channels are read during perception and inference, but preserved during the update step
- `hidden_layer_size` should be divisible by `4`
- checkpoints use `conv2d_1.*` and `conv2d_2.*` parameter names

Example export:

```bash
python scripts/export_pytorch_to_webgl.py ^
  --checkpoint path\to\model.pth ^
  --output public\my_models\regen-011.json ^
  --name "Regeneration 011" ^
  --genome-channels 3 ^
  --genome-preset "Genome 000:0,0,0:#f3c35d" ^
  --genome-preset "Genome 011:0,1,1:#3a9f8f" ^
  --target "Genome 000:./my_targets/regen-000.png:0,0,0" ^
  --target "Genome 011:./my_targets/regen-011.png:0,1,1"
```

The script writes the model JSON and prints a suggested entry for `public/my_models.json`.

## Add a new model

1. Export the checkpoint into `public/my_models/<name>.json`.
2. Place target previews in `public/my_targets/`.
3. Add a registry entry to `public/my_models.json` with:
   - `name`
   - `model_path`
   - `state_channels`
   - `genome_channels`
   - `genome_presets`
   - `targets`
4. Reload `genomic-demo.html`.

Each target entry should point to the genome it represents. For `g` genome channels, include `2^g` targets if you want the full palette represented in the UI.

## Interaction modes

The browser demo supports:

- model and target selection
- genome palette selection
- brush radius changes
- sketch initialization mode on a white canvas
- damage brush for regeneration experiments
- live genome painting with three behaviors:
  - `paint genome only`
  - `paint genome + reset`
  - `graft patch`
- `Start`, `Pause`, `Reset`, `Clear`, and `Random Damage`

## Notes on exported values

The runtime keeps the simulation in RGBA8 WebGL framebuffers, so exported weights are quantized on the client when the model JSON loads. If a model looks clipped or unstable, the first values to tune are:

- `state_quantization_scale`
- `hidden_quantization_scale`
- `perception_quantization_scale`

Those can be passed through the exporter flags or edited in the exported model JSON.
