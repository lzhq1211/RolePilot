import assert from "node:assert/strict";
import test from "node:test";

import { createTextPdf } from "../../../packages/document-ingest/tests/fixtures/pdf-fixtures.mjs";
import { createDocx } from "../../../packages/document-ingest/tests/fixtures/docx-fixtures.mjs";

import {
  createSourceApi,
  createSourceHttpServer,
  InMemoryIdempotencyStore,
  InMemorySourceObjectStore,
  InMemorySourceRepository,
  SourceService,
  SupabaseIdempotencyStore,
  SupabaseRestClient,
  SupabaseSourceRepository,
} from "../dist/index.js";

const encoder = new TextEncoder();

function createHarness({ referenceReader, documentParser, parserTimeoutMs } = {}) {
  const objectStore = new InMemorySourceObjectStore();
  const repository = new InMemorySourceRepository({
    objectStore,
    referenceReader: referenceReader ?? { async isReferencedByRun() { return false; } },
  });
  const idempotencyStore = new InMemoryIdempotencyStore();
  let sequence = 0;
  const createService = () =>
    new SourceService({
      repository,
      objectStore,
      idempotencyStore,
      idFactory: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
      documentParser,
      parserTimeoutMs,
    });
  const sourceService = createService();
  return {
    repository,
    objectStore,
    createService,
    api: createSourceApi({
      sourceService,
      requestIdFactory: () => "req-test",
    }),
  };
}

function pastedRequest(text, key = "key-1") {
  return new Request("http://rolepilot.test/api/resume-sources", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify({ inputKind: "pasted-text", text }),
  });
}

function multipartRequest(bytes, name, mediaType, key) {
  const formData = new FormData();
  formData.append("file", new Blob([bytes], { type: mediaType }), name);
  return new Request("http://rolepilot.test/api/resume-sources", {
    method: "POST",
    headers: { "idempotency-key": key },
    body: formData,
  });
}

async function responseJson(response) {
  return response.json();
}

test("pasted resume creates a safe READY source and is available through GET", async () => {
  const { api } = createHarness();
  const createResponse = await api.handle(pastedRequest("Lin Yu\r\nBackend Engineer"));
  const source = await responseJson(createResponse);

  assert.equal(createResponse.status, 201);
  assert.equal(createResponse.headers.get("x-request-id"), "req-test");
  assert.deepEqual(Object.keys(source).sort(), [
    "createdAt",
    "error",
    "id",
    "inputKind",
    "mediaType",
    "originalFileName",
    "pageCount",
    "parserVersion",
    "previewText",
    "sizeBytes",
    "status",
    "textLength",
    "updatedAt",
  ]);
  assert.equal(source.status, "READY");
  assert.equal(source.inputKind, "pasted-text");
  assert.equal(source.originalFileName, null);
  assert.equal(source.previewText, "Lin Yu\nBackend Engineer");
  assert.equal(source.textLength, 23);
  assert.equal(source.error, null);
  assert.equal("originalObjectKey" in source, false);
  assert.equal(JSON.stringify(source).includes("sources/"), false);

  const getResponse = await api.handle(
    new Request(`http://rolepilot.test/api/resume-sources/${source.id}`),
  );
  assert.equal(getResponse.status, 200);
  assert.deepEqual(await responseJson(getResponse), source);
});

test("multipart TXT uses the same parser and returns parser failures as FAILED sources", async () => {
  const { api } = createHarness();
  const formData = new FormData();
  formData.append(
    "file",
    new Blob([encoder.encode("Lin Yu\nPlatform Engineer")], { type: "text/plain" }),
    "resume.txt",
  );
  const readyResponse = await api.handle(
    new Request("http://rolepilot.test/api/resume-sources", {
      method: "POST",
      headers: { "idempotency-key": "upload-key" },
      body: formData,
    }),
  );
  const ready = await responseJson(readyResponse);
  assert.equal(readyResponse.status, 201);
  assert.equal(ready.status, "READY");
  assert.equal(ready.inputKind, "file");
  assert.equal(ready.originalFileName, "resume.txt");

  const invalidForm = new FormData();
  invalidForm.append(
    "file",
    new Blob([new Uint8Array([0xc3, 0x28])], { type: "text/plain" }),
    "invalid.txt",
  );
  const failedResponse = await api.handle(
    new Request("http://rolepilot.test/api/resume-sources", {
      method: "POST",
      headers: { "idempotency-key": "invalid-key" },
      body: invalidForm,
    }),
  );
  const failed = await responseJson(failedResponse);
  assert.equal(failedResponse.status, 201);
  assert.equal(failed.status, "FAILED");
  assert.deepEqual(failed.error, {
    code: "ENCODING_UNSUPPORTED",
    message: "TXT 文件编码不受支持。",
    retryable: false,
  });
  assert.equal(failed.previewText, null);
  assert.equal(failed.textLength, null);
});

test("invalid request shapes and format mismatches do not create sources", async () => {
  const { api, repository } = createHarness();
  const response = await api.handle(
    new Request("http://rolepilot.test/api/resume-sources", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "invalid-format",
      },
      body: JSON.stringify({ inputKind: "pasted-text", text: "%PDF-1.7" }),
    }),
  );
  const payload = await responseJson(response);

  assert.equal(response.status, 400);
  assert.deepEqual(payload.error, {
    code: "CONTENT_SIGNATURE_MISMATCH",
    message: "文件内容与声明格式不一致。",
    retryable: false,
    requestId: "req-test",
  });
  assert.equal(repository.activeCount(), 0);
});

test("multipart PDF returns a ready Source with extracted text and page count", async () => {
  const { api } = createHarness();
  const response = await api.handle(
    multipartRequest(
      createTextPdf([["Lin Yu"], ["Platform Engineer"]]),
      "resume.pdf",
      "application/pdf",
      "pdf-ready",
    ),
  );
  const source = await responseJson(response);

  assert.equal(response.status, 201);
  assert.equal(source.status, "READY");
  assert.equal(source.mediaType, "application/pdf");
  assert.equal(source.textLength, 24);
  assert.equal(source.pageCount, 2);
  assert.equal(source.previewText, "Lin Yu\nPlatform Engineer");
  assert.equal(source.error, null);
});

test("PDF parse failures remain failed sources and leave no objects behind", async () => {
  const { api, objectStore } = createHarness();
  const response = await api.handle(
    multipartRequest(createTextPdf([[]]), "scanned.pdf", "application/pdf", "pdf-empty"),
  );
  const source = await responseJson(response);

  assert.equal(response.status, 201);
  assert.equal(source.status, "FAILED");
  assert.equal(source.mediaType, "application/pdf");
  assert.deepEqual(source.error, {
    code: "PDF_TEXT_UNAVAILABLE",
    message: "PDF 中没有可提取文本。",
    retryable: false,
  });
  assert.equal(objectStore.count(), 0);
});

test("multipart DOCX returns a ready Source with extracted text and DOCX metadata", async () => {
  const { api } = createHarness();
  const response = await api.handle(
    multipartRequest(
      createDocx({
        documentXml: `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Lin Yu</w:t></w:r></w:p><w:p><w:r><w:t>Platform Engineer</w:t></w:r></w:p></w:body></w:document>`,
      }),
      "resume.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "docx-ready",
    ),
  );
  const source = await responseJson(response);

  assert.equal(response.status, 201);
  assert.equal(source.status, "READY");
  assert.equal(source.mediaType, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(source.textLength, 24);
  assert.equal(source.pageCount, null);
  assert.equal(source.previewText, "Lin Yu\nPlatform Engineer");
  assert.equal(source.parserVersion, "document-ingest/docx-v1");
  assert.equal(source.error, null);
});

test("DOCX parser failures remain failed sources and clean temporary objects", async () => {
  const { api, objectStore } = createHarness();
  const response = await api.handle(
    multipartRequest(
      createDocx({ extraEntries: [{ name: "word/vbaProject.bin", data: "macro" }] }),
      "macro.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "docx-invalid",
    ),
  );
  const source = await responseJson(response);

  assert.equal(response.status, 201);
  assert.equal(source.status, "FAILED");
  assert.deepEqual(source.error, {
    code: "DOCX_INVALID",
    message: "DOCX 文件无效。",
    retryable: false,
  });
  assert.equal(source.previewText, null);
  assert.equal(objectStore.count(), 0);
});

test("parser timeout produces a failed source and cleans temporary objects", async () => {
  const { api, objectStore } = createHarness({
    documentParser: {
      async parse() {
        return new Promise(() => {});
      },
    },
    parserTimeoutMs: 1,
  });
  const response = await api.handle(
    multipartRequest(createTextPdf([["Lin Yu"]]), "timeout.pdf", "application/pdf", "pdf-timeout"),
  );
  const source = await responseJson(response);

  assert.equal(response.status, 201);
  assert.equal(source.status, "FAILED");
  assert.deepEqual(source.error, {
    code: "PARSER_TIMEOUT",
    message: "解析超时。",
    retryable: true,
  });
  assert.equal(objectStore.count(), 0);
});

test("source request above 10 MiB is rejected before a source record is created", async () => {
  const { api, repository } = createHarness();
  const response = await api.handle(
    pastedRequest("a".repeat(10 * 1024 * 1024 + 1), "too-large"),
  );

  assert.equal(response.status, 413);
  assert.deepEqual((await responseJson(response)).error, {
    code: "FILE_TOO_LARGE",
    message: "文件超过 10 MiB 限制。",
    retryable: false,
    requestId: "req-test",
  });
  assert.equal(repository.activeCount(), 0);
});

test("idempotency reuses the first source across a new service instance and rejects changed input", async () => {
  const harness = createHarness();
  const firstResponse = await harness.api.handle(pastedRequest("Lin Yu", "stable-key"));
  const first = await responseJson(firstResponse);

  const restartedApi = createSourceApi({
    sourceService: harness.createService(),
    requestIdFactory: () => "req-restarted",
  });
  const repeatedResponse = await restartedApi.handle(pastedRequest("Lin Yu", "stable-key"));
  assert.equal(repeatedResponse.status, 201);
  assert.deepEqual(await responseJson(repeatedResponse), first);
  assert.equal(harness.repository.activeCount(), 1);

  const conflictResponse = await restartedApi.handle(
    pastedRequest("Lin Yu with different content", "stable-key"),
  );
  assert.equal(conflictResponse.status, 409);
  assert.deepEqual((await responseJson(conflictResponse)).error, {
    code: "IDEMPOTENCY_CONFLICT",
    message: "此 Idempotency-Key 已用于不同请求。",
    retryable: false,
    requestId: "req-restarted",
  });
});

test("deleting one source leaves another source intact and preserves run-referenced source", async () => {
  const referenced = new Set();
  const { api } = createHarness({
    referenceReader: {
      async isReferencedByRun(sourceId) {
        return referenced.has(sourceId);
      },
    },
  });
  const first = await responseJson(await api.handle(pastedRequest("First", "delete-first")));
  const second = await responseJson(await api.handle(pastedRequest("Second", "delete-second")));

  const deleteResponse = await api.handle(
    new Request(`http://rolepilot.test/api/resume-sources/${first.id}`, { method: "DELETE" }),
  );
  assert.equal(deleteResponse.status, 204);
  assert.equal(
    (await api.handle(new Request(`http://rolepilot.test/api/resume-sources/${first.id}`))).status,
    404,
  );
  assert.equal(
    (await responseJson(
      await api.handle(new Request(`http://rolepilot.test/api/resume-sources/${second.id}`)),
    )).status,
    "READY",
  );

  referenced.add(second.id);
  const deferredDelete = await api.handle(
    new Request(`http://rolepilot.test/api/resume-sources/${second.id}`, { method: "DELETE" }),
  );
  assert.equal(deferredDelete.status, 202);
  assert.equal((await responseJson(deferredDelete)).status, "READY");
});

test("native HTTP server exposes the same relative source API", async () => {
  const { api } = createHarness();
  const server = createSourceHttpServer(api);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/resume-sources`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "http-key",
        },
        body: JSON.stringify({ inputKind: "pasted-text", text: "Lin Yu" }),
      },
    );
    assert.equal(response.status, 201);
    assert.equal((await response.json()).status, "READY");
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("native HTTP server accepts PDF uploads and returns PDF metadata", async () => {
  const { api } = createHarness();
  const server = createSourceHttpServer(api);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const formData = new FormData();
    formData.append(
      "file",
      new Blob([createTextPdf([["Lin Yu"], ["Platform Engineer"]])], {
        type: "application/pdf",
      }),
      "resume.pdf",
    );
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/resume-sources`,
      {
        method: "POST",
        headers: { "idempotency-key": "http-pdf-key" },
        body: formData,
      },
    );
    const source = await response.json();

    assert.equal(response.status, 201);
    assert.equal(source.status, "READY");
    assert.equal(source.mediaType, "application/pdf");
    assert.equal(source.pageCount, 2);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("Supabase idempotency adapter maps unique-key errors without exposing transport details", async () => {
  const client = new SupabaseRestClient({
    url: "http://supabase.test",
    serviceRoleKey: "test-service-key",
    fetchImplementation: async () =>
      new Response(JSON.stringify({ code: "23505" }), { status: 409 }),
  });
  const store = new SupabaseIdempotencyStore({ client });

  await assert.rejects(
    () =>
      store.put("resume-sources.create", "key", {
      requestFingerprint: "sha256:abc",
      resultKind: "source",
      resultId: "00000000-0000-4000-8000-000000000001",
      sourceId: "00000000-0000-4000-8000-000000000001",
        expiresAt: "2030-01-01T00:00:00.000Z",
      }),
    { name: "IdempotencyKeyConflictError" },
  );
});

test("Supabase adapters keep new secret keys out of Authorization and retain legacy service-role support", async () => {
  const seenHeaders = [];
  const fetchImplementation = async (_url, init) => {
    seenHeaders.push(new Headers(init.headers));
    return Response.json([]);
  };

  const secretClient = new SupabaseRestClient({
    url: "http://supabase.test",
    serviceRoleKey: "sb_secret_test",
    fetchImplementation,
  });
  await secretClient.json("/rest/v1/source_documents?select=id");

  const legacyClient = new SupabaseRestClient({
    url: "http://supabase.test",
    serviceRoleKey: "eyJ.legacy-service-role",
    fetchImplementation,
  });
  await legacyClient.json("/rest/v1/source_documents?select=id");

  assert.equal(seenHeaders[0].get("apikey"), "sb_secret_test");
  assert.equal(seenHeaders[0].get("authorization"), null);
  assert.equal(seenHeaders[1].get("apikey"), "eyJ.legacy-service-role");
  assert.equal(seenHeaders[1].get("authorization"), "Bearer eyJ.legacy-service-role");
});

test("Supabase source deletion uses the atomic source-reference RPC", async () => {
  const calls = [];
  const client = new SupabaseRestClient({
    url: "http://supabase.test",
    serviceRoleKey: "sb_secret_test",
    fetchImplementation: async (url, init) => {
      calls.push({ url: String(url), method: init?.method ?? "GET" });
      return Response.json({
        id: "source-1",
        status: "READY",
        input_kind: "pasted-text",
        original_file_name: null,
        media_type: "text/plain",
        size_bytes: 10,
        text_length: 10,
        page_count: null,
        parser_version: "txt-v1",
        error_code: null,
        error_message: null,
        error_retryable: null,
        original_object_key: "sources/source-1/original.bin",
        extracted_text_object_key: "sources/source-1/extracted.txt",
        cleanup_requested_at: "2026-09-05T00:00:01.000Z",
        created_at: "2026-09-05T00:00:00.000Z",
        updated_at: "2026-09-05T00:00:01.000Z",
        deleted_at: null,
      });
    },
  });
  const repository = new SupabaseSourceRepository({
    client,
    objectStore: new InMemorySourceObjectStore(),
  });

  const result = await repository.delete("source-1");
  assert.equal(result.kind, "pending-cleanup");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /rpc\/rolepilot_delete_source_with_reference_check/);
});
