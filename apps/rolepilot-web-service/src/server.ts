import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { randomUUID } from "node:crypto";

import { SOURCE_LIMITS } from "web-contracts";

import type { SourceApi } from "./source-api.js";
import { MaintenanceBusyError, type MaintenanceGate } from "./maintenance-gate.js";

const MAX_HTTP_BODY_BYTES = SOURCE_LIMITS.maxFileBytes + 64 * 1024;

export function createSourceHttpServer(sourceApi: SourceApi, gate?: MaintenanceGate): Server {
  return createServer(async (nodeRequest, nodeResponse) => {
    let release: (() => void) | undefined;
    try {
      const pathname = new URL(nodeRequest.url ?? "/", "http://localhost").pathname;
      if (gate && !["GET", "HEAD", "OPTIONS"].includes(nodeRequest.method ?? "GET") && !pathname.startsWith("/api/maintenance/") && pathname !== "/api/instance-data") release = gate.admitRequest();
      const request = await toWebRequest(nodeRequest);
      await writeWebResponse(nodeResponse, await sourceApi.handle(request));
    } catch (error) {
      const detail = formatError(error);
      process.stderr.write(`[RolePilot] HTTP request failed: ${detail}\n`);
      if (error instanceof MaintenanceBusyError) {
        const requestId = randomUUID();
        writeJson(nodeResponse, 409, requestId, { error: { code: "INSTANCE_BUSY", message: "实例正在清理，请稍后重试。", retryable: true, requestId } });
        return;
      }
      if (error instanceof RequestBodyTooLargeError) {
        const requestId = randomUUID();
        writeJson(nodeResponse, 413, requestId, {
          error: {
            code: "FILE_TOO_LARGE",
            message: "文件超过 10 MiB 限制。",
            retryable: false,
            requestId,
          },
        });
        return;
      }

      const requestId = randomUUID();
      writeJson(nodeResponse, 503, requestId, {
        error: {
          code: "NETWORK_ERROR",
          message: "服务暂时不可用，请稍后重试。",
          retryable: true,
          requestId,
        },
      });
    } finally { release?.(); }
  });
}

async function toWebRequest(nodeRequest: IncomingMessage): Promise<Request> {
  const body = await readBody(nodeRequest);
  const headers = new Headers();
  for (const [name, value] of Object.entries(nodeRequest.headers)) {
    if (Array.isArray(value)) {
      headers.set(name, value.join(", "));
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }

  const host = headers.get("host") ?? "127.0.0.1";
  const url = new URL(nodeRequest.url ?? "/", `http://${host}`);
  const method = nodeRequest.method ?? "GET";
  const requestBody =
    body.byteLength === 0
      ? undefined
      : (body.buffer.slice(
          body.byteOffset,
          body.byteOffset + body.byteLength,
        ) as ArrayBuffer);
  return new Request(url, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : requestBody,
  });
}

async function readBody(nodeRequest: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of nodeRequest) {
    const bytes = Buffer.from(chunk);
    length += bytes.byteLength;
    if (length > MAX_HTTP_BODY_BYTES) {
      throw new RequestBodyTooLargeError();
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, length);
}

async function writeWebResponse(nodeResponse: ServerResponse, response: Response): Promise<void> {
  for (const [name, value] of response.headers) {
    nodeResponse.setHeader(name, value);
  }
  nodeResponse.statusCode = response.status;
  if (!response.body) {
    nodeResponse.end();
    return;
  }
  const reader = response.body.getReader();
  const disconnected = () => { void reader.cancel().catch(() => undefined); };
  nodeResponse.on("close", disconnected);
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (nodeResponse.destroyed) break;
      nodeResponse.write(Buffer.from(chunk.value));
    }
    nodeResponse.end();
  } catch {
    reader.cancel().catch(() => undefined);
    nodeResponse.destroy();
  } finally { nodeResponse.off("close", disconnected); }
}

function writeJson(
  nodeResponse: ServerResponse,
  status: number,
  requestId: string,
  payload: unknown,
): void {
  nodeResponse.statusCode = status;
  nodeResponse.setHeader("content-type", "application/json; charset=utf-8");
  nodeResponse.setHeader("x-request-id", requestId);
  nodeResponse.end(JSON.stringify(payload));
}

class RequestBodyTooLargeError extends Error {}

function formatError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = "code" in error && typeof error.code === "string" ? ` [${error.code}]` : "";
  return `${error.name}${code}: ${error.message}`;
}
