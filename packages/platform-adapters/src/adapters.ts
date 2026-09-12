import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { BackendRegistryError } from "./registry.js";
import { createReplayAdapter } from "./replay.js";
import type {
  BackendAdapter,
  BackendCommandProgressEvent,
  BackendCommandExecutor,
  BackendCommandInvocation,
  BackendCommandResult,
  BackendExecutionMode,
  BackendHealth,
  BackendOutputSource,
  BackendProvider,
  BackendReplaySource,
  CapabilityProfile,
  NormalizedBackendRequest,
  NormalizedBackendResult,
} from "./types.js";

type OfflineMode = Extract<BackendExecutionMode, "stub" | "replay">;

type ExtractionResult = {
  outputText: string;
  raw?: unknown;
  metadata?: Record<string, unknown>;
};

type OutputExtractor = (execution: BackendCommandResult) => ExtractionResult;

type CliFailureClassification = {
  code:
    | "CLI_SPAWN_FAILURE"
    | "CLI_PERMISSION_DENIED"
    | "CLI_CANCELLED"
    | "CLI_TIMEOUT"
    | "CLI_EXIT"
    | "PROVIDER_UNAVAILABLE";
  message: string;
  retryable: boolean;
};

export interface CliAdapterOptions {
  provider: BackendProvider;
  command: string;
  baseArgs: string[];
  executor?: BackendCommandExecutor;
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  replaySources?: Partial<Record<OfflineMode, BackendReplaySource>>;
  supportsFallback?: boolean;
  extractOutput: OutputExtractor;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isBackendRegistryErrorLike(
  value: unknown,
): value is BackendRegistryError {
  return (
    value instanceof BackendRegistryError ||
    (isPlainObject(value) &&
      Reflect.get(value, "name") === "BackendRegistryError" &&
      typeof Reflect.get(value, "code") === "string" &&
      typeof Reflect.get(value, "message") === "string")
  );
}

function createAdapterError({
  request,
  code,
  message,
  retryable,
  cause,
  metadata,
}: {
  request: Pick<NormalizedBackendRequest, "requestId" | "provider" | "mode">;
  code: BackendRegistryError["code"];
  message: string;
  retryable: boolean;
  cause?: unknown;
  metadata?: Record<string, unknown>;
}) {
  return new BackendRegistryError({
    requestId: request.requestId,
    provider: request.provider,
    mode: request.mode,
    code,
    message,
    retryable,
    cause,
    metadata,
  });
}

function createOutputCapturePath(
  options: CliAdapterOptions,
  request: NormalizedBackendRequest,
) {
  if (options.provider !== "codex") {
    return undefined;
  }

  const baseDir = request.cwd ?? options.cwd ?? process.cwd();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return path.join(baseDir, `.codex-last-message-${suffix}.txt`);
}

function readOutputCapture(outputCapturePath?: string) {
  if (!outputCapturePath) {
    return null;
  }

  try {
    const text = fs.readFileSync(outputCapturePath, "utf8").trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

function getErrorCode(error: unknown) {
  if (!error || typeof error !== "object") {
    return null;
  }

  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : null;
}

function isPermissionDeniedError(error: unknown) {
  const code = getErrorCode(error);
  return code === "EPERM" || code === "EACCES";
}

function isProviderUnavailableError(error: unknown) {
  const code = getErrorCode(error);
  return code === "ENOENT";
}

function textSuggestsMissingProvider(text: string) {
  return /\bnot found\b|is not recognized as the name of a cmdlet|command not found|No such file or directory/i.test(
    text,
  );
}

function textSuggestsPermissionDenied(text: string) {
  return /\bEPERM\b|\bEACCES\b|permission denied|access is denied/i.test(text);
}

function createAbortError(reason?: unknown) {
  if (reason instanceof Error) {
    return reason;
  }

  const message =
    typeof reason === "string" && reason.trim().length > 0
      ? reason
      : "Run cancelled by user.";
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function classifyExecutionFailure(
  provider: BackendProvider,
  execution: BackendCommandResult,
): CliFailureClassification {
  if (execution.cancelled) {
    return {
      code: "CLI_CANCELLED",
      message:
        execution.error instanceof Error &&
        execution.error.message.trim().length > 0
          ? execution.error.message
          : `Run cancelled while waiting for ${provider} CLI.`,
      retryable: false,
    };
  }

  if (execution.timedOut) {
    return {
      code: "CLI_TIMEOUT",
      message: `${provider} CLI timed out.`,
      retryable: true,
    };
  }

  if (isPermissionDeniedError(execution.error)) {
    return {
      code: "CLI_PERMISSION_DENIED",
      message: `${provider} CLI could not start because the current environment denied process spawn permissions. This is a runtime permission issue, not a model output issue. Try running outside the sandbox or switch to replay/stub mode.`,
      retryable: false,
    };
  }

  if (isProviderUnavailableError(execution.error)) {
    return {
      code: "PROVIDER_UNAVAILABLE",
      message: `${provider} CLI is unavailable in the current environment. Install it or ensure it is on PATH before using live mode.`,
      retryable: false,
    };
  }

  return {
    code: "CLI_SPAWN_FAILURE",
    message:
      execution.error instanceof Error && execution.error.message.trim().length > 0
        ? execution.error.message
        : `${provider} CLI failed to start.`,
    retryable: false,
  };
}

function classifyCliExit(
  provider: BackendProvider,
  execution: BackendCommandResult,
): CliFailureClassification {
  const combinedOutput = `${execution.stderr}\n${execution.stdout}`.trim();

  if (textSuggestsMissingProvider(combinedOutput)) {
    return {
      code: "PROVIDER_UNAVAILABLE",
      message: `${provider} CLI is unavailable in the current environment. Install it or ensure it is on PATH before using live mode.`,
      retryable: false,
    };
  }

  if (textSuggestsPermissionDenied(combinedOutput)) {
    return {
      code: "CLI_PERMISSION_DENIED",
      message: `${provider} CLI exited because the current environment denied execution permissions. This is a runtime permission issue, not a model output issue. Try running outside the sandbox or switch to replay/stub mode.`,
      retryable: false,
    };
  }

  return {
    code: "CLI_EXIT",
    message:
      combinedOutput ||
      `${provider} CLI exited with status ${execution.exitCode}.`,
    retryable: false,
  };
}

function executionMetadata(execution: BackendCommandResult) {
  return {
    ...(execution.completionSignal
      ? { completionSignal: execution.completionSignal }
      : {}),
    ...(execution.outputSource ? { outputSource: execution.outputSource } : {}),
    ...(execution.pid !== undefined ? { pid: execution.pid } : {}),
  };
}

function buildCliArgs(
  request: NormalizedBackendRequest,
  baseArgs: string[],
  outputCapturePath?: string,
) {
  const args = [...baseArgs];
  if (outputCapturePath) {
    args.push("--output-last-message", outputCapturePath);
  }
  if (request.model) {
    args.push("--model", request.model);
  }
  if (request.temperature !== undefined) {
    args.push("--temperature", String(request.temperature));
  }
  if (request.maxTokens !== undefined) {
    args.push("--max-tokens", String(request.maxTokens));
  }
  if (Array.isArray(request.extraArgs)) {
    args.push(...request.extraArgs.map((value) => String(value)));
  }
  return args;
}

function createInvocationMetadata(
  options: CliAdapterOptions,
  request: NormalizedBackendRequest,
  args: string[],
  outputCapturePath?: string,
) {
  return {
    transport: "cli" as const,
    command: options.command,
    args,
    cwd: request.cwd ?? options.cwd,
    timeoutMs: request.timeoutMs ?? options.timeoutMs ?? 10 * 60 * 1000,
    model: request.model,
    temperature: request.temperature,
    maxTokens: request.maxTokens,
    extraArgs: request.extraArgs,
    inputBytes: Buffer.byteLength(request.input, "utf8"),
    ...(outputCapturePath
      ? {
          outputCapturePath,
          outputCaptureStableMs: 750,
        }
      : {}),
    progressHeartbeatMs: 15_000,
  };
}

async function terminateChildProcess(
  child: ReturnType<typeof spawn>,
  onProgress?: (event: Pick<BackendCommandProgressEvent, "stage" | "detail">) => void,
) {
  if (
    child.pid === undefined ||
    child.exitCode !== null ||
    child.signalCode !== null
  ) {
    return;
  }

  onProgress?.({
    stage: "terminating-process",
    detail: "已拿到最终输出，正在结束子进程。",
  });

  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        shell: false,
        windowsHide: true,
      });

      let finished = false;
      const finish = () => {
        if (finished) {
          return;
        }
        finished = true;
        resolve();
      };

      const timer = setTimeout(finish, 1500);
      killer.on("error", () => {
        clearTimeout(timer);
        finish();
      });
      killer.on("close", () => {
        clearTimeout(timer);
        finish();
      });
    });
    return;
  }

  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore cleanup failure
        }
      }
      resolve();
    }, 1500);

    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export const defaultCommandExecutor: BackendCommandExecutor = async (
  invocation: BackendCommandInvocation,
) => {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    let settling = false;
    let lastCaptureSignature: string | null = null;
    let captureStableAt = 0;
    let lastProgressAt = startedAt;
    let sawStdout = false;
    let sawOutputCapture = false;
    let child: ReturnType<typeof spawn>;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let capturePoll: ReturnType<typeof setInterval> | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let abortListener: (() => void) | undefined;

    const emitProgress = (
      stage: BackendCommandProgressEvent["stage"],
      detail: string,
      extra: Partial<
        Pick<
          BackendCommandProgressEvent,
          "pid" | "outputCapturePath" | "outputSource"
        >
      > = {},
    ) => {
      lastProgressAt = Date.now();
      invocation.onProgress?.({
        requestId: invocation.requestId,
        provider: invocation.provider,
        stage,
        detail,
        elapsedMs: Date.now() - startedAt,
        ...extra,
      });
    };

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (capturePoll) clearInterval(capturePoll);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (abortListener) {
        invocation.signal?.removeEventListener("abort", abortListener);
      }
    };

    const complete = (result: BackendCommandResult) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };

    const beginSettle = () => {
      if (settled || settling) {
        return false;
      }
      settling = true;
      cleanup();
      return true;
    };

    const stdoutText = () => Buffer.concat(stdoutChunks).toString("utf8");
    const stderrText = () => Buffer.concat(stderrChunks).toString("utf8");
    const pid = () => child.pid ?? undefined;

    emitProgress(
      "provider-launching",
      `正在启动 ${invocation.provider} provider。`,
    );

    try {
      child = spawn(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        env: invocation.env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
      });
    } catch (error) {
      complete({
        stdout: "",
        stderr: "",
        exitCode: null,
        signal: null,
        timedOut: false,
        cancelled: false,
        error,
        completionSignal: "spawn-error",
      });
      return;
    }

    if (child.pid !== undefined) {
      emitProgress("provider-started", "已启动 provider。", {
        pid: child.pid,
      });
    }

    timer = invocation.timeoutMs
      ? setTimeout(() => {
          if (!beginSettle()) {
            return;
          }
          timedOut = true;
          emitProgress("timed-out", "Provider 运行超时。", { pid: pid() });
          void terminateChildProcess(child, (event) => emitProgress(event.stage, event.detail, {
            pid: pid(),
          })).finally(() => {
            complete({
              stdout: stdoutText(),
              stderr: stderrText(),
              exitCode: null,
              signal: null,
              timedOut: true,
              cancelled: false,
              error: Object.assign(new Error("Command timed out."), {
                code: "ETIMEDOUT",
              }),
              completionSignal: "timeout",
              outputSource: stdoutText().length > 0 ? "stdout" : undefined,
              pid: pid(),
            });
          });
        }, invocation.timeoutMs)
      : null;

    const heartbeatMs = invocation.progressHeartbeatMs ?? 15_000;
    heartbeatTimer = heartbeatMs
      ? setInterval(() => {
          if (settled || settling) {
            return;
          }
          if (Date.now() - lastProgressAt < heartbeatMs) {
            return;
          }
          emitProgress(
            "heartbeat",
            `${invocation.provider} provider 仍在运行，不是卡死。`,
            { pid: pid() },
          );
        }, Math.max(1_000, Math.min(heartbeatMs, 5_000)))
      : null;

    capturePoll = invocation.outputCapturePath
      ? setInterval(() => {
          if (settled || settling) {
            return;
          }

          try {
            const stat = fs.statSync(invocation.outputCapturePath!);
            const capturedOutput = readOutputCapture(invocation.outputCapturePath);
            if (!capturedOutput) {
              lastCaptureSignature = null;
              captureStableAt = 0;
              sawOutputCapture = false;
              return;
            }

            if (!sawOutputCapture) {
              sawOutputCapture = true;
              emitProgress(
                "waiting-output-file-stable",
                "正在等待最终消息文件稳定写入。",
                {
                  pid: pid(),
                  outputCapturePath: invocation.outputCapturePath,
                  outputSource: "output-file",
                },
              );
            }

            const signature = `${stat.size}:${stat.mtimeMs}`;
            if (lastCaptureSignature !== signature) {
              lastCaptureSignature = signature;
              captureStableAt = Date.now();
              return;
            }

            const stableMs = invocation.outputCaptureStableMs ?? 750;
            if (Date.now() - captureStableAt < stableMs) {
              return;
            }

            if (!beginSettle()) {
              return;
            }

            emitProgress("final-output-ready", "已拿到最终输出。", {
              pid: pid(),
              outputCapturePath: invocation.outputCapturePath,
              outputSource: "output-file",
            });

            void terminateChildProcess(child, (event) =>
              emitProgress(event.stage, event.detail, {
                pid: pid(),
                outputCapturePath: invocation.outputCapturePath,
                outputSource: "output-file",
              }),
            ).finally(() => {
              complete({
                stdout: capturedOutput,
                stderr: stderrText(),
                exitCode: 0,
                signal: null,
                timedOut: false,
                cancelled: false,
                error: undefined,
                completionSignal: "output-file-stable",
                outputSource: "output-file",
                pid: pid(),
              });
            });
          } catch {
            lastCaptureSignature = null;
            captureStableAt = 0;
            sawOutputCapture = false;
          }
        }, invocation.outputCapturePollMs ?? 250)
      : null;

    if (invocation.signal) {
      abortListener = () => {
        if (!beginSettle()) {
          return;
        }
        const error = createAbortError(invocation.signal?.reason);
        emitProgress("cancelled", error.message, { pid: pid() });
        void terminateChildProcess(child, (event) =>
          emitProgress(event.stage, event.detail, { pid: pid() }),
        ).finally(() => {
          complete({
            stdout: stdoutText(),
            stderr: stderrText(),
            exitCode: null,
            signal: null,
            timedOut: false,
            cancelled: true,
            error,
            completionSignal: "cancelled",
            outputSource: stdoutText().length > 0 ? "stdout" : undefined,
            pid: pid(),
          });
        });
      };

      if (invocation.signal.aborted) {
        abortListener();
        return;
      }

      invocation.signal.addEventListener("abort", abortListener, { once: true });
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      if (!sawStdout) {
        sawStdout = true;
        emitProgress("stdout-first-byte", "已收到首字节输出。", {
          pid: pid(),
          outputSource: "stdout",
        });
      }
      stdoutChunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    if (invocation.input) {
      child.stdin?.write(invocation.input, "utf8");
    }
    child.stdin?.end();

    child.on("error", (error) => {
      if (!beginSettle()) {
        return;
      }
      complete({
        stdout: stdoutText(),
        stderr: stderrText(),
        exitCode: null,
        signal: null,
        timedOut,
        cancelled: false,
        error,
        completionSignal: "spawn-error",
        outputSource: stdoutText().length > 0 ? "stdout" : undefined,
        pid: pid(),
      });
    });

    child.on("close", (code, signal) => {
      if (!beginSettle()) {
        return;
      }

      const capturedOutput = readOutputCapture(invocation.outputCapturePath);
      emitProgress("process-exited", "Provider 进程已结束。", {
        pid: pid(),
        ...(invocation.outputCapturePath
          ? { outputCapturePath: invocation.outputCapturePath }
          : {}),
        ...(capturedOutput
          ? { outputSource: "output-file" as BackendOutputSource }
          : stdoutText().length > 0
            ? { outputSource: "stdout" as BackendOutputSource }
            : {}),
      });
      complete({
        stdout: capturedOutput ?? stdoutText(),
        stderr: stderrText(),
        exitCode: code,
        signal: signal ?? null,
        timedOut,
        cancelled: false,
        error: undefined,
        completionSignal: "process-exit",
        outputSource: capturedOutput
          ? "output-file"
          : stdoutText().length > 0
            ? "stdout"
            : undefined,
        pid: pid(),
      });
    });
  });
};

function extractPlainTextOutput(
  execution: BackendCommandResult,
): ExtractionResult {
  return {
    outputText: String(execution.stdout ?? "").trim(),
    metadata: {
      extraction: {
        parser: "plain-text",
      },
    },
  };
}

function extractOpenCodeOutput(
  execution: BackendCommandResult,
): ExtractionResult {
  const lines = String(execution.stdout ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const textParts: string[] = [];
  const errors: string[] = [];
  let parsedEvents = 0;

  for (const line of lines) {
    let event: unknown;
    try {
      event = JSON.parse(line);
      parsedEvents += 1;
    } catch {
      continue;
    }

    if (!isPlainObject(event)) {
      continue;
    }

    const eventType = Reflect.get(event, "type");
    const part = Reflect.get(event, "part");
    if (
      eventType === "text" &&
      isPlainObject(part) &&
      typeof Reflect.get(part, "text") === "string"
    ) {
      textParts.push(String(Reflect.get(part, "text")));
      continue;
    }

    if (eventType === "error") {
      const errorValue = Reflect.get(event, "error");
      const messageValue = Reflect.get(event, "message");
      const message =
        typeof errorValue === "string"
          ? errorValue
          : typeof messageValue === "string"
            ? messageValue
            : "Unknown OpenCode error";
      errors.push(message);
    }
  }

  if (errors.length > 0) {
    throw new Error(`OpenCode returned error events: ${errors.join(" | ")}`);
  }

  if (textParts.length > 0) {
    return {
      outputText: textParts.join("\n").trim(),
      metadata: {
        extraction: {
          parser: "opencode-json-events",
          parsedEvents,
          textPartCount: textParts.length,
          errorCount: errors.length,
        },
      },
    };
  }

  throw new Error("OpenCode did not return any usable text events.");
}

function createCliAdapter(options: CliAdapterOptions): BackendAdapter {
  const executor = options.executor ?? defaultCommandExecutor;
  const replayAdapter = createReplayAdapter({
    provider: options.provider,
    env: options.env,
    cwd: options.cwd,
    sources: options.replaySources,
  });

  return {
    provider: options.provider,

    async execute(
      request: NormalizedBackendRequest,
    ): Promise<NormalizedBackendResult> {
      if (request.provider !== options.provider) {
        throw createAdapterError({
          request,
          code: "INVALID_REQUEST",
          message: `Adapter provider ${options.provider} cannot execute request for ${request.provider}.`,
          retryable: false,
        });
      }

      if (request.mode !== "live") {
        return replayAdapter.execute(request);
      }

      const outputCapturePath = createOutputCapturePath(options, request);
      const args = buildCliArgs(request, options.baseArgs, outputCapturePath);
      const invocation = createInvocationMetadata(
        options,
        request,
        args,
        outputCapturePath,
      );

      if (request.signal?.aborted) {
        throw createAdapterError({
          request,
          code: "CLI_CANCELLED",
          message: createAbortError(request.signal.reason).message,
          retryable: false,
          metadata: {
            invocation,
          },
          cause: request.signal.reason,
        });
      }

      const execution = await executor({
        requestId: request.requestId,
        provider: request.provider,
        command: options.command,
        args,
        cwd: invocation.cwd,
        env: request.env ?? options.env,
        timeoutMs: invocation.timeoutMs,
        input: request.input,
        outputCapturePath,
        outputCaptureStableMs: invocation.outputCaptureStableMs,
        progressHeartbeatMs: invocation.progressHeartbeatMs,
        signal: request.signal,
        onProgress: request.onProgress,
      });

      try {
        if (execution.cancelled || execution.timedOut) {
          const classified = classifyExecutionFailure(options.provider, execution);
          throw createAdapterError({
            request,
            code: classified.code,
            message:
              classified.code === "CLI_TIMEOUT"
                ? `${options.provider} CLI timed out after ${invocation.timeoutMs}ms.`
                : classified.message,
            retryable: classified.retryable,
            metadata: {
              invocation,
              stderr: execution.stderr,
              stdout: execution.stdout,
              ...executionMetadata(execution),
            },
            cause: execution.error,
          });
        }

        if (execution.error && execution.exitCode === null) {
          const classified = classifyExecutionFailure(options.provider, execution);
          throw createAdapterError({
            request,
            code: classified.code,
            message: classified.message,
            retryable: classified.retryable,
            metadata: {
              invocation,
              stderr: execution.stderr,
              stdout: execution.stdout,
              ...executionMetadata(execution),
            },
            cause: execution.error,
          });
        }

        if ((execution.exitCode ?? 0) !== 0) {
          const classified = classifyCliExit(options.provider, execution);
          throw createAdapterError({
            request,
            code: classified.code,
            message: classified.message,
            retryable: classified.retryable,
            metadata: {
              invocation,
              stderr: execution.stderr,
              stdout: execution.stdout,
              exitCode: execution.exitCode,
              signal: execution.signal,
              ...executionMetadata(execution),
            },
          });
        }

        const extracted = options.extractOutput(execution);
        return {
          requestId: request.requestId,
          provider: request.provider,
          mode: request.mode,
          status: "succeeded",
          outputText: extracted.outputText,
          raw: extracted.raw,
          metadata: {
            invocation: {
              ...invocation,
              ...executionMetadata(execution),
            },
            stderr: execution.stderr,
            exitCode: execution.exitCode,
            signal: execution.signal,
            ...extracted.metadata,
          },
        };
      } catch (cause) {
        if (isBackendRegistryErrorLike(cause)) {
          throw cause;
        }
        throw createAdapterError({
          request,
          code: "OUTPUT_PARSE_ERROR",
          message: cause instanceof Error ? cause.message : String(cause),
          retryable: false,
          metadata: {
            invocation: {
              ...invocation,
              ...executionMetadata(execution),
            },
            stderr: execution.stderr,
            stdout: execution.stdout,
            exitCode: execution.exitCode,
            signal: execution.signal,
          },
          cause,
        });
      } finally {
        if (outputCapturePath) {
          fs.rmSync(outputCapturePath, { force: true });
        }
      }
    },

    async health(): Promise<BackendHealth> {
      try {
        const child = spawn(options.command, ["--version"], {
          cwd: options.cwd,
          env: options.env,
          stdio: ["ignore", "pipe", "pipe"],
          shell: process.platform === "win32",
        });
        const result = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
          const timer = setTimeout(() => {
            child.kill("SIGTERM");
            resolve({ ok: false, detail: `${options.command} --version timed out` });
          }, 5000);
          child.on("error", () => {
            clearTimeout(timer);
            resolve({ ok: false, detail: `${options.command} not found` });
          });
          child.on("close", (code) => {
            clearTimeout(timer);
            resolve({
              ok: code === 0,
              detail: code === 0
                ? `${options.command} available`
                : `${options.command} --version exited with ${code}`,
            });
          });
        });
        return {
          provider: options.provider,
          ...result,
          checkedAt: new Date().toISOString(),
        };
      } catch {
        return {
          provider: options.provider,
          ok: false,
          detail: `${options.command} health check failed`,
          checkedAt: new Date().toISOString(),
        };
      }
    },

    capabilities(): CapabilityProfile {
      return {
        provider: options.provider,
        executionModes: ["live", "stub", "replay"],
        supportsStreaming: false,
        supportsFallback: options.supportsFallback ?? true,
      };
    },
  };
}

type OpenAIChatMessage = {
  role?: unknown;
  content?: unknown;
};

type ApiAdapterOptions = {
  provider: Extract<BackendProvider, "openai-chat" | "anthropic-api">;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  replaySources?: Partial<Record<OfflineMode, BackendReplaySource>>;
  supportsFallback?: boolean;
  baseUrl?: string;
  apiKey?: string;
  defaultModel?: string;
  fetch?: typeof fetch;
};

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : undefined;
}

function getEnvValue(
  env: NodeJS.ProcessEnv | undefined,
  key: string,
): string | undefined {
  return normalizeOptionalString(env?.[key] ?? process.env[key]);
}

function getEnvNumberValue(
  env: NodeJS.ProcessEnv | undefined,
  key: string,
): number | undefined {
  const value = getEnvValue(env, key);
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function createApiInvocationMetadata(
  options: ApiAdapterOptions,
  request: NormalizedBackendRequest,
  endpoint: string,
) {
  const env = request.env ?? options.env;
  return {
    transport: "api" as const,
    endpoint,
    cwd: request.cwd ?? options.cwd,
    timeoutMs:
      request.timeoutMs ??
      getEnvNumberValue(env, "AGENT_TIMEOUT_MS") ??
      10 * 60 * 1000,
    model: request.model ?? options.defaultModel,
    temperature: request.temperature,
    maxTokens:
      request.maxTokens ??
      getEnvNumberValue(env, "OPENAI_MAX_OUTPUT_TOKENS") ??
      getEnvNumberValue(env, "MAX_OUTPUT_TOKENS"),
    extraArgs: request.extraArgs,
    inputBytes: Buffer.byteLength(request.input, "utf8"),
    outputSource: "api" as const,
  };
}

function extractOpenAIChatOutput(value: unknown): string {
  if (!isPlainObject(value)) {
    throw new Error("OpenAI Chat response must be an object.");
  }

  const choices = Reflect.get(value, "choices");
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error("OpenAI Chat response missing choices.");
  }

  const firstChoice = choices[0];
  if (!isPlainObject(firstChoice)) {
    throw new Error("OpenAI Chat response choice must be an object.");
  }

  const message = Reflect.get(firstChoice, "message");
  if (!isPlainObject(message)) {
    throw new Error("OpenAI Chat response choice missing message.");
  }

  const content = Reflect.get(message, "content");
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (
          isPlainObject(part) &&
          typeof Reflect.get(part, "text") === "string"
        ) {
          return String(Reflect.get(part, "text"));
        }
        return "";
      })
      .join("\n")
      .trim();
    if (text.length > 0) {
      return text;
    }
  }

  throw new Error("OpenAI Chat response message content must contain text.");
}

function buildOpenAIChatMessages(request: NormalizedBackendRequest) {
  const rawMessages = request.metadata?.messages;
  if (Array.isArray(rawMessages)) {
    const messages: OpenAIChatMessage[] = [];
    for (const entry of rawMessages) {
      if (!isPlainObject(entry)) {
        throw new Error("metadata.messages entries must be objects.");
      }
      const role = Reflect.get(entry, "role");
      const content = Reflect.get(entry, "content");
      if (typeof role !== "string" || typeof content !== "string") {
        throw new Error(
          "metadata.messages entries must contain string role and content.",
        );
      }
      messages.push({ role, content });
    }
    if (messages.length > 0) {
      return messages;
    }
  }

  const systemPrompt =
    typeof request.metadata?.systemPrompt === "string"
      ? request.metadata.systemPrompt
      : undefined;
  return [
    ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
    { role: "user", content: request.input },
  ];
}

function createApiError({
  request,
  code,
  message,
  retryable,
  cause,
  metadata,
}: {
  request: Pick<NormalizedBackendRequest, "requestId" | "provider" | "mode">;
  code: BackendRegistryError["code"];
  message: string;
  retryable: boolean;
  cause?: unknown;
  metadata?: Record<string, unknown>;
}) {
  return createAdapterError({
    request,
    code,
    message,
    retryable,
    cause,
    metadata,
  });
}

function createOpenAIChatRequestBody(
  request: NormalizedBackendRequest,
  invocation: ReturnType<typeof createApiInvocationMetadata>,
) {
  if (
    typeof invocation.model !== "string" ||
    invocation.model.trim().length === 0
  ) {
    throw new Error("A model is required for openai-chat live mode.");
  }

  return {
    model: invocation.model,
    messages: buildOpenAIChatMessages(request),
    ...(invocation.temperature !== undefined
      ? { temperature: invocation.temperature }
      : {}),
    ...(invocation.maxTokens !== undefined
      ? { max_tokens: invocation.maxTokens }
      : {}),
  };
}

export function createOpenAIChatAdapter(
  options: Omit<ApiAdapterOptions, "provider"> = {},
) {
  const provider = "openai-chat" as const;
  const env = options.env;
  const replayAdapter = createReplayAdapter({
    provider,
    env,
    cwd: options.cwd,
    sources: options.replaySources,
  });

  return {
    provider,

    async execute(request: NormalizedBackendRequest): Promise<NormalizedBackendResult> {
      if (request.provider !== provider) {
        throw createApiError({
          request,
          code: "INVALID_REQUEST",
          message: `Adapter provider ${provider} cannot execute request for ${request.provider}.`,
          retryable: false,
        });
      }

      if (request.mode !== "live") {
        return replayAdapter.execute(request);
      }

      const requestEnv = request.env ?? env;

      const apiKey =
        normalizeOptionalString(options.apiKey) ??
        getEnvValue(requestEnv, "OPENAI_API_KEY");
      const baseUrl =
        normalizeOptionalString(options.baseUrl) ??
        getEnvValue(requestEnv, "OPENAI_BASE_URL") ??
        "https://api.openai.com/v1";
      const model =
        normalizeOptionalString(request.model) ??
        normalizeOptionalString(options.defaultModel) ??
        getEnvValue(requestEnv, "OPENAI_CHAT_MODEL") ??
        getEnvValue(requestEnv, "DEFAULT_MODEL");
      const endpoint = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
      const invocation = createApiInvocationMetadata(
        { ...options, provider, env: requestEnv, defaultModel: model },
        { ...request, model },
        endpoint,
      );

      if (!apiKey) {
        throw createApiError({
          request,
          code: "API_AUTHENTICATION",
          message: "OPENAI_API_KEY is required for openai-chat live mode.",
          retryable: false,
          metadata: { invocation },
        });
      }
      if (!model) {
        throw createApiError({
          request,
          code: "INVALID_REQUEST",
          message: "A model is required for openai-chat live mode.",
          retryable: false,
          metadata: { invocation },
        });
      }

      let timedOut = false;
      try {
        const controller = new AbortController();
        const timeoutMs = invocation.timeoutMs;
        const timeout = setTimeout(() => {
          timedOut = true;
          controller.abort(
            createAbortError(
              `openai-chat API request timed out after ${timeoutMs}ms.`,
            ),
          );
        }, timeoutMs);
        const abortListener = () => {
          controller.abort(createAbortError(request.signal?.reason));
        };

        if (request.signal?.aborted) {
          abortListener();
        } else {
          request.signal?.addEventListener("abort", abortListener, {
            once: true,
          });
        }

        const response = await (options.fetch ?? fetch)(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(createOpenAIChatRequestBody(request, invocation)),
          signal: controller.signal,
        }).finally(() => {
          clearTimeout(timeout);
          request.signal?.removeEventListener("abort", abortListener);
        });
        const responseText = await response.text();
        let raw: unknown;
        try {
          raw = responseText ? JSON.parse(responseText) : null;
        } catch {
          raw = responseText;
        }

        if (!response.ok) {
          const code =
            response.status === 401 || response.status === 403
              ? "API_AUTHENTICATION"
              : response.status === 429
                ? "API_RATE_LIMIT"
                : "API_REQUEST_FAILED";
          throw createApiError({
            request,
            code,
            message: `openai-chat API request failed with status ${response.status}.`,
            retryable: response.status === 429 || response.status >= 500,
            metadata: {
              invocation,
              status: response.status,
              response: raw,
            },
          });
        }

        const outputText = extractOpenAIChatOutput(raw);
        return {
          requestId: request.requestId,
          provider,
          mode: request.mode,
          status: "succeeded",
          outputText,
          raw,
          metadata: {
            invocation,
            status: response.status,
            usage: isPlainObject(raw) ? Reflect.get(raw, "usage") : undefined,
          },
        };
      } catch (cause) {
        if (isBackendRegistryErrorLike(cause)) {
          throw cause;
        }
        if (cause instanceof Error && cause.name === "AbortError") {
          throw createApiError({
            request,
            code: timedOut ? "API_TIMEOUT" : "CLI_CANCELLED",
            message:
              cause.message ||
              (timedOut
                ? "openai-chat API request timed out."
                : "Run cancelled by user."),
            retryable: timedOut,
            cause,
            metadata: { invocation },
          });
        }
        throw createApiError({
          request,
          code: "API_REQUEST_FAILED",
          message: cause instanceof Error ? cause.message : String(cause),
          retryable: true,
          cause,
          metadata: { invocation },
        });
      }
    },

    async health(): Promise<BackendHealth> {
      const apiKey =
        normalizeOptionalString(options.apiKey) ??
        getEnvValue(env, "OPENAI_API_KEY");
      return {
        provider,
        ok: Boolean(apiKey),
        detail: apiKey
          ? "OPENAI_API_KEY configured"
          : "OPENAI_API_KEY missing",
        checkedAt: new Date().toISOString(),
      };
    },

    capabilities(): CapabilityProfile {
      return {
        provider,
        executionModes: ["live", "stub", "replay"],
        supportsStreaming: false,
        supportsFallback: options.supportsFallback ?? true,
      };
    },
  } satisfies BackendAdapter;
}

export function createAnthropicApiAdapter(
  options: Omit<ApiAdapterOptions, "provider"> = {},
) {
  const provider = "anthropic-api" as const;
  const env = options.env;
  const replayAdapter = createReplayAdapter({
    provider,
    env,
    cwd: options.cwd,
    sources: options.replaySources,
  });

  return {
    provider,

    async execute(request: NormalizedBackendRequest): Promise<NormalizedBackendResult> {
      if (request.provider !== provider) {
        throw createApiError({
          request,
          code: "INVALID_REQUEST",
          message: `Adapter provider ${provider} cannot execute request for ${request.provider}.`,
          retryable: false,
        });
      }
      if (request.mode !== "live") {
        return replayAdapter.execute(request);
      }
      throw createApiError({
        request,
        code: "PROVIDER_UNAVAILABLE",
        message:
          "anthropic-api live mode requires the planned direct Anthropic SDK adapter; use openai-chat, claude CLI, stub, or replay for now.",
        retryable: false,
        metadata: {
          invocation: createApiInvocationMetadata(
            { ...options, provider, env },
            request,
            normalizeOptionalString(options.baseUrl) ??
              getEnvValue(env, "ANTHROPIC_BASE_URL") ??
              "https://api.anthropic.com/v1/messages",
          ),
        },
      });
    },

    async health(): Promise<BackendHealth> {
      const apiKey =
        normalizeOptionalString(options.apiKey) ??
        getEnvValue(env, "ANTHROPIC_API_KEY");
      return {
        provider,
        ok: Boolean(apiKey),
        detail: apiKey
          ? "ANTHROPIC_API_KEY configured; live adapter not implemented yet"
          : "ANTHROPIC_API_KEY missing; live adapter not implemented yet",
        checkedAt: new Date().toISOString(),
      };
    },

    capabilities(): CapabilityProfile {
      return {
        provider,
        executionModes: ["stub", "replay"],
        supportsStreaming: false,
        supportsFallback: options.supportsFallback ?? true,
      };
    },
  } satisfies BackendAdapter;
}

export function createClaudeAdapter(
  options: Omit<
    CliAdapterOptions,
    "provider" | "command" | "baseArgs" | "extractOutput"
  > = {},
) {
  return createCliAdapter({
    ...options,
    provider: "claude",
    command: "claude",
    baseArgs: ["--print"],
    extractOutput: extractPlainTextOutput,
  });
}

export function createOpenCodeAdapter(
  options: Omit<
    CliAdapterOptions,
    "provider" | "command" | "baseArgs" | "extractOutput"
  > = {},
) {
  return createCliAdapter({
    ...options,
    provider: "opencode",
    command: "opencode",
    baseArgs: ["run", "--format", "json"],
    extractOutput: extractOpenCodeOutput,
  });
}

export function createCodexAdapter(
  options: Omit<
    CliAdapterOptions,
    "provider" | "command" | "baseArgs" | "extractOutput"
  > = {},
) {
  return createCliAdapter({
    ...options,
    provider: "codex",
    command: "codex",
    baseArgs: ["exec"],
    extractOutput: extractPlainTextOutput,
  });
}

export function createConcreteAdapters(
  options: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    claude?: Omit<
      CliAdapterOptions,
      "provider" | "command" | "baseArgs" | "extractOutput"
    >;
    opencode?: Omit<
      CliAdapterOptions,
      "provider" | "command" | "baseArgs" | "extractOutput"
    >;
    codex?: Omit<
      CliAdapterOptions,
      "provider" | "command" | "baseArgs" | "extractOutput"
    >;
    openaiChat?: Omit<ApiAdapterOptions, "provider">;
    anthropicApi?: Omit<ApiAdapterOptions, "provider">;
  } = {},
) {
  return [
    createOpenAIChatAdapter({
      env: options.env,
      cwd: options.cwd,
      ...options.openaiChat,
    }),
    createAnthropicApiAdapter({
      env: options.env,
      cwd: options.cwd,
      ...options.anthropicApi,
    }),
    createClaudeAdapter({
      env: options.env,
      cwd: options.cwd,
      ...options.claude,
    }),
    createOpenCodeAdapter({
      env: options.env,
      cwd: options.cwd,
      ...options.opencode,
    }),
    createCodexAdapter({
      env: options.env,
      cwd: options.cwd,
      ...options.codex,
    }),
  ] as const;
}
