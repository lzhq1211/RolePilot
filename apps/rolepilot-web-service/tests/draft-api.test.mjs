import assert from "node:assert/strict";
import test from "node:test";

import {
  createDraftApi,
  DraftService,
  InMemoryDraftRepository,
} from "../dist/index.js";

function createHarness() {
  const repository = new InMemoryDraftRepository({
    clock: () => "2026-09-04T00:00:00.000Z",
  });
  let sequence = 0;
  const service = new DraftService({
    repository,
    idFactory: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
  });
  return {
    repository,
    api: createDraftApi({
      draftService: service,
      requestIdFactory: () => "req-draft-test",
    }),
  };
}

function draftBody(overrides = {}) {
  return {
    resumeSourceId: "source-1",
    company: "RolePilot",
    title: "AI 产品经理",
    jdText: "负责证据驱动的简历优化。",
    ...overrides,
  };
}

function request(method, path, body, headers = {}) {
  return new Request(`http://rolepilot.test${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("Draft can be created, read, and updated with optimistic revision", async () => {
  const { api } = createHarness();
  const createdResponse = await api.handle(request("POST", "/api/input-drafts", draftBody()));
  const created = await createdResponse.json();

  assert.equal(createdResponse.status, 201);
  assert.equal(createdResponse.headers.get("x-request-id"), "req-draft-test");
  assert.deepEqual(Object.keys(created).sort(), [
    "company",
    "id",
    "jdText",
    "resumeSourceId",
    "revision",
    "title",
    "updatedAt",
  ]);
  assert.equal(created.revision, 1);

  const readResponse = await api.handle(
    request("GET", `/api/input-drafts/${created.id}`),
  );
  assert.equal(readResponse.status, 200);
  assert.deepEqual(await readResponse.json(), created);

  const updatedResponse = await api.handle(
    request(
      "PUT",
      `/api/input-drafts/${created.id}`,
      draftBody({ title: "Senior AI 产品经理", jdText: "负责完整的求职物料链路。" }),
      { "if-match": "1" },
    ),
  );
  const updated = await updatedResponse.json();
  assert.equal(updatedResponse.status, 200);
  assert.equal(updated.revision, 2);
  assert.equal(updated.title, "Senior AI 产品经理");
});

test("stale Draft updates are rejected without overwriting the current value", async () => {
  const { api } = createHarness();
  const created = await (
    await api.handle(request("POST", "/api/input-drafts", draftBody()))
  ).json();
  await api.handle(
    request("PUT", `/api/input-drafts/${created.id}`, draftBody({ company: "New Co" }), {
      "if-match": "1",
    }),
  );

  const conflictResponse = await api.handle(
    request("PUT", `/api/input-drafts/${created.id}`, draftBody({ company: "Stale Co" }), {
      "if-match": "1",
    }),
  );
  assert.equal(conflictResponse.status, 409);
  assert.deepEqual((await conflictResponse.json()).error, {
    code: "DRAFT_CONFLICT",
    message: "输入草稿已被其他请求更新，请重新读取后选择保留版本。",
    retryable: false,
    requestId: "req-draft-test",
  });

  const current = await (
    await api.handle(request("GET", `/api/input-drafts/${created.id}`))
  ).json();
  assert.equal(current.company, "New Co");
  assert.equal(current.revision, 2);
});

test("Draft validation returns field-level errors and does not create invalid data", async () => {
  const { api, repository } = createHarness();
  const response = await api.handle(
    request("POST", "/api/input-drafts", draftBody({ company: "x".repeat(201) })),
  );
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.deepEqual(payload.error.fieldErrors, [
    {
      field: "company",
      code: "TOO_LONG",
      message: "公司名称不能超过 200 字。",
    },
  ]);
  assert.equal(await repository.get("missing"), null);
});

test("missing revision and unknown Draft use separate API errors", async () => {
  const { api } = createHarness();
  const missingRevision = await api.handle(
    request("PUT", "/api/input-drafts/unknown", draftBody()),
  );
  assert.equal(missingRevision.status, 400);

  const unknown = await api.handle(
    request("GET", "/api/input-drafts/unknown"),
  );
  assert.equal(unknown.status, 404);
  assert.deepEqual((await unknown.json()).error, {
    code: "DRAFT_NOT_FOUND",
    message: "未找到这份输入草稿。",
    retryable: false,
    requestId: "req-draft-test",
  });
});
