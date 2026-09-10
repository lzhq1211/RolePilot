import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = process.cwd();
const MIGRATION_PATH = path.join(
  ROOT,
  "supabase",
  "migrations",
  "202609050001_w3_runs.sql",
);

function readMigration() {
  return fs.readFileSync(MIGRATION_PATH, "utf8").toLowerCase();
}

test("W3 migration extends idempotency before creating Run tables", () => {
  const sql = readMigration();
  const addResultKind = sql.indexOf("add column if not exists result_kind");
  const orphanGuard = sql.indexOf("cannot backfill idempotency_keys");
  const backfill = sql.indexOf("set result_kind = 'source'");
  const dropNotNull = sql.indexOf("alter column source_id drop not null");
  const createRuns = sql.indexOf("create table if not exists public.runs");
  const createEvents = sql.indexOf("create table if not exists public.run_events");
  const createArtifacts = sql.indexOf("create table if not exists public.artifacts");
  const createEvidence = sql.indexOf("create table if not exists public.run_evidence_submissions");

  assert.ok(addResultKind >= 0);
  assert.ok(orphanGuard > addResultKind);
  assert.ok(backfill > orphanGuard);
  assert.ok(dropNotNull > backfill);
  assert.ok(createRuns > dropNotNull);
  assert.ok(createEvents > createRuns);
  assert.ok(createArtifacts > createEvents);
  assert.ok(createEvidence > createArtifacts);
  assert.doesNotMatch(sql, /create table if not exists public\.idempotency_keys/);
});

test("W3 migration freezes persistence, cleanup, artifact, evidence, and event constraints", () => {
  const sql = readMigration();

  for (const fragment of [
    "source_id uuid not null references public.source_documents(id) on delete restrict",
    "last_event_sequence bigint not null default 0 check (last_event_sequence >= 0)",
    "unique (run_id, sequence)",
    "'storagekey',",
    "status in ('staged', 'published', 'cleanup_pending', 'deleted')",
    "status in ('pending', 'consumed', 'abandoned')",
    "rolepilot-artifacts",
    "alter table public.runs enable row level security",
    "alter table public.run_events enable row level security",
    "alter table public.artifacts enable row level security",
    "alter table public.run_evidence_submissions enable row level security",
    "rolepilot_validate_idempotency_result",
    "rolepilot_delete_source_with_reference_check",
    "status <> 'needs_user_input' or jsonb_array_length(pending_user_questions) > 0",
  ]) {
    assert.match(sql, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), fragment);
  }
});

test("W3 migration exposes only atomic transaction boundaries for Run state and events", () => {
  const sql = readMigration();
  for (const functionName of [
    "rolepilot_create_run_and_event",
    "rolepilot_transition_run_and_append_event",
    "rolepilot_claim_next_run",
    "rolepilot_startup_recover_running",
  ]) {
    assert.match(sql, new RegExp(`create or replace function public\\.${functionName}`));
  }
  assert.match(sql, /for update\s+skip locked/);
  assert.match(sql, /next_sequence := current_run\.last_event_sequence \+ 1/);
  assert.match(sql, /failure_code = 'worker_interrupted'/);
  assert.match(sql, /status = 'abandoned'/);
  assert.match(sql, /revoke all on function public\.rolepilot_create_run_and_event/);
  assert.match(sql, /grant execute on function public\.rolepilot_startup_recover_running\(\) to service_role/);
});
