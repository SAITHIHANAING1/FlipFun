const board = document.getElementById('board');
const cameraPreview = document.getElementById('cameraPreview');
const captureModal = document.getElementById('captureModal');
const captureCanvas = document.getElementById('captureCanvas');
const startButton = document.getElementById('startButton');
const uploadButton = document.getElementById('uploadButton');
const uploadInput = document.getElementById('uploadInput');
const stopButton = document.getElementById('stopButton');
const proceedButton = document.getElementById('proceedButton');
const retakeButton = document.getElementById('retakeButton');
const statusText = document.getElementById('statusText');

const GRID_COLUMNS = 96;
const GRID_ROWS = 54;
const SAMPLE_SCALE = 6;

const offscreenCanvas = document.createElement('canvas');
const offscreenContext = offscreenCanvas.getContext('2d', { willReadFrequently: true });

let cells = [];
let currentStream = null;
let pendingCapture = null;
let renderTimeouts = [];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function setStatus(message) {
  statusText.textContent = message;
}

function createBoard() {
  board.innerHTML = '';
  cells = [];
  board.style.gridTemplateColumns = `repeat(${GRID_COLUMNS}, minmax(0, 1fr))`;

  for (let row = 0; row < GRID_ROWS; row += 1) {
    for (let column = 0; column < GRID_COLUMNS; column += 1) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.setAttribute('role', 'gridcell');

      const tile = document.createElement('div');
      tile.className = 'tile tile--white';
      tile.setAttribute('aria-hidden', 'true');

      cell.appendChild(tile);
      board.appendChild(cell);
      cells.push({ tile, isBlack: false, onAnimEnd: null });
    }
  }
}

function setCellTone(index, isBlack) {
  const tileState = cells[index];
  if (!tileState || tileState.isBlack === isBlack) {
    return;
  }

  tileState.isBlack = isBlack;
  const { tile } = tileState;
  const animClass = isBlack ? 'tile--flipping-to-black' : 'tile--flipping-to-white';
  const stableClass = isBlack ? 'tile--black' : 'tile--white';

  if (tileState.onAnimEnd) {
    tile.removeEventListener('animationend', tileState.onAnimEnd);
    tileState.onAnimEnd = null;
  }

  tile.classList.remove(
    'tile--black', 'tile--white',
    'tile--flipping-to-black', 'tile--flipping-to-white',
  );
  tile.classList.add(animClass);

  tileState.onAnimEnd = () => {
    tile.classList.remove(animClass);
    tile.classList.add(stableClass);
    tileState.onAnimEnd = null;
  };
  tile.addEventListener('animationend', tileState.onAnimEnd, { once: true });
}

function cancelRender() {
  renderTimeouts.forEach(clearTimeout);
  renderTimeouts = [];
}

function renderPixels(pixels) {
  cancelRender();
  for (let index = 0; index < pixels.length; index += 1) {
    const row = Math.floor(index / GRID_COLUMNS);
    const col = index % GRID_COLUMNS;
    const delay = row * 28 + col * 2;
    const id = setTimeout(() => setCellTone(index, pixels[index]), delay);
    renderTimeouts.push(id);
  }
}

function cropToFit(sourceWidth, sourceHeight, targetWidth, targetHeight) {
  const sourceRatio = sourceWidth / sourceHeight;
  const targetRatio = targetWidth / targetHeight;

  if (sourceRatio > targetRatio) {
    const cropWidth = Math.floor(sourceHeight * targetRatio);
    const cropX = Math.floor((sourceWidth - cropWidth) / 2);
    return { sx: cropX, sy: 0, sw: cropWidth, sh: sourceHeight };
  }

  const cropHeight = Math.floor(sourceWidth / targetRatio);
  const cropY = Math.floor((sourceHeight - cropHeight) / 2);
  return { sx: 0, sy: cropY, sw: sourceWidth, sh: cropHeight };
}

function sampleImageData(imageData) {
  const { data, width, height } = imageData;
  const rawLuminances = new Float32Array(GRID_ROWS * GRID_COLUMNS);

  for (let row = 0; row < GRID_ROWS; row += 1) {
    for (let column = 0; column < GRID_COLUMNS; column += 1) {
      const startX = column * SAMPLE_SCALE;
      const startY = row * SAMPLE_SCALE;
      let total = 0;
      let count = 0;

      for (let dy = 0; dy < SAMPLE_SCALE; dy += 1) {
        for (let dx = 0; dx < SAMPLE_SCALE; dx += 1) {
          const sx = Math.min(width - 1, startX + dx);
          const sy = Math.min(height - 1, startY + dy);
          const i = (sy * width + sx) * 4;
          const a = data[i + 3] ?? 255;
          const lum = a === 0
            ? 255
            : (0.299 * (data[i] ?? 0)) + (0.587 * (data[i + 1] ?? 0)) + (0.114 * (data[i + 2] ?? 0));
          total += lum;
          count += 1;
        }
      }

      rawLuminances[row * GRID_COLUMNS + column] = count > 0 ? total / count : 255;
    }
  }

  // Auto-level: stretch the 5th–95th percentile to fill 0–1
  const sorted = Array.from(rawLuminances).sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length * 0.05)] ?? 0;
  const hi = sorted[Math.max(Math.floor(sorted.length * 0.05) + 1, Math.floor(sorted.length * 0.95))] ?? 255;
  const range = Math.max(1, hi - lo);

  // Normalize and apply a mild gamma lift to preserve mid-tone detail
  const grid = new Float32Array(GRID_ROWS * GRID_COLUMNS);
  for (let i = 0; i < grid.length; i += 1) {
    const stretched = clamp((rawLuminances[i] - lo) / range, 0, 1);
    grid[i] = Math.pow(stretched, 0.88);
  }

  // Floyd-Steinberg error diffusion
  const pixels = [];
  for (let row = 0; row < GRID_ROWS; row += 1) {
    for (let col = 0; col < GRID_COLUMNS; col += 1) {
      const idx = row * GRID_COLUMNS + col;
      const old = grid[idx];
      const isBlack = old < 0.5;
      const err = old - (isBlack ? 0 : 1);

      pixels.push(isBlack);

      if (col + 1 < GRID_COLUMNS) {
        grid[idx + 1] += err * (7 / 16);
      }
      if (row + 1 < GRID_ROWS) {
        if (col - 1 >= 0) {
          grid[(row + 1) * GRID_COLUMNS + (col - 1)] += err * (3 / 16);
        }
        grid[(row + 1) * GRID_COLUMNS + col] += err * (5 / 16);
        if (col + 1 < GRID_COLUMNS) {
          grid[(row + 1) * GRID_COLUMNS + (col + 1)] += err * (1 / 16);
        }
      }
    }
  }

  return pixels;
}

function frameToBoard(sourceElement) {
  if (!offscreenContext) {
    return;
  }

  const sourceWidth = sourceElement.videoWidth || sourceElement.naturalWidth || sourceElement.width;
  const sourceHeight = sourceElement.videoHeight || sourceElement.naturalHeight || sourceElement.height;
  if (!sourceWidth || !sourceHeight) {
    return;
  }

  offscreenCanvas.width = GRID_COLUMNS * SAMPLE_SCALE;
  offscreenCanvas.height = GRID_ROWS * SAMPLE_SCALE;

  const crop = cropToFit(sourceWidth, sourceHeight, GRID_COLUMNS, GRID_ROWS);
  offscreenContext.clearRect(0, 0, offscreenCanvas.width, offscreenCanvas.height);
  offscreenContext.imageSmoothingEnabled = true;
  offscreenContext.imageSmoothingQuality = 'high';
  offscreenContext.drawImage(
    sourceElement,
    crop.sx,
    crop.sy,
    crop.sw,
    crop.sh,
    0,
    0,
    offscreenCanvas.width,
    offscreenCanvas.height,
  );

  const imageData = offscreenContext.getImageData(0, 0, offscreenCanvas.width, offscreenCanvas.height);
  const pixels = sampleImageData(imageData);
  renderPixels(pixels);
}

function canvasFromImageElement(imageElement) {
  const sourceWidth = imageElement.naturalWidth || imageElement.width;
  const sourceHeight = imageElement.naturalHeight || imageElement.height;
  if (!sourceWidth || !sourceHeight) {
    return null;
  }

  const canvas = document.createElement('canvas');
  canvas.width = sourceWidth;
  canvas.height = sourceHeight;

  const context = canvas.getContext('2d');
  if (!context) {
    return null;
  }

  context.drawImage(imageElement, 0, 0, sourceWidth, sourceHeight);
  return canvas;
}

function resetBoard() {
  cancelRender();
  cells.forEach((tileState) => {
    if (tileState.onAnimEnd) {
      tileState.tile.removeEventListener('animationend', tileState.onAnimEnd);
      tileState.onAnimEnd = null;
    }
    tileState.isBlack = false;
    tileState.tile.classList.remove(
      'tile--black', 'tile--flipping-to-black', 'tile--flipping-to-white',
    );
    tileState.tile.classList.add('tile--white');
  });
}

function stopCamera(quiet = false) {
  if (currentStream) {
    currentStream.getTracks().forEach((track) => track.stop());
    currentStream = null;
  }

  cameraPreview.srcObject = null;
  if (!quiet) {
    setStatus('Camera stopped.');
  }
}

function closeCaptureModal() {
  captureModal.classList.remove('is-open');
  captureModal.setAttribute('aria-hidden', 'true');
}

function openCaptureModal(imageCanvas) {
  const context = captureCanvas.getContext('2d');
  if (!context) {
    return;
  }

  captureCanvas.width = imageCanvas.width;
  captureCanvas.height = imageCanvas.height;
  context.clearRect(0, 0, captureCanvas.width, captureCanvas.height);
  context.drawImage(imageCanvas, 0, 0);

  captureModal.classList.add('is-open');
  captureModal.setAttribute('aria-hidden', 'false');
}

function capturePreviewCanvas(sourceElement) {
  const sourceWidth = sourceElement.videoWidth || sourceElement.naturalWidth || sourceElement.width;
  const sourceHeight = sourceElement.videoHeight || sourceElement.naturalHeight || sourceElement.height;
  if (!sourceWidth || !sourceHeight) {
    return null;
  }

  const canvas = document.createElement('canvas');
  canvas.width = sourceWidth;
  canvas.height = sourceHeight;

  const context = canvas.getContext('2d');
  if (!context) {
    return null;
  }

  context.drawImage(sourceElement, 0, 0, sourceWidth, sourceHeight);
  return canvas;
}

async function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus('This browser does not support camera access.');
    return;
  }

  try {
    stopCamera(true);
    setStatus('Requesting camera permission...');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: 'environment',
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });

    currentStream = stream;
    cameraPreview.srcObject = stream;
    await cameraPreview.play();

    await new Promise((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });

    const previewCanvas = capturePreviewCanvas(cameraPreview);
    stopCamera(true);

    if (!previewCanvas) {
      setStatus('Could not capture the camera photo.');
      return;
    }

    pendingCapture = previewCanvas;
    openCaptureModal(previewCanvas);
    setStatus('Preview your captured photo, then press Proceed to render the pixel art.');
  } catch (error) {
    console.error(error);
    setStatus('Camera access failed or was blocked.');
    stopCamera(true);
  }
}

function openUploadPicker() {
  stopCamera(true);
  uploadInput.value = '';
  uploadInput.click();
}

async function handleUploadChange(event) {
  const [file] = event.target.files || [];
  if (!file) {
    return;
  }

  try {
    setStatus('Loading uploaded photo...');
    stopCamera(true);

    const imageUrl = URL.createObjectURL(file);
    const image = new Image();

    await new Promise((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('Could not load image'));
      image.src = imageUrl;
    });

    const previewCanvas = canvasFromImageElement(image);
    URL.revokeObjectURL(imageUrl);

    if (!previewCanvas) {
      setStatus('Could not load the uploaded image.');
      return;
    }

    pendingCapture = previewCanvas;
    openCaptureModal(previewCanvas);
    setStatus('Preview your uploaded photo, then press Proceed to render the pixel art.');
  } catch (error) {
    console.error(error);
    setStatus('Could not load the uploaded image.');
  }
}

startButton.addEventListener('click', () => {
  startCamera();
});

uploadButton.addEventListener('click', () => {
  openUploadPicker();
});

uploadInput.addEventListener('change', handleUploadChange);

stopButton.addEventListener('click', () => {
  stopCamera();
  closeCaptureModal();
  pendingCapture = null;
  resetBoard();
});

proceedButton.addEventListener('click', () => {
  if (!pendingCapture) {
    setStatus('No captured photo to render.');
    return;
  }

  frameToBoard(pendingCapture);
  closeCaptureModal();
  pendingCapture = null;
  setStatus('Captured photo rendered into black and white pixel art.');
});

retakeButton.addEventListener('click', () => {
  closeCaptureModal();
  pendingCapture = null;
  setStatus('Retake the photo when you are ready.');
});

captureModal.addEventListener('click', (event) => {
  if (event.target.classList.contains('capture-modal__backdrop')) {
    closeCaptureModal();
    pendingCapture = null;
    setStatus('Preview closed. Capture again when ready.');
  }
});

window.addEventListener('beforeunload', () => {
  stopCamera(true);
});

createBoard();
resetBoard();
setStatus('Camera is off. Capture one photo to turn it into black and white pixel art.');
