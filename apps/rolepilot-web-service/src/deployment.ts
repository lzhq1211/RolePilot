export const DEFAULT_DEPLOYMENT_INSTANCE_ID = "local";

export function instanceObjectKey(
  deploymentInstanceId: string,
  kind: "sources" | "runs",
  resourceId: string,
  suffix: string,
): string {
  return `instances/${deploymentInstanceId}/${kind}/${resourceId}/${suffix}`;
}

export function requireDeploymentInstanceId(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized || normalized === "." || normalized === ".." || normalized.length > 100 || !/^[A-Za-z0-9._-]+$/.test(normalized)) {
    throw new Error("ROLEPILOT_DEPLOYMENT_INSTANCE_ID must be a non-empty safe identifier.");
  }
  return normalized;
}
