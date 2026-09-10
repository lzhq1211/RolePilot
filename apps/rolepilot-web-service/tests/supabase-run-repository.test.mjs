import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryIdempotencyStore,
  SupabaseRestClient,
  SupabaseRunRepository,
  SupabaseWorkbenchRepository,
} from "../dist/index.js";

const BASE_TIME = "2026-09-05T00:00:00.000Z";

function runRow(overrides = {}) {
  return {
    id: "run-1",
    resume_source_id: "source-1",
    company: "RolePilot",
    title: "AI 产品经理",
    jd_text: "负责证据驱动的简历优化。",
    status: "QUEUED",
    current_step: null,
    step_statuses: [
      { id: "mine", status: "pending" },
      { id: "jd-analysis", status: "pending" },
      { id: "preflight", status: "pending" },
      { id: "write", status: "pending" },
      { id: "review", status: "pending" },
    ],
    last_event_sequence: 1,
    stop_reason: null,
    failure_code: null,
    resume_app_run_id: null,
    checkpoint_artifact_id: null,
    pending_evidence_submission_id: null,
    parent_run_id: null,
    pending_user_questions: [],
    cleanup_status: "NOT_REQUESTED",
    created_at: BASE_TIME,
    updated_at: BASE_TIME,
    completed_at: null,
    deleted_at: null,
    ...overrides,
  };
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createHarness(handler) {
  const calls = [];
  const client = new SupabaseRestClient({
    url: "http://supabase.test",
    serviceRoleKey: "sb_secret_test",
    fetchImplementation: async (url, init) => {
      const request = {
        url: String(url),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(init.body) : undefined,
      };
      calls.push(request);
      return handler(request);
    },
  });
  return { calls, client };
}

test("Supabase Run Repository uses RPC for creation and atomic transition", async () => {
  const { calls, client } = createHarness((request) => {
    if (request.url.includes("/rpc/rolepilot_create_run_scoped")) {
      return json(runRow());
    }
    if (request.url.includes("/rpc/rolepilot_transition_run_scoped")) {
      return json({ id: "event-2", sequence: 2 });
    }
    if (request.url.includes("/rest/v1/runs?select=*&id=eq.run-1")) {
      return json([runRow({ status: "RUNNING", last_event_sequence: 2 })]);
    }
    if (request.url.includes("/rest/v1/artifacts?select=id")) return json([]);
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  });
  const repository = new SupabaseRunRepository({
    client,
    idempotencyStore: new InMemoryIdempotencyStore(),
  });

  const created = await repository.createIdempotent({
    id: "run-1",
    resumeSourceId: "source-1",
    company: "RolePilot",
    title: "AI 产品经理",
    jdText: "负责证据驱动的简历优化。",
    extractedTextObjectKey: "sources/source-1/extracted.txt",
    createdAt: BASE_TIME,
    eventId: "event-1",
    idempotencyKey: "run-key",
    requestFingerprint: "sha256:run",
    expiresAt: "2030-01-01T00:00:00.000Z",
  });
  assert.equal(created.reused, false);
  assert.equal(created.run.lastEventSequence, 1);

  const transition = await repository.transition({
    runId: "run-1",
    expectedStatus: "QUEUED",
    nextStatus: "RUNNING",
    currentStep: null,
    stepStatuses: created.run.stepStatuses,
    stopReason: null,
    failureCode: null,
    completedAt: null,
    pendingUserQuestions: [],
    checkpointArtifactId: null,
    cleanupStatus: "NOT_REQUESTED",
    event: {
      id: "event-2",
      runId: "run-1",
      sequence: 2,
      type: "run.status",
      payload: { runId: "run-1", status: "RUNNING", stopReason: null, failureCode: null },
      createdAt: BASE_TIME,
    },
  });
  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.lastEventSequence, 2);

  const createCall = calls.find((call) => call.url.includes("rolepilot_create_run_scoped"));
  assert.equal(createCall.method, "POST");
  assert.equal(createCall.body.p_extracted_text_object_key, "sources/source-1/extracted.txt");
  assert.equal(createCall.body.p_idempotency_key, "run-key");
  const transitionCall = calls.find((call) => call.url.includes("rolepilot_transition_run_scoped"));
  assert.equal(transitionCall.body.p_pending_user_questions.length, 0);
  assert.equal(transitionCall.body.p_checkpoint_artifact_id, null);
});

test("Supabase Run Repository maps event cursors, queue claims, and active source references", async () => {
  const { client } = createHarness((request) => {
    if (request.url.includes("/rpc/rolepilot_claim_next_run")) {
      return json([runRow({ status: "RUNNING", last_event_sequence: 2 })]);
    }
    if (request.url.includes("/rpc/rolepilot_startup_recover_scoped")) return json(2);
    if (request.url.includes("/rest/v1/run_events")) {
      return json([
        {
          id: "event-2",
          run_id: "run-1",
          sequence: 2,
          event_type: "run.status",
          payload: { runId: "run-1", status: "RUNNING", stopReason: null, failureCode: null },
          created_at: BASE_TIME,
        },
      ]);
    }
    if (request.url.includes("resume_source_id=eq.source-1")) return json([{ id: "run-1" }]);
    if (request.url.includes("/rest/v1/artifacts?select=id")) return json([]);
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  });
  const repository = new SupabaseRunRepository({ client });

  const claimed = await repository.claimNext("claim-event");
  assert.equal(claimed.id, "run-1");
  assert.equal(claimed.status, "RUNNING");
  assert.equal(await repository.startupRecoverRunning(), 2);
  const events = await repository.eventsAfter("run-1", 1);
  assert.equal(events[0].sequence, 2);
  assert.equal(await repository.isReferencedByRun("source-1"), true);
});

test("Supabase Run Repository persists artifact and evidence metadata without evidence text", async () => {
  const { client } = createHarness((request) => {
    if (request.url.endsWith("/rest/v1/artifacts")) {
      return json([
        {
          id: "artifact-1",
          run_id: "run-1",
          artifact_type: "checkpoint",
          stage: "checkpoint",
          status: "STAGED",
          storage_object_key: "runs/run-1/checkpoint.json",
          relative_path: "checkpoint.json",
          mime_type: "application/json",
          size_bytes: 42,
          created_at: BASE_TIME,
          published_at: null,
          cleanup_requested_at: null,
          deleted_at: null,
        },
      ]);
    }
    if (request.url.endsWith("/rest/v1/run_evidence_submissions")) {
      return json([
        {
          id: "evidence-1",
          run_id: "run-1",
          request_fingerprint: "sha256:evidence",
          storage_object_key: "runs/run-1/evidence/evidence-1.txt",
          byte_length: 24,
          character_length: 10,
          status: "PENDING",
          created_at: BASE_TIME,
          consumed_at: null,
          abandoned_at: null,
        },
      ]);
    }
    if (request.url.includes("/rest/v1/runs?")) return json([]);
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  });
  const repository = new SupabaseRunRepository({ client });

  const artifact = await repository.createArtifact({
    id: "artifact-1",
    runId: "run-1",
    artifactType: "checkpoint",
    stage: "checkpoint",
    status: "STAGED",
    storageObjectKey: "runs/run-1/checkpoint.json",
    relativePath: "checkpoint.json",
    mimeType: "application/json",
    sizeBytes: 42,
  });
  assert.equal(artifact.storageObjectKey, "runs/run-1/checkpoint.json");

  const evidence = await repository.createEvidence({
    id: "evidence-1",
    runId: "run-1",
    requestFingerprint: "sha256:evidence",
    storageObjectKey: "runs/run-1/evidence/evidence-1.txt",
    byteLength: 24,
    characterLength: 10,
  });
  assert.equal(evidence.status, "PENDING");
  assert.equal("evidenceText" in evidence, false);
});

test("Supabase Workbench Repository uses instance-scoped atomic RPCs", async () => {
  const content = {
    schemaVersion: 3,
    documentId: "run-1:generated",
    resumeName: "Candidate",
    profile: { name: "Candidate", headline: "Engineer", location: "", phone: "", email: "", website: "", portfolio: "", github: "" },
    sections: [],
  };
  const document = {
    documentId: content.documentId,
    runId: "run-1",
    deploymentInstanceId: "instance-a",
    variant: "generated",
    content,
    revision: 1,
    updatedAt: "2026-09-07T10:00:00.000Z",
  };
  const { calls, client } = createHarness((request) => {
    if (request.url.includes("/rpc/rolepilot_read_workbench_documents")) return json([document]);
    if (request.url.includes("/rpc/rolepilot_save_workbench_document")) return json({ kind: "saved", document });
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  });
  const repository = new SupabaseWorkbenchRepository({ client, deploymentInstanceId: "instance-a" });

  const listed = await repository.list("run-1");
  assert.equal(listed.kind, "active");
  assert.equal(listed.documents[0].content.documentId, content.documentId);
  const saved = await repository.save({ runId: "run-1", documentId: content.documentId, variant: "generated", content, expectedRevision: 0 });
  assert.equal(saved.kind, "saved");
  assert.equal(saved.document.revision, 1);
  assert.equal(calls[0].body.p_deployment_instance_id, "instance-a");
  assert.equal(calls[1].body.p_expected_revision, 0);
  assert.equal(calls.some((call) => call.url.includes("/rest/v1/workbench_documents")), false);
});
