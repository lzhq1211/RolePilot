import fs from "node:fs";
import path from "node:path";

import { BackendRegistryError } from "./registry.js";
import type {
  BackendAdapter,
  BackendExecutionMode,
  BackendHealth,
  BackendProvider,
  BackendReplaySource,
  CapabilityProfile,
  NormalizedBackendErrorCode,
  NormalizedBackendRequest,
  NormalizedBackendResult,
  ReplayResponseEntry,
  ReplayState,
} from "./types.js";

type OfflineMode = Extract<BackendExecutionMode, "stub" | "replay">;

type ReplaySourceResolution = {
  source: BackendReplaySource;
  sourceKind: "inline" | "file" | "env";
  persistent: boolean;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isReplayObjectEntry(
  value: ReplayResponseEntry,
): value is Exclude<ReplayResponseEntry, string> {
  return typeof value !== "string";
}

export interface ReplayAdapterOptions {
  provider: BackendProvider;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  sources?: Partial<Record<OfflineMode, BackendReplaySource>>;
}

function createReplayError({
  request,
  code,
  message,
  retryable,
  cause,
  metadata,
}: {
  request: Pick<NormalizedBackendRequest, "requestId" | "provider" | "mode">;
  code: NormalizedBackendErrorCode;
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

function resolveReplayFilePath(filePath: string, cwd?: string) {
  const trimmed = filePath.trim();
  if (!trimmed) {
    throw new Error("Replay file path must not be empty.");
  }

  return path.isAbsolute(trimmed)
    ? trimmed
    : path.resolve(cwd ?? process.cwd(), trimmed);
}

function normalizeReplayEntries(
  provider: BackendProvider,
  raw: unknown,
): ReplayResponseEntry[] {
  if (Array.isArray(raw)) {
    return [...raw];
  }

  if (typeof raw === "string") {
    return [raw];
  }

  if (!raw || typeof raw !== "object") {
    throw new Error(
      `Replay payload for provider ${provider} must be a string, array, or object.`,
    );
  }

  if (!isPlainObject(raw)) {
    throw new Error(
      `Replay payload for provider ${provider} must be a plain object when provided as an object.`,
    );
  }

  const objectValue = raw;
  const queueValue =
    objectValue.entries ?? objectValue.responses ?? objectValue.queue;
  if (queueValue !== undefined) {
    return normalizeReplayEntries(provider, queueValue);
  }

  if (objectValue[provider] !== undefined) {
    return normalizeReplayEntries(provider, objectValue[provider]);
  }

  return [objectValue];
}

function createReplayState({
  provider,
  mode,
  sourceKind,
  source,
}: {
  provider: BackendProvider;
  mode: OfflineMode;
  sourceKind: "inline" | "file" | "env";
  source: BackendReplaySource;
}): ReplayState {
  if (Array.isArray(source.entries)) {
    return {
      provider,
      mode,
      source: sourceKind,
      baseDir: path.resolve(source.cwd ?? process.cwd()),
      filePath: source.filePath,
      entries: [...source.entries],
    };
  }

  if (typeof source.filePath === "string") {
    const resolvedFilePath = resolveReplayFilePath(source.filePath, source.cwd);
    const raw: unknown = JSON.parse(fs.readFileSync(resolvedFilePath, "utf8"));
    return {
      provider,
      mode,
      source: sourceKind,
      baseDir: path.dirname(resolvedFilePath),
      filePath: resolvedFilePath,
      entries: normalizeReplayEntries(provider, raw),
    };
  }

  throw new Error(
    `No replay source configured for provider ${provider} in ${mode} mode.`,
  );
}

function createReplayMetadata(state: ReplayState) {
  return {
    mode: state.mode,
    source: state.source,
    provider: state.provider,
    filePath: state.filePath,
    remaining: state.entries.length,
  };
}

function resolveReplayText(entry: ReplayResponseEntry, state: ReplayState) {
  if (typeof entry === "string") {
    return entry;
  }

  if (!entry || typeof entry !== "object") {
    throw new Error("Replay response must be a string or object.");
  }

  if (typeof entry.outputText === "string") {
    return entry.outputText;
  }

  if (typeof entry.text === "string") {
    return entry.text;
  }

  const filePath = entry.file ?? entry.responseFile;
  if (typeof filePath === "string" && filePath.trim()) {
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(state.baseDir, filePath);
    return fs.readFileSync(absolutePath, "utf8");
  }

  return null;
}

function normalizeReplayFailure(
  entry: Exclude<ReplayResponseEntry, string>,
  request: NormalizedBackendRequest,
  state: ReplayState,
): never {
  const replayError = entry.error;
  if (!replayError) {
    throw createReplayError({
      request,
      code: "MALFORMED_REPLAY",
      message: `Replay payload for provider ${request.provider} is missing text, outputText, file, responseFile, or error.`,
      retryable: false,
      metadata: {
        replay: createReplayMetadata(state),
      },
    });
  }

  if (typeof replayError === "string") {
    throw createReplayError({
      request,
      code: "ADAPTER_FAILURE",
      message: replayError,
      retryable: false,
      metadata: {
        replay: createReplayMetadata(state),
      },
    });
  }

  throw createReplayError({
    request,
    code: replayError.code ?? "ADAPTER_FAILURE",
    message: replayError.message,
    retryable: replayError.retryable ?? false,
    metadata: {
      replay: createReplayMetadata(state),
      ...replayError.metadata,
    },
  });
}

function consumeReplayEntry(
  state: ReplayState,
  request: NormalizedBackendRequest,
): NormalizedBackendResult {
  const next = state.entries.shift();
  if (next === undefined) {
    throw createReplayError({
      request,
      code: "REPLAY_EXHAUSTED",
      message: `Replay queue exhausted for provider ${request.provider} in ${request.mode} mode.`,
      retryable: false,
      metadata: {
        replay: createReplayMetadata(state),
      },
    });
  }

  if (typeof next !== "string" && (!next || typeof next !== "object")) {
    throw createReplayError({
      request,
      code: "MALFORMED_REPLAY",
      message: `Replay payload for provider ${request.provider} must be a string or object entry.`,
      retryable: false,
      metadata: {
        replay: createReplayMetadata(state),
      },
    });
  }

  const outputText = resolveReplayText(next, state);
  if (outputText === null) {
    if (!isReplayObjectEntry(next)) {
      throw createReplayError({
        request,
        code: "MALFORMED_REPLAY",
        message: `Replay payload for provider ${request.provider} is missing text, outputText, file, responseFile, or error.`,
        retryable: false,
        metadata: {
          replay: createReplayMetadata(state),
        },
      });
    }

    return normalizeReplayFailure(next, request, state);
  }

  return {
    requestId: request.requestId,
    provider: request.provider,
    mode: request.mode,
    status: "succeeded",
    outputText,
    raw: typeof next === "string" ? undefined : next.raw,
    metadata: {
      ...(typeof next === "string" ? undefined : next.metadata),
      replay: createReplayMetadata(state),
      invocation: {
        transport: "replay",
      },
    },
  };
}

function resolveEnvReplaySource(
  provider: BackendProvider,
  mode: OfflineMode,
  env: NodeJS.ProcessEnv | undefined,
  cwd?: string,
): ReplaySourceResolution | null {
  if (mode !== "stub") {
    return null;
  }

  const stubFilePath = String(env?.ORCHESTRATE_AGENT_STUB_FILE ?? "").trim();
  if (!stubFilePath) {
    return null;
  }

  return {
    source: { filePath: stubFilePath, cwd },
    sourceKind: "env",
    persistent: true,
  };
}

function resolveConfiguredSource(
  options: ReplayAdapterOptions,
  request: NormalizedBackendRequest,
  mode: OfflineMode,
): ReplaySourceResolution {
  if (
    Array.isArray(request.replay?.entries) ||
    typeof request.replay?.filePath === "string"
  ) {
    return {
      source: request.replay,
      sourceKind: request.replay.filePath ? "file" : "inline",
      persistent: false,
    };
  }

  const configured = options.sources?.[mode];
  if (
    Array.isArray(configured?.entries) ||
    typeof configured?.filePath === "string"
  ) {
    return {
      source: configured,
      sourceKind: configured.filePath ? "file" : "inline",
      persistent: true,
    };
  }

  const envSource = resolveEnvReplaySource(
    options.provider,
    mode,
    request.env ?? options.env,
    request.cwd ?? options.cwd,
  );
  if (envSource) {
    return envSource;
  }

  throw createReplayError({
    request,
    code: "INVALID_REQUEST",
    message: `No replay source configured for provider ${request.provider} in ${mode} mode.`,
    retryable: false,
  });
}

export function createReplayAdapter(
  options: ReplayAdapterOptions,
): BackendAdapter {
  const stateCache = new Map<OfflineMode, ReplayState>();

  function getState(
    mode: OfflineMode,
    request: NormalizedBackendRequest,
  ): ReplayState {
    const resolution = resolveConfiguredSource(options, request, mode);
    if (!resolution.persistent) {
      try {
        return createReplayState({
          provider: options.provider,
          mode,
          sourceKind: resolution.sourceKind,
          source: resolution.source,
        });
      } catch (cause) {
        throw createReplayError({
          request,
          code: "MALFORMED_REPLAY",
          message: cause instanceof Error ? cause.message : String(cause),
          retryable: false,
          cause,
        });
      }
    }

    const cached = stateCache.get(mode);
    if (cached) {
      return cached;
    }

    try {
      const state = createReplayState({
        provider: options.provider,
        mode,
        sourceKind: resolution.sourceKind,
        source: resolution.source,
      });
      stateCache.set(mode, state);
      return state;
    } catch (cause) {
      throw createReplayError({
        request,
        code: "MALFORMED_REPLAY",
        message: cause instanceof Error ? cause.message : String(cause),
        retryable: false,
        cause,
      });
    }
  }

  return {
    provider: options.provider,

    async execute(request: NormalizedBackendRequest) {
      if (request.mode === "live") {
        throw createReplayError({
          request,
          code: "INVALID_REQUEST",
          message: `Replay adapter for provider ${request.provider} only supports stub or replay mode.`,
          retryable: false,
        });
      }

      const state = getState(request.mode, request);
      return consumeReplayEntry(state, request);
    },

    async health(): Promise<BackendHealth> {
      return {
        provider: options.provider,
        ok: true,
        detail: "deterministic replay available",
        checkedAt: new Date().toISOString(),
      };
    },

    capabilities(): CapabilityProfile {
      return {
        provider: options.provider,
        executionModes: ["stub", "replay"],
        supportsStreaming: false,
        supportsFallback: false,
      };
    },
  };
}
