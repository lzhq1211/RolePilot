import type { WorkbenchDto, WorkbenchSaveResponseDto, WorkbenchDocumentContent } from "web-contracts";

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  if (!response.ok) throw new Error(body?.error?.message ?? "工作台请求失败。");
  return body as T;
}

export function getWorkbench(runId: string, signal?: AbortSignal): Promise<WorkbenchDto> {
  return fetch(`/api/runs/${encodeURIComponent(runId)}/workbench`, { signal }).then((response) => readJson<WorkbenchDto>(response));
}

export function saveWorkbenchDocument(runId: string, documentId: string, content: WorkbenchDocumentContent, expectedRevision: number, signal?: AbortSignal): Promise<WorkbenchSaveResponseDto> {
  return fetch(`/api/runs/${encodeURIComponent(runId)}/workbench/documents/${encodeURIComponent(documentId)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content, expectedRevision }),
    signal,
  }).then((response) => readJson<WorkbenchSaveResponseDto>(response));
}
