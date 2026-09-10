import { randomUUID } from "node:crypto";

import type { ApiErrorResponse, CreateRunInput } from "web-contracts";
import type { RunEvent } from "web-contracts";

import { IdempotencyKeyConflictError } from "./errors.js";
import { RunRepositoryError } from "./run-types.js";
import { RunService, RunServiceError } from "./run-service.js";
import type { RunEventHub } from "./run-events.js";
import { submitRunEvidence, type RunEvidenceObjectStore } from "./run-evidence.js";
import { DEFAULT_DEPLOYMENT_INSTANCE_ID } from "./deployment.js";
import { SupabaseRestError } from "./supabase.js";

const COLLECTION_PATH = "/api/runs";

export type RunApi = {
  handle(request: Request): Promise<Response>;
};

export function createRunApi({
  runService,
  requestIdFactory = randomUUID,
  eventHub,
  evidenceStore,
  deploymentInstanceId,
  returnCleanupStatus = false,
}: {
  runService: RunService;
  requestIdFactory?: () => string;
  eventHub?: RunEventHub;
  evidenceStore?: RunEvidenceObjectStore;
  deploymentInstanceId?: string;
  returnCleanupStatus?: boolean;
}): RunApi {
  const instanceId = deploymentInstanceId ?? DEFAULT_DEPLOYMENT_INSTANCE_ID;
  return {
    async handle(request: Request): Promise<Response> {
      const requestId = requestIdFactory();
      try {
        const url = new URL(request.url);
        if (url.pathname === COLLECTION_PATH && request.method === "POST") {
          const result = await runService.create(await readCreateInput(request), request.headers.get("idempotency-key") ?? "");
          return Response.json(result.run, { status: 202, headers: { "x-request-id": requestId } });
        }
        const match = url.pathname.match(/^\/api\/runs\/([^/]+)(\/(?:events|cancel|evidence))?$/);
        if (url.pathname === COLLECTION_PATH && request.method === "GET") {
          const items = await runService.list();
          const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), 100);
          const cursor = url.searchParams.get("cursor");
          const start = cursor ? decodeListCursor(cursor) : 0;
          const page = items.slice(start, start + limit);
          return Response.json({ items: page, nextCursor: start + limit < items.length ? encodeListCursor(start + limit) : null }, { headers: { "x-request-id": requestId } });
        }
        if (!match) throw new RunServiceError("REQUEST_INVALID", "请求路径或方法无效。");
        const runId = decodeURIComponent(match[1]);
        if (match[2] === "/events" && request.method === "GET") return await createEventsResponse(runService, runId, request, eventHub, requestId);
        if (url.pathname.endsWith("/evidence") && request.method === "POST") {
          if (!evidenceStore) throw new Error("Evidence store is not configured.");
          const payload = await readEvidenceInput(request);
          const evidence = await submitRunEvidence({ runService, runRepository: runService.repository, objectStore: evidenceStore, runId, evidenceText: payload.evidenceText, eventHub, deploymentInstanceId: instanceId });
          if (!evidence) throw new RunServiceError("RUN_NOT_FOUND", "未找到这次运行。");
          return Response.json({ id: evidence.id, status: evidence.status, createdAt: evidence.createdAt }, { status: 202, headers: { "x-request-id": requestId } });
        }
        if (request.method === "GET") {
          const run = await runService.get(runId);
          if (!run) throw new RunServiceError("RUN_NOT_FOUND", "未找到这次运行。");
          return Response.json((await import("./run-types.js")).toRunDto(run), { headers: { "x-request-id": requestId } });
        }
        if (request.method === "DELETE") {
          if (request.headers.get("x-rolepilot-confirm") !== "DELETE_RUN") throw new DeleteConfirmationError();
          const deleted = await runService.delete(runId);
          if (!deleted) throw new RunServiceError("RUN_NOT_FOUND", "未找到这次运行。");
          if (returnCleanupStatus) return Response.json({ id: deleted.id, status: deleted.status, cleanupStatus: deleted.cleanupStatus }, { status: 202, headers: { "x-request-id": requestId } });
          return new Response(null, { status: 204, headers: { "x-request-id": requestId } });
        }
        if (match[2] === "/cancel" && request.method === "POST") {
          let cancelled;
          try { cancelled = await runService.cancel(runId, eventHub); } catch (error) { if (error instanceof Error && error.message === "RUN_NOT_CANCELLABLE") throw new RunNotCancellableError(); throw error; }
          if (!cancelled) throw new RunServiceError("RUN_NOT_FOUND", "未找到这次运行。");
          return Response.json((await import("./run-types.js")).toRunDto(cancelled), { headers: { "x-request-id": requestId } });
        }
        throw new RunServiceError("REQUEST_INVALID", "请求路径或方法无效。");
      } catch (error) {
        return errorResponse(error, requestId);
      }
    },
  };
}

async function readCreateInput(request: Request): Promise<CreateRunInput> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new RunServiceError("REQUEST_INVALID", "Content-Type 必须是 application/json。");
  }
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    throw new RunServiceError("REQUEST_INVALID", "请求正文不是有效 JSON。");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new RunServiceError("REQUEST_INVALID", "创建运行请求无效。");
  }
  return payload as CreateRunInput;
}

async function readEvidenceInput(request: Request): Promise<{ evidenceText: string }> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) throw new RunServiceError("REQUEST_INVALID", "Content-Type 必须是 application/json。");
  const payload = await request.json();
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new RunServiceError("REQUEST_INVALID", "证据请求无效。");
  return payload as { evidenceText: string };
}

function errorResponse(error: unknown, requestId: string): Response {
  const mapped = mapError(error);
  if (mapped.code === "NETWORK_ERROR" || error instanceof SupabaseRestError) logUnexpectedApiError("run", requestId, error);
  const payload: ApiErrorResponse = {
    error: {
      code: mapped.code,
      message: mapped.message,
      retryable: mapped.retryable,
      requestId,
      ...(mapped.fieldErrors ? { fieldErrors: mapped.fieldErrors } : {}),
    },
  };
  return Response.json(payload, {
    status: mapped.status,
    headers: { "x-request-id": requestId },
  });
}

function logUnexpectedApiError(scope: string, requestId: string, error: unknown): void {
  const detail = formatError(error);
  process.stderr.write(`[RolePilot] ${scope} request ${requestId} failed: ${detail}\n`);
}

function formatError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = "code" in error && typeof error.code === "string" ? ` [${error.code}]` : "";
  return `${error.name}${code}: ${error.message}`;
}

function mapError(error: unknown): {
  code: ApiErrorResponse["error"]["code"];
  message: string;
  retryable: boolean;
  status: number;
  fieldErrors?: RunServiceError["fieldErrors"];
} {
  if (error instanceof RunServiceError) {
    return {
      code:
        error.code === "SOURCE_NOT_FOUND"
          ? "SOURCE_NOT_FOUND"
          : error.code === "RUN_NOT_FOUND"
            ? "RUN_NOT_FOUND"
          : error.code === "SOURCE_NOT_READY" || error.code === "SOURCE_TEXT_UNAVAILABLE"
            ? "SOURCE_TEXT_UNAVAILABLE"
            : "REQUEST_INVALID",
      message: error.message,
      retryable: false,
      status:
          error.code === "SOURCE_NOT_FOUND" || error.code === "RUN_NOT_FOUND"
          ? 404
          : error.code === "SOURCE_NOT_READY" || error.code === "SOURCE_TEXT_UNAVAILABLE"
            ? 409
            : 400,
      fieldErrors: error.fieldErrors,
    };
  }
  if (error instanceof DeleteConfirmationError) return { code: "DELETE_CONFIRMATION_REQUIRED", message: "删除运行需要确认。", retryable: false, status: 428 };
  if (error instanceof EventCursorError) return { code: "EVENT_CURSOR_INVALID", message: "事件游标无效。", retryable: false, status: 400 };
  if (error instanceof RunNotCancellableError) return { code: "RUN_NOT_CANCELLABLE", message: "这次运行当前不可取消。", retryable: false, status: 409 };
  if (error instanceof Error && error.message === "RUN_NOT_RESUMABLE") return { code: "RUN_NOT_RESUMABLE", message: "运行无法恢复。", retryable: false, status: 409 };
  if (error instanceof Error && error.message === "REQUEST_INVALID") return { code: "REQUEST_INVALID", message: "请求无效。", retryable: false, status: 400 };
  if (error instanceof IdempotencyKeyConflictError) {
    return {
      code: "IDEMPOTENCY_CONFLICT",
      message: "此 Idempotency-Key 已用于不同请求。",
      retryable: false,
      status: 409,
    };
  }
  if (error instanceof RunRepositoryError) {
    if (error.code === "RUN_NOT_RESUMABLE") {
      return { code: "RUN_NOT_RESUMABLE", message: "运行无法恢复。", retryable: false, status: 409 };
    }
    if (error.code === "RUN_CONFLICT") {
      return { code: "RUN_CONFLICT", message: "运行状态冲突，请先取消或等待执行、导出结束后重试。", retryable: false, status: 409 };
    }
  }
  if (error instanceof SupabaseRestError && error.code === "22P02") {
    return { code: "REQUEST_INVALID", message: "请求中的资源 ID 无效。", retryable: false, status: 400 };
  }
  return {
    code: "NETWORK_ERROR",
    message: "服务暂时不可用，请稍后重试。",
    retryable: true,
    status: 503,
  };
}

class DeleteConfirmationError extends Error {}

function encodeListCursor(value: number): string {
  return Buffer.from(JSON.stringify({ offset: value }), "utf8").toString("base64url");
}

function decodeListCursor(value: string): number {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { offset?: unknown };
    if (!Number.isSafeInteger(parsed.offset) || (parsed.offset as number) < 0) throw new Error();
    return parsed.offset as number;
  } catch {
    throw new RunServiceError("REQUEST_INVALID", "分页游标无效。");
  }
}

async function createEventsResponse(runService: RunService, runId: string, request: Request, eventHub: RunEventHub | undefined, requestId: string): Promise<Response> {
  const headerCursor = request.headers.get("last-event-id");
  const queryCursor = new URL(request.url).searchParams.get("cursor");
  if (headerCursor && queryCursor && headerCursor !== queryCursor) throw new EventCursorError();
  const rawCursor = headerCursor ?? queryCursor ?? "0";
  const sequence = Number(rawCursor);
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new EventCursorError();
  if (!(await runService.get(runId))) throw new RunServiceError("RUN_NOT_FOUND", "未找到这次运行。");
  const encoder = new TextEncoder();
  let dispose = () => {};
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let cursor = sequence;
      let unsubscribe: (() => void) | undefined;
      const close = () => { if (!closed) { closed = true; unsubscribe?.(); clearTimeout(timeout); request.signal.removeEventListener("abort", close); controller.close(); } };
      const timeout = setTimeout(close, 15_000);
      dispose = () => { if (!closed) { closed = true; unsubscribe?.(); clearTimeout(timeout); request.signal.removeEventListener("abort", close); } };
      request.signal.addEventListener("abort", close, { once: true });
      const push = (event: RunEvent) => {
        if (closed || event.sequence <= cursor) return;
        cursor = event.sequence;
        controller.enqueue(encoder.encode(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`));
        if (["run.completed", "run.failed", "run.cancelled"].includes(event.type)) close();
      };
      let replaying = true;
      const buffered: RunEvent[] = [];
      unsubscribe = eventHub?.subscribe(runId, (event) => { if (replaying) buffered.push(event); else push(event); });
      try {
        const events = await runService.eventsAfter(runId, sequence);
        for (const event of [...events, ...buffered].sort((a, b) => a.sequence - b.sequence)) push(event);
        replaying = false;
        const run = await runService.get(runId);
        if (!run) throw new Error("not found");
        if (["COMPLETED", "FAILED", "UNSUPPORTED", "CANCELLED"].includes(run.status)) close();
      } catch { close(); }
    },
    cancel() { dispose(); },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", "x-request-id": requestId } });
}

class EventCursorError extends Error {}
class RunNotCancellableError extends Error {}
