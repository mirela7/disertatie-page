import { GenomicCA } from './ca.js';

const TOOLS = [
  { id: 'genome', label: 'Genome paint', description: 'Paint the selected genome into a region.' },
  { id: 'damage', label: 'Damage', description: 'Randomize RGB, hidden, and genome values in a circular patch.' },
];

const GENOME_MODES = [
  { id: 'paint-only', label: 'Paint genome only', description: 'Preserve the existing RGB and hidden state.' },
  { id: 'paint-reset', label: 'Paint genome + reset', description: 'Rewrite genome bits and zero the local state.' },
];

const SPEED_OPTIONS = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

const state = {
  registry: null,
  activeModelMeta: null,
  activeModelData: null,
  activeGenomeIndex: 0,
  activeTargetId: null,
  tool: 'genome',
  genomeMode: 'paint-only',
  running: false,
  seeded: false,
  brushRadius: 14,
  sketchMode: false,
  gridSize: 128,
  stepCount: 0,
  speedIndex: 4,
  interpolationEnabled: false,
  interpolationAlpha: 0.5,
  interpolationFirst: 0,
  interpolationSecond: 0,
  metricsRows: [],
};

const glCanvas = document.getElementById('gl-canvas');
const sketchCanvas = document.getElementById('sketch-canvas');
const sketchCtx = sketchCanvas.getContext('2d');
const gl = glCanvas.getContext('webgl');
const ca = new GenomicCA(gl, { gridSize: [state.gridSize, state.gridSize] });

let sketchGenomeValues = new Float32Array(0);
let sketchColorValues = new Uint8ClampedArray(0);
let sketchMask = new Uint8Array(0);
let isPointerDown = false;
const targetImageCache = new Map();

const elements = {
  modelList: document.getElementById('model-list'),
  targetList: document.getElementById('target-list'),
  genomeList: document.getElementById('genome-list'),
  toolList: document.getElementById('tool-list'),
  genomeModeList: document.getElementById('genome-mode-list'),
  status: document.getElementById('status-text'),
  note: document.getElementById('model-note'),
  stepCounter: document.getElementById('step-counter'),
  brushRadius: document.getElementById('brush-radius'),
  brushRadiusValue: document.getElementById('brush-radius-value'),
  speedSlider: document.getElementById('speed-slider'),
  speedValue: document.getElementById('speed-value'),
  gridSize: document.getElementById('grid-size'),
  sketchMode: document.getElementById('sketch-mode'),
  interpEnabled: document.getElementById('interp-enabled'),
  interpFirst: document.getElementById('interp-first'),
  interpSecond: document.getElementById('interp-second'),
  interpAlpha: document.getElementById('interp-alpha'),
  interpAlphaValue: document.getElementById('interp-alpha-value'),
  start: document.getElementById('start-btn'),
  pause: document.getElementById('pause-btn'),
  reset: document.getElementById('reset-btn'),
  clear: document.getElementById('clear-btn'),
  save: document.getElementById('save-btn'),
  metrics: document.getElementById('metrics-btn'),
  metricsBody: document.getElementById('metrics-body'),
  randomDamage: document.getElementById('random-damage-btn'),
};

function setStatus(message) {
  elements.status.textContent = message;
}

function updateStepCounter() {
  elements.stepCounter.textContent = `Step ${state.stepCount}`;
}

function currentSpeedMultiplier() {
  return SPEED_OPTIONS[state.speedIndex] || 1;
}

function updateSpeedLabel() {
  elements.speedValue.textContent = `${currentSpeedMultiplier()}x`;
}

function updateInterpolationLabel() {
  elements.interpAlphaValue.textContent = state.interpolationAlpha.toFixed(2);
}

function activeGenomePreset() {
  const presets = state.activeModelMeta?.genome_presets || [];
  return presets[state.activeGenomeIndex] || presets[0] || null;
}

function activeTargetMeta() {
  const targets = state.activeModelMeta?.targets || [];
  return targets.find(target => target.id === state.activeTargetId) || null;
}

function createSketchStorage() {
  const genomeChannels = state.activeModelMeta?.genome_channels || 0;
  const cellCount = state.gridSize * state.gridSize;
  sketchGenomeValues = new Float32Array(cellCount * Math.max(genomeChannels, 1));
  sketchColorValues = new Uint8ClampedArray(cellCount * 3);
  sketchMask = new Uint8Array(cellCount);
}

function resizeSketchStorage() {
  createSketchStorage();
}

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  const value = clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean;
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function mixColor(colorA, colorB, alpha) {
  const a = hexToRgb(colorA);
  const b = hexToRgb(colorB);
  return [
    Math.round(lerp(a[0], b[0], alpha)),
    Math.round(lerp(a[1], b[1], alpha)),
    Math.round(lerp(a[2], b[2], alpha)),
  ];
}

function gridPositionFromPointer(event) {
  const rect = glCanvas.getBoundingClientRect();
  const px = ((event.clientX - rect.left) / rect.width) * state.gridSize;
  const py = ((event.clientY - rect.top) / rect.height) * state.gridSize;
  return [Math.max(0, Math.min(state.gridSize - 1, px)), Math.max(0, Math.min(state.gridSize - 1, py))];
}

function cellDistance(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function currentSketchGenomeVector() {
  const genomeChannels = state.activeModelMeta?.genome_channels || 0;
  const presets = state.activeModelMeta?.genome_presets || [];
  const primary = presets[state.activeGenomeIndex]?.bits || new Array(genomeChannels).fill(0);
  if (!state.sketchMode || !state.interpolationEnabled || presets.length === 0) {
    return primary.slice(0, genomeChannels).map(value => clamp01(Number(value) || 0));
  }
  const first = presets[state.interpolationFirst]?.bits || primary;
  const second = presets[state.interpolationSecond]?.bits || primary;
  const alpha = state.interpolationAlpha;
  const result = new Array(genomeChannels).fill(0);
  for (let i = 0; i < genomeChannels; ++i) {
    result[i] = clamp01(lerp(Number(first[i] || 0), Number(second[i] || 0), alpha));
  }
  return result;
}

function currentSketchColor() {
  const presets = state.activeModelMeta?.genome_presets || [];
  const active = presets[state.activeGenomeIndex];
  if (!state.sketchMode || !state.interpolationEnabled || presets.length === 0) {
    return hexToRgb(active?.color || '#000000');
  }
  const first = presets[state.interpolationFirst] || active;
  const second = presets[state.interpolationSecond] || active;
  return mixColor(first?.color || '#000000', second?.color || '#000000', state.interpolationAlpha);
}

function setSketchCell(index, genomeVector, rgb) {
  sketchMask[index] = 1;
  const genomeChannels = state.activeModelMeta?.genome_channels || 0;
  for (let i = 0; i < genomeChannels; ++i) {
    sketchGenomeValues[index * genomeChannels + i] = clamp01(Number(genomeVector[i] || 0));
  }
  sketchColorValues[index * 3 + 0] = rgb[0];
  sketchColorValues[index * 3 + 1] = rgb[1];
  sketchColorValues[index * 3 + 2] = rgb[2];
}

function clearSketchCell(index) {
  sketchMask[index] = 0;
  const genomeChannels = state.activeModelMeta?.genome_channels || 0;
  for (let i = 0; i < genomeChannels; ++i) {
    sketchGenomeValues[index * genomeChannels + i] = 0;
  }
  sketchColorValues[index * 3 + 0] = 255;
  sketchColorValues[index * 3 + 1] = 255;
  sketchColorValues[index * 3 + 2] = 255;
}

function paintSketchCircle(x, y) {
  const radius = state.brushRadius;
  const genomeVector = currentSketchGenomeVector();
  const color = currentSketchColor();
  for (let row = 0; row < state.gridSize; ++row) {
    for (let col = 0; col < state.gridSize; ++col) {
      if (cellDistance(col + 0.5, row + 0.5, x, y) <= radius) {
        setSketchCell(row * state.gridSize + col, genomeVector, color);
      }
    }
  }
}

function eraseSketchCircle(x, y) {
  const radius = state.brushRadius;
  for (let row = 0; row < state.gridSize; ++row) {
    for (let col = 0; col < state.gridSize; ++col) {
      if (cellDistance(col + 0.5, row + 0.5, x, y) <= radius) {
        clearSketchCell(row * state.gridSize + col);
      }
    }
  }
}

function sketchMapToGenomeMap() {
  const genomeChannels = state.activeModelMeta?.genome_channels || 0;
  const result = new Array(state.gridSize * state.gridSize);
  for (let i = 0; i < result.length; ++i) {
    const cell = new Array(genomeChannels).fill(0);
    if (sketchMask[i]) {
      for (let g = 0; g < genomeChannels; ++g) {
        cell[g] = sketchGenomeValues[i * genomeChannels + g];
      }
    }
    result[i] = cell;
  }
  return result;
}

function renderSketchOverlay() {
  sketchCtx.clearRect(0, 0, sketchCanvas.width, sketchCanvas.height);
  const showSketchOverlay = state.sketchMode && !state.running && !state.seeded;
  if (!showSketchOverlay) {
    sketchCanvas.style.opacity = '0';
    return;
  }

  sketchCanvas.style.opacity = '1';
  const image = sketchCtx.createImageData(state.gridSize, state.gridSize);
  for (let i = 0; i < state.gridSize * state.gridSize; ++i) {
    const offset = i * 4;
    if (sketchMask[i]) {
      image.data[offset + 0] = sketchColorValues[i * 3 + 0];
      image.data[offset + 1] = sketchColorValues[i * 3 + 1];
      image.data[offset + 2] = sketchColorValues[i * 3 + 2];
    } else {
      image.data[offset + 0] = 255;
      image.data[offset + 1] = 255;
      image.data[offset + 2] = 255;
    }
    image.data[offset + 3] = 255;
  }

  const buffer = document.createElement('canvas');
  buffer.width = state.gridSize;
  buffer.height = state.gridSize;
  const bufferCtx = buffer.getContext('2d');
  bufferCtx.putImageData(image, 0, 0);
  sketchCtx.imageSmoothingEnabled = false;
  sketchCtx.drawImage(buffer, 0, 0, sketchCanvas.width, sketchCanvas.height);
}

function renderToolList() {
  elements.toolList.innerHTML = '';
  TOOLS.forEach(tool => {
    const button = document.createElement('button');
    button.className = `mode-chip${state.tool === tool.id ? ' active' : ''}`;
    button.innerHTML = `<strong>${tool.label}</strong><span>${tool.description}</span>`;
    button.onclick = () => {
      state.tool = tool.id;
      renderToolList();
    };
    elements.toolList.appendChild(button);
  });
}

function renderGenomeModes() {
  elements.genomeModeList.innerHTML = '';
  GENOME_MODES.forEach(mode => {
    const button = document.createElement('button');
    button.className = `mode-chip${state.genomeMode === mode.id ? ' active' : ''}`;
    button.innerHTML = `<strong>${mode.label}</strong><span>${mode.description}</span>`;
    button.onclick = () => {
      state.genomeMode = mode.id;
      renderGenomeModes();
    };
    elements.genomeModeList.appendChild(button);
  });
}

function renderGenomePalette() {
  elements.genomeList.innerHTML = '';
  const presets = state.activeModelMeta?.genome_presets || [];
  presets.forEach((preset, index) => {
    const button = document.createElement('button');
    button.className = `genome-chip${state.activeGenomeIndex === index ? ' active' : ''}`;
    button.innerHTML = `<span class="swatch" style="background:${preset.color}"></span><div class="genome-copy"><strong>${preset.label}</strong><span>${preset.bits.join('')}</span></div>`;
    button.onclick = () => {
      state.activeGenomeIndex = index;
      renderGenomePalette();
    };
    elements.genomeList.appendChild(button);
  });
}

function pixelsToDownloadCanvas({ width, height, pixels }) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const imageData = ctx.createImageData(width, height);
  const rowStride = width * 4;

  for (let y = 0; y < height; ++y) {
    const srcOffset = (height - 1 - y) * rowStride;
    const dstOffset = y * rowStride;
    imageData.data.set(pixels.subarray(srcOffset, srcOffset + rowStride), dstOffset);
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

async function saveTextureImage() {
  if (!state.activeModelMeta) {
    setStatus('Load a model before saving an image.');
    return;
  }

  const exportCanvas = pixelsToDownloadCanvas(ca.readVisiblePixels());
  const blob = await new Promise(resolve => exportCanvas.toBlob(resolve, 'image/png'));
  if (!blob) {
    setStatus('Image export failed.');
    return;
  }

  const targetId = state.activeTargetId || 'texture';
  const genomeBits = activeGenomePreset()?.bits?.join('') || 'unknown';
  const filename = `${state.activeModelMeta.id}-${targetId}-${state.gridSize}x${state.gridSize}-g${genomeBits}.png`;
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  setStatus(`Saved ${filename}.`);
}

function clearMetricsRows() {
  state.metricsRows = [];
  renderMetricsTable();
}

function renderMetricsTable() {
  elements.metricsBody.innerHTML = '';
  if (state.metricsRows.length === 0) {
    elements.metricsBody.innerHTML = `
      <tr class="metrics-empty">
        <td colspan="2">No metrics captured yet.</td>
      </tr>
    `;
    return;
  }

  state.metricsRows.forEach(row => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>At T=${row.step}</td>
      <td>${row.ssim.toFixed(4)}</td>
    `;
    elements.metricsBody.appendChild(tr);
  });
}

function reflectIndex(index, length) {
  if (length <= 1) {
    return 0;
  }
  let value = index;
  while (value < 0 || value >= length) {
    if (value < 0) {
      value = -value - 1;
    } else {
      value = 2 * length - value - 1;
    }
  }
  return value;
}

function extractRgbChannel(rgba, channel) {
  const pixelCount = Math.floor(rgba.length / 4);
  const values = new Float64Array(pixelCount);
  for (let i = 0; i < pixelCount; ++i) {
    values[i] = rgba[i * 4 + channel];
  }
  return values;
}

function boxFilterReflect(src, width, height, winSize) {
  const radius = Math.floor(winSize / 2);
  const paddedWidth = width + radius * 2;
  const paddedHeight = height + radius * 2;
  const padded = new Float64Array(paddedWidth * paddedHeight);

  for (let y = 0; y < paddedHeight; ++y) {
    const srcY = reflectIndex(y - radius, height);
    for (let x = 0; x < paddedWidth; ++x) {
      const srcX = reflectIndex(x - radius, width);
      padded[y * paddedWidth + x] = src[srcY * width + srcX];
    }
  }

  const integralWidth = paddedWidth + 1;
  const integral = new Float64Array((paddedHeight + 1) * integralWidth);
  for (let y = 0; y < paddedHeight; ++y) {
    let rowSum = 0.0;
    for (let x = 0; x < paddedWidth; ++x) {
      rowSum += padded[y * paddedWidth + x];
      integral[(y + 1) * integralWidth + (x + 1)] = integral[y * integralWidth + (x + 1)] + rowSum;
    }
  }

  const area = winSize * winSize;
  const filtered = new Float64Array(width * height);
  for (let y = 0; y < height; ++y) {
    const y0 = y;
    const y1 = y + winSize;
    for (let x = 0; x < width; ++x) {
      const x0 = x;
      const x1 = x + winSize;
      const sum =
        integral[y1 * integralWidth + x1]
        - integral[y0 * integralWidth + x1]
        - integral[y1 * integralWidth + x0]
        + integral[y0 * integralWidth + x0];
      filtered[y * width + x] = sum / area;
    }
  }

  return filtered;
}

function cropMean(values, width, height, pad) {
  let sum = 0.0;
  let count = 0;
  for (let y = pad; y < height - pad; ++y) {
    for (let x = pad; x < width - pad; ++x) {
      sum += values[y * width + x];
      count += 1;
    }
  }
  return count > 0 ? sum / count : NaN;
}

function computeSingleChannelSSIM(reference, candidate, width, height) {
  const winSize = 7;
  const pad = Math.floor((winSize - 1) / 2);
  const pixelCount = width * height;

  const refSquared = new Float64Array(pixelCount);
  const candSquared = new Float64Array(pixelCount);
  const refCand = new Float64Array(pixelCount);
  for (let i = 0; i < pixelCount; ++i) {
    refSquared[i] = reference[i] * reference[i];
    candSquared[i] = candidate[i] * candidate[i];
    refCand[i] = reference[i] * candidate[i];
  }

  const ux = boxFilterReflect(reference, width, height, winSize);
  const uy = boxFilterReflect(candidate, width, height, winSize);
  const uxx = boxFilterReflect(refSquared, width, height, winSize);
  const uyy = boxFilterReflect(candSquared, width, height, winSize);
  const uxy = boxFilterReflect(refCand, width, height, winSize);

  const np = winSize * winSize;
  const covNorm = np / (np - 1);
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  const ssimMap = new Float64Array(pixelCount);

  for (let i = 0; i < pixelCount; ++i) {
    const vx = covNorm * (uxx[i] - ux[i] * ux[i]);
    const vy = covNorm * (uyy[i] - uy[i] * uy[i]);
    const vxy = covNorm * (uxy[i] - ux[i] * uy[i]);
    const a1 = 2 * ux[i] * uy[i] + c1;
    const a2 = 2 * vxy + c2;
    const b1 = ux[i] * ux[i] + uy[i] * uy[i] + c1;
    const b2 = vx + vy + c2;
    ssimMap[i] = (a1 * a2) / (b1 * b2);
  }

  return cropMean(ssimMap, width, height, pad);
}

function computeSSIM(referenceRgba, candidateRgba, width, height) {
  if (referenceRgba.length !== candidateRgba.length || referenceRgba.length === 0) {
    return NaN;
  }

  let total = 0.0;
  let channels = 0;
  for (let channel = 0; channel < 3; ++channel) {
    const score = computeSingleChannelSSIM(
      extractRgbChannel(referenceRgba, channel),
      extractRgbChannel(candidateRgba, channel),
      width,
      height
    );
    if (Number.isFinite(score)) {
      total += score;
      channels += 1;
    }
  }

  return channels > 0 ? total / channels : NaN;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

async function getTargetImageData() {
  const target = activeTargetMeta();
  if (!target?.image) {
    return null;
  }

  const cacheKey = `${target.image}|${state.gridSize}`;
  if (targetImageCache.has(cacheKey)) {
    return targetImageCache.get(cacheKey);
  }

  const image = await loadImage(target.image);
  const canvas = document.createElement('canvas');
  canvas.width = state.gridSize;
  canvas.height = state.gridSize;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  targetImageCache.set(cacheKey, imageData.data);
  return imageData.data;
}

async function captureMetrics() {
  if (!state.activeModelMeta) {
    setStatus('Load a model before calculating metrics.');
    return;
  }

  const targetData = await getTargetImageData();
  if (!targetData) {
    setStatus('No target image is available for SSIM.');
    return;
  }

  const currentFrame = ca.readVisiblePixels();
  const currentCanvas = pixelsToDownloadCanvas(currentFrame);
  const ctx = currentCanvas.getContext('2d');
  const currentData = ctx.getImageData(0, 0, currentCanvas.width, currentCanvas.height).data;
  const ssim = computeSSIM(targetData, currentData, currentCanvas.width, currentCanvas.height);

  if (!Number.isFinite(ssim)) {
    setStatus('SSIM calculation failed.');
    return;
  }

  state.metricsRows.push({ step: state.stepCount, ssim });
  renderMetricsTable();
  setStatus(`Captured SSIM at T=${state.stepCount}.`);
}

function renderInterpolationControls() {
  const presets = state.activeModelMeta?.genome_presets || [];
  const controlsDisabled = !state.sketchMode;
  [elements.interpEnabled, elements.interpFirst, elements.interpSecond, elements.interpAlpha].forEach(element => {
    element.disabled = controlsDisabled;
  });
  elements.interpEnabled.checked = state.interpolationEnabled;
  elements.interpFirst.value = String(state.interpolationFirst);
  elements.interpSecond.value = String(state.interpolationSecond);
  elements.interpAlpha.value = String(Math.round(state.interpolationAlpha * 100));
  updateInterpolationLabel();
  if (presets.length === 0) {
    elements.interpFirst.innerHTML = '';
    elements.interpSecond.innerHTML = '';
    return;
  }
  const optionsMarkup = presets.map((preset, index) => `<option value="${index}">${preset.label} (${preset.bits.join('')})</option>`).join('');
  elements.interpFirst.innerHTML = optionsMarkup;
  elements.interpSecond.innerHTML = optionsMarkup;
  elements.interpFirst.value = String(Math.min(state.interpolationFirst, presets.length - 1));
  elements.interpSecond.value = String(Math.min(state.interpolationSecond, presets.length - 1));
}

function renderModelList() {
  elements.modelList.innerHTML = '';
  state.registry.models.forEach(model => {
    const card = document.createElement('button');
    card.className = `model-card${state.activeModelMeta?.id === model.id ? ' active' : ''}`;
    card.innerHTML = `<strong>${model.name}</strong><span>${model.description || `${model.genome_channels} genome channels`}</span>`;
    card.onclick = () => loadModel(model, null);
    elements.modelList.appendChild(card);
  });
}

function renderTargetList() {
  elements.targetList.innerHTML = '';
  const targets = state.activeModelMeta?.targets || [];
  targets.forEach(target => {
    const card = document.createElement('button');
    card.className = `target-card${state.activeTargetId === target.id ? ' active' : ''}`;
    card.innerHTML = `
      <img src="${target.image}" alt="${target.label}">
      <div class="target-copy">
        <strong>${target.label}</strong>
        <span>${target.genome.join('')}</span>
      </div>
    `;
    card.onclick = () => loadModel(state.activeModelMeta, target.id);
    elements.targetList.appendChild(card);
  });
}

function applyDefaultTargetGenome(targetId) {
  const targets = state.activeModelMeta?.targets || [];
  const target = targets.find(entry => entry.id === targetId) || targets.find(entry => entry.default) || targets[0];
  if (!target) {
    return;
  }
  state.activeTargetId = target.id;
  const presetIndex = state.activeModelMeta.genome_presets.findIndex(preset => preset.bits.join('') === target.genome.join(''));
  state.activeGenomeIndex = Math.max(0, presetIndex);
  state.interpolationFirst = state.activeGenomeIndex;
  state.interpolationSecond = state.activeGenomeIndex;
  state.sketchMode = false;
  elements.sketchMode.checked = false;
  clearMetricsRows();
  renderTargetList();
  renderGenomePalette();
  renderInterpolationControls();
}

async function loadModel(modelMeta, targetId) {
  setStatus(`Loading ${modelMeta.name}...`);
  state.activeModelMeta = modelMeta;
  renderModelList();

  if (!state.activeModelData || state.activeModelData.__path !== modelMeta.model_path) {
    const response = await fetch(modelMeta.model_path);
    const modelData = await response.json();
    modelData.__path = modelMeta.model_path;
    state.activeModelData = modelData;
  }

  ca.setGridSize([state.gridSize, state.gridSize]);
  ca.loadModel(state.activeModelData);
  createSketchStorage();
  applyDefaultTargetGenome(targetId);
  resetSimulation();
  renderTargetList();
  renderGenomePalette();
  renderInterpolationControls();
  elements.note.textContent = modelMeta.notes || 'Sketch mode seeds the simulation from the painted genome map. Interpolation uses linear mixing between the two selected genomes only during sketch initialization.';
  state.stepCount = 0;
  updateStepCounter();
  setStatus(`${modelMeta.name} loaded at ${state.gridSize} × ${state.gridSize}.`);
}

function resetSimulation() {
  state.running = false;
  state.seeded = false;
  state.stepCount = 0;
  updateStepCounter();
  ca.clearAll();
  if (state.sketchMode) {
    renderSketchOverlay();
  } else {
    ca.fillGenome(activeGenomePreset()?.bits || []);
    state.seeded = true;
  }
}

function clearSketch() {
  for (let i = 0; i < state.gridSize * state.gridSize; ++i) {
    clearSketchCell(i);
  }
  renderSketchOverlay();
}

function startSimulation() {
  if (!state.activeModelMeta) {
    return;
  }
  if (!state.running && (!state.seeded || state.stepCount === 0)) {
    clearMetricsRows();
  }
  if (state.sketchMode) {
    ca.seedGenomeMap(sketchMapToGenomeMap());
    setStatus('Simulation running from sketch genome map.');
  } else {
    ca.fillGenome(activeGenomePreset()?.bits || []);
    setStatus(`Simulation running with genome ${activeGenomePreset()?.bits?.join('') || ''}.`);
  }
  state.seeded = true;
  state.running = true;
}

function clearAll() {
  state.running = false;
  state.seeded = false;
  state.stepCount = 0;
  updateStepCounter();
  clearMetricsRows();
  ca.clearAll();
  clearSketch();
  if (!state.sketchMode) {
    ca.fillGenome(activeGenomePreset()?.bits || []);
    state.seeded = true;
  }
  setStatus('State and sketch cleared.');
}

function handleLiveBrush(x, y) {
  if (!state.activeModelMeta) {
    return;
  }
  if (state.tool === 'damage') {
    ca.damageCircle(x, y, state.brushRadius);
  } else {
    ca.paintGenome(x, y, state.brushRadius, activeGenomePreset()?.bits || [], state.genomeMode);
  }
}

function handleSketchBrush(x, y) {
  if (state.tool === 'genome') {
    paintSketchCircle(x, y);
  } else {
    eraseSketchCircle(x, y);
  }
  renderSketchOverlay();
}

function pointerPaint(event) {
  if (!state.activeModelMeta) {
    return;
  }
  const [x, y] = gridPositionFromPointer(event);
  if (state.sketchMode && !state.running) {
    handleSketchBrush(x, y);
  } else {
    handleLiveBrush(x, y);
  }
}

function attachEvents() {
  elements.brushRadius.oninput = event => {
    state.brushRadius = parseInt(event.target.value, 10);
    elements.brushRadiusValue.textContent = `${state.brushRadius} px`;
  };

  elements.speedSlider.oninput = event => {
    state.speedIndex = parseInt(event.target.value, 10);
    updateSpeedLabel();
  };

  elements.gridSize.onchange = async event => {
    state.gridSize = parseInt(event.target.value, 10);
    resizeSketchStorage();
    if (state.activeModelMeta) {
      await loadModel(state.activeModelMeta, state.activeTargetId);
    } else {
      renderSketchOverlay();
    }
  };

  elements.sketchMode.onchange = event => {
    state.sketchMode = event.target.checked;
    if (!state.sketchMode) {
      ca.fillGenome(activeGenomePreset()?.bits || []);
      state.seeded = true;
    }
    renderInterpolationControls();
    renderSketchOverlay();
  };

  elements.interpEnabled.onchange = event => {
    state.interpolationEnabled = event.target.checked;
    renderInterpolationControls();
  };

  elements.interpFirst.onchange = event => {
    state.interpolationFirst = parseInt(event.target.value, 10);
    renderInterpolationControls();
  };

  elements.interpSecond.onchange = event => {
    state.interpolationSecond = parseInt(event.target.value, 10);
    renderInterpolationControls();
  };

  elements.interpAlpha.oninput = event => {
    state.interpolationAlpha = parseInt(event.target.value, 10) / 100;
    updateInterpolationLabel();
  };

  elements.start.onclick = () => startSimulation();
  elements.pause.onclick = () => {
    state.running = !state.running;
    setStatus(state.running ? 'Simulation running.' : 'Simulation paused.');
  };
  elements.reset.onclick = () => {
    resetSimulation();
    setStatus('Simulation reset.');
  };
  elements.clear.onclick = () => clearAll();
  elements.save.onclick = () => {
    saveTextureImage().catch(() => {
      setStatus('Image export failed.');
    });
  };
  elements.metrics.onclick = () => {
    captureMetrics().catch(() => {
      setStatus('SSIM calculation failed.');
    });
  };
  elements.randomDamage.onclick = () => {
    if (!state.activeModelMeta) {
      return;
    }
    if (!state.seeded) {
      startSimulation();
      state.running = false;
    }
    ca.randomDamage(5, Math.max(6, state.brushRadius * 0.7), Math.max(12, state.brushRadius * 1.5));
    setStatus('Random damage applied.');
  };

  glCanvas.addEventListener('pointerdown', event => {
    isPointerDown = true;
    pointerPaint(event);
  });
  window.addEventListener('pointerup', () => {
    isPointerDown = false;
  });
  glCanvas.addEventListener('pointermove', event => {
    if (isPointerDown) {
      pointerPaint(event);
    }
  });
}

function render() {
  if (state.running) {
    const baseSteps = 256 / state.gridSize;
    const scaledSteps = baseSteps * currentSpeedMultiplier();
    let stepsThisFrame = Math.floor(scaledSteps);
    const fractional = scaledSteps - stepsThisFrame;
    if (Math.random() < fractional) {
      stepsThisFrame += 1;
    }
    if (stepsThisFrame > 0) {
      ca.step(stepsThisFrame);
      state.stepCount += stepsThisFrame;
      updateStepCounter();
    }
  }
  twgl.bindFramebufferInfo(gl);
  ca.draw(1.0);
  renderSketchOverlay();
  requestAnimationFrame(render);
}

async function init() {
  createSketchStorage();
  attachEvents();
  renderToolList();
  renderGenomeModes();
  updateSpeedLabel();
  updateInterpolationLabel();
  updateStepCounter();
  renderInterpolationControls();
  renderSketchOverlay();
  renderMetricsTable();
  const response = await fetch('./my_models.json');
  state.registry = await response.json();
  renderModelList();
  if (state.registry.models.length > 0) {
    await loadModel(state.registry.models[0], state.registry.models[0].targets?.find(target => target.default)?.id || null);
  }
  requestAnimationFrame(render);
}

init();
