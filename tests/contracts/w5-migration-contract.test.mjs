import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const sql = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/202609050003_w5_exports.sql"), "utf8").toLowerCase();

test("W5 migration freezes instance-scoped exports and private bucket", () => {
  for (const fragment of ["create table if not exists public.exports", "deployment_instance_id text not null", "format text not null check (format in ('docx', 'pdf'))", "status text not null check (status in ('queued', 'generating', 'ready', 'failed'))", "rolepilot-exports", "alter table public.exports enable row level security", "storage_object_key like 'instances/' || deployment_instance_id || '/%'", "exports_active_run_format_idx"]) {
    assert.equal(sql.includes(fragment), true, fragment);
  }
});
