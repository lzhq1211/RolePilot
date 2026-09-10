/**
 * A4 Overflow Detection module.
 * Detects whether resume content exceeds single A4 page.
 */

const OVERFLOW_TOLERANCE_PX = 2;
let _a4StatusFrame = 0;
let _a4StatusTimer = 0;
let _a4StatusSuspended = false;

function setA4StatusSuspended(suspended) {
  _a4StatusSuspended = suspended;
  if (!suspended) scheduleA4Status();
}

/** Coalesce repeated layout measurements caused by sliders and ResizeObserver. */
function scheduleA4Status(delay = 0) {
  if (_a4StatusSuspended) return;
  if (_a4StatusFrame) cancelAnimationFrame(_a4StatusFrame);
  if (_a4StatusTimer) clearTimeout(_a4StatusTimer);
  _a4StatusTimer = window.setTimeout(() => {
    _a4StatusTimer = 0;
    _a4StatusFrame = requestAnimationFrame(() => {
      _a4StatusFrame = 0;
      updateA4Status();
    });
  }, delay);
}

/**
 * Measure 297mm in pixels at current zoom/DPI by injecting a temporary ruler.
 * @returns {number}
 */
function getA4HeightPx() {
  const ruler = document.createElement("div");
  ruler.style.cssText =
    "position:fixed;top:0;left:-9999px;width:1px;height:297mm;" +
    "visibility:hidden;pointer-events:none;";
  document.body.appendChild(ruler);
  const h = ruler.offsetHeight;
  ruler.remove();
  return h;
}

/** Measure the same content flow that will be exported, excluding editor UI. */
function getPrintableContentHeightPx(contentEl) {
  const pageEl = document.getElementById("resume-page");
  if (!pageEl) return contentEl.offsetHeight;

  pageEl.classList.add("a4-measuring");
  const height = contentEl.offsetHeight;
  pageEl.classList.remove("a4-measuring");
  return height;
}

/**
 * Check if resume content overflows the A4 page.
 * @returns {{ overflow: boolean, pxBeyond: number, mmBeyond: number, firstOverflowSection: string|null }}
 */
function checkOverflow() {
  const contentEl = document.getElementById("resume-content");
  if (!contentEl) return { overflow: false, pxBeyond: 0, mmBeyond: 0, firstOverflowSection: null };

  const a4Px      = getA4HeightPx();
  const contentPx = getPrintableContentHeightPx(contentEl);
  const overflowPx = Math.max(0, contentPx - a4Px);
  const overflow   = overflowPx > OVERFLOW_TOLERANCE_PX;

  let firstOverflowSection = null;

  if (overflow) {
    // Find first section that extends below the A4 boundary
    const pageRect  = contentEl.getBoundingClientRect();
    const a4Bottom  = pageRect.top + a4Px;

    const sections = contentEl.querySelectorAll(".resume-section");
    for (const section of sections) {
      const rect = section.getBoundingClientRect();
      if (rect.bottom > a4Bottom + OVERFLOW_TOLERANCE_PX) {
        firstOverflowSection =
          section.dataset.sectionType ||
          section.querySelector(".section-title")?.textContent ||
          null;
        break;
      }
    }
  }

  return { overflow, pxBeyond: overflowPx, mmBeyond: pxToMm(overflowPx), firstOverflowSection };
}

/**
 * Update A4 status display and fix button label.
 */
function updateA4Status() {
  const statusEl = document.getElementById("a4-status");
  const btnLabel  = document.getElementById("btn-fix-label");
  const fixBtn    = document.getElementById("btn-fix-overflow");
  const result    = checkOverflow();

  if (result.overflow) {
    const msg = `⚠️ 超出 A4 约 ${result.mmBeyond.toFixed(1)} mm`;
    if (statusEl)  { statusEl.textContent = msg; statusEl.style.color = "#dc2626"; }
    if (btnLabel)  btnLabel.textContent = `修复溢出 ${result.mmBeyond.toFixed(1)}mm`;
    if (fixBtn) {
      fixBtn.hidden = false;
      fixBtn.title = `${msg}，点击自动压缩排版`;
      fixBtn.classList.add("toolbar-btn-warn");
    }
  } else {
    if (statusEl)  { statusEl.textContent = "✓ A4 排版正常"; statusEl.style.color = "#16a34a"; }
    if (btnLabel)  btnLabel.textContent = "修复溢出";
    if (fixBtn) {
      fixBtn.hidden = true;
      fixBtn.title = "修复 A4 内容溢出";
      fixBtn.classList.remove("toolbar-btn-warn");
    }
  }
}

/**
 * Auto-fix overflow by progressively reducing section spacings,
 * then line-height if spacings are exhausted.
 * Forces layout reflow between iterations to get accurate measurements.
 */
function autoFixOverflow() {
  let result = checkOverflow();

  if (!result.overflow) return;

  const state = getState();
  const DEFAULT_SPACING = 0;
  const lineHeightInput = document.getElementById("line-height-slider");
  const minLineHeight = Number(lineHeightInput && lineHeightInput.min) || 1.15;
  const lineHeightStep = Number(lineHeightInput && lineHeightInput.step) || 0.01;
  const MAX_ITER = 200;
  let changed = false;

  for (let i = 0; i < MAX_ITER && result.overflow; i++) {
    const sections = state.sections;
    const totalSpacing = sections.reduce((sum, s) => {
      const spacing = s.spacingBefore !== undefined ? s.spacingBefore : DEFAULT_SPACING;
      return sum + Math.max(0, spacing);
    }, 0);

    if (totalSpacing > 0.1) {
      // Reduce section spacings proportionally (with 15% buffer)
      const target = Math.max(0, totalSpacing - result.mmBeyond * 1.15);
      const factor = target / totalSpacing;
      let spacingChanged = false;
      sections.forEach(s => {
        const cur = s.spacingBefore !== undefined ? s.spacingBefore : DEFAULT_SPACING;
        if (cur > 0) {
          const next = Math.max(0, Math.round(cur * factor * 10) / 10);
          if (next !== cur) {
            s.spacingBefore = next;
            spacingChanged = true;
            changed = true;
          }
        }
      });

      // Rounding must not leave the loop repeatedly measuring identical layout.
      if (!spacingChanged) {
        const section = sections.find(s =>
          (s.spacingBefore !== undefined ? s.spacingBefore : DEFAULT_SPACING) > 0
        );
        if (section) {
          const cur = section.spacingBefore !== undefined ? section.spacingBefore : DEFAULT_SPACING;
          section.spacingBefore = Math.max(0, Math.round((cur - 0.1) * 10) / 10);
          changed = true;
        }
      }

      // Apply the actual spacing values before measuring the next iteration.
      renderSections(state);
    } else {
      // Spacings exhausted — shrink line-height stored in state.layout
      if (!state.layout) state.layout = {};
      const curLH = Number(state.layout.lineHeight) || 1.57;
      const nextLH = Math.max(
        minLineHeight,
        Math.round((curLH - lineHeightStep) * 100) / 100
      );
      if (nextLH >= curLH) break;
      state.layout.lineHeight = nextLH;
      changed = true;
      if (typeof applyLineHeight === "function") applyLineHeight(nextLH);
    }

    // Force reflow then re-measure
    const contentEl = document.getElementById("resume-content");
    if (contentEl) contentEl.offsetHeight; // eslint-disable-line no-unused-expressions
    result = checkOverflow();
  }

  if (typeof applyLayoutState === "function") applyLayoutState(state);
  updateA4Status();
  if (changed && typeof markDirty === "function") markDirty();

  if (result.overflow) {
    showToast(`仍超出约 ${result.mmBeyond.toFixed(1)} mm，视觉参数已到可读下限。`, "warning");
  } else {
    showToast("已自动修复，A4 排版正常。", "success");
  }
}

/**
 * Initialize overflow detection via ResizeObserver.
 */
function initOverflowDetection() {
  const contentEl = document.getElementById("resume-content");
  if (!contentEl) return;

  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(() => {
      if (_a4StatusSuspended) return;
      scheduleA4Status(100);
    });
    observer.observe(contentEl);
  }

  updateA4Status();
}
