import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryRunRepository,
  InMemorySourceObjectStore,
  InMemorySourceRepository,
  InMemoryWorkbenchRepository,
  ResultService,
  WorkbenchService,
  WorkbenchResultService,
  createResultApi,
  createWebApi,
  createWorkbenchApi,
  diffResumes,
} from "../dist/index.js";

const resume = { schemaVersion: "v1", name: "Candidate", contact: [], summary: null, sections: [{ id: "work", title: "Work", entries: [{ id: "work-1", title: "Role", date: null, location: null, bullets: ["Final"] }] }] };
const original = { ...resume, sections: [{ ...resume.sections[0], entries: [{ ...resume.sections[0].entries[0], bullets: ["Original"] }] }] };
const review = { schemaVersion: 2, verdict: "PASS", roleInfoQuestion: null, overallScore: 84, positioningDiagnosis: { currentPositioning: "平台工程实践者", targetPositioning: "平台工程候选人", biggestGap: "" }, topIssues: [], jdCoverage: { strong: [], weak: [], unsupported: [] }, strengths: ["有可核对的平台工程证据。"] };

async function harness(complete = true, includeReview = false, reviewValue = review) {
  const objects = new InMemorySourceObjectStore();
  const runs = new InMemoryRunRepository({ clock: () => "2026-09-05T00:00:00.000Z" });
  const sources = new InMemorySourceRepository({ objectStore: objects, referenceReader: runs, clock: () => "2026-09-05T00:00:00.000Z" });
  await sources.createPending({ id: "source-1", inputKind: "pasted-text", originalFileName: null, mediaType: "text/plain", sizeBytes: 10 });
  await objects.put({ key: "source-1.txt", bytes: new TextEncoder().encode(JSON.stringify(original)), contentType: "application/json" });
  await sources.markReady("source-1", { parsed: { mediaType: "application/json", text: JSON.stringify(original), textLength: 10, pageCount: null, parserVersion: "test" }, originalObjectKey: "source-1.txt", extractedTextObjectKey: "source-1.txt" });
  await runs.create({ id: "run-1", resumeSourceId: "source-1", company: "RolePilot", title: "PM", jdText: "JD", extractedTextObjectKey: "source-1.txt", createdAt: "2026-09-05T00:00:00.000Z", eventId: "event-1" });
  const running = await runs.claimNext("event-2");
  const final = await runs.createArtifact({ id: "artifact-final", runId: running.id, role: "final-resume", artifactType: "resume", stage: "final", status: "STAGED", storageObjectKey: "run-1/final.json", relativePath: "final.json", mimeType: "application/json", sizeBytes: 1 });
  const preflight = await runs.createArtifact({ id: "artifact-preflight", runId: running.id, artifactType: "preflight", stage: "supporting", status: "STAGED", storageObjectKey: "run-1/preflight.json", relativePath: "preflight.json", mimeType: "application/json", sizeBytes: 1 });
  const reviewArtifact = includeReview ? await runs.createArtifact({ id: "artifact-review", runId: running.id, artifactType: "review-report", stage: "review", status: "STAGED", storageObjectKey: "run-1/review.json", relativePath: "review.json", mimeType: "application/json", sizeBytes: 1 }) : null;
  await runs.updateArtifactStatus(final.id, "PUBLISHED", "2026-09-05T00:00:00.000Z");
  await runs.updateArtifactStatus(preflight.id, "PUBLISHED", "2026-09-05T00:00:00.000Z");
  if (reviewArtifact) await runs.updateArtifactStatus(reviewArtifact.id, "PUBLISHED", "2026-09-05T00:00:00.000Z");
  await objects.put({ key: final.storageObjectKey, bytes: new TextEncoder().encode(JSON.stringify(resume)), contentType: "application/json" });
  await objects.put({ key: preflight.storageObjectKey, bytes: new TextEncoder().encode(JSON.stringify({ decision: "PROCEED", safeWritingScope: ["work"] })), contentType: "application/json" });
  if (reviewArtifact) await objects.put({ key: reviewArtifact.storageObjectKey, bytes: new TextEncoder().encode(JSON.stringify(reviewValue)), contentType: "application/json" });
  if (complete) {
    const current = await runs.get("run-1");
    await runs.transition({ runId: "run-1", expectedStatus: "RUNNING", nextStatus: "COMPLETED", currentStep: "review", stepStatuses: current.stepStatuses.map((step) => ({ ...step, status: "completed" })), stopReason: "pass", failureCode: null, completedAt: "2026-09-05T00:00:00.000Z", artifactIds: [final.id, preflight.id, ...(reviewArtifact ? [reviewArtifact.id] : [])], finalResumeArtifactId: final.id, event: { id: "event-3", runId: "run-1", sequence: current.lastEventSequence + 1, type: "run.completed", payload: { runId: "run-1", status: "COMPLETED", stopReason: "pass" }, createdAt: "2026-09-05T00:00:00.000Z" } });
  }
  return { runs, sources, objects };
}

function resumeV3(documentId, name = "Candidate") {
  return {
    schemaVersion: 3,
    documentId,
    resumeName: name,
    profile: { name, headline: "平台工程师", location: "上海", phone: "", email: "candidate@example.com", website: "", portfolio: "", github: "" },
    sections: [{
      id: `${documentId}:experience`,
      type: "experience",
      title: "工作经历",
      entries: [{
        id: `${documentId}:experience:0`,
        name: "Acme",
        role: "Engineer",
        date: "2024",
        location: "上海",
        bullets: [{ id: `${documentId}:experience:0:bullet:0`, content: "交付平台能力" }],
      }],
    }],
  };
}

async function workbenchHarness() {
  const objects = new InMemorySourceObjectStore();
  const runs = new InMemoryRunRepository({ clock: () => "2026-09-05T00:00:00.000Z" });
  const publish = async (runId, id, role, artifactType, stage, relativePath, value) => {
    const artifact = await runs.createArtifact({
      id,
      runId,
      role,
      artifactType,
      stage,
      status: "STAGED",
      storageObjectKey: `${runId}/${relativePath}`,
      relativePath,
      mimeType: "application/json",
      sizeBytes: 1,
    });
    await objects.put({ key: artifact.storageObjectKey, bytes: new TextEncoder().encode(JSON.stringify(value)), contentType: "application/json" });
    await runs.updateArtifactStatus(id, "PUBLISHED", "2026-09-05T00:00:00.000Z");
    return artifact;
  };
  const complete = async (runId, finalArtifactId, artifacts) => {
    const current = await runs.get(runId);
    await runs.transition({
      runId,
      expectedStatus: "RUNNING",
      nextStatus: "COMPLETED",
      currentStep: "review",
      stepStatuses: current.stepStatuses.map((step) => ({ ...step, status: "completed" })),
      stopReason: "pass",
      failureCode: null,
      completedAt: "2026-09-05T00:00:00.000Z",
      artifactIds: artifacts.map((artifact) => artifact.id),
      finalResumeArtifactId: finalArtifactId,
      event: { id: `${runId}-completed`, runId, sequence: current.lastEventSequence + 1, type: "run.completed", payload: { runId, status: "COMPLETED", stopReason: "pass" }, createdAt: "2026-09-05T00:00:00.000Z" },
    });
  };
  return { runs, objects, publish, complete };
}

test("result API assembles a safe completed DTO and produces a structured diff", async () => {
  const h = await harness();
  const api = createResultApi({ resultService: new ResultService({ runs: h.runs, sources: h.sources, objects: h.objects }) });
  const response = await api.handle(new Request("http://localhost/api/runs/run-1/result"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.resume.name, "Candidate");
  assert.equal(body.diff[0].kind, "changed");
  assert.equal("storageObjectKey" in body, false);
});

test("result API exposes a published v2 review summary", async () => {
  const h = await harness(true, true);
  const api = createResultApi({ resultService: new ResultService({ runs: h.runs, sources: h.sources, objects: h.objects }) });
  const response = await api.handle(new Request("http://localhost/api/runs/run-1/result"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.review.schemaVersion, 2);
  assert.equal(body.review.verdict, "PASS");
  assert.equal(body.review.roleInfoQuestion, null);
});

test("result API normalizes finite provider category aliases before DTO validation", async () => {
  const h = await harness(true, true, {
    ...review,
    topIssues: [{
      issueRef: "I1",
      priority: " p3 ",
      category: " match ",
      resolution: " rewrite_now ",
      section: "summary",
      resumeEvidence: "已有摘要证据",
      jdEvidence: "岗位要求",
      sourceEvidence: "resume.summary",
      problem: "匹配表达不够直接",
      whyItHurts: "筛选者难以快速判断匹配度",
      recommendedAction: "前置已有证据",
    }],
  });
  const api = createResultApi({ resultService: new ResultService({ runs: h.runs, sources: h.sources, objects: h.objects }) });
  const response = await api.handle(new Request("http://localhost/api/runs/run-1/result"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.review.topIssues[0].category, "JD_COVERAGE");
  assert.equal(body.review.topIssues[0].priority, "P3");
});

test("result API does not expose half-finished artifacts", async () => {
  const h = await harness(false);
  const api = createResultApi({ resultService: new ResultService({ runs: h.runs, sources: h.sources, objects: h.objects }) });
  const response = await api.handle(new Request("http://localhost/api/runs/run-1/result"));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "RESULT_NOT_READY");
});

test("workbench result reads the delivery-bound review instead of a later historical report", async () => {
  const h = await workbenchHarness();
  const runId = "run-workbench";
  await h.runs.create({ id: runId, resumeSourceId: "source-workbench", company: "RolePilot", title: "PM", jdText: "JD", extractedTextObjectKey: "source.txt", createdAt: "2026-09-05T00:00:00.000Z", eventId: "run-workbench-created" });
  await h.runs.claimNext("run-workbench-running");
  const originalV3 = resumeV3(`${runId}:original`, "Original");
  const finalV3 = resumeV3(`${runId}:generated`, "Final");
  const originalArtifact = await h.publish(runId, "workbench-original", "supporting", "resume", "supporting", "resumes/original.json", originalV3);
  const finalArtifact = await h.publish(runId, "workbench-final", "final-resume", "resume", "final", "resumes/final.json", finalV3);
  const preflightArtifact = await h.publish(runId, "workbench-preflight", "supporting", "preflight", "supporting", "preflight.json", { decision: "PROCEED", safeWritingScope: ["experience"] });
  const boundReviewArtifact = await h.publish(runId, "workbench-review-bound", "supporting", "review-report", "review", "reviews/bound.json", review);
  const laterReviewArtifact = await h.publish(runId, "workbench-review-later", "supporting", "review-report", "review", "reviews/later.json", { ...review, overallScore: 10 });
  const bindingArtifact = await h.publish(runId, "workbench-binding", "supporting", "log", "supporting", "reviews/bound.binding.json", {
    documentId: finalV3.documentId,
    candidateVersion: 2,
    evidenceVersion: 0,
    reviewArtifactPath: boundReviewArtifact.relativePath,
    issueTargets: [],
  });
  const deliveryArtifact = await h.publish(runId, "workbench-delivery", "supporting", "log", "supporting", "workbench-delivery.json", {
    schemaVersion: 1,
    format: "workbench-delivery",
    deliveryStatus: "OPTIMIZED",
    original: { documentId: originalV3.documentId, path: originalArtifact.relativePath },
    final: { documentId: finalV3.documentId, path: finalArtifact.relativePath, candidateVersion: 2 },
    candidate: { documentId: finalV3.documentId, path: finalArtifact.relativePath, version: 2 },
    review: { kind: "final-bound", reportPath: boundReviewArtifact.relativePath, bindingPath: bindingArtifact.relativePath },
    preflight: { path: preflightArtifact.relativePath, decision: "PROCEED" },
    actionHistory: [{ sequence: 1, decision: { action: "REWRITE_SECTION", target: "experience", reason: "补足成果", evidenceRefs: ["resume.experience"], expectedImprovement: "更清晰", risk: "low", issueKey: "I1" }, route: { allowed: true, action: "REWRITE_SECTION", normalizedTarget: "experience", reasonCodes: [], shouldStop: false }, status: "executed", rejectedReason: null }],
  });
  await h.complete(runId, finalArtifact.id, [originalArtifact, finalArtifact, preflightArtifact, boundReviewArtifact, laterReviewArtifact, bindingArtifact, deliveryArtifact]);

  const result = await new WorkbenchResultService({ runs: h.runs, objects: h.objects }).get(runId);
  assert.equal(result.deliveryStatus, "OPTIMIZED");
  assert.equal(result.original.availability, "AVAILABLE");
  assert.equal(result.final.documentId, finalV3.documentId);
  assert.equal(result.review.kind, "final-bound");
  assert.equal(result.review.report.overallScore, 84);
  assert.equal(result.review.binding.documentId, finalV3.documentId);
  assert.equal(result.actionHistoryStatus, "VERIFIED");
  assert.equal(result.actionHistory[0].status, "executed");
});

test("workbench result converts a historical Final deterministically when the original is unavailable", async () => {
  const h = await workbenchHarness();
  const runId = "run-history";
  await h.runs.create({ id: runId, resumeSourceId: "source-history", company: "RolePilot", title: "PM", jdText: "JD", extractedTextObjectKey: "source.txt", createdAt: "2026-09-05T00:00:00.000Z", eventId: "run-history-created" });
  await h.runs.claimNext("run-history-running");
  const finalArtifact = await h.publish(runId, "history-final", "final-resume", "resume", "final", "resume.final.json", {
    sections: [
      { id: "personal", type: "personal_info", title: "个人信息", content: { fullName: "Candidate", email: "candidate@example.com" } },
      { id: "work", type: "experience", title: "工作经历", content: { items: [{ company: "Acme", position: "Engineer", startDate: "2024", highlights: ["交付平台能力"] }] } },
    ],
  });
  const reviewArtifact = await h.publish(runId, "history-review", "supporting", "review-report", "review", "reviews/history.json", review);
  await h.complete(runId, finalArtifact.id, [finalArtifact, reviewArtifact]);

  const result = await new WorkbenchResultService({ runs: h.runs, objects: h.objects }).get(runId);
  assert.equal(result.deliveryStatus, "HISTORICAL");
  assert.equal(result.original.availability, "UNAVAILABLE");
  assert.equal(result.final.documentId, `legacy:${runId}:final`);
  assert.equal(result.final.profile.name, "Candidate");
  assert.equal(result.final.sections[0].entries[0].name, "Acme");
  assert.equal(result.review.kind, "historical-suggestion");
  assert.equal("overallScore" in result.review.report, false);
  assert.equal(result.actionHistoryStatus, "UNKNOWN");
});

test("workbench API saves each document by revision, wins routing, and hides soft-deleted runs", async () => {
  const h = await workbenchHarness();
  const runId = "run-workbench-save";
  await h.runs.create({ id: runId, resumeSourceId: "source-workbench", company: "RolePilot", title: "PM", jdText: "JD", extractedTextObjectKey: "source.txt", createdAt: "2026-09-05T00:00:00.000Z", eventId: `${runId}-created` });
  await h.runs.claimNext(`${runId}-running`);
  const originalV3 = resumeV3(`${runId}:original`, "Original");
  const finalV3 = resumeV3(`${runId}:generated`, "Final");
  const originalArtifact = await h.publish(runId, `${runId}-original`, "supporting", "resume", "supporting", "resumes/original.json", originalV3);
  const finalArtifact = await h.publish(runId, `${runId}-final`, "final-resume", "resume", "final", "resumes/final.json", finalV3);
  const preflightArtifact = await h.publish(runId, `${runId}-preflight`, "supporting", "preflight", "supporting", "preflight.json", { decision: "PROCEED", safeWritingScope: ["experience"] });
  const reviewArtifact = await h.publish(runId, `${runId}-review`, "supporting", "review-report", "review", "reviews/final.json", review);
  const bindingArtifact = await h.publish(runId, `${runId}-binding`, "supporting", "log", "supporting", "reviews/final.binding.json", {
    documentId: finalV3.documentId, candidateVersion: 1, evidenceVersion: 0, reviewArtifactPath: reviewArtifact.relativePath, issueTargets: [],
  });
  const deliveryArtifact = await h.publish(runId, `${runId}-delivery`, "supporting", "log", "supporting", "workbench-delivery.json", {
    schemaVersion: 1,
    format: "workbench-delivery",
    deliveryStatus: "OPTIMIZED",
    original: { documentId: originalV3.documentId, path: originalArtifact.relativePath },
    final: { documentId: finalV3.documentId, path: finalArtifact.relativePath, candidateVersion: 1 },
    candidate: { documentId: finalV3.documentId, path: finalArtifact.relativePath, version: 1 },
    review: { kind: "final-bound", reportPath: reviewArtifact.relativePath, bindingPath: bindingArtifact.relativePath },
    preflight: { path: preflightArtifact.relativePath, decision: "PROCEED" },
    actionHistory: [],
  });
  await h.complete(runId, finalArtifact.id, [originalArtifact, finalArtifact, preflightArtifact, reviewArtifact, bindingArtifact, deliveryArtifact]);

  const documents = new InMemoryWorkbenchRepository({ runs: h.runs, clock: () => "2026-09-07T10:00:00.000Z" });
  const workbenchApi = createWorkbenchApi({ workbenchService: new WorkbenchService({ results: new WorkbenchResultService({ runs: h.runs, objects: h.objects }), documents }) });
  const api = createWebApi({
    sourceApi: { handle: async () => new Response("source", { status: 418 }) },
    draftApi: { handle: async () => new Response("draft", { status: 418 }) },
    runApi: { handle: async () => new Response("wrong run route", { status: 418 }) },
    workbenchApi,
  });

  let response = await api.handle(new Request(`http://localhost/api/runs/${runId}/workbench`));
  assert.equal(response.status, 200);
  let body = await response.json();
  assert.equal(body.generated.revision, 0);
  assert.equal(body.generated.content.resumeName, "Final");
  assert.equal(body.generated.reviewBinding.documentId, finalV3.documentId);

  const edited = structuredClone(finalV3);
  edited.resumeName = "Manual Final";
  const request = () => new Request(`http://localhost/api/runs/${runId}/workbench/documents/${encodeURIComponent(finalV3.documentId)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: edited, expectedRevision: 0 }),
  });
  response = await api.handle(request());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).revision, 1);
  response = await api.handle(request());
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "WORKBENCH_REVISION_CONFLICT");

  response = await api.handle(new Request(`http://localhost/api/runs/${runId}/workbench`));
  body = await response.json();
  assert.equal(body.generated.initialContent.resumeName, "Final");
  assert.equal(body.generated.content.resumeName, "Manual Final");
  assert.equal(body.generated.contentEdited, true);
  assert.equal(body.generated.revision, 1);

  await h.runs.softDelete(runId);
  response = await api.handle(new Request(`http://localhost/api/runs/${runId}/workbench`));
  assert.equal(response.status, 404);
  response = await api.handle(new Request(`http://localhost/api/runs/${runId}/workbench/documents/${encodeURIComponent(finalV3.documentId)}`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: edited, expectedRevision: 1 }),
  }));
  assert.equal(response.status, 404);
});

test("resume diff distinguishes additions, removals, and missing section alignment", () => {
  const before = { ...original, sections: [{ ...original.sections[0], entries: [...original.sections[0].entries, { id: "old-1", title: "Old", date: null, location: null, bullets: ["old"] }] }, { id: "old", title: "Old", entries: [{ id: "old-2", title: "Old", date: null, location: null, bullets: ["old"] }] }] };
  const after = { ...resume, sections: [{ ...resume.sections[0], entries: [...resume.sections[0].entries, { id: "new-1", title: "New", date: null, location: null, bullets: ["new"] }] }, { id: "new", title: "New", entries: [{ id: "new-2", title: "New", date: null, location: null, bullets: ["new"] }] }] };
  const kinds = diffResumes(before, after).map((block) => block.kind);
  assert.equal(kinds.includes("removed"), true);
  assert.equal(kinds.includes("added"), true);
  assert.equal(kinds.includes("unaligned"), true);
});
