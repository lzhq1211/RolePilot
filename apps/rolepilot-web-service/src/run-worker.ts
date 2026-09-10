import { randomUUID } from "node:crypto";
import { mkdir, stat, rm, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  AnswerInterpretationError,
  createResumeAgentBindings,
  runResumeVerticalSlice,
  type ResumeAgentBindings,
  type ResumeAppStatusEvent,
  type ResumeVerticalSliceResult,
} from "rolepilot-engine";
import { parseResumeContentV3, type RunStepId, type RunStepStatusDto, type RunStatus } from "web-contracts";

import type { InProcessRunQueue } from "./run-queue.js";
import type { RunRepository } from "./run-repository.js";
import type { SourceRepository } from "./source-repository.js";
import type { RunArtifactRecord, RunRecord } from "./run-types.js";
import { RunRepositoryError } from "./run-types.js";
import type { RunEventHub } from "./run-events.js";
import { RunCancellationRegistry } from "./run-cancel.js";
import type { RunEvidenceObjectStore } from "./run-evidence.js";
import { InMemorySourceObjectStore, type SourceObjectStore } from "./source-object-store.js";
import { DEFAULT_DEPLOYMENT_INSTANCE_ID, instanceObjectKey } from "./deployment.js";
import type { MaintenanceGate } from "./maintenance-gate.js";
import { CheckpointRecoveryError, packRunCheckpoint, restoreRunCheckpoint } from "./run-checkpoint.js";
import { DIAGNOSTIC_JOURNAL, publishArtifactBytes, retryRunDiagnostics, writeDiagnosticJournal } from "./run-diagnostics.js";

type WorkerOptions = {
  queue: InProcessRunQueue;
  runRepository: RunRepository;
  sourceRepository: SourceRepository;
  workDir: string;
  agentBindings: ResumeAgentBindings;
  env?: NodeJS.ProcessEnv;
  maxReviewRounds?: number;
  pollTimeoutMs?: number;
  idFactory?: () => string;
  now?: () => Date;
  runFn?: typeof runResumeVerticalSlice;
  eventHub?: RunEventHub;
  cancellationRegistry?: RunCancellationRegistry;
  evidenceStore?: RunEvidenceObjectStore;
  artifactStore?: SourceObjectStore;
  deploymentInstanceId?: string;
  gate?: MaintenanceGate;
  onCleanupNeeded?: () => void;
};

const STEP_IDS: RunStepId[] = ["mine", "jd-analysis", "preflight", "write", "review"];

export class InProcessRunWorker {
  readonly #queue: InProcessRunQueue;
  readonly #runRepository: RunRepository;
  readonly #sourceRepository: SourceRepository;
  readonly #workDir: string;
  readonly #agentBindings: ResumeAgentBindings;
  readonly #env: NodeJS.ProcessEnv | undefined;
  readonly #maxReviewRounds: number;
  readonly #pollTimeoutMs: number;
  readonly #idFactory: () => string;
  readonly #now: () => Date;
  readonly #runFn: typeof runResumeVerticalSlice;
  readonly #eventHub: RunEventHub | undefined;
  readonly #cancellationRegistry: RunCancellationRegistry;
  readonly #evidenceStore: RunEvidenceObjectStore | undefined;
  readonly #artifactStore: SourceObjectStore;
  readonly #deploymentInstanceId: string;
  readonly #abort = new AbortController();
  #loopPromise: Promise<void> | null = null;
  readonly #gate: MaintenanceGate | undefined;
  readonly #onCleanupNeeded: () => void;

  constructor(options: WorkerOptions) {
    this.#queue = options.queue;
    this.#runRepository = options.runRepository;
    this.#sourceRepository = options.sourceRepository;
    this.#workDir = options.workDir;
    this.#agentBindings = options.agentBindings;
    this.#env = options.env;
    this.#maxReviewRounds = options.maxReviewRounds ?? 2;
    this.#pollTimeoutMs = options.pollTimeoutMs ?? 1_000;
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
    this.#runFn = options.runFn ?? runResumeVerticalSlice;
    this.#eventHub = options.eventHub;
    this.#cancellationRegistry = options.cancellationRegistry ?? new RunCancellationRegistry();
    this.#evidenceStore = options.evidenceStore;
    this.#artifactStore = options.artifactStore ?? new InMemorySourceObjectStore();
    this.#deploymentInstanceId = options.deploymentInstanceId ?? DEFAULT_DEPLOYMENT_INSTANCE_ID;
    this.#gate = options.gate;
    this.#onCleanupNeeded = options.onCleanupNeeded ?? (() => undefined);
  }

  start(): void {
    if (!this.#loopPromise) this.#loopPromise = this.#pollLoop();
  }

  async stop(): Promise<void> {
    this.#abort.abort();
    await this.#loopPromise;
    this.#loopPromise = null;
  }

  async processOne(): Promise<RunRecord | null> {
    const result = this.#gate ? await this.#gate.execute(() => this.#processOne()) : await this.#processOne();
    if (result) this.#onCleanupNeeded();
    return result;
  }

  async #processOne(): Promise<RunRecord | null> {
    const run = await this.#queue.claimNext();
    if (!run) return null;
    await this.#execute(run);
    return this.#runRepository.get(run.id, { includeDeleted: true });
  }

  async #pollLoop(): Promise<void> {
    while (!this.#abort.signal.aborted) {
      const run = await this.processOne();
      if (run) continue;
      await this.#queue.waitForSignal({ timeoutMs: this.#pollTimeoutMs, signal: this.#abort.signal });
    }
  }

  async #execute(run: RunRecord): Promise<void> {
    const runController = new AbortController();
    this.#cancellationRegistry.register(run.id, runController);
    try {
      await this.#executeRun(run, runController);
    } finally {
      // The cancellation registry remains active until filesystem cleanup ends.
      try {
        const current = await this.#runRepository.get(run.id, { includeDeleted: true });
        if (current && await stat(path.join(this.#workDir, "runs", run.id, DIAGNOSTIC_JOURNAL)).then(() => true, () => false)) {
          // Keep failed-run files available for the cleanup/diagnostic lifecycle;
          // an unconditional delete would discard the only raw provider output.
          this.#onCleanupNeeded();
        } else {
          await rm(path.join(this.#workDir, "runs", run.id), { recursive: true, force: true });
        }
      } catch { this.#onCleanupNeeded(); }
      finally { this.#cancellationRegistry.unregister(run.id); }
    }
  }

  async #executeRun(run: RunRecord, runController: AbortController): Promise<void> {
    if ((await this.#runRepository.get(run.id))?.status !== "RUNNING") return;
    let userEvidenceText: string | undefined;
    let resumeFromCheckpoint = false;
    const runRoot = path.join(this.#workDir, "runs", run.id);
    const stepStatuses = structuredClone(run.stepStatuses);
    let pendingUserQuestions: string[] | undefined;
    let checkpointArtifactId: string | undefined;
    const diagnosticArtifacts: ResumeVerticalSliceResult["artifactManifest"]["artifacts"] = [];
    const statusEvent = (status: RunStatus, failureCode: RunRecord["failureCode"] = null, stopReason: RunRecord["stopReason"] = null) => ({
      id: this.#idFactory(),
      runId: run.id,
      sequence: 0,
      type: "run.status" as const,
      payload: { runId: run.id, status: status as Exclude<RunStatus, "DRAFT" | "READY">, stopReason, failureCode },
      createdAt: this.#now().toISOString(),
    });

    const transition = async (nextStatus: RunStatus, currentStep: RunStepId | null, steps: RunStepStatusDto[], failureCode: RunRecord["failureCode"], stopReason: RunRecord["stopReason"], eventType: "run.status" | "run.completed" | "run.failed", finalResumeArtifactId?: string | null) => {
      const current = await this.#runRepository.get(run.id, { includeDeleted: true });
      if (!current || current.status !== "RUNNING") return;
      const event = eventType === "run.completed"
        ? { id: this.#idFactory(), runId: run.id, sequence: current.lastEventSequence + 1, type: "run.completed" as const, payload: { runId: run.id, status: "COMPLETED" as const, stopReason: stopReason as "pass" | "early-stop" | "max-rounds" }, createdAt: this.#now().toISOString() }
        : eventType === "run.failed"
          ? { id: this.#idFactory(), runId: run.id, sequence: current.lastEventSequence + 1, type: "run.failed" as const, payload: { runId: run.id, status: "FAILED" as const, failureCode: failureCode as NonNullable<RunRecord["failureCode"]> }, createdAt: this.#now().toISOString() }
          : { ...statusEvent(nextStatus, failureCode, stopReason), sequence: current.lastEventSequence + 1 };
      await this.#runRepository.transition({
        runId: run.id,
        expectedStatus: "RUNNING",
        nextStatus,
        currentStep,
        stepStatuses: steps,
        stopReason,
        failureCode,
        completedAt: nextStatus === "RUNNING" || nextStatus === "NEEDS_USER_INPUT" ? null : event.createdAt,
        finalResumeArtifactId,
        pendingUserQuestions,
        checkpointArtifactId,
        event,
      });
      this.#eventHub?.publish(event);
    };

    const handleStatus = async (event: ResumeAppStatusEvent) => {
      if (event.type === "task-started" || event.type === "task-completed") {
        const step = event.stepId as RunStepId;
        if (!STEP_IDS.includes(step)) return;
        const next = stepStatuses.map((item) => item.id === step ? { ...item, status: event.type === "task-started" ? "running" as const : "completed" as const } : item);
        stepStatuses.splice(0, stepStatuses.length, ...next);
        const current = await this.#runRepository.get(run.id, { includeDeleted: true });
        if (!current || current.status !== "RUNNING") return;
        const eventRecord = { id: this.#idFactory(), runId: run.id, sequence: current.lastEventSequence + 1, type: "run.step" as const, payload: { runId: run.id, stepId: step, status: event.type === "task-started" ? "running" as const : "completed" as const, durationMs: null }, createdAt: this.#now().toISOString() };
        await this.#runRepository.transition({ runId: run.id, expectedStatus: "RUNNING", nextStatus: "RUNNING", currentStep: step, stepStatuses: next, stopReason: null, failureCode: null, completedAt: null, event: eventRecord });
        this.#eventHub?.publish(eventRecord);
      }
    };
    let statusChain = Promise.resolve();
    const onStatus = (event: ResumeAppStatusEvent) => {
      if (event.type === "artifact-created") {
        const artifact = event.artifact as ResumeVerticalSliceResult["artifactManifest"]["artifacts"][number];
        if (artifact.stage !== "final" && !isWorkbenchDeliveryArtifact(artifact)) diagnosticArtifacts.push(artifact);
      }
      statusChain = statusChain.then(() => handleStatus(event));
      return statusChain;
    };

    try {
      const sourceText = await this.#readSource(run);
      if (run.pendingEvidenceSubmissionId) {
        if (!this.#evidenceStore || !run.checkpointArtifactId) throw new CheckpointRecoveryError();
        const evidence = await this.#runRepository.getEvidence(run.pendingEvidenceSubmissionId);
        const checkpoint = await this.#runRepository.getArtifact(run.checkpointArtifactId);
        if (!evidence || evidence.status !== "PENDING" || evidence.runId !== run.id || evidence.deploymentInstanceId !== this.#deploymentInstanceId || !checkpoint || checkpoint.runId !== run.id || checkpoint.deploymentInstanceId !== this.#deploymentInstanceId || checkpoint.status !== "PUBLISHED" || checkpoint.artifactType !== "checkpoint") throw new CheckpointRecoveryError();
        await rm(runRoot, { recursive: true, force: true });
        try { await restoreRunCheckpoint(await this.#artifactStore.read(checkpoint.storageObjectKey), runRoot, run.id); }
        catch { throw new CheckpointRecoveryError(); }
        userEvidenceText = await this.#evidenceStore.read(evidence.storageObjectKey);
        resumeFromCheckpoint = true;
      }
      await mkdir(runRoot, { recursive: true });
      const result = await this.#runFn({
        rootDir: runRoot,
        runId: run.id,
        createdAt: run.createdAt,
        company: { company: run.company, title: run.title },
        agentBindings: this.#agentBindings,
        importedResumeText: sourceText,
        jdText: run.jdText,
        includeInterview: false,
        maxReviewRounds: this.#maxReviewRounds,
        resumeFromCheckpoint,
        userEvidenceText,
        env: this.#env,
        signal: runController.signal,
        onStatus,
      });
      await statusChain;
      if (run.pendingEvidenceSubmissionId) {
        await this.#runRepository.updateEvidenceStatus(run.pendingEvidenceSubmissionId, "CONSUMED", this.#now().toISOString());
      }
      const persisted = await this.#persistArtifacts(run, result);
      const stopReason = mapStopReason(result.stopReason);
      if (stopReason === "needs-user-input" || stopReason === "unsupported-input") {
        pendingUserQuestions = result.pendingUserQuestions;
      }
      const current = await this.#runRepository.get(run.id, { includeDeleted: true });
      if (!current || current.status !== "RUNNING") return;
      if (stopReason === "needs-user-input") {
        checkpointArtifactId = await this.#persistCheckpoint(run, runRoot);
        const blockedStep: RunStepId = result.pendingQuestionStage === "review" ? "review" : "preflight";
        const waitingSteps = stepStatuses.map((step) => step.id === blockedStep
          ? { ...step, status: "waiting" as const }
          : step);
        await transition("NEEDS_USER_INPUT", blockedStep, waitingSteps, null, stopReason, "run.status", persisted.finalResumeArtifactId);
      } else if (stopReason === "unsupported-input") {
        await transition("UNSUPPORTED", "preflight", stepStatuses, null, stopReason, "run.status", persisted.finalResumeArtifactId);
      } else {
        await transition("COMPLETED", "review", stepStatuses.map((item) => ({ ...item, status: "completed" as const })), null, stopReason ?? "pass", "run.completed", persisted.finalResumeArtifactId);
      }
    } catch (error) {
      if (this.#abort.signal.aborted) return;
      await statusChain.catch(() => undefined);
      const current = await this.#runRepository.get(run.id, { includeDeleted: true });
      if (!current || current.status !== "RUNNING") return;
      const detail = error instanceof Error ? error.message : String(error);
      const answerFailure = error instanceof AnswerInterpretationError && resumeFromCheckpoint;
      process.stderr.write(`[RolePilot] run ${run.id} at ${current.currentStep ?? "unknown"}: ${answerFailure ? "ANSWER_INTERPRETATION_RETRY_REQUIRED" : "RUN_EXECUTION_FAILED"}\n`);
      await mkdir(runRoot, { recursive: true });
      const errorPath = path.join(runRoot, "execution-error.json");
      await writeFile(errorPath, JSON.stringify({ stage: current.currentStep, message: detail, artifactPaths: diagnosticArtifacts.map((artifact) => artifact.path) }), "utf8");
      const records: RunArtifactRecord[] = [];
      const specs = [...diagnosticArtifacts.map((artifact) => ({ absolutePath: artifact.absolutePath, fileName: artifact.fileName, kind: artifact.kind })), { absolutePath: errorPath, fileName: "execution-error.json", kind: "log" }];
      try {
        for (const artifact of specs) {
          const relativePath = path.relative(runRoot, artifact.absolutePath).replaceAll("\\", "/");
          if (!relativePath || relativePath.startsWith("../") || path.isAbsolute(relativePath)) throw new Error("Diagnostic path escapes run workspace.");
          const id = this.#idFactory();
          const record = await this.#runRepository.createArtifact({ id, runId: run.id, deploymentInstanceId: this.#deploymentInstanceId, role: "supporting", artifactType: mapArtifactType(artifact.kind), stage: "supporting", status: "STAGED", storageObjectKey: instanceObjectKey(this.#deploymentInstanceId, "runs", run.id, id), relativePath, mimeType: mimeTypeFor(artifact.fileName), sizeBytes: (await stat(artifact.absolutePath)).size });
          records.push(record);
          const latest = await this.#runRepository.get(run.id, { includeDeleted: true });
          if (!latest || latest.status !== "RUNNING") break;
          const event = { id: this.#idFactory(), runId: run.id, sequence: latest.lastEventSequence + 1, type: "run.artifact" as const, payload: { runId: run.id, artifactId: id }, createdAt: this.#now().toISOString() };
          await this.#runRepository.transition({ runId: run.id, expectedStatus: "RUNNING", nextStatus: "RUNNING", currentStep: latest.currentStep, stepStatuses: latest.stepStatuses, stopReason: null, failureCode: null, completedAt: null, artifactIds: [...latest.artifactIds, id], event });
          this.#eventHub?.publish(event);
        }
        await writeDiagnosticJournal(runRoot, { runId: run.id, deploymentInstanceId: this.#deploymentInstanceId, errorCode: null, attempts: 0, metadataComplete: true, artifacts: records });
        await retryRunDiagnostics(runRoot, run.id, this.#deploymentInstanceId, this.#runRepository, this.#artifactStore);
      } catch {
        await writeDiagnosticJournal(runRoot, { runId: run.id, deploymentInstanceId: this.#deploymentInstanceId, errorCode: "DIAGNOSTIC_PUBLICATION_FAILED", attempts: 1, metadataComplete: false, artifacts: records });
        process.stderr.write(`[RolePilot] run ${run.id}: DIAGNOSTIC_PUBLICATION_FAILED\n`);
      }
      if (answerFailure) {
        pendingUserQuestions = error.questions;
        checkpointArtifactId = await this.#persistCheckpoint(run, runRoot);
        if (run.pendingEvidenceSubmissionId) {
          await this.#runRepository.updateEvidenceStatus(run.pendingEvidenceSubmissionId, "ABANDONED", this.#now().toISOString());
        }
        await transition("NEEDS_USER_INPUT", error.stage,
          stepStatuses.map((item) => item.id === error.stage ? { ...item, status: "waiting" as const } : item),
          null, "needs-user-input", "run.status");
      } else {
        const evidence = run.pendingEvidenceSubmissionId ? await this.#runRepository.getEvidence(run.pendingEvidenceSubmissionId) : null;
        if (evidence?.status === "PENDING") await this.#runRepository.updateEvidenceStatus(evidence.id, "ABANDONED", this.#now().toISOString());
        await transition("FAILED", current.currentStep, stepStatuses.map((item) => item.status === "running" ? { ...item, status: "failed" as const } : item), error instanceof CheckpointRecoveryError ? "CHECKPOINT_INVALID" : "RUN_EXECUTION_FAILED", null, "run.failed");
      }
    }
  }

  async #readSource(run: RunRecord): Promise<string> {
    try {
      return await this.#sourceRepository.readExtractedText(run.resumeSourceId);
    } catch {
      const current = await this.#runRepository.get(run.id, { includeDeleted: true });
      if (current?.status === "RUNNING") {
        const event = { id: this.#idFactory(), runId: run.id, sequence: current.lastEventSequence + 1, type: "run.failed" as const, payload: { runId: run.id, status: "FAILED" as const, failureCode: "SOURCE_TEXT_UNAVAILABLE" as const }, createdAt: this.#now().toISOString() };
        await this.#runRepository.transition({ runId: run.id, expectedStatus: "RUNNING", nextStatus: "FAILED", currentStep: current.currentStep, stepStatuses: current.stepStatuses, stopReason: null, failureCode: "SOURCE_TEXT_UNAVAILABLE", completedAt: event.createdAt, event });
        this.#eventHub?.publish(event);
      }
      throw new RunRepositoryError("RUN_NOT_FOUND", "Source text unavailable.");
    }
  }

  async #persistArtifacts(run: RunRecord, result: ResumeVerticalSliceResult): Promise<{ finalResumeArtifactId: string | null }> {
    const artifacts = result.artifactManifest.artifacts;
    const deliveryArtifacts = artifacts.filter(isWorkbenchDeliveryArtifact);
    if (deliveryArtifacts.length > 1) {
      throw new RunRepositoryError("CONTRACT_INVALID", "Run contains multiple workbench delivery indexes.");
    }
    const deliveryArtifact = deliveryArtifacts[0] ?? null;
    const finalArtifacts = artifacts.filter(
      (artifact) => artifact.kind === "resume" && artifact.stage === "final",
    );
    const finalResumePath = result.finalResumePath ?? null;
    if (finalResumePath && (finalArtifacts.length !== 1 || finalArtifacts[0]!.absolutePath !== finalResumePath || !deliveryArtifact)) {
      throw new RunRepositoryError("CONTRACT_INVALID", "Completed delivery requires one v3 final resume and one workbench delivery index.");
    }
    if (finalResumePath) {
      try {
        parseResumeContentV3(JSON.parse(await readFile(finalResumePath, "utf8")) as unknown);
      } catch {
        throw new RunRepositoryError("CONTRACT_INVALID", "Final resume must use the V3 content contract.");
      }
    }
    let finalResumeArtifactId: string | null = null;
    const publishedByRelativePath = new Map<string, RunArtifactRecord>();
    const publish = async (
      artifact: (typeof artifacts)[number],
      role: RunArtifactRecord["role"],
    ): Promise<boolean> => {
      const absolute = artifact.absolutePath;
      const info = await stat(absolute);
      const bytes = new Uint8Array(await readFile(absolute));
      const relativePath = path.relative(path.join(this.#workDir, "runs", run.id), absolute).replaceAll("\\", "/");
      if (!relativePath || relativePath.startsWith("../") || path.isAbsolute(relativePath)) {
        throw new RunRepositoryError("CONTRACT_INVALID", "Artifact path escapes the run workspace.");
      }
      const artifactId = this.#idFactory();
      const storageObjectKey = instanceObjectKey(this.#deploymentInstanceId, "runs", run.id, artifactId);
      const temporaryKey = instanceObjectKey(this.#deploymentInstanceId, "runs", run.id, `tmp/${artifactId}`);
      await this.#artifactStore.put({ key: temporaryKey, bytes, contentType: mimeTypeFor(artifact.fileName) });
      const record = await this.#runRepository.createArtifact({
        id: artifactId,
        runId: run.id,
        deploymentInstanceId: this.#deploymentInstanceId,
        role,
        artifactType: mapArtifactType(artifact.kind),
        stage: artifact.stage,
        status: "STAGED",
        storageObjectKey,
        relativePath,
        mimeType: mimeTypeFor(artifact.fileName),
        sizeBytes: info.size,
      });
      await publishArtifactBytes(this.#runRepository, this.#artifactStore, record, bytes, this.#now().toISOString());
      await this.#artifactStore.remove([temporaryKey]);
      if (role === "final-resume") finalResumeArtifactId = record.id;
      publishedByRelativePath.set(relativePath, { ...record, status: "PUBLISHED", publishedAt: this.#now().toISOString() });
      const current = await this.#runRepository.get(run.id, { includeDeleted: true });
      if (!current || current.status !== "RUNNING") return false;
      const event = { id: this.#idFactory(), runId: run.id, sequence: current.lastEventSequence + 1, type: "run.artifact" as const, payload: { runId: run.id, artifactId: record.id }, createdAt: this.#now().toISOString() };
      await this.#runRepository.transition({ runId: run.id, expectedStatus: "RUNNING", nextStatus: "RUNNING", currentStep: current.currentStep, stepStatuses: current.stepStatuses, stopReason: null, failureCode: null, completedAt: null, artifactIds: [...current.artifactIds, record.id], event });
      this.#eventHub?.publish(event);
      return true;
    };
    for (const artifact of artifacts) {
      if (artifact === deliveryArtifact) continue;
      const role = finalResumePath && artifact.absolutePath === finalResumePath
        ? "final-resume"
        : artifact.stage === "derived" ? "derived" : "supporting";
      if (!await publish(artifact, role)) return { finalResumeArtifactId };
    }
    if (deliveryArtifact) {
      validateWorkbenchDeliveryIndex(
        JSON.parse(await readFile(deliveryArtifact.absolutePath, "utf8")) as unknown,
        run,
        publishedByRelativePath,
        finalResumeArtifactId,
      );
      if (!await publish(deliveryArtifact, "supporting")) return { finalResumeArtifactId };
    }
    return { finalResumeArtifactId };
  }

  async #persistCheckpoint(run: RunRecord, root: string): Promise<string> {
    const bytes = await packRunCheckpoint(root, run.id);
    const id = this.#idFactory();
    const storageObjectKey = instanceObjectKey(this.#deploymentInstanceId, "runs", run.id, id);
    await this.#runRepository.createArtifact({ id, runId: run.id, deploymentInstanceId: this.#deploymentInstanceId, artifactType: "checkpoint", stage: "supporting", status: "STAGED", storageObjectKey, relativePath: ".checkpoint-recovery.json", mimeType: "application/json", sizeBytes: bytes.byteLength });
    await this.#artifactStore.put({ key: storageObjectKey, bytes, contentType: "application/json" });
    await this.#runRepository.updateArtifactStatus(id, "PUBLISHED", this.#now().toISOString());
    return id;
  }
}

function mimeTypeFor(fileName: string): string {
  if (fileName.endsWith(".json")) return "application/json";
  if (fileName.endsWith(".yml") || fileName.endsWith(".yaml")) return "application/yaml";
  return "text/plain; charset=utf-8";
}

function mapStopReason(value: string | null): "needs-user-input" | "unsupported-input" | "pass" | "early-stop" | "max-rounds" | null {
  if (value === "needs-user-input" || value === "unsupported-input" || value === "pass" || value === "early-stop" || value === "max-rounds") return value;
  return null;
}

function mapArtifactType(kind: string): import("web-contracts").RunArtifactType {
  if (["timeline", "jd-analysis", "preflight", "questions", "unsupported", "resume", "review-report", "optimization-decision", "supplemental-evidence", "checkpoint", "checkpoint-manifest", "log"].includes(kind)) return kind as import("web-contracts").RunArtifactType;
  return "log";
}

function isWorkbenchDeliveryArtifact(
  artifact: { kind: string; stage: string; fileName: string },
) {
  return artifact.kind === "log"
    && artifact.stage === "supporting"
    && artifact.fileName === "workbench-delivery.json";
}

function validateWorkbenchDeliveryIndex(
  value: unknown,
  run: RunRecord,
  publishedByRelativePath: Map<string, RunArtifactRecord>,
  finalResumeArtifactId: string | null,
) {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.format !== "workbench-delivery") {
    throw new RunRepositoryError("CONTRACT_INVALID", "Workbench delivery index has an unsupported format.");
  }
  if (value.deliveryStatus !== "OPTIMIZED" && value.deliveryStatus !== "SOURCE_ONLY") {
    throw new RunRepositoryError("CONTRACT_INVALID", "Workbench delivery index has no delivery status.");
  }
  const original = requireRecord(value.original, "original");
  const final = requireRecord(value.final, "final");
  const preflight = requireRecord(value.preflight, "preflight");
  if (!["PROCEED", "ASK_USER", "STOP_UNSUPPORTED"].includes(String(preflight.decision)) || typeof preflight.decision !== "string") {
    throw new RunRepositoryError("CONTRACT_INVALID", "Workbench preflight decision must be a decision string.");
  }
  const finalPath = requireRelativePath(final.path, "final.path");
  const finalArtifact = publishedByRelativePath.get(finalPath);
  if (!finalArtifact || finalArtifact.id !== finalResumeArtifactId || finalArtifact.role !== "final-resume") {
    throw new RunRepositoryError("CONTRACT_INVALID", "Workbench delivery index does not bind the published final resume.");
  }
  const preflightArtifact = publishedByRelativePath.get(requireRelativePath(preflight.path, "preflight.path"));
  const originalArtifact = publishedByRelativePath.get(requireRelativePath(original.path, "original.path"));
  if (!preflightArtifact || preflightArtifact.artifactType !== "preflight" || !originalArtifact || originalArtifact.artifactType !== "resume") {
    throw new RunRepositoryError("CONTRACT_INVALID", "Workbench delivery index has missing original or preflight references.");
  }
  for (const reference of collectDeliveryReferences(value)) {
    const artifact = publishedByRelativePath.get(reference);
    if (!artifact || artifact.runId !== run.id || artifact.deploymentInstanceId !== run.deploymentInstanceId || artifact.status !== "PUBLISHED") {
      throw new RunRepositoryError("CONTRACT_INVALID", `Workbench delivery reference is not published for this run: ${reference}`);
    }
  }
}

function collectDeliveryReferences(value: unknown): string[] {
  const references = new Set<string>();
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isRecord(node)) return;
    for (const [key, child] of Object.entries(node)) {
      if (key === "path" || key.endsWith("Path")) {
        if (child === null) continue;
        references.add(requireRelativePath(child, key));
      } else {
        visit(child);
      }
    }
  };
  visit(value);
  return [...references];
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new RunRepositoryError("CONTRACT_INVALID", `Workbench delivery ${label} must be an object.`);
  return value;
}

function requireRelativePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.startsWith("/") || path.isAbsolute(value) || value.split("/").includes("..") || value.split("\\").includes("..")) {
    throw new RunRepositoryError("CONTRACT_INVALID", `Workbench delivery ${label} must be a relative artifact path.`);
  }
  return value.replaceAll("\\", "/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function createOfflineWorkerBindings(env: NodeJS.ProcessEnv = process.env): ResumeAgentBindings {
  const provider = (env.ROLEPILOT_WORKER_PROVIDER?.trim() || "openai-chat") as "openai-chat";
  return createResumeAgentBindings({ miner: { tool: provider }, writer: { tool: provider }, reviewer: { tool: provider }, interviewer: { tool: provider } }, {
    miner: { mode: "stub" }, writer: { mode: "stub" }, reviewer: { mode: "stub" }, interviewer: { mode: "stub" },
  });
}
