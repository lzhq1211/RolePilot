/**
 * Photo module.
 * Handles upload, compression, drag, zoom, delete, reset.
 */

const PHOTO_MAX_FILE_MB = 10;
const PHOTO_MAX_EDGE_PX = 1600;
const PHOTO_TARGET_KB = 500;

/**
 * Initialize photo upload, crop controls, frame movement, and frame sizing.
 */
function initPhoto() {
  const btnUpload = document.getElementById("btn-photo-upload");
  const btnDelete = document.getElementById("btn-photo-delete");
  const btnReset = document.getElementById("btn-photo-reset");
  const scaleInput = document.getElementById("photo-scale");
  const sizeInput = document.getElementById("photo-size-slider");
  const photoInput = document.getElementById("file-input-photo");
  const container = document.getElementById("photo-container");

  if (btnUpload && photoInput) btnUpload.addEventListener("click", () => photoInput.click());

  if (photoInput) {
    photoInput.addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      photoInput.value = "";
      handlePhotoFile(file);
    });
  }

  if (btnDelete) btnDelete.addEventListener("click", clearPhoto);

  if (scaleInput) {
    scaleInput.addEventListener("input", () => {
      const state = getState();
      state.photo.scale = parseFloat(scaleInput.value);
      applyPhotoTransform(state.photo);
      markDirty();
    });
  }

  if (btnReset) {
    btnReset.addEventListener("click", () => {
      const state = getState();
      state.photo.scale = 1;
      state.photo.frameOffsetX = 0;
      state.photo.frameOffsetY = 0;
      state.photo.offsetX = 0;
      state.photo.offsetY = 0;
      if (scaleInput) scaleInput.value = "1";
      applyPhotoFramePosition(state.photo);
      applyPhotoTransform(state.photo);
      markDirty();
    });
  }

  if (sizeInput) {
    updateRangeProgress(sizeInput);
    sizeInput.addEventListener("input", () => {
      updateRangeProgress(sizeInput);
      const state = getState();
      state.photo.frameScale = parseFloat(sizeInput.value) / 100;
      applyPhotoFrameSize(state.photo);
      renderPhoto(state);
      markDirty();
      requestAnimationFrame(() => updateA4Status());
    });
  }

  if (container && photoInput) {
    container.addEventListener("click", (event) => {
      if (event.target.closest(".photo-delete-btn")) {
        event.stopPropagation();
        clearPhoto();
      } else if (event.target.closest(".photo-frame-handle")) {
        event.stopPropagation();
      } else if (container.dataset.empty === "true") {
        photoInput.click();
      }
    });
    container.addEventListener("keydown", (event) => {
      if (container.dataset.empty !== "true" || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      photoInput.click();
    });
  }

  initPhotoDrag();
  initPhotoFrameDrag();
  updatePhotoControls();
  applyPhotoFrameSize(getState().photo);
  applyPhotoFramePosition(getState().photo);
}

/**
 * Handle a photo File object: validate, compress, store in state, render.
 * @param {File} file
 */
function handlePhotoFile(file) {
  buildPhotoStateFromFile(file, getState().photo)
    .then((photo) => {
      const state = getState();
      state.photo = photo;
      renderPhoto(state);
      updatePhotoControls();
      markDirty();
    })
    .catch((error) => showToast(error.message || "图片读取失败。", "error"));
}

/** Convert an image File into the persisted photo state. */
function buildPhotoStateFromFile(file, previousPhoto = {}) {
  const supported = ["image/jpeg", "image/png", "image/webp"];
  if (!supported.includes(file.type)) {
    return Promise.reject(new Error("不支持的图片格式，请上传 JPEG、PNG 或 WebP。"));
  }
  if (file.size > PHOTO_MAX_FILE_MB * 1024 * 1024) {
    return Promise.reject(new Error(`图片超过 ${PHOTO_MAX_FILE_MB}MB，请压缩后再上传。`));
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      compressPhoto(e.target.result, file.type, (compressed, mimeType, w, h) => {
        resolve({
          source: "",
          dataUrl: compressed,
          mimeType,
          originalWidth: w,
          originalHeight: h,
          scale: 1,
          frameScale: previousPhoto.frameScale || 1,
          frameOffsetX: Number(previousPhoto.frameOffsetX) || 0,
          frameOffsetY: Number(previousPhoto.frameOffsetY) || 0,
          offsetX: 0,
          offsetY: 0,
        });
      });
    };
    reader.onerror = () => reject(new Error("图片读取失败。"));
    reader.readAsDataURL(file);
  });
}

/**
 * Compress a photo via Canvas.
 * @param {string} dataUrl
 * @param {string} mimeType
 * @param {Function} callback (compressedDataUrl, mimeType, width, height)
 */
function compressPhoto(dataUrl, mimeType, callback) {
  const img = new Image();
  img.onload = () => {
    let { width, height } = img;
    const maxEdge = PHOTO_MAX_EDGE_PX;

    if (width > maxEdge || height > maxEdge) {
      if (width >= height) {
        height = Math.round(height * maxEdge / width);
        width = maxEdge;
      } else {
        width = Math.round(width * maxEdge / height);
        height = maxEdge;
      }
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, width, height);

    // Try JPEG first for size; fall back to original type
    const outType = mimeType === "image/png" ? "image/png" : "image/jpeg";
    const quality = 0.85;
    const compressed = canvas.toDataURL(outType, quality);
    callback(compressed, outType, width, height);
  };
  img.onerror = () => {
    showToast("图片解码失败。", "error");
  };
  img.src = dataUrl;
}

/**
 * Apply CSS transform to the photo img element from photo state.
 * @param {object} photo
 */
function applyPhotoTransform(photo) {
  const container = document.getElementById("photo-container");
  if (!container) return;
  const img = container.querySelector("img");
  if (!img) return;
  const offsetX = pxToMm(Number(photo && photo.offsetX) || 0);
  const offsetY = pxToMm(Number(photo && photo.offsetY) || 0);
  const scale = Math.max(0.1, Number(photo && photo.scale) || 1);
  img.style.setProperty("--photo-image-offset-x", `${offsetX.toFixed(4)}mm`);
  img.style.setProperty("--photo-image-offset-y", `${offsetY.toFixed(4)}mm`);
  img.style.setProperty("--photo-image-scale", String(scale));
}

function applyPhotoFrameSize(photo) {
  const page = document.getElementById("resume-page");
  if (!page) return;
  const baseWidth = 20.1;
  const baseHeight = 24.4;
  const frameScale = Math.max(0.4, Math.min(2, Number(photo && photo.frameScale) || 1));
  page.style.setProperty("--photo-w", `${(baseWidth * frameScale).toFixed(2)}mm`);
  page.style.setProperty("--photo-h", `${(baseHeight * frameScale).toFixed(2)}mm`);

  const input = document.getElementById("photo-size-slider");
  const output = document.getElementById("photo-size-value");
  const percent = Math.round(frameScale * 100);
  if (input) input.value = String(percent);
  updateRangeProgress(input);
  if (output) output.textContent = `${percent}%`;
}

function applyPhotoFramePosition(photo) {
  const page = document.getElementById("resume-page");
  if (!page) return;
  const x = Number(photo && photo.frameOffsetX) || 0;
  const y = Number(photo && photo.frameOffsetY) || 0;
  page.style.setProperty("--photo-frame-offset-x", `${x}mm`);
  page.style.setProperty("--photo-frame-offset-y", `${y}mm`);
}

/** Freeze the on-screen photo frame geometry for the print layout. */
function preparePhotoForPrint() {
  const page = document.getElementById("resume-page");
  const container = document.getElementById("photo-container");
  if (!page || !container || container.dataset.empty === "true") return;

  const pageRect = page.getBoundingClientRect();
  const frameRect = container.getBoundingClientRect();
  page.classList.add("photo-print-prepared");
  page.style.setProperty("--photo-print-x", `${pxToMm(frameRect.left - pageRect.left).toFixed(4)}mm`);
  page.style.setProperty("--photo-print-y", `${pxToMm(frameRect.top - pageRect.top).toFixed(4)}mm`);
  page.style.setProperty("--photo-print-w", `${pxToMm(frameRect.width).toFixed(4)}mm`);
  page.style.setProperty("--photo-print-h", `${pxToMm(frameRect.height).toFixed(4)}mm`);
}

function updatePhotoControls() {
  const state = getState();
  const hasPhoto = !!(state.photo && state.photo.dataUrl);
  const btnDelete = document.getElementById("btn-photo-delete");
  const controls = document.querySelector(".photo-controls");
  const scaleInput = document.getElementById("photo-scale");
  if (btnDelete) btnDelete.hidden = !hasPhoto;
  if (controls) controls.hidden = !hasPhoto;
  if (scaleInput) scaleInput.value = String((state.photo && state.photo.scale) || 1);
}

function clearPhoto() {
  const state = getState();
  const frameScale = state.photo && state.photo.frameScale ? state.photo.frameScale : 1;
  const frameOffsetX = Number(state.photo && state.photo.frameOffsetX) || 0;
  const frameOffsetY = Number(state.photo && state.photo.frameOffsetY) || 0;
  state.photo = {
    source: "",
    dataUrl: "", mimeType: "", originalWidth: 0, originalHeight: 0,
    scale: 1, frameScale, frameOffsetX, frameOffsetY, offsetX: 0, offsetY: 0,
  };
  renderPhoto(state);
  updatePhotoControls();
  markDirty();
}

/**
 * Initialize photo drag via Pointer Events.
 */
function initPhotoDrag() {
  const container = document.getElementById("photo-container");
  if (!container) return;

  let dragging = false;
  let startX = 0, startY = 0;
  let startOffsetX = 0, startOffsetY = 0;

  container.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".photo-delete-btn, .photo-frame-handle")) return;
    const img = container.querySelector("img");
    if (!img) return;
    e.preventDefault();
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const state = getState();
    startOffsetX = state.photo.offsetX;
    startOffsetY = state.photo.offsetY;
    container.setPointerCapture(e.pointerId);
  });

  container.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const state = getState();
    state.photo.offsetX = startOffsetX + dx;
    state.photo.offsetY = startOffsetY + dy;
    applyPhotoTransform(state.photo);
  });

  container.addEventListener("pointerup", () => {
    if (dragging) markDirty();
    dragging = false;
  });
  container.addEventListener("pointercancel", () => { dragging = false; });
}

/** Move the entire photo frame without changing its internal crop. */
function initPhotoFrameDrag() {
  const container = document.getElementById("photo-container");
  if (!container) return;

  let dragging = false;
  let startX = 0, startY = 0;
  let startOffsetX = 0, startOffsetY = 0;
  let pxPerMm = 1;

  container.addEventListener("pointerdown", (event) => {
    const handle = event.target.closest(".photo-frame-handle");
    if (!handle || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const photo = getState().photo;
    dragging = true;
    startX = event.clientX;
    startY = event.clientY;
    startOffsetX = Number(photo.frameOffsetX) || 0;
    startOffsetY = Number(photo.frameOffsetY) || 0;
    pxPerMm = getPxPerMm();
    handle.classList.add("dragging");
    handle.setPointerCapture(event.pointerId);
  });

  container.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const photo = getState().photo;
    photo.frameOffsetX = Math.round((startOffsetX + (event.clientX - startX) / pxPerMm) * 2) / 2;
    photo.frameOffsetY = Math.round((startOffsetY + (event.clientY - startY) / pxPerMm) * 2) / 2;
    applyPhotoFramePosition(photo);
  });

  const finishDrag = (event) => {
    if (!dragging) return;
    dragging = false;
    const handle = event && event.target.closest(".photo-frame-handle");
    if (handle) handle.classList.remove("dragging");
    markDirty();
    updateA4Status();
  };
  container.addEventListener("pointerup", finishDrag);
  container.addEventListener("pointercancel", finishDrag);

  container.addEventListener("dblclick", (event) => {
    if (!event.target.closest(".photo-frame-handle")) return;
    event.preventDefault();
    const photo = getState().photo;
    photo.frameOffsetX = 0;
    photo.frameOffsetY = 0;
    applyPhotoFramePosition(photo);
    markDirty();
  });

  container.addEventListener("keydown", (event) => {
    if (!event.target.closest(".photo-frame-handle") || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home"].includes(event.key)) return;
    event.preventDefault();
    const photo = getState().photo;
    const amount = event.shiftKey ? 2 : 0.5;
    if (event.key === "Home") {
      photo.frameOffsetX = 0;
      photo.frameOffsetY = 0;
    } else {
      photo.frameOffsetX = (Number(photo.frameOffsetX) || 0) + (event.key === "ArrowLeft" ? -amount : event.key === "ArrowRight" ? amount : 0);
      photo.frameOffsetY = (Number(photo.frameOffsetY) || 0) + (event.key === "ArrowUp" ? -amount : event.key === "ArrowDown" ? amount : 0);
    }
    applyPhotoFramePosition(photo);
    markDirty();
  });
}
