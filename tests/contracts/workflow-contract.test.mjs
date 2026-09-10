import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const WORKFLOW_PATH = path.join(ROOT, ".github", "workflows", "pr-checks.yml");

function readWorkflow() {
  return fs.readFileSync(WORKFLOW_PATH, "utf8");
}

test("workflow contract: PR checks workflow keeps stable offline-safe commands for the rebuilt repo", () => {
  const workflow = readWorkflow();

  assert.match(workflow, /^name: PR Checks$/m);
  assert.match(workflow, /^\s{2}pull_request:$/m);
  assert.match(workflow, /^\s{2}workflow_dispatch:$/m);
  assert.match(workflow, /^\s{2}pr-checks:$/m);
  assert.match(workflow, /^\s{4}name: pr-checks$/m);
  assert.match(workflow, /uses: actions\/checkout@v4/);
  assert.match(workflow, /uses: pnpm\/action-setup@v4/);
  assert.match(workflow, /uses: actions\/setup-node@v4/);
  assert.match(workflow, /cache: pnpm/);
  assert.match(workflow, /run: pnpm install --frozen-lockfile/);
  assert.match(workflow, /run: pnpm -r check/);
  assert.match(
    workflow,
    /run: pnpm --filter platform-contracts test -- --governance/,
  );
  assert.match(workflow, /run: pnpm --filter rolepilot-engine test:ci/);

  assert.doesNotMatch(workflow, /claude/i);
  assert.doesNotMatch(workflow, /opencode/i);
  assert.doesNotMatch(workflow, /codex/i);
  assert.doesNotMatch(workflow, /OPENAI|ANTHROPIC|GITHUB_TOKEN|secrets\./);
});
