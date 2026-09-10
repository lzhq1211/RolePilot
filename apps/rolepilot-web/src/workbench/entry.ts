import { isDirty, loadDocument, startWorkbench } from "resume-workbench";
import { getWorkbench, saveWorkbenchDocument } from "./run-client";
import { createSession, documentFor, setDocument, type WorkbenchSession } from "./session";
import { renderSuggestions } from "./suggestions";
import workbenchTemplate from "resume-workbench/template?raw";
import "resume-workbench/styles/app.css";
import "resume-workbench/styles/resume.css";
import "resume-workbench/styles/print.css";

const style = document.createElement("style");
style.textContent = ".workbench-suggestions{position:static;width:auto;max-height:34vh;overflow:auto;padding:14px;background:#fff;border:1px solid #dbe3ee;border-radius:10px;box-shadow:0 8px 24px rgba(15,23,42,.08);margin:16px auto;max-width:860px}.workbench-suggestions-header{display:flex;justify-content:space-between;gap:12px;margin-bottom:8px}.workbench-suggestions-header span{color:#64748b;font-size:12px}.workbench-suggestions ol{margin:0;padding-left:20px}.workbench-suggestions li{margin:7px 0;color:#334155;font-size:13px;line-height:1.45}.workbench-reference-block{border-top:1px solid #e2e8f0;margin-top:12px;padding-top:10px}.workbench-reference-block strong{display:block;margin-bottom:5px}.workbench-reference-block ul{margin:0;padding-left:18px}.workbench-reference-block li{margin:4px 0;color:#475569;font-size:12px;line-height:1.4}.workbench-dual{display:grid;grid-template-columns:210mm minmax(360px,1fr);gap:20px;align-items:start;padding:20px;max-width:1800px;margin:0 auto}.workbench-pane{min-width:0}.workbench-pane-label{font-weight:700;color:#172033;margin:0 0 10px}.workbench-original-preview{background:#f8fafc;border:1px solid #dbe3ee;padding:12px;overflow:auto;max-height:calc(100vh - 180px)}.workbench-original-preview #resume-page{width:210mm;min-width:210mm;margin:0 auto;transform:none}.workbench-generated-pane{min-width:0}.workbench-generated-preview-wrap{overflow:auto;max-width:100%}.workbench-generated-preview{width:min(210mm,100%);min-width:0;margin:0 auto}.workbench-dual #workspace{padding:0;min-width:0}.workbench-dual #resume-list-panel{display:none}@media(max-width:1250px){.workbench-dual{grid-template-columns:210mm minmax(300px,1fr)}}@media(max-width:900px){.workbench-dual{grid-template-columns:1fr;padding:12px}.workbench-original-preview #resume-page{margin:0 auto}}@media print{.workbench-suggestions,.workbench-original-preview,.workbench-pane-label{display:none}.workbench-dual{display:block;padding:0}.workbench-generated-pane{width:100%}.workbench-generated-preview{width:210mm}}";
style.textContent += ".workbench-original-preview{overflow:visible;max-height:none}.workbench-reference-pane{min-width:0}.workbench-generated-pane{display:none}.workbench-dual{grid-template-columns:210mm minmax(300px,1fr)}@media(max-width:900px){.workbench-dual{grid-template-columns:1fr}}";
style.textContent += "#toolbar{margin-left:24px;margin-right:auto;width:max-content;max-width:calc(100vw - 48px);justify-content:flex-start;flex-wrap:nowrap;overflow:hidden}.toolbar-info{flex:0 1 170px;margin-left:4px}.toolbar-spacer{display:none}#resume-list-panel{margin-top:8px;margin-right:24px;background:#fff;color:#111;border-color:#d7dbe2;width:360px;min-height:220px;box-shadow:0 14px 34px rgba(15,23,42,.10)}#resume-list-panel .panel-header{padding:14px 16px;border-bottom-color:#e5e7eb}#resume-list-panel .panel-dir-name,#resume-list-panel .panel-icon-btn,#resume-list-panel .resume-list-item{color:#111}#resume-list-panel .panel-import-btn{background:#fff;color:#111;border-color:#cbd5e1;font-size:13px;padding:7px 10px}#resume-list-panel .panel-empty{padding:42px 16px;color:#111;font-size:18px;text-align:center}#resume-list-panel .resume-list-item{font-size:15px;padding:12px 16px}.workbench-dual{grid-template-columns:210mm minmax(560px,1fr);gap:32px;padding:12px 24px}.workbench-reference-pane{font-size:17px}.workbench-reference-pane .workbench-suggestions{max-width:none;width:100%;padding:24px;font-size:17px;line-height:1.75}.workbench-reference-pane .workbench-suggestions ol{padding-left:28px}.workbench-reference-pane .workbench-suggestions li{font-size:17px;line-height:1.75;margin:14px 0}.workbench-reference-block{padding-top:18px;margin-top:18px}.workbench-reference-block li{font-size:16px;line-height:1.7}";
style.textContent += [
  ".workbench-version-toolbar{position:fixed!important;top:78px;right:24px;z-index:120!important;width:auto!important;min-width:0;min-height:0;margin:0!important;padding:0;background:transparent!important;border:0!important;border-radius:0!important;box-shadow:none!important;overflow:visible!important}",
  ".workbench-version-toolbar{width:max-content!important}",
  ".workbench-version-toolbar .panel-header{display:flex;align-items:center;gap:6px;padding:4px;background:rgba(255,255,255,.96);border:1px solid #cbd5e1;border-radius:999px;box-shadow:0 8px 22px rgba(15,23,42,.12);cursor:grab;user-select:none;touch-action:none}",
  ".workbench-version-toolbar.is-dragging .panel-header{cursor:grabbing}",
  ".workbench-version-toggle,.workbench-version-toolbar .panel-import-btn{height:30px;border:1px solid #cbd5e1;border-radius:999px;background:#fff;color:#111;font:inherit;font-size:12px!important;font-weight:650;cursor:pointer;padding:5px 11px;line-height:1.2;transition:background .15s,color .15s,box-shadow .15s}",
  ".workbench-version-toggle{min-width:88px;text-align:center}",
  ".workbench-version-toggle:hover,.workbench-version-toolbar .panel-import-btn:hover{background:#111;color:#fff;box-shadow:0 3px 10px rgba(15,23,42,.16)}",
  ".workbench-version-toolbar .panel-import-btn{display:inline-flex;align-items:center;gap:4px}",
  ".workbench-version-toolbar .panel-import-btn::-webkit-details-marker{display:none}",
  ".workbench-version-toolbar:not(.is-expanded) #resume-list,.workbench-version-toolbar:not(.is-expanded) #panel-empty,.workbench-version-toolbar:not(.is-expanded) #panel-import-status{display:none!important}",
  ".workbench-version-toolbar.is-expanded #resume-list,.workbench-version-toolbar.is-expanded #panel-empty,.workbench-version-toolbar.is-expanded #panel-import-status{position:absolute;left:auto!important;right:0!important;top:calc(100% + 8px);width:240px!important;min-width:240px;box-sizing:border-box;margin:0;background:#fff;border:1px solid #dbe3ee;border-radius:16px;box-shadow:0 14px 35px rgba(15,23,42,.16);z-index:130}",
  ".workbench-version-toolbar.is-expanded #resume-list{max-height:360px;overflow:auto;padding:6px 0}",
  ".workbench-version-toolbar.is-expanded #panel-empty{padding:18px 14px;color:#475569;font-size:13px;text-align:center}",
  ".workbench-version-toolbar.is-expanded #panel-import-status{padding:8px 10px;transform:translateY(calc(-100% - 16px));font-size:11px}",
  ".workbench-version-toolbar .resume-list-item{font-size:13px;padding:8px 12px;color:#111}",
  ".workbench-version-toolbar .toolbar-popover{border:1px solid #dbe3ee;border-radius:14px;background:#fff;color:#111;box-shadow:0 14px 35px rgba(15,23,42,.16)}",
  ".workbench-version-toolbar .toolbar-popover .toolbar-btn{color:#111}",
  ".workbench-version-toolbar .toolbar-popover .toolbar-btn:hover{background:#f1f5f9;color:#111}",
  ".workbench-reference-pane .workbench-suggestions{min-height:calc(100vh - 270px);max-height:none}",
  "@media(max-width:900px){.workbench-version-toolbar{top:68px;right:14px}.workbench-version-toolbar.is-expanded #resume-list,.workbench-version-toolbar.is-expanded #panel-empty,.workbench-version-toolbar.is-expanded #panel-import-status{width:min(240px,calc(100vw - 28px))}}",
].join("");
style.textContent += "#toolbar{overflow:visible}#toolbar #workbench-variants{display:flex;align-items:center;gap:6px;margin-left:8px;flex-shrink:0;position:relative;z-index:500}#toolbar #workbench-variants .workbench-variant-button{height:30px;padding:5px 12px;border:1px solid #cbd5e1;border-radius:999px;background:#fff;color:#111;font-size:12px;font-weight:650;white-space:nowrap}#toolbar #workbench-variants .workbench-variant-button:hover,#toolbar #workbench-variants .workbench-variant-button.toolbar-btn-active{background:#111;color:#fff}#toolbar #workbench-variants .toolbar-menu{flex-shrink:0;position:relative}#toolbar #workbench-variants .toolbar-popover{left:0;right:auto;top:calc(100% + 8px);z-index:600}#toolbar #workbench-variants .panel-import-btn{height:30px;border:1px solid #cbd5e1;border-radius:999px;background:#fff;color:#111;font-size:12px;font-weight:650;padding:5px 11px;white-space:nowrap}#toolbar #workbench-variants .panel-import-btn:hover{background:#111;color:#fff}";

document.head.append(style);

document.body.innerHTML = workbenchTemplate;
document.getElementById("privacy-notice")?.remove();

const toolbar = document.getElementById("toolbar");
const versionPanel = document.getElementById("resume-list-panel");
if (toolbar && versionPanel) {
  const importMenu = versionPanel.querySelector<HTMLElement>("#import-menu");
  if (importMenu) toolbar.append(importMenu);
  versionPanel.remove();
}

const runId = new URLSearchParams(window.location.search).get("runId");
const session = createSession(runId);
let runData: Awaited<ReturnType<typeof getWorkbench>> | null = null;
let saveInFlight = false;

function setWorkbenchStatus(message: string): void {
  const region = document.getElementById("status-region");
  if (region) { region.textContent = message; region.dataset.state = message.includes("失败") || message.includes("不可用") || message.includes("暂无") ? "error" : "ready"; }
}

function setActiveVariantLabel(variant: "original" | "generated"): void {
  const filename = document.getElementById("current-filename");
  if (filename) filename.textContent = variant === "generated" ? "agent新稿" : "原稿";
}

function updateSuggestionPanel(): void {
  document.querySelector(".workbench-suggestions")?.remove();
  const current = runData?.generated ?? null;
  const panel = renderSuggestions(current, runData ?? undefined);
  document.querySelector(".workbench-reference-pane")?.append(panel);
}

function renderRunVersions(): void {
  const list = document.getElementById("resume-list");
  const empty = document.getElementById("panel-empty");
  if (!list || !runData) return;
  list.replaceChildren();
  for (const variant of ["generated", "original"] as const) {
    const content = documentFor(runData, variant);
    if (!content) continue;
    const item = window.document.createElement("li");
    item.className = "resume-list-item";
    item.textContent = variant === "generated" ? "Agent 新稿" : "原稿";
    item.addEventListener("click", (event) => {
      event.stopPropagation();
      if (session.activeVariant === variant || (isDirty() && !confirm("切换前放弃当前未保存修改？"))) return;
      setDocument(session, variant, content);
      loadDocument(session.document!);
      updateSuggestionPanel();
      setWorkbenchStatus(variant === "generated" ? "已切换到 Agent 新稿" : "已切换到原稿");
      versionPanel?.classList.remove("is-expanded");
    });
    list.append(item);
  }
  if (empty) empty.hidden = list.children.length > 0;
}

function createDualLayout(): void {
  const workspace = document.getElementById("workspace");
  if (!workspace || document.querySelector(".workbench-dual")) return;
  const page = document.getElementById("resume-page");
  if (!page) return;
  const dual = document.createElement("div"); dual.className = "workbench-dual";
  const left = document.createElement("section"); left.className = "workbench-pane";
  left.innerHTML = '<h2 class="workbench-pane-label">编辑器</h2><div class="workbench-original-preview"></div>';
  const preview = left.querySelector(".workbench-original-preview")!;
  const right = document.createElement("section"); right.className = "workbench-pane workbench-reference-pane";
  right.innerHTML = '<h2 class="workbench-pane-label">补充、判断与建议</h2>';
  preview.append(page);
  workspace.replaceWith(dual); left.append(workspace); dual.append(left, right);
}

function onChange(content: NonNullable<WorkbenchSession["document"]>): void {
  session.document = content;
  session.editSequence += 1;
}

async function save(content: NonNullable<WorkbenchSession["document"]>): Promise<boolean> {
  if (!session.runId || !session.document) return true;
  if (saveInFlight) return false;
  const documentId = session.document.documentId;
  const editSequence = session.editSequence;
  saveInFlight = true;
  setWorkbenchStatus("保存中…");
  try {
    const result = await saveWorkbenchDocument(session.runId, documentId, content, session.revision);
    session.revision = result.revision;
    if (editSequence === session.editSequence) setWorkbenchStatus("正文已保存");
    else setWorkbenchStatus("已保存上一版，当前修改尚未保存");
    return true;
  } catch (error) {
    setWorkbenchStatus(error instanceof Error && error.message.includes("版本") ? "保存冲突，请重新读取" : "保存失败，请重试");
    return false;
  } finally {
    saveInFlight = false;
  }
}

function startLocal(): void {
  startWorkbench({ loadSample: true, onChange, onSave: async () => save(session.document!) });
  setWorkbenchStatus("本地模式");
}

async function startRun(): Promise<void> {
  const controller = new AbortController();
  try {
    runData = await getWorkbench(runId!, controller.signal);
    const original = documentFor(runData, "original");
    if (!original) throw new Error("原稿暂无可用正文。");
    setDocument(session, "original", original);
    setActiveVariantLabel("original");
    startWorkbench({ document: session.document!, onChange, onSave: save });
    createDualLayout();
    addVariantControls();
    renderRunVersions();
    updateSuggestionPanel();
    setWorkbenchStatus("已载入编辑器；右侧为补充、判断与建议");
  } catch (error) {
    setWorkbenchStatus(error instanceof Error ? error.message : "工作台暂时不可用");
    document.getElementById("status-region")?.setAttribute("role", "alert");
  }
}

function addVariantControls(): void {
  const toolbar = document.getElementById("toolbar");
  if (!toolbar || document.getElementById("workbench-variants")) return;
  const group = document.createElement("div");
  group.id = "workbench-variants";
  group.className = "toolbar-group";
  for (const variant of ["original", "generated"] as const) {
    const button = document.createElement("button");
    button.className = "toolbar-btn workbench-variant-button";
    button.textContent = variant === "generated" ? "agent新稿" : "原稿";
    button.classList.toggle("toolbar-btn-active", session.activeVariant === variant);
    button.disabled = variant === "original" && runData?.original.availability !== "AVAILABLE";
    button.addEventListener("click", () => {
      if (!runData || session.activeVariant === variant || (isDirty() && !confirm("切换前放弃当前未保存修改？"))) return;
      const document = documentFor(runData, variant);
      if (!document) return;
      setDocument(session, variant, document);
      if (session.document) loadDocument(session.document);
      setActiveVariantLabel(variant);
      group.querySelectorAll<HTMLButtonElement>(".workbench-variant-button").forEach((candidate) => {
        candidate.classList.toggle("toolbar-btn-active", candidate === button);
      });
      updateSuggestionPanel();
      setWorkbenchStatus(variant === "generated" ? "已切换到 Agent 新稿" : "已切换到原稿");
    });
    group.append(button);
  }
  const importMenu = document.getElementById("import-menu");
  if (importMenu) group.append(importMenu);
  toolbar.prepend(group);
}

if (runId) void startRun();
else {
  startLocal();
  setWorkbenchStatus("请从完成的运行进入工作台；当前地址没有绑定 runId。");
}
