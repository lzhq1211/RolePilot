import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("docs contract: README defines offline checks and links to the authoritative architecture", () => {
  const readme = read("README.md");

  assert.match(readme, /pnpm -r check/);
  assert.match(readme, /pnpm --filter platform-contracts test -- --governance/);
  assert.match(readme, /offline|replay/i);
  assert.doesNotMatch(readme, /preflight[^\n]*固定放行/i);
  assert.match(readme, /Router/);
  assert.match(readme, /maxOptimizationActions|预算/);
  assert.match(readme, /docs\/architecture\.md/);
});

test("docs contract: governance doc keeps workflow contract, docs contract, and template expectations explicit", () => {
  const governance = read("docs/review-governance.md");

  assert.match(governance, /workflow contract/i);
  assert.match(governance, /docs contract/i);
  assert.match(governance, /template contract/i);
  assert.match(
    governance,
    /provider registry|backend fallback|workflow runtime|memory separation|policy gates|resume vertical slice/,
  );
  assert.match(governance, /offline|replay/i);
});

test("docs contract: PR template captures contract drift, offline fixture evidence, and workflow-doc-template follow-up", () => {
  const template = read(".github/PULL_REQUEST_TEMPLATE.md");

  assert.match(template, /Contract changes/i);
  assert.match(template, /Offline fixture or replay evidence/i);
  assert.match(template, /Workflow\/docs\/template contract impact/i);
  assert.match(template, /Local verification/i);
  assert.match(template, /pnpm -r check/);
  assert.match(template, /pnpm --filter platform-contracts test -- --governance/);
});
