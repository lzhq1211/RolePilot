import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { until } from "./config.mjs";

export function client(base) {
  async function request(route, method = "GET", body, headers = {}, expected) {
    const response = await fetch(base + route, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    if (expected !== undefined) assert.equal(response.status, expected, `${method} ${route}`);
    else assert.ok(response.ok, `${method} ${route}: HTTP ${response.status}`);
    return response;
  }
  const json = async (...args) => (await request(...args)).json();
  return { request, json,
    async create(fixture, company = "W6 normal", sourceId) {
      const source = sourceId ? { id: sourceId } : await json("/api/resume-sources", "POST", { inputKind: "pasted-text", text: fixture.resumeText }, { "idempotency-key": randomUUID() });
      const input = { resumeSourceId: source.id, company, title: "Platform Engineer", jdText: fixture.jdText };
      await json("/api/input-drafts", "POST", input);
      const headers = { "idempotency-key": randomUUID() };
      const run = await json("/api/runs", "POST", input, headers);
      assert.equal((await json("/api/runs", "POST", input, headers)).id, run.id);
      return { run, source };
    },
    wait(id, status) { return until(() => json(`/api/runs/${id}`), (r) => { if (["FAILED", "UNSUPPORTED"].includes(r.status) && r.status !== status) throw new Error(`Run ${id}: ${r.status}`); return r.status === status; }, `Run ${status}`, 120000); },
    async exportRetired(id) {
      const response = await request(`/api/runs/${id}/exports`, "POST", { format: "PDF" }, { "idempotency-key": randomUUID() }, 410);
      const body = await response.json();
      assert.equal(body.error.code, "EXPORT_UNAVAILABLE");
    },
    clear() { return request("/api/instance-data", "DELETE", undefined, { "x-rolepilot-confirm": "DELETE_ALL" }, 202); },
  };
}
