import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createBackendRegistry,
  createClaudeAdapter,
  createCodexAdapter,
  createFallbackDecision,
  createOpenAIChatAdapter,
  createOpenCodeAdapter,
  createReplayAdapter,
  defaultCommandExecutor,
} from "../dist/index.js";

function createAdapter({
  provider,
  supportsStreaming = true,
  execute,
  stream,
  health,
  capabilities,
}) {
  return {
    provider,
    async execute(request) {
      return execute(request);
    },
    async *stream(request) {
      if (!supportsStreaming) {
        throw new Error(`${provider} streaming disabled`);
      }
      if (stream) {
        yield* stream(request);
      }
    },
    async health() {
      return health?.() ?? { provider, ok: true, detail: "healthy" };
    },
    capabilities() {
      return (
        capabilities?.() ?? {
          provider,
          executionModes: ["live", "stub", "replay"],
          supportsStreaming,
          supportsFallback: false,
        }
      );
    },
  };
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "platform-adapters-"));
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      return error.code !== "ESRCH";
    }
    return false;
  }
}

test("provider registry resolves a configured provider and preserves provider vocabulary", () => {
  const registry = createBackendRegistry([
    createAdapter({ provider: "claude", execute: async () => ({}) }),
    createAdapter({ provider: "opencode", execute: async () => ({}) }),
  ]);

  assert.deepEqual(registry.list(), ["claude", "opencode"]);
  assert.equal(registry.get("claude")?.provider, "claude");
  assert.deepEqual(registry.resolve({ provider: "opencode" }), {
    provider: "opencode",
    adapter: registry.get("opencode"),
  });
});

test("provider registry executes through the resolved adapter with normalized live request/result semantics", async () => {
  const seen = [];
  const registry = createBackendRegistry([
    createAdapter({
      provider: "claude",
      execute: async (request) => {
        seen.push(request);
        return {
          requestId: request.requestId,
          provider: request.provider,
          mode: request.mode,
          status: "succeeded",
          outputText: `ok:${request.input}`,
          raw: { transport: "fake" },
        };
      },
    }),
  ]);

  const result = await registry.execute({
    requestId: "req-live",
    provider: "claude",
    mode: "live",
    input: "hello",
  });

  assert.equal(seen[0].provider, "claude");
  assert.equal(seen[0].mode, "live");
  assert.equal(result.status, "succeeded");
  assert.equal(result.provider, "claude");
  assert.equal(result.mode, "live");
  assert.equal(result.outputText, "ok:hello");
});

test("provider registry keeps offline execution as mode metadata, not provider replacement", async () => {
  const seen = [];
  const registry = createBackendRegistry([
    createAdapter({
      provider: "codex",
      execute: async (request) => {
        seen.push(request);
        return {
          requestId: request.requestId,
          provider: request.provider,
          mode: request.mode,
          status: "succeeded",
          outputText: "offline",
        };
      },
    }),
  ]);

  const result = await registry.execute({
    requestId: "req-stub",
    provider: "codex",
    mode: "stub",
    input: "offline",
  });

  assert.equal(seen[0].provider, "codex");
  assert.equal(seen[0].mode, "stub");
  assert.equal(result.provider, "codex");
  assert.equal(result.mode, "stub");
});

test("provider registry exposes backend capability and health introspection without executing requests", async () => {
  let executed = false;
  const registry = createBackendRegistry([
    createAdapter({
      provider: "opencode",
      execute: async () => {
        executed = true;
        return {
          requestId: "req",
          provider: "opencode",
          mode: "live",
          status: "succeeded",
        };
      },
      health: () => ({ provider: "opencode", ok: true, detail: "idle" }),
      capabilities: () => ({
        provider: "opencode",
        executionModes: ["live", "stub"],
        supportsStreaming: false,
        supportsFallback: true,
      }),
    }),
  ]);

  assert.deepEqual(registry.capabilities("opencode"), {
    provider: "opencode",
    executionModes: ["live", "stub"],
    supportsStreaming: false,
    supportsFallback: true,
  });
  assert.deepEqual(registry.capabilitiesAll(), [
    {
      provider: "opencode",
      executionModes: ["live", "stub"],
      supportsStreaming: false,
      supportsFallback: true,
    },
  ]);
  assert.deepEqual(await registry.health("opencode"), {
    provider: "opencode",
    ok: true,
    detail: "idle",
  });
  assert.equal(executed, false);
});

test("backend fallback is represented as an external decision after adapter failure", () => {
  const decision = createFallbackDecision({
    request: {
      requestId: "req-fallback",
      provider: "claude",
      mode: "live",
      input: "retry me",
    },
    error: {
      requestId: "req-fallback",
      provider: "claude",
      mode: "live",
      code: "ADAPTER_FAILURE",
      message: "primary failed",
      retryable: true,
    },
    nextProvider: "opencode",
    reason: "retryable-primary-failure",
  });

  assert.deepEqual(decision, {
    shouldFallback: true,
    fromProvider: "claude",
    toProvider: "opencode",
    mode: "live",
    requestId: "req-fallback",
    reason: "retryable-primary-failure",
    error: {
      requestId: "req-fallback",
      provider: "claude",
      mode: "live",
      code: "ADAPTER_FAILURE",
      message: "primary failed",
      retryable: true,
    },
  });
});

test("provider registry rejects unknown providers and unsupported streaming with normalized errors", async () => {
  const registry = createBackendRegistry([
    createAdapter({
      provider: "claude",
      supportsStreaming: false,
      execute: async (request) => ({
        requestId: request.requestId,
        provider: request.provider,
        mode: request.mode,
        status: "succeeded",
      }),
    }),
  ]);

  await assert.rejects(
    () =>
      registry.execute({
        requestId: "req-missing",
        provider: "opencode",
        mode: "live",
        input: "x",
      }),
    (error) => {
      assert.equal(error.name, "BackendRegistryError");
      assert.equal(error.code, "UNKNOWN_PROVIDER");
      assert.equal(error.provider, "opencode");
      return true;
    },
  );

  await assert.rejects(
    async () => {
      for await (const _event of registry.stream({
        requestId: "req-stream",
        provider: "claude",
        mode: "live",
        input: "stream",
      })) {
      }
    },
    (error) => {
      assert.equal(error.name, "BackendRegistryError");
      assert.equal(error.code, "UNSUPPORTED_STREAM");
      assert.equal(error.provider, "claude");
      return true;
    },
  );
});

test("claude adapter normalizes CLI invocation metadata and plain-text output", async () => {
  const adapter = createClaudeAdapter({
    timeoutMs: 2500,
    cwd: "/workspace/claude",
    executor: async (invocation) => {
      assert.equal(invocation.command, "claude");
      assert.deepEqual(invocation.args, [
        "--print",
        "--model",
        "claude-3-7-sonnet",
        "--temperature",
        "0.3",
        "--max-tokens",
        "1200",
        "--dangerously-skip-permissions",
      ]);
      return {
        stdout: "  Claude normalized output  \n",
        stderr: "",
        exitCode: 0,
        signal: null,
      };
    },
  });

  const result = await adapter.execute({
    requestId: "claude-live-1",
    provider: "claude",
    mode: "live",
    input: "hello claude",
    model: "claude-3-7-sonnet",
    temperature: 0.3,
    maxTokens: 1200,
    extraArgs: ["--dangerously-skip-permissions"],
  });

  assert.equal(result.outputText, "Claude normalized output");
  assert.deepEqual(result.metadata.invocation, {
    transport: "cli",
    command: "claude",
    args: [
      "--print",
      "--model",
      "claude-3-7-sonnet",
      "--temperature",
      "0.3",
      "--max-tokens",
      "1200",
      "--dangerously-skip-permissions",
    ],
    cwd: "/workspace/claude",
    timeoutMs: 2500,
    model: "claude-3-7-sonnet",
    temperature: 0.3,
    maxTokens: 1200,
    extraArgs: ["--dangerously-skip-permissions"],
    inputBytes: Buffer.byteLength("hello claude", "utf8"),
    progressHeartbeatMs: 15000,
  });
  assert.equal(adapter.capabilities().provider, "claude");
  assert.deepEqual(adapter.capabilities().executionModes, [
    "live",
    "stub",
    "replay",
  ]);
});

test("openai-chat adapter calls Chat Completions API directly without CLI transport", async () => {
  const calls = [];
  const adapter = createOpenAIChatAdapter({
    env: {
      OPENAI_API_KEY: "test-key",
      OPENAI_BASE_URL: "https://example.test/v1",
      OPENAI_CHAT_MODEL: "gpt-test",
    },
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "  direct api output  " } }],
          usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  const result = await adapter.execute({
    requestId: "openai-chat-live-1",
    provider: "openai-chat",
    mode: "live",
    input: "hello api",
    maxTokens: 1200,
    metadata: { systemPrompt: "You are concise." },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://example.test/v1/chat/completions");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, "Bearer test-key");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    model: "gpt-test",
    messages: [
      { role: "system", content: "You are concise." },
      { role: "user", content: "hello api" },
    ],
    max_tokens: 1200,
  });
  assert.equal(result.outputText, "direct api output");
  assert.equal(result.metadata.invocation.transport, "api");
  assert.equal(result.metadata.invocation.outputSource, "api");
  assert.equal(
    result.metadata.invocation.inputBytes,
    Buffer.byteLength("hello api", "utf8"),
  );
  assert.deepEqual(result.metadata.usage, {
    prompt_tokens: 10,
    completion_tokens: 3,
    total_tokens: 13,
  });
});

test("openai-chat adapter requires an API key for live mode", async () => {
  const adapter = createOpenAIChatAdapter({
    env: { OPENAI_CHAT_MODEL: "gpt-test" },
  });

  await assert.rejects(
    () =>
      adapter.execute({
        requestId: "openai-chat-live-missing-key",
        provider: "openai-chat",
        mode: "live",
        input: "hello",
      }),
    (error) => {
      assert.equal(error.name, "BackendRegistryError");
      assert.equal(error.code, "API_AUTHENTICATION");
      assert.equal(error.retryable, false);
      assert.match(error.message, /OPENAI_API_KEY/);
      assert.equal(error.metadata.invocation.transport, "api");
      return true;
    },
  );
});

test("openai-chat adapter normalizes HTTP failures and timeout errors", async () => {
  const failingAdapter = createOpenAIChatAdapter({
    env: {
      OPENAI_API_KEY: "test-key",
      OPENAI_CHAT_MODEL: "gpt-test",
    },
    fetch: async () =>
      new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
  });

  await assert.rejects(
    () =>
      failingAdapter.execute({
        requestId: "openai-chat-rate-limit",
        provider: "openai-chat",
        mode: "live",
        input: "hello",
      }),
    (error) => {
      assert.equal(error.name, "BackendRegistryError");
      assert.equal(error.code, "API_RATE_LIMIT");
      assert.equal(error.retryable, true);
      assert.equal(error.metadata.invocation.transport, "api");
      assert.equal(error.metadata.status, 429);
      assert.deepEqual(error.metadata.response, {
        error: { message: "rate limited" },
      });
      return true;
    },
  );

  const timeoutAdapter = createOpenAIChatAdapter({
    env: {
      OPENAI_API_KEY: "test-key",
      OPENAI_CHAT_MODEL: "gpt-test",
    },
    fetch: (_url, init) => {
      assert.ok(init.signal);
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), {
          once: true,
        });
      });
    },
  });

  await assert.rejects(
    () =>
      timeoutAdapter.execute({
        requestId: "openai-chat-timeout",
        provider: "openai-chat",
        mode: "live",
        input: "hello",
        timeoutMs: 1,
      }),
    (error) => {
      assert.equal(error.name, "BackendRegistryError");
      assert.equal(error.code, "API_TIMEOUT");
      assert.equal(error.retryable, true);
      assert.equal(error.metadata.invocation.timeoutMs, 1);
      return true;
    },
  );
});

test("opencode adapter extracts text from JSON events without leaking raw event format", async () => {
  const adapter = createOpenCodeAdapter({
    executor: async (invocation) => {
      assert.equal(invocation.command, "opencode");
      assert.deepEqual(invocation.args, ["run", "--format", "json"]);
      return {
        stdout: [
          '{"type":"text","part":{"text":"first paragraph"}}',
          '{"type":"text","part":{"text":"second paragraph"}}',
        ].join("\n"),
        stderr: "",
        exitCode: 0,
        signal: null,
      };
    },
  });

  const result = await adapter.execute({
    requestId: "opencode-live-1",
    provider: "opencode",
    mode: "live",
    input: "hello opencode",
  });

  assert.equal(result.outputText, "first paragraph\nsecond paragraph");
  assert.deepEqual(result.metadata.extraction, {
    parser: "opencode-json-events",
    parsedEvents: 2,
    textPartCount: 2,
    errorCount: 0,
  });
  assert.equal(result.raw, undefined);
});

test("opencode adapter rejects responses that contain both text and error events", async () => {
  const adapter = createOpenCodeAdapter({
    executor: async () => ({
      stdout: [
        '{"type":"text","part":{"text":"partial output"}}',
        '{"type":"error","message":"quota exceeded"}',
      ].join("\n"),
      stderr: "",
      exitCode: 0,
      signal: null,
    }),
  });

  await assert.rejects(
    () =>
      adapter.execute({
        requestId: "opencode-live-mixed",
        provider: "opencode",
        mode: "live",
        input: "hello",
      }),
    (error) => {
      assert.equal(error.name, "BackendRegistryError");
      assert.equal(error.code, "OUTPUT_PARSE_ERROR");
      assert.match(error.message, /quota exceeded/);
      return true;
    },
  );
});

test("opencode adapter classifies parser failures as normalized output errors", async () => {
  const adapter = createOpenCodeAdapter({
    executor: async () => ({
      stdout: '{"type":"error","message":"quota exceeded"}',
      stderr: "",
      exitCode: 0,
      signal: null,
    }),
  });

  await assert.rejects(
    () =>
      adapter.execute({
        requestId: "opencode-live-2",
        provider: "opencode",
        mode: "live",
        input: "hello",
      }),
    (error) => {
      assert.equal(error.name, "BackendRegistryError");
      assert.equal(error.code, "OUTPUT_PARSE_ERROR");
      assert.match(error.message, /quota exceeded/);
      return true;
    },
  );
});

test("codex adapter classifies CLI timeouts and preserves normalized invocation metadata", async () => {
  const adapter = createCodexAdapter({
    timeoutMs: 1500,
    executor: async (invocation) => {
      assert.equal(invocation.command, "codex");
      assert.equal(invocation.args[0], "exec");
      assert.equal(invocation.args[1], "--output-last-message");
      assert.equal(invocation.args[2], invocation.outputCapturePath);
      assert.match(invocation.outputCapturePath, /\.codex-last-message-.*\.txt$/);
      return {
        stdout: "",
        stderr: "timed out",
        exitCode: null,
        signal: "SIGTERM",
        timedOut: true,
        error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
      };
    },
  });

  await assert.rejects(
    () =>
      adapter.execute({
        requestId: "codex-live-1",
        provider: "codex",
        mode: "live",
        input: "hello codex",
      }),
    (error) => {
      assert.equal(error.name, "BackendRegistryError");
      assert.equal(error.code, "CLI_TIMEOUT");
      assert.equal(error.retryable, true);
      assert.equal(error.metadata.invocation.command, "codex");
      assert.equal(error.metadata.invocation.args[0], "exec");
      assert.equal(error.metadata.invocation.args[1], "--output-last-message");
      assert.match(
        error.metadata.invocation.outputCapturePath,
        /\.codex-last-message-.*\.txt$/,
      );
      assert.equal(error.metadata.invocation.timeoutMs, 1500);
      return true;
    },
  );
});

test("codex adapter classifies sandbox permission failures without mislabeling them as output errors", async () => {
  const adapter = createCodexAdapter({
    executor: async () => ({
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: null,
      error: Object.assign(new Error("spawn EPERM"), { code: "EPERM" }),
      completionSignal: "spawn-error",
    }),
  });

  await assert.rejects(
    () =>
      adapter.execute({
        requestId: "codex-live-eperm",
        provider: "codex",
        mode: "live",
        input: "hello codex",
      }),
    (error) => {
      assert.equal(error.name, "BackendRegistryError");
      assert.equal(error.code, "CLI_PERMISSION_DENIED");
      assert.match(error.message, /runtime permission issue/i);
      assert.match(error.message, /replay\/stub/i);
      return true;
    },
  );
});

test("codex adapter classifies missing live provider binaries as provider unavailable", async () => {
  const adapter = createCodexAdapter({
    executor: async () => ({
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: null,
      error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
      completionSignal: "spawn-error",
    }),
  });

  await assert.rejects(
    () =>
      adapter.execute({
        requestId: "codex-live-enoent",
        provider: "codex",
        mode: "live",
        input: "hello codex",
      }),
    (error) => {
      assert.equal(error.name, "BackendRegistryError");
      assert.equal(error.code, "PROVIDER_UNAVAILABLE");
      assert.match(error.message, /on PATH/i);
      return true;
    },
  );
});

test("codex adapter preserves explicit cancellation as CLI_CANCELLED", async () => {
  const adapter = createCodexAdapter({
    executor: async () => ({
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: null,
      cancelled: true,
      error: Object.assign(new Error("Run cancelled by user."), {
        name: "AbortError",
      }),
      completionSignal: "cancelled",
    }),
  });

  await assert.rejects(
    () =>
      adapter.execute({
        requestId: "codex-live-cancelled",
        provider: "codex",
        mode: "live",
        input: "hello codex",
      }),
    (error) => {
      assert.equal(error.name, "BackendRegistryError");
      assert.equal(error.code, "CLI_CANCELLED");
      assert.equal(error.retryable, false);
      return true;
    },
  );
});

test("default command executor can return codex-style output captured from file before process exits", async () => {
  const tempDir = makeTempDir();
  const outputCapturePath = path.join(tempDir, "captured.txt");
  const startedAt = Date.now();
  const progressStages = [];
  let capturedPid = null;

  try {
    const result = await defaultCommandExecutor({
      requestId: "executor-output-file",
      provider: "codex",
      command: process.execPath,
      args: [
        "-e",
        "const fs = require('node:fs'); fs.writeFileSync(process.argv[1], 'captured output\\n', 'utf8'); setTimeout(() => {}, 30000);",
        outputCapturePath,
      ],
      cwd: tempDir,
      env: process.env,
      timeoutMs: 5000,
      input: "",
      outputCapturePath,
      outputCaptureStableMs: 200,
      progressHeartbeatMs: 100,
      onProgress(event) {
        progressStages.push(event.stage);
      },
    });

    assert.equal(result.stdout, "captured output");
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.completionSignal, "output-file-stable");
    assert.equal(result.outputSource, "output-file");
    assert.equal(typeof result.pid, "number");
    capturedPid = result.pid;
    assert.ok(progressStages.includes("provider-launching"));
    assert.ok(progressStages.includes("provider-started"));
    assert.ok(progressStages.includes("waiting-output-file-stable"));
    assert.ok(progressStages.includes("final-output-ready"));
    assert.ok(progressStages.includes("terminating-process"));
    assert.ok(Date.now() - startedAt < 5000);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (capturedPid) {
      assert.equal(isProcessAlive(capturedPid), false);
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("default command executor aborts child processes on cancellation instead of leaving them running", async () => {
  const controller = new AbortController();
  const tempDir = makeTempDir();
  const startedAt = Date.now();

  try {
    const resultPromise = defaultCommandExecutor({
      requestId: "executor-cancelled",
      provider: "codex",
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 30000);"] ,
      cwd: tempDir,
      env: process.env,
      timeoutMs: 30_000,
      input: "",
      signal: controller.signal,
    });

    setTimeout(() => {
      controller.abort(new Error("Run cancelled by user."));
    }, 300);

    const result = await resultPromise;
    assert.equal(result.cancelled, true);
    assert.equal(result.completionSignal, "cancelled");
    assert.equal(result.exitCode, null);
    assert.equal(result.timedOut, false);
    assert.ok(Date.now() - startedAt < 30_000);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(isProcessAlive(result.pid), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("replay adapter preserves deterministic queue order across inline and file-backed responses", async () => {
  const tempDir = makeTempDir();

  try {
    const responsePath = path.join(tempDir, "reply.txt");
    fs.writeFileSync(responsePath, "from file-backed replay\n", "utf8");
    const replayFilePath = path.join(tempDir, "replay.json");
    fs.writeFileSync(
      replayFilePath,
      JSON.stringify(
        {
          claude: [{ file: "reply.txt" }, { text: "second queued response" }],
        },
        null,
        2,
      ),
      "utf8",
    );

    const adapter = createReplayAdapter({
      provider: "claude",
      cwd: tempDir,
      sources: {
        stub: {
          entries: ["inline-first", { text: "inline-second" }],
        },
        replay: {
          filePath: replayFilePath,
          cwd: tempDir,
        },
      },
    });

    const stubFirst = await adapter.execute({
      requestId: "replay-inline-1",
      provider: "claude",
      mode: "stub",
      input: "ignored",
    });
    const stubSecond = await adapter.execute({
      requestId: "replay-inline-2",
      provider: "claude",
      mode: "stub",
      input: "ignored",
    });
    const replayFirst = await adapter.execute({
      requestId: "replay-file-1",
      provider: "claude",
      mode: "replay",
      input: "ignored",
    });
    const replaySecond = await adapter.execute({
      requestId: "replay-file-2",
      provider: "claude",
      mode: "replay",
      input: "ignored",
    });

    assert.equal(stubFirst.outputText, "inline-first");
    assert.equal(stubSecond.outputText, "inline-second");
    assert.equal(replayFirst.outputText, "from file-backed replay\n");
    assert.equal(replaySecond.outputText, "second queued response");
    assert.equal(replayFirst.metadata.replay.source, "file");
    assert.equal(replayFirst.metadata.replay.filePath, replayFilePath);
    assert.equal(replaySecond.metadata.replay.remaining, 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("replay adapter rejects malformed replay payloads and exhausted queues with normalized errors", async () => {
  const tempDir = makeTempDir();

  try {
    const malformedFilePath = path.join(tempDir, "malformed.json");
    fs.writeFileSync(
      malformedFilePath,
      JSON.stringify({ claude: [{ nope: true }] }, null, 2),
      "utf8",
    );

    const malformedAdapter = createReplayAdapter({
      provider: "claude",
      cwd: tempDir,
      sources: {
        replay: {
          filePath: malformedFilePath,
          cwd: tempDir,
        },
      },
    });

    await assert.rejects(
      () =>
        malformedAdapter.execute({
          requestId: "replay-bad-1",
          provider: "claude",
          mode: "replay",
          input: "ignored",
        }),
      (error) => {
        assert.equal(error.name, "BackendRegistryError");
        assert.equal(error.code, "MALFORMED_REPLAY");
        assert.match(
          error.message,
          /missing text, outputText, file, responseFile, or error/i,
        );
        return true;
      },
    );

    const exhaustedAdapter = createReplayAdapter({
      provider: "claude",
      sources: {
        stub: {
          entries: ["only-response"],
        },
      },
    });

    const first = await exhaustedAdapter.execute({
      requestId: "replay-good-1",
      provider: "claude",
      mode: "stub",
      input: "ignored",
    });
    assert.equal(first.outputText, "only-response");

    await assert.rejects(
      () =>
        exhaustedAdapter.execute({
          requestId: "replay-good-2",
          provider: "claude",
          mode: "stub",
          input: "ignored",
        }),
      (error) => {
        assert.equal(error.name, "BackendRegistryError");
        assert.equal(error.code, "REPLAY_EXHAUSTED");
        assert.equal(error.retryable, false);
        return true;
      },
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("replay adapter keeps stub env isolated from replay mode", async () => {
  const tempDir = makeTempDir();

  try {
    const stubFilePath = path.join(tempDir, "stub.json");
    fs.writeFileSync(
      stubFilePath,
      JSON.stringify({ claude: ["stub-from-env"] }, null, 2),
      "utf8",
    );

    const adapter = createReplayAdapter({
      provider: "claude",
      cwd: tempDir,
      env: {
        ORCHESTRATE_AGENT_STUB_FILE: stubFilePath,
      },
    });

    const stubResult = await adapter.execute({
      requestId: "stub-env-1",
      provider: "claude",
      mode: "stub",
      input: "ignored",
    });
    assert.equal(stubResult.outputText, "stub-from-env");

    await assert.rejects(
      () =>
        adapter.execute({
          requestId: "replay-env-1",
          provider: "claude",
          mode: "replay",
          input: "ignored",
        }),
      (error) => {
        assert.equal(error.name, "BackendRegistryError");
        assert.equal(error.code, "INVALID_REQUEST");
        assert.match(error.message, /No replay source configured/i);
        return true;
      },
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("replay adapter treats empty entries as an explicit exhausted source", async () => {
  const tempDir = makeTempDir();

  try {
    const stubFilePath = path.join(tempDir, "stub.json");
    fs.writeFileSync(
      stubFilePath,
      JSON.stringify({ claude: ["fallback-env-response"] }, null, 2),
      "utf8",
    );

    const adapter = createReplayAdapter({
      provider: "claude",
      cwd: tempDir,
      env: {
        ORCHESTRATE_AGENT_STUB_FILE: stubFilePath,
      },
    });

    await assert.rejects(
      () =>
        adapter.execute({
          requestId: "replay-empty-1",
          provider: "claude",
          mode: "stub",
          input: "ignored",
          replay: {
            entries: [],
          },
        }),
      (error) => {
        assert.equal(error.name, "BackendRegistryError");
        assert.equal(error.code, "REPLAY_EXHAUSTED");
        return true;
      },
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
