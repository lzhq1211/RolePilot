/**
 * Unique ID generation with fallback for environments without crypto.randomUUID().
 * @returns {string}
 */
function generateId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * Deep clone an object using structuredClone if available.
 * @template T
 * @param {T} obj
 * @returns {T}
 */
function deepClone(obj) {
  if (typeof structuredClone === "function") {
    return structuredClone(obj);
  }
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Escape HTML special characters to prevent XSS.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Safe JSON serialization that escapes characters that could break
 * when embedded in HTML <script> tags.
 * @param {*} data
 * @returns {string}
 */
function safeJsonSerialize(data) {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Safely parse JSON embedded in HTML, handling common corruption.
 * @param {string} jsonStr
 * @returns {object|null}
 */
function safeJsonParse(jsonStr) {
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    console.error("Failed to parse embedded state:", e);
    return null;
  }
}

/**
 * Clean a filename string for safe file system use.
 * @param {string} name
 * @returns {string}
 */
function sanitizeFileName(name) {
  return name
    .trim()
    .replace(/[<>:"/\\|?*]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    || "resume";
}

/**
 * Convert pixels to millimeters.
 * @param {number} px
 * @returns {number}
 */
function pxToMm(px) {
  return px * 0.264583;
}

/**
 * @param {string} message
 * @param {string} level - 'info' | 'success' | 'warning' | 'error'
 */
function showToast(message, level) {
  let container = document.querySelector(".toast-container");
  if (!container) {
    container = document.createElement("div");
    container.className = "toast-container";
    document.body.appendChild(container);
  }

  const toast = document.createElement("div");
  toast.className = `toast toast-${level}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.remove();
    if (container.children.length === 0) {
      container.remove();
    }
  }, 3000);
}
