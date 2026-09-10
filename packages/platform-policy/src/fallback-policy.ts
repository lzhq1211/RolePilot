import { createGovernanceReason } from "./governance-reasons.js";
import type {
  BackendProvider,
  FallbackPolicyConfig,
  FallbackPolicyDecision,
  FallbackPolicyInput,
} from "./types.js";

const DEFAULT_PROVIDER_ORDER: BackendProvider[] = [
  "openai-chat",
  "anthropic-api",
  "claude",
  "opencode",
  "codex",
];

function resolveBackupProvider(
  provider: BackendProvider,
  config?: FallbackPolicyConfig,
): BackendProvider | null {
  const explicit = config?.fallbackByProvider?.[provider];
  if (explicit && explicit !== provider) {
    return explicit;
  }

  const orderedProviders = config?.providerOrder?.length
    ? config.providerOrder
    : DEFAULT_PROVIDER_ORDER;
  const providerIndex = orderedProviders.indexOf(provider);
  if (providerIndex === -1) {
    return null;
  }

  return orderedProviders[providerIndex + 1] ?? null;
}

export function selectFallbackPolicy(
  input: FallbackPolicyInput,
): FallbackPolicyDecision {
  if (input.mode !== "live") {
    return {
      shouldFallback: false,
      fromProvider: input.provider,
      toProvider: null,
      mode: input.mode,
      reasons: [
        createGovernanceReason(
          "FALLBACK_NOT_ALLOWED",
          "Fallback is only allowed for retryable live provider failures.",
          { mode: input.mode },
        ),
      ],
    };
  }

  if (!input.error.retryable) {
    return {
      shouldFallback: false,
      fromProvider: input.provider,
      toProvider: null,
      mode: input.mode,
      reasons: [
        createGovernanceReason(
          "NON_RETRYABLE_BACKEND_ERROR",
          "Fallback is disabled for non-retryable backend errors.",
          { errorCode: input.error.code },
        ),
      ],
    };
  }

  const backupProvider = resolveBackupProvider(input.provider, input.config);
  if (!backupProvider) {
    return {
      shouldFallback: false,
      fromProvider: input.provider,
      toProvider: null,
      mode: input.mode,
      reasons: [
        createGovernanceReason(
          "FALLBACK_NOT_ALLOWED",
          "No backup provider is configured for this retryable live failure.",
          { provider: input.provider },
        ),
      ],
    };
  }

  return {
    shouldFallback: true,
    fromProvider: input.provider,
    toProvider: backupProvider,
    mode: input.mode,
    reasons: [],
  };
}
