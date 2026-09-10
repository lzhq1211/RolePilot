import type { CreateRunInput, RunDto, RunEvidenceInput, RunListDto } from "web-contracts";

export async function createRun(input: CreateRunInput, signal?: AbortSignal): Promise<RunDto> {
  const response = await fetch("/api/runs", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": `run-${crypto.randomUUID()}` }, body: JSON.stringify(input), signal });
  return readJson<RunDto>(response);
}
export async function getRun(runId: string, signal?: AbortSignal): Promise<RunDto> { return readJson<RunDto>(await fetch(`/api/runs/${encodeURIComponent(runId)}`, { signal })); }
export async function listRuns(signal?: AbortSignal): Promise<RunListDto> { return readJson<RunListDto>(await fetch("/api/runs", { signal })); }
export async function cancelRun(runId: string, signal?: AbortSignal): Promise<RunDto> { return readJson<RunDto>(await fetch(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST", signal })); }
export async function submitEvidence(runId: string, evidenceText: string, signal?: AbortSignal): Promise<unknown> { return readJson(await fetch(`/api/runs/${encodeURIComponent(runId)}/evidence`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ evidenceText } satisfies RunEvidenceInput), signal })); }
export function runEventsUrl(runId: string, cursor?: number): string { return `/api/runs/${encodeURIComponent(runId)}/events${cursor ? `?cursor=${cursor}` : ""}`; }
async function readJson<T = unknown>(response: Response): Promise<T> { const payload = await response.json().catch(() => null); if (!response.ok) throw new Error(payload?.error?.message ?? "服务暂时不可用，请稍后重试。"); return payload as T; }
