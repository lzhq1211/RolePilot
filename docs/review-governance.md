# Review Governance

This repo treats the following as explicit contracts:

- **workflow contract**: `.github/workflows/pr-checks.yml` must stay offline-safe, keep the workflow name `PR Checks`, keep the required job name `pr-checks`, and run only commands that do not need live providers
- **docs contract**: `README.md` must keep local review gates, replay/offline guidance, package boundaries, and routing or fallback expectations visible
- **template contract**: `.github/PULL_REQUEST_TEMPLATE.md` must ask for contract drift, offline fixture or replay evidence, workflow or docs or template impact, and the exact local verification commands used

The offline evaluation harness must keep coverage for provider registry, backend fallback, workflow runtime, memory separation, policy gates, and the resume vertical slice.

All governance checks are replay/offline only.

## 当前业务合同（2026-09-08）

- 当前统一口径见 [architecture.md](architecture.md)。Preflight 模型 envelope、回答解释、Review 绑定与 Web ResumeContentV3 各有边界，不得统称所有合同都是 v1。
- Preflight / Review 共用最多两轮已发布问题，每轮最多两题；发布前过滤资格、已答和重复缺口。无有效问题或额度用尽时按事实限定写作，不因岗位资格未知拒绝。
- 只有原稿和有效 acceptedFacts / additionalFacts / corrections 作为来源；具体限制通过有据的 resolvedRestrictions / resolvedMissingEvidence 解除，不因有补充就全量清空限制。有据新增经历、描述性标题或改写幅度本身不是事实风险。
- Review 新证据恢复先重新诊断，再从当前 evidenceVersion 绑定选动作，保留累计预算；新证据基线不与旧证据评分直接竞高。单 Proposal 拒绝允许一次重选；连续两次执行无改善停止。
- 不再存在 Final Polish 调用。正常 Final 复制 Best；SOURCE_ONLY 使用冻结原稿应用已接受明确更正后的副本，保留原稿、不给原稿冒配候选诊断。Web 不生成 Interview，核心链路可选。
- v3 live Writer YAML 语法失败、Review JSON 语法失败各有一次显式重试；回答合同 live 失败同样一次显式重试，仍失败回挂起供重提。这不是通用自动重试许可；审计必须保留。
- 工作台交付与双稿手动保存已实现；保存不修改 Final、不自动重诊断。DOCX/服务端 PDF 输出退役，历史清理和输入解析保留。离线通过不等于 Provider、数据库或用户页面验收。

## Required local commands

Run these before opening or approving a PR:

```bash
pnpm -r check
pnpm --filter platform-contracts test -- --governance
pnpm --filter rolepilot-engine test:ci
```

Use `pnpm -r test` when you need the full workspace suite, but the required governance gate should stay aligned with the commands above.

The governance command runs an explicit offline-safe suite for:

- docs contract
- workflow contract
- offline evaluation harness

## What must be called out in a PR

Any PR that changes review behavior, fixtures, docs, or CI expectations should make these points explicit:

1. **Contract changes**
   - validator, prompt, or vocabulary updates
   - Review, Preflight, or OptimizationDecision schema changes
   - review-loop, Router, fallback, or policy behavior drift
2. **Offline fixture or replay evidence**
   - added, renamed, or removed fixture files
   - replay inputs used for verification
   - why deterministic coverage still exists
3. **Test evidence**
   - exact local commands run
   - relevant pass output or a clear baseline issue explanation
4. **Workflow, docs, and template impact**
   - whether `manual`, `local-ci`, or `github-actions` behavior changed
   - whether package boundaries, routing rules, or fallback policy docs changed
   - whether workflow names, required checks, or PR instructions need admin follow-up

## Reviewer checklist

Reviewers should confirm all of the following before approval:

- `pnpm -r check` ran successfully
- `pnpm --filter platform-contracts test -- --governance` ran successfully for governance changes
- `pnpm --filter rolepilot-engine test:ci` ran successfully when app wiring, runtime behavior, or workflow semantics changed
- contract changes are reflected consistently across code, fixtures, tests, and docs
- every OptimizationDecision is routed before execution and every candidate is re-reviewed
- replay and fixture updates keep offline verification deterministic
- no required CI job depends on provider credentials or live provider quality
- branch protection follow-up is documented if workflow names or required checks changed

## Branch protection guardrail

GitHub branch protection is a manual repository administration follow-up unless it is automated elsewhere.

That means docs and PR templates can describe expected checks, but they do not configure GitHub settings on their own. If `PR Checks` or `pr-checks` ever changes, update the docs and tell the repo admin what to change in GitHub.
