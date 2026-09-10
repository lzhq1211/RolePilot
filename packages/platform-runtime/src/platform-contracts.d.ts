declare module "platform-contracts" {
  export const ARTIFACT_KINDS: readonly [
    "resume",
    "review-report",
    "optimization-decision",
    "preflight",
    "supplemental-evidence",
    "questions",
    "unsupported",
    "jd-analysis",
    "timeline",
    "interview",
    "cheatsheet",
    "log",
  ];

  export const LOG_EVENT_LEVELS: readonly ["debug", "info", "warn", "error"];

  export function validateArtifactManifest(data: unknown): {
    valid: boolean;
    errors?: string[];
    data?: unknown;
  };

  export function validateLogEvent(data: unknown): {
    valid: boolean;
    errors?: string[];
    data?: unknown;
  };
}
