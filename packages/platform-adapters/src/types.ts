export type BackendProvider =
  | "claude"
  | "opencode"
  | "codex"
  | "openai-chat"
  | "anthropic-api";

export type BackendExecutionMode = "live" | "stub" | "replay";

export type NormalizedBackendErrorCode =
  | "UNKNOWN_PROVIDER"
  | "UNSUPPORTED_STREAM"
  | "INVALID_REQUEST"
  | "ADAPTER_FAILURE"
  | "CLI_SPAWN_FAILURE"
  | "CLI_PERMISSION_DENIED"
  | "CLI_CANCELLED"
  | "CLI_TIMEOUT"
  | "CLI_EXIT"
  | "PROVIDER_UNAVAILABLE"
  | "API_AUTHENTICATION"
  | "API_RATE_LIMIT"
  | "API_TIMEOUT"
  | "API_REQUEST_FAILED"
  | "OUTPUT_PARSE_ERROR"
  | "MALFORMED_REPLAY"
  | "REPLAY_EXHAUSTED";

export type BackendCompletionSignal =
  | "process-exit"
  | "output-file-stable"
  | "timeout"
  | "cancelled"
  | "spawn-error";

export type BackendOutputSource = "stdout" | "output-file" | "api";

export type BackendProgressStage =
  | "provider-launching"
  | "provider-started"
  | "stdout-first-byte"
  | "waiting-output-file-stable"
  | "final-output-ready"
  | "heartbeat"
  | "terminating-process"
  | "process-exited"
  | "timed-out"
  | "cancelled";

export interface BackendCommandProgressEvent {
  requestId: string;
  provider: BackendProvider;
  stage: BackendProgressStage;
  detail: string;
  elapsedMs: number;
  pid?: number;
  outputCapturePath?: string;
  outputSource?: BackendOutputSource;
}

export type BackendProgressHandler = (
  event: BackendCommandProgressEvent,
) => void;

export interface CapabilityProfile {
  provider: BackendProvider;
  executionModes: BackendExecutionMode[];
  supportsStreaming: boolean;
  supportsFallback: boolean;
}

export interface BackendReplaySource {
  entries?: ReplayResponseEntry[];
  filePath?: string;
  cwd?: string;
}

export interface NormalizedBackendRequest {
  requestId: string;
  provider: BackendProvider;
  mode: BackendExecutionMode;
  input: string;
  metadata?: Record<string, unknown>;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  extraArgs?: string[];
  replay?: BackendReplaySource;
  signal?: AbortSignal;
  onProgress?: BackendProgressHandler;
}

export interface BackendInvocationMetadata {
  transport: "cli" | "api" | "replay";
  command?: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  extraArgs?: string[];
  inputBytes?: number;
  outputCapturePath?: string;
  outputCaptureStableMs?: number;
  progressHeartbeatMs?: number;
  completionSignal?: BackendCompletionSignal;
  outputSource?: BackendOutputSource;
  pid?: number;
}

export interface BackendReplayMetadata {
  mode: Extract<BackendExecutionMode, "stub" | "replay">;
  source: "inline" | "file" | "env";
  provider: BackendProvider;
  filePath?: string;
  remaining?: number;
}

export interface BackendCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut?: boolean;
  cancelled?: boolean;
  error?: unknown;
  completionSignal?: BackendCompletionSignal;
  outputSource?: BackendOutputSource;
  pid?: number;
}

export interface BackendCommandInvocation {
  requestId: string;
  provider: BackendProvider;
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  input: string;
  outputCapturePath?: string;
  outputCaptureStableMs?: number;
  outputCapturePollMs?: number;
  progressHeartbeatMs?: number;
  signal?: AbortSignal;
  onProgress?: BackendProgressHandler;
}

export type BackendCommandExecutor = (
  invocation: BackendCommandInvocation,
) => Promise<BackendCommandResult>;

export interface NormalizedBackendResult {
  requestId: string;
  provider: BackendProvider;
  mode: BackendExecutionMode;
  status: "succeeded" | "failed";
  outputText?: string;
  raw?: unknown;
  metadata?: Record<string, unknown>;
}

export interface NormalizedBackendError {
  requestId: string;
  provider: BackendProvider;
  mode: BackendExecutionMode;
  code: NormalizedBackendErrorCode;
  message: string;
  retryable: boolean;
  cause?: unknown;
  metadata?: Record<string, unknown>;
}

export interface NormalizedStreamEvent {
  requestId: string;
  provider: BackendProvider;
  mode: BackendExecutionMode;
  type: "start" | "delta" | "end" | "error";
  chunk?: string;
  error?: NormalizedBackendError;
}

export interface RoutingDecision {
  provider: BackendProvider;
  adapter: BackendAdapter;
}

export interface FallbackDecision {
  shouldFallback: boolean;
  fromProvider: BackendProvider;
  toProvider: BackendProvider | null;
  mode: BackendExecutionMode;
  requestId: string;
  reason: string;
  error: NormalizedBackendError;
}

export interface BackendHealth {
  provider: BackendProvider;
  ok: boolean;
  detail?: string;
  checkedAt?: string;
}

export interface BackendAdapter {
  provider: BackendProvider;
  execute(request: NormalizedBackendRequest): Promise<NormalizedBackendResult>;
  stream?(
    request: NormalizedBackendRequest,
  ): AsyncIterable<NormalizedStreamEvent>;
  health(): Promise<BackendHealth>;
  capabilities(): CapabilityProfile;
}

export interface BackendRegistry {
  list(): BackendProvider[];
  get(provider: BackendProvider): BackendAdapter | undefined;
  resolve(decision: {
    provider: BackendProvider;
    requestId?: string;
    mode?: BackendExecutionMode;
  }): RoutingDecision;
  execute(request: NormalizedBackendRequest): Promise<NormalizedBackendResult>;
  stream(
    request: NormalizedBackendRequest,
  ): AsyncIterable<NormalizedStreamEvent>;
  health(provider: BackendProvider): Promise<BackendHealth>;
  capabilities(provider: BackendProvider): CapabilityProfile;
  capabilitiesAll(): CapabilityProfile[];
}

export type ReplayResponseEntry =
  | string
  | {
      text?: string;
      outputText?: string;
      file?: string;
      responseFile?: string;
      error?:
        | string
        | {
            message: string;
            code?: NormalizedBackendErrorCode;
            retryable?: boolean;
            metadata?: Record<string, unknown>;
          };
      raw?: unknown;
      metadata?: Record<string, unknown>;
    };

export interface ReplayState {
  provider: BackendProvider;
  mode: Extract<BackendExecutionMode, "stub" | "replay">;
  source: "inline" | "file" | "env";
  baseDir: string;
  filePath?: string;
  entries: ReplayResponseEntry[];
}
