import type {
  BackendAdapter,
  BackendExecutionMode,
  BackendHealth,
  BackendProvider,
  BackendRegistry,
  CapabilityProfile,
  FallbackDecision,
  NormalizedBackendError,
  NormalizedBackendRequest,
  NormalizedBackendResult,
  NormalizedStreamEvent,
  RoutingDecision,
} from "./types.js";

const BACKEND_PROVIDERS = [
  "claude",
  "opencode",
  "codex",
  "openai-chat",
  "anthropic-api",
] as const;
const BACKEND_EXECUTION_MODES = ["live", "stub", "replay"] as const;

type RegistryRequestLike = Pick<
  NormalizedBackendRequest,
  "requestId" | "provider" | "mode"
>;

class BackendRegistryError extends Error implements NormalizedBackendError {
  requestId: string;

  provider: BackendProvider;

  mode: BackendExecutionMode;

  code: NormalizedBackendError["code"];

  retryable: boolean;

  cause?: unknown;

  metadata?: Record<string, unknown>;

  constructor(error: NormalizedBackendError) {
    super(error.message);
    this.name = "BackendRegistryError";
    this.requestId = error.requestId;
    this.provider = error.provider;
    this.mode = error.mode;
    this.code = error.code;
    this.retryable = error.retryable;
    this.cause = error.cause;
    this.metadata = error.metadata;
  }
}

function isNormalizedBackendErrorLike(
  value: unknown,
): value is NormalizedBackendError {
  return Boolean(
    value &&
    typeof value === "object" &&
    "requestId" in value &&
    "provider" in value &&
    "mode" in value &&
    "code" in value &&
    "message" in value &&
    "retryable" in value,
  );
}

function isBackendProvider(value: string): value is BackendProvider {
  return (BACKEND_PROVIDERS as readonly string[]).includes(value);
}

function isExecutionMode(value: string): value is BackendExecutionMode {
  return (BACKEND_EXECUTION_MODES as readonly string[]).includes(value);
}

function createRegistryError(
  error: NormalizedBackendError,
): BackendRegistryError {
  return new BackendRegistryError(error);
}

function toRegistryError(
  request: RegistryRequestLike,
  cause: unknown,
): BackendRegistryError {
  if (cause instanceof BackendRegistryError) {
    return cause;
  }

  if (isNormalizedBackendErrorLike(cause)) {
    return createRegistryError(cause);
  }

  if (cause instanceof Error) {
    return createRegistryError({
      requestId: request.requestId,
      provider: request.provider,
      mode: request.mode,
      code: "ADAPTER_FAILURE",
      message: cause.message,
      retryable: true,
      cause,
    });
  }

  return createRegistryError({
    requestId: request.requestId,
    provider: request.provider,
    mode: request.mode,
    code: "ADAPTER_FAILURE",
    message: "Backend adapter failed",
    retryable: true,
    cause,
  });
}

function assertValidRequest(request: NormalizedBackendRequest): void {
  if (!request.requestId || !request.input) {
    throw createRegistryError({
      requestId: request.requestId || "unknown-request",
      provider: request.provider,
      mode: request.mode,
      code: "INVALID_REQUEST",
      message: "Normalized backend request requires requestId and input",
      retryable: false,
    });
  }

  if (!isBackendProvider(request.provider)) {
    throw createRegistryError({
      requestId: request.requestId,
      provider: request.provider,
      mode: request.mode,
      code: "UNKNOWN_PROVIDER",
      message: `Unknown backend provider: ${request.provider}`,
      retryable: false,
    });
  }

  if (!isExecutionMode(request.mode)) {
    throw createRegistryError({
      requestId: request.requestId,
      provider: request.provider,
      mode: request.mode,
      code: "INVALID_REQUEST",
      message: `Unknown backend execution mode: ${request.mode}`,
      retryable: false,
    });
  }
}

function createUnknownProviderError(
  request: RegistryRequestLike,
): BackendRegistryError {
  return createRegistryError({
    requestId: request.requestId,
    provider: request.provider,
    mode: request.mode,
    code: "UNKNOWN_PROVIDER",
    message: `Unknown backend provider: ${request.provider}`,
    retryable: false,
  });
}

function createUnsupportedStreamError(
  request: RegistryRequestLike,
): BackendRegistryError {
  return createRegistryError({
    requestId: request.requestId,
    provider: request.provider,
    mode: request.mode,
    code: "UNSUPPORTED_STREAM",
    message: `Backend provider ${request.provider} does not support streaming`,
    retryable: false,
  });
}

export function createFallbackDecision({
  request,
  error,
  nextProvider,
  reason,
}: {
  request: RegistryRequestLike;
  error: NormalizedBackendError;
  nextProvider?: BackendProvider | null;
  reason: string;
}): FallbackDecision {
  return {
    shouldFallback: Boolean(nextProvider),
    fromProvider: request.provider,
    toProvider: nextProvider ?? null,
    mode: request.mode,
    requestId: request.requestId,
    reason,
    error,
  };
}

export function createBackendRegistry(
  adapters: readonly BackendAdapter[],
): BackendRegistry {
  const registry = new Map<BackendProvider, BackendAdapter>();

  for (const adapter of adapters) {
    registry.set(adapter.provider, adapter);
  }

  function get(provider: BackendProvider): BackendAdapter | undefined {
    return registry.get(provider);
  }

  function resolve({
    provider,
    requestId = "resolve",
    mode = "live",
  }: {
    provider: BackendProvider;
    requestId?: string;
    mode?: BackendExecutionMode;
  }): RoutingDecision {
    const adapter = get(provider);
    if (!adapter) {
      throw createUnknownProviderError({ requestId, provider, mode });
    }
    return { provider, adapter };
  }

  return {
    list(): BackendProvider[] {
      return Array.from(registry.keys());
    },

    get,

    resolve,

    async execute(
      request: NormalizedBackendRequest,
    ): Promise<NormalizedBackendResult> {
      assertValidRequest(request);
      const { adapter } = resolve(request);

      try {
        return await adapter.execute(request);
      } catch (cause) {
        throw toRegistryError(request, cause);
      }
    },

    async *stream(
      request: NormalizedBackendRequest,
    ): AsyncIterable<NormalizedStreamEvent> {
      assertValidRequest(request);
      const { adapter } = resolve(request);
      const capabilities = adapter.capabilities();
      if (!capabilities.supportsStreaming || !adapter.stream) {
        throw createUnsupportedStreamError(request);
      }

      try {
        yield* adapter.stream(request);
      } catch (cause) {
        throw toRegistryError(request, cause);
      }
    },

    async health(provider: BackendProvider): Promise<BackendHealth> {
      const { adapter } = resolve({
        provider,
        requestId: "health",
        mode: "live",
      });
      return adapter.health();
    },

    capabilities(provider: BackendProvider): CapabilityProfile {
      const { adapter } = resolve({
        provider,
        requestId: "capabilities",
        mode: "live",
      });
      return adapter.capabilities();
    },

    capabilitiesAll(): CapabilityProfile[] {
      return Array.from(registry.values(), (adapter) => adapter.capabilities());
    },
  };
}

export { BackendRegistryError };
