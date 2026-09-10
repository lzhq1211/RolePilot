import type { WorkbenchAvailableDocumentDto, WorkbenchActionAuditDto, WorkbenchDto } from "web-contracts";

export function renderSuggestions(workbenchDocument: WorkbenchAvailableDocumentDto | null, context?: Pick<WorkbenchDto, "preflight" | "actionHistory">): HTMLElement {
  const panel = window.document.createElement("aside");
  panel.className = "workbench-suggestions no-print";
  panel.setAttribute("aria-label", "简历建议");
  if (!workbenchDocument?.review?.report) return panel;
  const report = workbenchDocument.review.report;
  panel.innerHTML = `<div class="workbench-suggestions-header"><strong>建议</strong><span>${workbenchDocument.review.kind === "final-bound" ? "基于当前 Agent 稿" : "历史建议"}</span></div>`;
  const list = window.document.createElement("ol");
  for (const issue of report.topIssues) {
    const item = window.document.createElement("li");
    item.textContent = `${issue.problem} ${issue.recommendedAction}`;
    list.append(item);
  }
  panel.append(list);
  const scope = context?.preflight?.safeWritingScope ?? [];
  if (scope.length) appendReference(panel, "可直接参考的补充判断", scope);
  const actions = (context?.actionHistory ?? []).filter((item) => item.status === "executed" || item.status === "no-op");
  if (actions.length) appendReference(panel, "已执行处理", actions.map((item: WorkbenchActionAuditDto) => item.decision.reason));
  return panel;
}

function appendReference(panel: HTMLElement, title: string, values: string[]): void {
  const block = window.document.createElement("section");
  block.className = "workbench-reference-block";
  const heading = window.document.createElement("strong");
  heading.textContent = title;
  const list = window.document.createElement("ul");
  for (const value of values) {
    const item = window.document.createElement("li");
    item.textContent = value;
    list.append(item);
  }
  block.append(heading, list);
  panel.append(block);
}
