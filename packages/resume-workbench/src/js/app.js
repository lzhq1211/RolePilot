/**
 * Main application entry point.
 * Initializes state, wires up toolbar buttons, manages import/export lifecycle.
 */

/** @type {boolean} */
let _workbenchStarted = false;

/** @type {object} */
let _workbenchOptions = {};

function updateRangeProgress(input) {
  if (!input) return;
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  const value = Number(input.value) || min;
  const progress = Math.max(0, Math.min(100, ((value - min) / (max - min || 1)) * 100));
  input.style.setProperty("--range-progress", `${progress}%`);
}

/**
 * Start the workbench after its static template has been installed.
 * Event listeners are registered exactly once for the lifetime of the page.
 * @param {object} [options]
 */
function startWorkbench(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("startWorkbench options must be an object.");
  }
  _workbenchOptions = { ..._workbenchOptions, ...options };
  if (_workbenchStarted) {
    if (options.document) loadDocument(options.document);
    return;
  }
  if (!document.getElementById("resume-content")) {
    throw new Error("resume-workbench template is not installed.");
  }
  const initialState = options.document
    ? validatedDocumentState(options.document)
    : loadInitialState();
  _workbenchStarted = true;
  setState(initialState);

  if (initialState.sections && initialState.sections.length > 0) {
    renderResume(initialState);
  } else if (options.loadSample === true) {
    const parseResult = parseMarkdown(DEFAULT_RESUME_MD);
    const validation  = validateAndBuildState(parseResult, DEFAULT_RESUME_FILENAME || "sample-resume.md");
    if (validation.state) {
      setState(validation.state);
      renderResume(validation.state);
    }
  } else {
    updateStatusInfo(initialState);
  }

  applyLayoutState(getState());

  initOverflowDetection();
  initEditor();
  initPhoto();

  // Wire up toolbar buttons
  wireToolbar();
  initThemeSwitcher();
  initToolbarMenus();
  initResumeListPanel();
  initJsonImport();
  initMarkdownPaste();
  requestAnimationFrame(() => updateA4Status());
}

/**
 * Replace the active document without registering another set of listeners.
 * @param {object} content
 */
function loadDocument(content) {
  if (!_workbenchStarted) {
    throw new Error("startWorkbench() must be called before loadDocument().");
  }
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    throw new TypeError("loadDocument content must be an object.");
  }
  syncFocusedEditor();
  const nextState = validatedDocumentState(content);
  _activeFile = null;
  setState(nextState);
  resetEditorTransientState();
  renderResume(nextState);
  applyLayoutState(nextState);
  clearDirty();
  requestAnimationFrame(() => updateA4Status());
}

/** Return isolated v3 content without layout, photo, history or file handles. */
function readDocument() {
  if (!_workbenchStarted) {
    throw new Error("startWorkbench() must be called before readDocument().");
  }
  syncFocusedEditor();
  return stateToResumeContent(getState());
}

/** Notify the host after an editor mutation. */
function notifyWorkbenchChange() {
  if (typeof _workbenchOptions.onChange !== "function") return;
  try {
    _workbenchOptions.onChange(stateToResumeContent(getState()));
  } catch (error) {
    console.error("resume-workbench onChange callback failed:", error);
  }
}

/**
 * Wire up toolbar button event listeners.
 */
function wireToolbar() {
  const btnImport = document.getElementById("btn-import-md");
  const btnExportPdf = document.getElementById("btn-export-pdf");
  const fileInput = document.getElementById("file-input-md");

  const btnAddSection = document.getElementById("btn-add-section");
  if (btnAddSection) {
    btnAddSection.addEventListener("click", () => {
      showInputDialog({
        title: "新增板块",
        message: "板块名称可以随时在简历中修改。",
        defaultValue: "",
        confirmText: "创建",
        onSubmit: addSection,
      });
    });
  }

  // Import MD
  if (btnImport && fileInput) {
    btnImport.addEventListener("click", () => {
      fileInput.click();
    });

    fileInput.addEventListener("change", (e) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;
      handleImport(files[0], fileInput);
    });
  }

  // Fix overflow button
  const btnFix = document.getElementById("btn-fix-overflow");
  if (btnFix) {
    btnFix.addEventListener("click", () => autoFixOverflow());
  }

  // Font-size slider
  const fsSlider = document.getElementById("font-size-slider");
  const fsValue  = document.getElementById("font-size-value");
  if (fsSlider) {
    updateRangeProgress(fsSlider);
    fsSlider.addEventListener("input", () => {
      const pt = parseFloat(fsSlider.value);
      updateRangeProgress(fsSlider);
      if (fsValue) fsValue.textContent = pt + "pt";
      applyFontSize(pt);
      const state = getState();
      if (!state.layout) state.layout = {};
      state.layout.fontSize = pt;
      markDirty();
      requestAnimationFrame(() => updateA4Status());
    });
  }
  const lhSlider = document.getElementById("line-height-slider");
  const lhValue  = document.getElementById("line-height-value");
  if (lhSlider) {
    updateRangeProgress(lhSlider);
    lhSlider.addEventListener("input", () => {
      const lh = parseFloat(lhSlider.value);
      updateRangeProgress(lhSlider);
      if (lhValue) lhValue.textContent = lh.toFixed(2);
      applyLineHeight(lh);
      const state = getState();
      if (!state.layout) state.layout = {};
      state.layout.lineHeight = lh;
      markDirty();
      requestAnimationFrame(() => updateA4Status());
    });
  }

  // New resume template
  const btnNew = document.getElementById("btn-new-resume");
  if (btnNew) {
    btnNew.addEventListener("click", handleNewResume);
  }
  const btnSave = document.getElementById("btn-save");
  if (btnSave) btnSave.addEventListener("click", () => handleSave());

  // Export PDF
  if (btnExportPdf) {
    btnExportPdf.addEventListener("click", () => {
      handleExportPdf();
    });
  }
}

/**
 * Handle Markdown file import.
 * @param {File} file
 * @param {HTMLInputElement} fileInput
 */
function handleImport(file, fileInput) {
  const reader = new FileReader();

  reader.onload = async (e) => {
    const raw = e.target.result;
    const parseResult = parseMarkdown(raw);
    const validation = validateAndBuildState(parseResult, file.name);

    if (validation.state) {
      // Import successful
      await hydrateReferencedPhoto(validation.state, { file });
      setState(validation.state);
      renderResume(validation.state);
      updateA4Status();
      clearDirty();
    } else {
      // Import had errors
      const errorMsgs = validation.errors
        .filter((err) => err.level === "error")
        .map((err) => err.message);

      showDialog({
        title: "导入失败",
        message: errorMsgs.join("\n") || "无法解析该 Markdown 文件。",
        buttons: [{ text: "好的", primary: true }],
      });
    }

    // Reset file input so same file can be re-imported
    fileInput.value = "";
  };

  reader.onerror = () => {
    showDialog({
      title: "Markdown 读取失败",
      message: `无法读取“${file.name}”。文件可能已被移动、重命名，或浏览器没有访问权限。请重新选择该文件。`,
      buttons: [{ text: "好的", primary: true }],
    });
  };

  reader.readAsText(file);
}

/**
 * Apply a base font size by scaling all font-size CSS variables proportionally.
 * Product 1 baseline is 10pt. All other sizes keep its type hierarchy.
 * @param {number} pt
 */
function applyFontSize(pt) {
  const page = document.getElementById("resume-page");
  if (!page) return;
  page.style.setProperty("--font-size-body",          pt + "pt");
  page.style.setProperty("--font-size-small",          pt.toFixed(2) + "pt");
  page.style.setProperty("--font-size-entry-name",     pt.toFixed(2) + "pt");
  page.style.setProperty("--font-size-section-title",  (pt * 1.2).toFixed(2) + "pt");
  page.style.setProperty("--font-size-contact",        (pt * 1.05).toFixed(2) + "pt");
  page.style.setProperty("--font-size-headline",       (pt * 1.3).toFixed(2) + "pt");
  page.style.setProperty("--font-size-name",           (pt * 1.8).toFixed(2) + "pt");
}

function applyLineHeight(lineHeight) {
  const page = document.getElementById("resume-page");
  if (page) page.style.setProperty("--layout-line-height", String(lineHeight));
}

/** Apply persisted layout values and keep toolbar controls in sync. */
function applyLayoutState(state) {
  if (!state.layout) state.layout = {};
  const fontSize = Number(state.layout.fontSize) || 10;
  const lineHeight = Number(state.layout.lineHeight) || 1.57;
  state.layout.fontSize = fontSize;
  state.layout.lineHeight = lineHeight;
  applyFontSize(fontSize);
  applyLineHeight(lineHeight);

  const fontSlider = document.getElementById("font-size-slider");
  const fontOutput = document.getElementById("font-size-value");
  const lineSlider = document.getElementById("line-height-slider");
  const lineOutput = document.getElementById("line-height-value");
  if (fontSlider) fontSlider.value = String(fontSize);
  updateRangeProgress(fontSlider);
  if (fontOutput) fontOutput.textContent = `${fontSize}pt`;
  if (lineSlider) lineSlider.value = String(lineHeight);
  updateRangeProgress(lineSlider);
  if (lineOutput) lineOutput.textContent = lineHeight.toFixed(2);
}

/**
 * Download a blank Schema v1 MD template.
 */
function handleNewResume() {
  const template = `---
schema_version: 1
resume_name: 公司名-岗位
name: 姓名
headline: 求职方向
phone: 手机号
email: 邮箱
---

## 教育经历

### 学校名称
role: 专业｜学历
date: 2020.09–2024.06

- 描述

## 实习经历

### 公司名称｜部门
role: 岗位
date: 2024.07–2024.09

- 描述

## 项目经历

### 项目名称
role: 角色
date: 2024.01–2024.03

- 描述

## 技能

- 技能类别：具体内容
`;

  const blob = new Blob([template], { type: "text/plain;charset=utf-8" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = "新简历-模板.md";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast("已下载模板，用文本编辑器填写后导入即可。", "success");
}

/** Choose whether to create a copy or overwrite the active source file. */
async function handleSave() {
  syncFocusedEditor();
  const state = deepClone(getState());
  if (!state.profile.name && (!state.sections || state.sections.length === 0)) {
    showToast("请先导入简历。", "warning");
    return;
  }
  if (typeof _workbenchOptions.onSave === "function") {
    try {
      const saved = await _workbenchOptions.onSave(stateToResumeContent(state));
      if (saved !== false) clearDirty();
    } catch (error) {
      console.error("resume-workbench onSave callback failed:", error);
      showToast("保存失败，请重试。", "error");
    }
    return;
  }
  const sourceFile = getActiveSourceFile();
  const canOverwrite = Boolean(
    sourceFile && sourceFile.parentDirectory && sourceFile.handle
    && typeof sourceFile.handle.createWritable === "function"
  );
  const currentName = sourceFile?.name || state.source?.fileName || "当前未关联源文件";
  const overwriteMessage = canOverwrite
    ? `当前文件：${currentName}\n请选择新建副本，或将修改写回当前源文件。`
    : `当前文件：${currentName}\n当前版本没有可写的源文件，只能新建副本。`;

  showDialog({
    title: "保存简历",
    message: overwriteMessage,
    buttons: [
      { text: "取消" },
      { text: "新建副本", action: () => promptSaveCopy(state) },
      {
        text: "覆盖源文件",
        primary: canOverwrite,
        disabled: !canOverwrite,
        title: canOverwrite ? `覆盖 ${currentName}` : "当前版本没有可写的源文件",
        action: () => confirmOverwriteSource(sourceFile),
      },
    ],
  });
}

/**
 * Handle "Export PDF" button.
 */
function handleExportPdf() {
  const state = getState();

  if (!state.profile.name) {
    showToast("请先导入 Markdown 简历。", "warning");
    return;
  }

  // Check overflow
  const { overflow } = checkOverflow();
  if (overflow) {
    showDialog({
      title: "内容溢出",
      message: "当前内容超出单页 A4。导出 PDF 可能出现分页或截断。是否仍然打印？",
      buttons: [
        { text: "返回修改" },
        { text: "仍然打印", primary: true, action: () => exportPdf() },
      ],
    });
  } else {
    exportPdf();
  }
}

/**
 * Show a simple confirmation/info dialog.
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} opts.message
 * @param {{ text: string, primary?: boolean, danger?: boolean, disabled?: boolean, title?: string, action?: Function }[]} opts.buttons
 */
function showDialog({ title, message, buttons }) {
  const root = document.getElementById("dialog-root");
  if (!root) return;

  root.innerHTML = "";
  root.classList.add("active");

  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  backdrop.addEventListener("click", closeDialog);
  root.appendChild(backdrop);

  const box = document.createElement("div");
  box.className = "dialog-box";

  const titleEl = document.createElement("h3");
  titleEl.className = "dialog-title";
  titleEl.textContent = title;
  box.appendChild(titleEl);

  const msgEl = document.createElement("p");
  msgEl.className = "dialog-message";
  msgEl.style.whiteSpace = "pre-line";
  msgEl.textContent = message;
  box.appendChild(msgEl);

  const actions = document.createElement("div");
  actions.className = "dialog-actions";

  for (const btn of (buttons || [{ text: "确定", primary: true }])) {
    const btnEl = document.createElement("button");
    btnEl.className = "dialog-btn";
    if (btn.primary) btnEl.classList.add("dialog-btn-primary");
    if (btn.danger || btn.text.includes("删除") || btn.text.includes("恢复")) btnEl.classList.add("dialog-btn-danger");
    btnEl.disabled = Boolean(btn.disabled);
    if (btn.title) btnEl.title = btn.title;
    btnEl.textContent = btn.text;
    btnEl.addEventListener("click", () => {
      closeDialog();
      if (btn.action) btn.action();
    });
    actions.appendChild(btnEl);
  }

  box.appendChild(actions);
  root.appendChild(box);
}

/**
 * Show an input dialog.
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} opts.message
 * @param {string} opts.defaultValue
 * @param {string} opts.confirmText
 * @param {Function} opts.onSubmit
 */
function showInputDialog({ title, message, defaultValue, confirmText, onSubmit }) {
  const root = document.getElementById("dialog-root");
  if (!root) return;

  root.innerHTML = "";
  root.classList.add("active");

  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  backdrop.addEventListener("click", closeDialog);
  root.appendChild(backdrop);

  const box = document.createElement("div");
  box.className = "dialog-box";

  const titleEl = document.createElement("h3");
  titleEl.className = "dialog-title";
  titleEl.textContent = title;
  box.appendChild(titleEl);

  if (message) {
    const msgEl = document.createElement("p");
    msgEl.className = "dialog-message";
    msgEl.textContent = message;
    box.appendChild(msgEl);
  }

  const input = document.createElement("input");
  input.className = "dialog-input";
  input.type = "text";
  input.value = defaultValue || "";
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && input.value.trim()) {
      closeDialog();
      onSubmit(input.value.trim());
    }
  });
  box.appendChild(input);

  const actions = document.createElement("div");
  actions.className = "dialog-actions";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "dialog-btn";
  cancelBtn.textContent = "取消";
  cancelBtn.addEventListener("click", closeDialog);
  actions.appendChild(cancelBtn);

  const confirmBtn = document.createElement("button");
  confirmBtn.className = "dialog-btn dialog-btn-primary";
  confirmBtn.textContent = confirmText || "确认";
  confirmBtn.addEventListener("click", () => {
    if (!input.value.trim()) return;
    closeDialog();
    onSubmit(input.value.trim());
  });
  actions.appendChild(confirmBtn);

  box.appendChild(actions);
  root.appendChild(box);

  // Focus input
  setTimeout(() => input.focus(), 50);
}

/**
 * Resume list panel and local Markdown snapshots.
 */

/** @type {FileSystemDirectoryHandle|null} */
let _dirHandle = null;

/** @type {string|null} — filename of currently active resume */
let _activeFile = null;

let _directoryFiles = [];
let _directoryName = "简历版本";
let _directoryCanRefresh = false;
let _directoryImportSequence = 0;

const MD_SNAPSHOTS_KEY = "rolepilot:resume-workbench:md-snapshots-v1";
const PINNED_RESUMES_KEY = "rolepilot:resume-workbench:pinned-resumes-v1";

function loadPinnedResumes() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PINNED_RESUMES_KEY) || "[]");
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch (e) {
    console.error("Failed to load pinned resumes:", e);
    return new Set();
  }
}

function getResumePinKey(type, id) {
  return `${type}:${id}`;
}

function toggleResumePin(pinKey) {
  const pinned = loadPinnedResumes();
  if (pinned.has(pinKey)) pinned.delete(pinKey);
  else pinned.add(pinKey);
  localStorage.setItem(PINNED_RESUMES_KEY, JSON.stringify([...pinned]));
  renderResumeFileList(_directoryFiles, _directoryName, _directoryCanRefresh);
}

function appendPinButton(listItem, pinKey, displayName, isPinned) {
  const button = document.createElement("button");
  button.className = `resume-list-action resume-list-pin${isPinned ? " active" : ""}`;
  button.textContent = isPinned ? "★" : "☆";
  button.title = isPinned ? "取消置顶" : "置顶";
  button.setAttribute("aria-label", `${isPinned ? "取消置顶" : "置顶"} ${displayName}`);
  button.setAttribute("aria-pressed", String(isPinned));
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleResumePin(pinKey);
  });
  listItem.appendChild(button);
}

function syncFocusedEditor() {
  const active = document.activeElement;
  if (active && active.closest && active.closest("#resume-content")) active.blur();
}

function getActiveSourceFile() {
  if (!_activeFile || !_activeFile.startsWith("source:")) return null;
  const sourceName = _activeFile.slice("source:".length);
  return _directoryFiles.find((file) => file.name === sourceName) || null;
}

function promptSaveCopy(state) {
  const sourceBaseName = (state.source?.fileName || "").split("/").pop()?.replace(/\.(?:md|markdown|json)$/i, "");
  const defaultName = `${sourceBaseName || state.resumeName || "resume"}-副本`;
  showInputDialog({
    title: "新建副本",
    message: "输入副本名称。副本将以 Markdown 格式保存在右侧版本列表中。",
    defaultValue: defaultName,
    confirmText: "创建副本",
    onSubmit: (name) => {
      try {
        const snapshot = saveMarkdownSnapshot(state, name);
        clearDirty();
        showToast(`已新建副本“${snapshot.name}”。`, "success");
      } catch (e) {
        console.error("Failed to save resume copy:", e);
        showToast("新建副本失败，请重试。", "error");
      }
    },
  });
}

function confirmOverwriteSource(file) {
  if (!file) return;
  showDialog({
    title: "确认覆盖源文件",
    message: `确定覆盖“${file.name}”吗？\n\n源文件将替换为当前编辑器中的内容；不属于简历 Schema 的注释或额外字段不会保留。此操作无法在排版器中撤销。`,
    buttons: [
      { text: "取消" },
      { text: "确认覆盖", danger: true, action: () => overwriteSourceFile(file) },
    ],
  });
}

async function overwriteSourceFile(file) {
  if (!file?.handle || typeof file.handle.createWritable !== "function") {
    showDirectoryWriteRequired();
    return;
  }
  if (!await ensureDirectoryWritePermission()) {
    showDirectoryWriteRequired();
    return;
  }

  const state = getState();
  const isJson = /\.json$/i.test(file.name);
  const content = isJson ? serializeStateToJson(state) : serializeStateToMarkdown(state);
  const saveButton = document.getElementById("btn-save");
  if (saveButton) saveButton.disabled = true;

  try {
    const writable = await file.handle.createWritable();
    try {
      await writable.write(content);
      await writable.close();
    } catch (e) {
      try {
        await writable.abort();
      } catch {}
      throw e;
    }
    state.importSnapshot = createImportSnapshot(state);
    clearDirty();
    try {
      await refreshResumeList();
    } catch (refreshError) {
      console.warn("Failed to refresh after saving source file:", refreshError);
    }
    showToast(`已覆盖源文件“${file.name}”。`, "success");
  } catch (e) {
    console.error("Failed to overwrite source file:", e);
    showDialog({
      title: "覆盖失败",
      message: `无法写入“${file.name}”：${e.message || "未知错误"}`,
      buttons: [{ text: "好的", primary: true }],
    });
  } finally {
    if (saveButton) saveButton.disabled = false;
  }
}

function loadMarkdownSnapshots() {
  try {
    const parsed = JSON.parse(localStorage.getItem(MD_SNAPSHOTS_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error("Failed to load Markdown snapshots:", e);
    return [];
  }
}

function saveMarkdownSnapshot(state, customName) {
  const now = new Date();
  const timestamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  const baseName = sanitizeFileName(
    customName || state.resumeName || (state.source.fileName || "").replace(/\.(?:md|markdown|json)$/i, "") || "resume"
  ).replace(/\.(?:md|markdown|json)$/i, "");
  const snapshot = {
    id: generateId(),
    name: `${baseName}${customName ? "" : `-${timestamp}`}.md`,
    markdown: serializeStateToMarkdown(state),
    createdAt: now.toISOString(),
  };
  const snapshots = loadMarkdownSnapshots();
  snapshots.unshift(snapshot);
  localStorage.setItem(MD_SNAPSHOTS_KEY, JSON.stringify(snapshots));
  _activeFile = `snapshot:${snapshot.id}`;
  renderResumeFileList(_directoryFiles, _directoryName, _directoryCanRefresh);
  return snapshot;
}

function deleteMarkdownSnapshot(snapshotId) {
  const snapshots = loadMarkdownSnapshots().filter((snapshot) => snapshot.id !== snapshotId);
  localStorage.setItem(MD_SNAPSHOTS_KEY, JSON.stringify(snapshots));
  if (_activeFile === `snapshot:${snapshotId}`) _activeFile = null;
  renderResumeFileList(_directoryFiles, _directoryName, _directoryCanRefresh);
}

function renameMarkdownSnapshot(snapshotId) {
  const snapshots = loadMarkdownSnapshots();
  const snapshot = snapshots.find((item) => item.id === snapshotId);
  if (!snapshot) return;

  showInputDialog({
    title: "重命名副本",
    message: "输入新的副本名称：",
    defaultValue: snapshot.name.replace(/\.md$/i, ""),
    confirmText: "重命名",
    onSubmit: (name) => {
      const sanitized = sanitizeFileName(name).replace(/\.md$/i, "");
      if (!sanitized) return;
      snapshot.name = `${sanitized}.md`;
      localStorage.setItem(MD_SNAPSHOTS_KEY, JSON.stringify(snapshots));
      renderResumeFileList(_directoryFiles, _directoryName, _directoryCanRefresh);
    },
  });
}

function initResumeListPanel() {
  renderResumeFileList([], "简历版本", false);
}

/**
 * Read directory and populate the resume list.
 */
async function refreshResumeList(sequence = _directoryImportSequence) {
  if (!_dirHandle) return [];

  // Collect supported candidates recursively, then validate with bounded concurrency.
  const candidates = [];
  await collectResumeFiles(_dirHandle, "", candidates);
  const files = await filterRecognizableResumeFiles(candidates, sequence);

  if (sequence !== _directoryImportSequence) return files;
  renderResumeFileList(files, _dirHandle.name, true);
  return files;
}

async function isRecognizableResumeFile(file, fileName) {
  if (!/\.(?:md|markdown|json)$/i.test(fileName)) return false;
  try {
    const raw = await file.text();
    const validation = /\.json$/i.test(fileName)
      ? importJsonResume(raw, fileName)
      : validateAndBuildState(parseMarkdown(raw), fileName);
    return Boolean(validation.state);
  } catch (e) {
    console.warn(`Skipped unrecognized resume file: ${fileName}`, e);
    return false;
  }
}

async function filterRecognizableResumeFiles(candidates, sequence) {
  const recognized = new Array(candidates.length);
  let nextIndex = 0;
  const workerCount = Math.min(8, candidates.length);

  async function validateNext() {
    while (nextIndex < candidates.length && sequence === _directoryImportSequence) {
      const index = nextIndex++;
      const candidate = candidates[index];
      try {
        const file = await candidate.handle.getFile();
        if (await isRecognizableResumeFile(file, candidate.name)) {
          recognized[index] = candidate;
        }
      } catch (e) {
        console.warn(`Skipped unreadable resume file: ${candidate.name}`, e);
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => validateNext()));
  return recognized.filter(Boolean);
}

async function ensureDirectoryWritePermission() {
  if (!_dirHandle) return false;
  try {
    let permission = await _dirHandle.queryPermission({ mode: "readwrite" });
    if (permission !== "granted") {
      permission = await _dirHandle.requestPermission({ mode: "readwrite" });
    }
    return permission === "granted";
  } catch (e) {
    console.warn("Failed to request directory write permission:", e);
    return false;
  }
}

function showDirectoryWriteRequired() {
  showDialog({
    title: "需要文件夹写入权限",
    message: "请重新选择可写入的来源，才能覆盖、重命名或删除其中的文件。",
    buttons: [{ text: "好的", primary: true }],
  });
}

async function deleteDirectoryResume(file) {
  if (!file.parentDirectory || !file.entryName) {
    showDirectoryWriteRequired();
    return;
  }
  if (!await ensureDirectoryWritePermission()) {
    showDirectoryWriteRequired();
    return;
  }

  try {
    await file.parentDirectory.removeEntry(file.entryName);
    if (_activeFile === `source:${file.name}`) _activeFile = null;
    try {
      await refreshResumeList();
    } catch (refreshError) {
      console.warn("Failed to refresh after deleting resume file:", refreshError);
    }
    showToast(`已删除“${file.name}”。`, "success");
  } catch (e) {
    console.error("Failed to delete resume file:", e);
    showDialog({
      title: "删除失败",
      message: `无法删除“${file.name}”：${e.message || "未知错误"}`,
      buttons: [{ text: "好的", primary: true }],
    });
  }
}

function confirmDeleteDirectoryResume(file) {
  const fileType = /\.json$/i.test(file.name) ? "JSON" : "Markdown";
  showDialog({
    title: `删除 ${fileType} 文件`,
    message: `确定删除“${file.name}”吗？\n\n确认后将从原目录中永久删除该文件，此操作无法在排版器中撤销。`,
    buttons: [
      { text: "取消" },
      { text: "确认删除", action: () => deleteDirectoryResume(file) },
    ],
  });
}

function renameDirectoryResume(file) {
  if (!file.parentDirectory || !file.entryName) {
    showDirectoryWriteRequired();
    return;
  }

  const extensionMatch = file.entryName.match(/(\.(?:md|markdown|json))$/i);
  const extension = extensionMatch ? extensionMatch[1] : "";
  const baseName = extension ? file.entryName.slice(0, -extension.length) : file.entryName;
  showInputDialog({
    title: "重命名简历文件",
    message: `文件位置：${file.name}`,
    defaultValue: baseName,
    confirmText: "重命名",
    onSubmit: async (name) => {
      const sanitized = sanitizeFileName(name).replace(/\.(?:md|markdown|json)$/i, "");
      const nextEntryName = `${sanitized}${extension}`;
      if (!sanitized || nextEntryName === file.entryName) return;
      if (!await ensureDirectoryWritePermission()) {
        showDirectoryWriteRequired();
        return;
      }

      try {
        try {
          await file.parentDirectory.getFileHandle(nextEntryName);
          showDialog({
            title: "无法重命名",
            message: `同一目录中已存在“${nextEntryName}”。`,
            buttons: [{ text: "好的", primary: true }],
          });
          return;
        } catch (e) {
          if (e.name !== "NotFoundError") throw e;
        }

        const source = await file.handle.getFile();
        const nextHandle = await file.parentDirectory.getFileHandle(nextEntryName, { create: true });
        const writable = await nextHandle.createWritable();
        try {
          await writable.write(source);
          await writable.close();
        } catch (e) {
          try {
            await writable.abort();
          } catch {}
          try {
            await file.parentDirectory.removeEntry(nextEntryName);
          } catch {}
          throw e;
        }
        try {
          await file.parentDirectory.removeEntry(file.entryName);
        } catch (e) {
          try {
            await file.parentDirectory.removeEntry(nextEntryName);
          } catch {}
          throw e;
        }

        const parentPath = file.name.includes("/") ? file.name.slice(0, file.name.lastIndexOf("/") + 1) : "";
        const nextName = `${parentPath}${nextEntryName}`;
        if (_activeFile === `source:${file.name}`) _activeFile = `source:${nextName}`;
        try {
          await refreshResumeList();
        } catch (refreshError) {
          console.warn("Failed to refresh after renaming resume file:", refreshError);
        }
        showToast(`已重命名为“${nextName}”。`, "success");
      } catch (e) {
        console.error("Failed to rename resume file:", e);
        showDialog({
          title: "重命名失败",
          message: `无法重命名“${file.name}”：${e.message || "未知错误"}`,
          buttons: [{ text: "好的", primary: true }],
        });
      }
    },
  });
}

/**
 * Render collected resume files in the version panel.
 * @param {Array<{name:string, handle:{getFile:Function}}>} files
 * @param {string} directoryName
 * @param {boolean} canRefresh
 */
function renderResumeFileList(files, directoryName, canRefresh) {
  const list = document.getElementById("resume-list");
  const empty = document.getElementById("panel-empty");
  const dirName = document.getElementById("panel-dir-name");
  _directoryFiles = files;
  _directoryName = directoryName;
  _directoryCanRefresh = canRefresh;

  if (dirName) {
    dirName.textContent = directoryName;
    dirName.title = directoryName;
  }
  const pinned = loadPinnedResumes();
  const sortPinnedFirst = (getKey, fallback) => (a, b) => {
    const pinDifference = Number(pinned.has(getKey(b))) - Number(pinned.has(getKey(a)));
    return pinDifference || fallback(a, b);
  };
  const sourceFiles = [...files].sort(sortPinnedFirst(
    (file) => getResumePinKey("source", file.name),
    (a, b) => a.name.localeCompare(b.name, "zh-CN")
  ));
  const snapshots = loadMarkdownSnapshots().sort(sortPinnedFirst(
    (snapshot) => getResumePinKey("snapshot", snapshot.id),
    (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
  ));

  if (list) {
    list.innerHTML = "";
    const appendHeading = (text) => {
      const heading = document.createElement("li");
      heading.className = "resume-list-heading";
      heading.textContent = text;
      list.appendChild(heading);
    };

    if (snapshots.length > 0) appendHeading("保存的副本");
    for (const snapshot of snapshots) {
      const versionKey = `snapshot:${snapshot.id}`;
      const li = document.createElement("li");
      li.className = "resume-list-item resume-list-snapshot" + (versionKey === _activeFile ? " active" : "");
      li.title = snapshot.name;
      li.dataset.versionKey = versionKey;

      const label = document.createElement("span");
      label.textContent = snapshot.name.replace(/\.md$/i, "");
      li.appendChild(label);

      const pinKey = getResumePinKey("snapshot", snapshot.id);
      const isPinned = pinned.has(pinKey);
      li.classList.toggle("pinned", isPinned);
      appendPinButton(li, pinKey, snapshot.name, isPinned);

      const renameButton = document.createElement("button");
      renameButton.className = "resume-list-action resume-list-rename";
      renameButton.textContent = "✎";
      renameButton.title = "重命名副本";
      renameButton.setAttribute("aria-label", "重命名副本");
      renameButton.addEventListener("click", (event) => {
        event.stopPropagation();
        renameMarkdownSnapshot(snapshot.id);
      });
      li.appendChild(renameButton);

      const deleteButton = document.createElement("button");
      deleteButton.className = "resume-list-action resume-list-delete";
      deleteButton.textContent = "×";
      deleteButton.title = "删除保存的副本";
      deleteButton.addEventListener("click", (event) => {
        event.stopPropagation();
        showDialog({
          title: "删除保存的副本",
          message: `确定删除“${snapshot.name}”吗？`,
          buttons: [
            { text: "取消" },
            { text: "删除", action: () => deleteMarkdownSnapshot(snapshot.id) },
          ],
        });
      });
      li.appendChild(deleteButton);

      const handle = {
        getFile: async () => new File([snapshot.markdown], snapshot.name, { type: "text/markdown" }),
      };
      li.addEventListener("click", () => loadResumeFromHandle(snapshot.name, handle, versionKey));
      list.appendChild(li);
    }

    if (sourceFiles.length > 0) appendHeading("目录文件");
    for (const file of sourceFiles) {
      const { name, handle } = file;
      const displayName = file.entryName || name.split("/").pop() || name;
      const versionKey = `source:${name}`;
      const li = document.createElement("li");
      li.className = "resume-list-item resume-list-source" + (versionKey === _activeFile ? " active" : "");
      li.title = displayName;
      li.dataset.versionKey = versionKey;

      const label = document.createElement("span");
      label.textContent = displayName.replace(/\.(?:md|markdown|json)$/i, "");
      li.appendChild(label);

      const pinKey = getResumePinKey("source", name);
      const isPinned = pinned.has(pinKey);
      li.classList.toggle("pinned", isPinned);
      appendPinButton(li, pinKey, displayName, isPinned);

      const renameButton = document.createElement("button");
      renameButton.className = "resume-list-action resume-list-rename";
      renameButton.textContent = "✎";
      renameButton.title = "重命名文件";
      renameButton.setAttribute("aria-label", `重命名 ${displayName}`);
      renameButton.addEventListener("click", (event) => {
        event.stopPropagation();
        renameDirectoryResume(file);
      });
      li.appendChild(renameButton);

      const deleteButton = document.createElement("button");
      deleteButton.className = "resume-list-action resume-list-delete";
      deleteButton.textContent = "×";
      deleteButton.title = /\.json$/i.test(name) ? "删除 JSON 文件" : "删除 Markdown 文件";
      deleteButton.setAttribute("aria-label", `删除 ${displayName}`);
      deleteButton.addEventListener("click", (event) => {
        event.stopPropagation();
        confirmDeleteDirectoryResume(file);
      });
      li.appendChild(deleteButton);

      li.addEventListener("click", () => loadResumeFromHandle(name, handle, versionKey));
      list.appendChild(li);
    }
  }

  if (empty) {
    const hasVersions = sourceFiles.length > 0 || snapshots.length > 0;
    empty.textContent = hasVersions ? "" : "暂无导入文件";
    empty.classList.toggle("hidden", hasVersions);
  }
}

/**
 * Recursively collect Markdown and JSON candidates for resume validation.
 * @param {FileSystemDirectoryHandle} directory
 * @param {string} prefix
 * @param {Array<{name:string, handle:FileSystemFileHandle, parentDirectory:FileSystemDirectoryHandle, entryName:string}>} files
 */
async function collectResumeFiles(directory, prefix, files) {
  for await (const [name, handle] of directory.entries()) {
    if (name.startsWith(".")) continue;
    const relativeName = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === "file" && /\.(?:md|markdown|json)$/i.test(name)) {
      files.push({ name: relativeName, handle, parentDirectory: directory, entryName: name });
    } else if (handle.kind === "directory") {
      await collectResumeFiles(handle, relativeName, files);
    }
  }
}

/**
 * Load a supported resume file from a FileSystemFileHandle.
 * @param {string} name
 * @param {FileSystemFileHandle} handle
 */
async function loadResumeFromHandle(name, handle, versionKey = name) {
  // Warn if dirty
  if (isDirty()) {
    const confirmed = await new Promise((resolve) => {
      showDialog({
        title: "有未保存的修改",
        message: "切换简历将丢失当前未保存的修改，是否继续？",
        buttons: [
          { text: "取消",    action: () => resolve(false) },
          { text: "继续切换", primary: true, action: () => resolve(true) },
        ],
      });
    });
    if (!confirmed) return;
  }

  try {
    const file = await handle.getFile();
    const text = await file.text();

    const isJson = /\.json$/i.test(name);
    const validation = isJson
      ? importJsonResume(text, name)
      : validateAndBuildState(parseMarkdown(text), name);

    if (validation.state) {
      const sourceFile = _directoryFiles.find((item) => item.name === name);
      await hydrateReferencedPhoto(validation.state, sourceFile || { handle });
      setState(validation.state);
      renderResume(validation.state);
      updateA4Status();
      clearDirty();

      // Mark active
      _activeFile = versionKey;
      document.querySelectorAll(".resume-list-item").forEach((li) => {
        li.classList.toggle("active", li.dataset.versionKey === versionKey);
      });

    } else {
      const errs = validation.errors
        .filter((e) => e.level === "error")
        .map((e) => e.message)
        .join("\n");
      showDialog({ title: `${isJson ? "JSON" : "Markdown"} 导入失败`, message: errs, buttons: [{ text: "好的", primary: true }] });
    }
  } catch (e) {
    console.error(e);
    const missing = e && (e.name === "NotFoundError" || /not found|不存在/i.test(e.message || ""));
    const denied = e && (e.name === "NotAllowedError" || e.name === "SecurityError");

    if (missing && _dirHandle) {
      try {
        await refreshResumeList();
      } catch (refreshError) {
        console.warn("Failed to refresh after missing file:", refreshError);
      }
    }

    showDialog({
      title: missing ? "文件已变化" : denied ? "需要重新授权" : "文件打开失败",
      message: missing
        ? `“${name}”已被移动、重命名或删除，右侧文件列表已刷新，请选择新的文件名。`
        : denied
          ? "浏览器已失去该来源的读取权限，请重新导入文件。"
          : `无法打开“${name}”：${e.message || "未知错误"}`,
      buttons: [{ text: "好的", primary: true }],
    });
  }
}

/** Load a photo declared in Markdown from the same private directory. */
async function hydrateReferencedPhoto(state, sourceFile) {
  const reference = String(state.photo && state.photo.source || "").trim();
  if (!reference) return;

  try {
    let photoFile = null;
    if (sourceFile && sourceFile.parentDirectory && !reference.includes("/")) {
      const photoHandle = await sourceFile.parentDirectory.getFileHandle(reference);
      photoFile = await photoHandle.getFile();
    } else if (sourceFile && sourceFile.relatedFiles) {
      const sourcePath = sourceFile.name || "";
      const basePath = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/") + 1) : "";
      photoFile = sourceFile.relatedFiles.get(basePath + reference) || null;
    }
    if (!photoFile) throw new Error("请先选择照片文件。");
    const photo = await buildPhotoStateFromFile(photoFile, state.photo);
    photo.source = reference;
    state.photo = photo;
  } catch (error) {
    showToast(`未能自动载入照片“${reference}”：${error.message || "文件不可读"}`, "warning");
  }
}

/**
 * Initialize theme switcher.
 */
function initThemeSwitcher() {
  const btnA = document.getElementById("btn-theme-a");
  const btnB = document.getElementById("btn-theme-b");
  const btnD = document.getElementById("btn-theme-d");
  const btnE = document.getElementById("btn-theme-e");
  const themeLabel = document.getElementById("current-theme-label");
  const themeMenu = document.getElementById("theme-menu");
  const page = document.getElementById("resume-page");
  if (!btnA || !btnB || !page) return;

  function setTheme(theme) {
    page.dataset.theme = theme;
    btnA.classList.toggle("toolbar-btn-active", theme === "a");
    btnB.classList.toggle("toolbar-btn-active", theme === "b");
    if (btnD) btnD.classList.toggle("toolbar-btn-active", theme === "d");
    if (btnE) btnE.classList.toggle("toolbar-btn-active", theme === "e");
    if (themeLabel) {
      themeLabel.textContent = { a: "黑体", b: "宋体", d: "楷体", e: "微软雅黑" }[theme];
    }
    if (themeMenu) themeMenu.open = false;
    // Re-render header to reflect theme-specific contact format
    const state = getState();
    if (typeof applyPhotoFrameSize === "function") applyPhotoFrameSize(state.photo);
    if (state.sections && state.sections.length > 0) {
      renderResume(state);
    }
  }

  btnA.addEventListener("click", () => setTheme("a"));
  btnB.addEventListener("click", () => setTheme("b"));
  if (btnD) btnD.addEventListener("click", () => setTheme("d"));
  if (btnE) btnE.addEventListener("click", () => setTheme("e"));
}

function initToolbarMenus() {
  const menus = Array.from(document.querySelectorAll(".toolbar-menu"));

  menus.forEach((menu) => {
    menu.addEventListener("toggle", () => {
      if (!menu.open) return;
      menus.forEach((other) => {
        if (other !== menu) other.open = false;
      });
    });
  });

  menus.forEach((menu) => {
    menu.querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", () => { menu.open = false; });
    });
  });

  document.addEventListener("click", (event) => {
    menus.forEach((menu) => {
      if (!menu.contains(event.target)) menu.open = false;
    });
  });
}


function closeDialog() {
  const root = document.getElementById("dialog-root");
  if (!root) return;
  root.innerHTML = "";
  root.classList.remove("active");
}

/**
 * JSON import initialization.
 * Wires up JSON import buttons and file input.
 */
function initJsonImport() {
  const btnPasteJson = document.getElementById("btn-paste-json");
  const btnImportJsonFile = document.getElementById("btn-import-json-file");
  const fileInput = document.getElementById("file-input-json");

  if (btnPasteJson) btnPasteJson.addEventListener("click", handlePasteJson);
  if (btnImportJsonFile) btnImportJsonFile.addEventListener("click", () => {
    if (fileInput) fileInput.click();
  });

  if (fileInput) {
    fileInput.addEventListener("change", (e) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;
      handleImportJsonFile(files[0], fileInput);
    });
  }
}

function initMarkdownPaste() {
  const btnPasteMd = document.getElementById("btn-paste-md");

  if (btnPasteMd) btnPasteMd.addEventListener("click", handlePasteMarkdown);
}

function handlePasteMarkdown() {
  _proceedWithDirtyCheck(() => {
    const root = document.getElementById("dialog-root");
    if (!root) return;

    root.innerHTML = "";
    root.classList.add("active");

    const backdrop = document.createElement("div");
    backdrop.className = "dialog-backdrop";
    backdrop.addEventListener("click", closeDialog);
    root.appendChild(backdrop);

    const box = document.createElement("div");
    box.className = "dialog-box";
    box.style.maxWidth = "600px";

    const titleEl = document.createElement("h3");
    titleEl.className = "dialog-title";
    titleEl.textContent = "粘贴 Markdown";
    box.appendChild(titleEl);

    const msgEl = document.createElement("p");
    msgEl.className = "dialog-message";
    msgEl.textContent = "将简历 Markdown 粘贴到下方文本框。";
    box.appendChild(msgEl);

    const textarea = document.createElement("textarea");
    textarea.className = "dialog-input";
    textarea.style.width = "100%";
    textarea.style.minHeight = "300px";
    textarea.style.fontFamily = "monospace";
    textarea.style.fontSize = "12px";
    textarea.placeholder = "在此粘贴 Markdown...";
    box.appendChild(textarea);

    const actions = document.createElement("div");
    actions.className = "dialog-actions";

    const clearBtn = document.createElement("button");
    clearBtn.className = "dialog-btn";
    clearBtn.textContent = "清空";
    clearBtn.addEventListener("click", () => { textarea.value = ""; });
    actions.appendChild(clearBtn);

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "dialog-btn";
    cancelBtn.textContent = "取消";
    cancelBtn.addEventListener("click", closeDialog);
    actions.appendChild(cancelBtn);

    const importBtn = document.createElement("button");
    importBtn.className = "dialog-btn dialog-btn-primary";
    importBtn.textContent = "导入";
    importBtn.addEventListener("click", () => {
      const raw = textarea.value.trim();
      if (!raw) {
        showToast("请先粘贴 Markdown 内容。", "warning");
        return;
      }
      const parseResult = parseMarkdown(raw);
      const validation = validateAndBuildState(parseResult, "粘贴的 Markdown");
      closeDialog();
      if (validation.state) {
        setState(validation.state);
        renderResume(validation.state);
        updateA4Status();
        clearDirty();
      } else {
        const errorMsgs = validation.errors
          .filter((err) => err.level === "error")
          .map((err) => err.message);
        showDialog({
          title: "Markdown 导入失败",
          message: errorMsgs.join("\n") || "无法解析该 Markdown。",
          buttons: [{ text: "关闭", primary: true }],
        });
      }
    });
    actions.appendChild(importBtn);

    box.appendChild(actions);
    root.appendChild(box);
    setTimeout(() => textarea.focus(), 50);
  });
}

/**
 * Check if current state is dirty and confirm before proceeding.
 * @param {Function} onProceed
 */
function _proceedWithDirtyCheck(onProceed) {
  if (!isDirty()) {
    onProceed();
    return;
  }
  showDialog({
    title: "有未保存的修改",
    message: "当前简历有未保存的修改，导入新内容将覆盖。是否继续？",
    buttons: [
      { text: "取消" },
      { text: "继续导入", primary: true, action: onProceed },
    ],
  });
}

/**
 * Handle "粘贴 JSON" button — show dialog with textarea.
 */
function handlePasteJson() {
  _proceedWithDirtyCheck(() => {
    const root = document.getElementById("dialog-root");
    if (!root) return;

    root.innerHTML = "";
    root.classList.add("active");

    const backdrop = document.createElement("div");
    backdrop.className = "dialog-backdrop";
    backdrop.addEventListener("click", closeDialog);
    root.appendChild(backdrop);

    const box = document.createElement("div");
    box.className = "dialog-box";
    box.style.maxWidth = "600px";

    const titleEl = document.createElement("h3");
    titleEl.className = "dialog-title";
    titleEl.textContent = "粘贴 JSON";
    box.appendChild(titleEl);

    const msgEl = document.createElement("p");
    msgEl.className = "dialog-message";
    msgEl.textContent = "将简历 JSON 粘贴到下方文本框，支持带 ```json 代码块标记。";
    box.appendChild(msgEl);

    const textarea = document.createElement("textarea");
    textarea.className = "dialog-input";
    textarea.style.width = "100%";
    textarea.style.minHeight = "300px";
    textarea.style.fontFamily = "monospace";
    textarea.style.fontSize = "12px";
    textarea.placeholder = "在此粘贴 JSON...";
    box.appendChild(textarea);

    const actions = document.createElement("div");
    actions.className = "dialog-actions";

    const clearBtn = document.createElement("button");
    clearBtn.className = "dialog-btn";
    clearBtn.textContent = "清空";
    clearBtn.addEventListener("click", () => {
      textarea.value = "";
    });
    actions.appendChild(clearBtn);

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "dialog-btn";
    cancelBtn.textContent = "取消";
    cancelBtn.addEventListener("click", closeDialog);
    actions.appendChild(cancelBtn);

    const importBtn = document.createElement("button");
    importBtn.className = "dialog-btn dialog-btn-primary";
    importBtn.textContent = "导入";
    importBtn.addEventListener("click", () => {
      const raw = textarea.value.trim();
      if (!raw) {
        showToast("请先粘贴 JSON 内容。", "warning");
        return;
      }
      const result = importJsonResume(raw, "粘贴的 JSON");
      closeDialog();
      handleJsonImportResult(result, "粘贴的 JSON", raw);
    });
    actions.appendChild(importBtn);

    box.appendChild(actions);
    root.appendChild(box);
    setTimeout(() => textarea.focus(), 50);
  });
}

/**
 * Handle .json file import.
 * @param {File} file
 * @param {HTMLInputElement} fileInput
 */
function handleImportJsonFile(file, fileInput) {
  _proceedWithDirtyCheck(() => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const raw = e.target.result;
      const result = importJsonResume(raw, file.name);
      handleJsonImportResult(result, file.name, raw);
    };
    reader.onerror = () => {
      showToast("文件读取失败，请重试。", "error");
    };
    reader.readAsText(file);
    if (fileInput) fileInput.value = "";
  });
}

/**
 * Handle JSON import result — success or failure.
 * @param {{ errors: object[], state: object|null }} result
 * @param {string} fileName
 * @param {string} [rawJson]
 */
function handleJsonImportResult(result, fileName, rawJson) {
  if (result.state) {
    setState(result.state);
    renderResume(result.state);
    updateA4Status();
    clearDirty();
  } else {
    const errorMsgs = result.errors
      .filter((err) => err.level === "error")
      .map((err) => err.message);

    showDialog({
      title: "JSON 导入失败",
      message: errorMsgs.join("\n") || "无法解析该 JSON 文件。",
      buttons: [
        { text: "关闭" },
        {
          text: "复制修复 Prompt",
          primary: true,
          action: () => {
            const prompt = buildFixPrompt(result.errors, rawJson || "", !!rawJson);
            if (typeof navigator === "undefined" || !navigator.clipboard) {
              showToast("当前浏览器不支持自动复制。", "warning");
              return;
            }
            navigator.clipboard.writeText(prompt).then(() => {
              showToast("修复 Prompt 已复制到剪贴板。", "success");
            }).catch(() => {
              showToast("复制失败，请手动复制。", "error");
            });
          },
        },
      ],
    });
  }
}
