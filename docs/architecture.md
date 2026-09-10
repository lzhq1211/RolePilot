# Architecture

## 当前架构（2026-09-08）

RolePilot 是同仓求职产品，不是通用 Agent。`apps/rolepilot-engine` 唯一负责 Agent 业务编排，LLM 提供结构化内容、诊断与 Proposal，确定性代码持有调度和执行权。

```text
来源 → Mine / 原稿冻结 → JD Analysis → Preflight → Write v3
                                              ↓
                    Review → Proposal → Router → 单动作 → Re-review
                                              ↓
                          Final → 工作台 / 可选 Interview
```

历史 workflow 标识 `mine-jd-analysis-preflight-write-review-interview` 保留；不表示 Web 必须运行 Interview。

## 包边界

| 位置 | 当前职责 |
|---|---|
| `apps/rolepilot-engine` | CLI、步骤/Prompt、回答解析、应用 checkpoint、白名单动作与最终交付 |
| `apps/rolepilot-web` | React/Vite 产品页面、Run 状态与补充、同站 `/workbench/` MPA |
| `apps/rolepilot-web-service` | 薄 API、队列 Worker、产物发布/读取、双稿手动保存；Worker 调用 rolepilot-engine 公开入口 |
| `packages/resume-workbench` | 内部原生 JS 排版、v3 导入编辑、打印；不复制 Agent |
| `packages/web-contracts` | Web DTO、ResumeContentV3、工作台交付与保存合同 |
| `packages/document-ingest` | 确定性输入解析，独立于 Agent 与存储 |
| `packages/platform-contracts` | Review、Preflight、OptimizationDecision 及策略词汇/校验；模型 envelope 不全在此包 |
| `packages/platform-policy` | 受限规划、fallback、Router 与停止策略 |
| `packages/platform-runtime` | 工作流、workspace、manifest、telemetry |
| `packages/platform-state` | checkpoint / durable memory 分离持久化；应用状态由 rolepilot-engine 定义 |
| `packages/platform-adapters` | Provider registry 与 live / stub / replay 隔离，不自行决定 fallback |
| `packages/platform-testkit` | 离线 fixtures、stub / replay 辅助 |

## 来源、写作与问题

- 原稿与已接受的 `acceptedFacts`、`additionalFacts`、`corrections` 同为有效来源。未解析回答、系统问题、JD 和生成稿不是独立事实。
- 初稿输出完整 ResumeContentV3；修订用稳定节点 ID 的 update / insert / delete / reorder / move operations。有据新增经历、栏目、描述性项目标题或改写幅度本身不构成风险。
- 身份硬校验限个人信息（name / phone / email / location / website / portfolio / github）；经历事实由 Review 判断。未知信息留空，不由岗位要求补造；明确更正优先。
- Preflight live envelope 为 `{schemaVersion: 1, writingBoundary, questionCandidates}`。内部 `PreflightDecision v1` 保留 `PROCEED / ASK_USER / STOP_UNSUPPORTED` 兼容词汇；代码筛选后只有有效问题且有额度才挂起，否则事实限定 PROCEED。
- Preflight 与 Review 共用最多两轮已发布问题，每轮最多两题。live 发布前语义筛选资格、已答及同义重复；stub / replay 不追加隐式模型调用。未发布不计轮，用户主动补充仍可接收。
- 回答解释保留引文和具体限制映射；partial、额外事实和更正只能解除有明确支持的对应限制，`resolvedMissingEvidence` 同步有效缺口，不能清空所有旧限制。

## 恢复、Review 与预算

- Preflight 挂起：解释回答后重跑 Preflight，保留 Mine / JD。
- Review 挂起：保留 Best 和累计评审/动作预算；有新 evidenceVersion 先重新诊断，再由当前绑定选动作。新证据诊断替代旧基线，旧分数不跨版本压回新稿；不重新运行免费初稿。
- 单个 Proposal 被拒不等于整个 Run STOP；当前诊断上下文允许一次重选。每个执行动作必须复评，连续两次执行无改善才停止，预算耗尽不扩调用。
- 新证据诊断消耗原有评审预算；预算不足不保证所有补充都进入最终正文。
- 回答合同 live 一次显式重试后仍失败，保留原挂起图、回答和诊断；Web 回到 NEEDS_USER_INPUT，可重提。提交仅成功恢复后 CONSUMED，失败提交 ABANDONED。“跳过并继续”提交精确跳过，直接关闭当前问题，不调用回答模型。

## Final 与工作台

- 不再调用模型 Final Polish。正常 Final 复制诊断绑定的 Best；必要时在剩余预算内刷新旧证据诊断。
- SOURCE_ONLY 取冻结原稿应用已接受明确更正后的副本，不改变冻结原稿；不冒用候选评分，`finalReviewPath: null`。
- Final JSON 是唯一 final 正文产物；`workbench-delivery.json` 是 supporting 索引，`preflight.decision` 为字符串。Worker 校验并发布完整引用后才 COMPLETED；历史不完整结果走 HISTORICAL 兼容，不放宽新 Run 完整性交付。
- Web 固定 `includeInterview: false`；核心链路可配置 Interview / Cheatsheet，正文绑定 Final。
- 独立工作台无需后端；集成态 original / generated 共用单画布，冻结 `initialContent` 与可手动保存的 `content` 分离，revision 原子冲突返回 409。
- 工作台不自动保存正文，不回写 Final，不自动重诊断或重生成面试材料；布局与照片不云同步。输入 Draft 保存是另一条链路。
- DOCX / 服务端 PDF 输出已退役（410 EXPORT_UNAVAILABLE）；浏览器打印保留，历史 exports 数据/清理/迁移和 PDF / DOCX 输入解析保留。

## Provider、验证与部署边界

Provider 身份 `claude / opencode / codex` 与执行模式 `live / stub / replay` 分离。fallback 由策略显式授权，只允许合规的可重试 live 失败；不允许静默切换。v3 live Writer YAML 语法、Review JSON 语法各有一次显式重试，回答合同同样一次；不能泛化为任意步骤自动重试。

根目录 `pnpm build` / `pnpm run prepare` 生成跨包产物。`pnpm check` / `pnpm test` 是统一入口，PR 必需门禁见 [review-governance.md](review-governance.md)。离线验证不代表 Provider、数据库迁移、当前服务版本或页面人工验收。

部署顺序和 MPA 路由见 [README](../README.md)。历史 FAILED Run 不因源码更新自动恢复；本地 checkpoint 跨根目录迁移不作承诺。最新实施与待验收事项记录在本地开发资料中，不作为公开运行依赖。
