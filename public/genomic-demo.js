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
  const response = await fetch('./my_models.json');
  state.registry = await response.json();
  renderModelList();
  if (state.registry.models.length > 0) {
    await loadModel(state.registry.models[0], state.registry.models[0].targets?.find(target => target.default)?.id || null);
  }
  requestAnimationFrame(render);
}

init();
