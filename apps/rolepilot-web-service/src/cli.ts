import { createDraftApi } from "./draft-api.js";
import { DraftService } from "./draft-service.js";
import { createRunApi } from "./run-api.js";
import { createResultApi } from "./result-api.js";
import { ResultService } from "./result-service.js";
import { RunService } from "./run-service.js";
import { InProcessRunQueue } from "./run-queue.js";
import { InProcessRunWorker, createOfflineWorkerBindings } from "./run-worker.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalInfrastructure } from "./local-storage.js";
import { RunEventHub } from "./run-events.js";
import { createTextEvidenceObjectStore } from "./run-evidence.js";
import { RunCancellationRegistry } from "./run-cancel.js";
import { createResumeAgentBindings } from "rolepilot-engine";
import { SupabaseRunRepository } from "./supabase-run-repository.js";
import { createSourceApi } from "./source-api.js";
import { SourceService } from "./source-service.js";
import { createSourceHttpServer } from "./server.js";
import { SupabaseDraftRepository, createSupabaseSourceInfrastructure } from "./supabase.js";
import { createWebApi } from "./web-api.js";
import { requireDeploymentInstanceId } from "./deployment.js";
import { CleanupService } from "./cleanup-service.js";
import { SupabaseCleanupRepository } from "./supabase-cleanup-repository.js";
import { MaintenanceGate } from "./maintenance-gate.js";
import { createCleanupApi } from "./cleanup-api.js";
import { WorkbenchResultService } from "./workbench-result.js";
import { WorkbenchService } from "./workbench-service.js";
import { createWorkbenchApi } from "./workbench-api.js";
import { SupabaseWorkbenchRepository } from "./supabase-workbench-repository.js";
import { createProviderConfigApi } from "./provider-config.js";

const config = requiredConfig(process.env);
const gate = new MaintenanceGate();
const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const dataRoot = path.resolve(projectRoot, process.env.ROLEPILOT_DATA_DIR?.trim() || ".rolepilot-data", "instances", config.deploymentInstanceId);
const workDir = path.resolve(projectRoot, process.env.ROLEPILOT_WORK_DIR?.trim() || ".rolepilot-work", "instances", config.deploymentInstanceId);
const infrastructure = config.storageMode === "local"
  ? await createLocalInfrastructure(dataRoot, config.deploymentInstanceId)
  : createCloudInfrastructure();
const runRepository = infrastructure.runRepository;
const cleanupRepository = infrastructure.cleanupRepository;
const sourceApi = createSourceApi({
  sourceService: new SourceService({ ...infrastructure, deferCleanup: true, onCleanupFailed: (id) => cleanupRepository.fail({ kind: "source", id }, "CLEANUP_STORAGE_FAILED") }),
});
const draftApi = createDraftApi({
  draftService: new DraftService({
    repository: infrastructure.draftRepository,
    deploymentInstanceId: config.deploymentInstanceId,
  }),
});
const eventHub = new RunEventHub();
const evidenceStore = createTextEvidenceObjectStore(infrastructure.artifactObjectStore);
const resultApi = createResultApi({
  resultService: new ResultService({
    runs: runRepository,
    sources: infrastructure.repository,
    objects: infrastructure.artifactObjectStore,
    deploymentInstanceId: config.deploymentInstanceId,
  }),
});
const workbenchApi = createWorkbenchApi({
  workbenchService: new WorkbenchService({
    results: new WorkbenchResultService({
      runs: runRepository,
      objects: infrastructure.artifactObjectStore,
      deploymentInstanceId: config.deploymentInstanceId,
    }),
    documents: infrastructure.workbenchRepository,
  }),
});
const stores = { sources: infrastructure.objectStore, artifacts: infrastructure.artifactObjectStore, exports: infrastructure.exportObjectStore };
const cleanupService = new CleanupService({ repository: cleanupRepository, stores, gate, runs: runRepository, deploymentInstanceId: config.deploymentInstanceId, workDir });
const cancellationRegistry = new RunCancellationRegistry();
let runQueue: InProcessRunQueue | undefined;
const runService = new RunService({
  sourceRepository: infrastructure.repository,
  runRepository,
  workDir,
  onRunQueued: () => runQueue?.wake(),
  cancellationRegistry,
  deploymentInstanceId: config.deploymentInstanceId,
  onRunDeleted: () => cleanupService.wake(),
});
runQueue = new InProcessRunQueue(runService);
const runApi = createRunApi({ runService, eventHub, evidenceStore, deploymentInstanceId: config.deploymentInstanceId, returnCleanupStatus: true });
gate.maintaining = (await cleanupRepository.status()).maintaining;
if (!gate.maintaining) {
  await infrastructure.startupRecoverSources();
  await runService.startupRecoverRunning();
  await cleanupRepository.recoverInterruptedExports();
}
await cleanupService.initialize();
const workerMode = process.env.ROLEPILOT_WORKER_MODE?.trim() || "live";
if (!["live", "stub"].includes(workerMode)) throw new Error("ROLEPILOT_WORKER_MODE must be live or stub.");
const worker = new InProcessRunWorker({
  queue: runQueue,
  runRepository,
  sourceRepository: infrastructure.repository,
  workDir,
  agentBindings: workerMode === "stub" ? createOfflineWorkerBindings(process.env) : createResumeAgentBindings({
    miner: { tool: process.env.ROLEPILOT_MINER_PROVIDER || "openai-chat" },
    writer: { tool: process.env.ROLEPILOT_WRITER_PROVIDER || "openai-chat" },
    reviewer: { tool: process.env.ROLEPILOT_REVIEWER_PROVIDER || "openai-chat" },
    interviewer: { tool: process.env.ROLEPILOT_INTERVIEWER_PROVIDER || "openai-chat" },
  }),
  env: process.env,
  maxReviewRounds: config.maxReviewRounds,
  eventHub,
  evidenceStore,
  artifactStore: infrastructure.artifactObjectStore,
  deploymentInstanceId: config.deploymentInstanceId,
  cancellationRegistry,
  gate,
  onCleanupNeeded: () => cleanupService.wake(),
});
const envFilePath = path.resolve(projectRoot, ".env");
const server = createSourceHttpServer(createWebApi({ sourceApi, draftApi, runApi, resultApi, workbenchApi, cleanupApi: createCleanupApi(cleanupService), providerConfigApi: createProviderConfigApi(envFilePath), gate }), gate);

server.listen(config.port, config.host, () => {
  worker.start();
  cleanupService.start();
  process.stdout.write(`RolePilot web service listening on http://${config.host}:${config.port}\n`);
  process.stdout.write(`Storage: ${config.storageMode}${config.storageMode === "local" ? ` (${dataRoot})` : ""}\n`);
});

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  gate.maintaining = true;
  server.close();
  await worker.stop();
  await cleanupService.stop();
  server.closeAllConnections();
};
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { void shutdown().catch(() => { process.stderr.write("SHUTDOWN_FAILED\n"); process.exitCode = 1; }); });

function requiredConfig(env: NodeJS.ProcessEnv): {
  storageMode: "local" | "supabase";
  host: string;
  port: number;
  url: string;
  serviceRoleKey: string;
  bucket: string;
  artifactBucket: string;
  exportBucket: string;
  deploymentInstanceId: string;
  maxReviewRounds: number;
} {
  const storageMode = env.ROLEPILOT_STORAGE_MODE?.trim() || "local";
  if (storageMode !== "local" && storageMode !== "supabase") throw new Error("ROLEPILOT_STORAGE_MODE must be local or supabase.");
  const url = env.SUPABASE_URL?.trim() || "";
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  if (storageMode === "supabase" && (!url || !serviceRoleKey)) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  }
  const port = Number(env.PORT ?? 4174);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be a valid TCP port.");
  }
  const maxReviewRounds = Number(env.ROLEPILOT_MAX_REVIEW_ROUNDS ?? 2);
  if (!Number.isInteger(maxReviewRounds) || maxReviewRounds < 1) throw new Error("ROLEPILOT_MAX_REVIEW_ROUNDS must be a positive integer.");
  return {
    storageMode,
    host: env.HOST?.trim() || "127.0.0.1",
    port,
    url,
    serviceRoleKey,
    bucket: env.ROLEPILOT_SOURCES_BUCKET?.trim() || "rolepilot-sources",
    artifactBucket: env.ROLEPILOT_ARTIFACTS_BUCKET?.trim() || "rolepilot-artifacts",
    exportBucket: env.ROLEPILOT_EXPORTS_BUCKET?.trim() || "rolepilot-exports",
    deploymentInstanceId: requireDeploymentInstanceId(env.ROLEPILOT_DEPLOYMENT_INSTANCE_ID || "local-double-click"),
    maxReviewRounds,
  };
}

function createCloudInfrastructure() {
  const cloud = createSupabaseSourceInfrastructure(config);
  const stores = { sources: cloud.objectStore, artifacts: cloud.artifactObjectStore, exports: cloud.exportObjectStore };
  return {
    ...cloud,
    runRepository: new SupabaseRunRepository({ client: cloud.client, idempotencyStore: cloud.idempotencyStore, deploymentInstanceId: config.deploymentInstanceId }),
    draftRepository: new SupabaseDraftRepository({ client: cloud.client, deploymentInstanceId: config.deploymentInstanceId }),
    workbenchRepository: new SupabaseWorkbenchRepository({ client: cloud.client, deploymentInstanceId: config.deploymentInstanceId }),
    cleanupRepository: new SupabaseCleanupRepository({ client: cloud.client, deploymentInstanceId: config.deploymentInstanceId, stores }),
    startupRecoverSources: () => cloud.client.rpc("rolepilot_startup_recover_sources", { p_deployment_instance_id: config.deploymentInstanceId }),
  };
}
