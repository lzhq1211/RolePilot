export function workbenchHref(runId?: string): string {
  // 无 runId 是独立排版工作台；已有 Run 则载入该 Run 的双栏交付。
  return runId ? `/workbench/?runId=${encodeURIComponent(runId)}` : "/workbench/";
}
