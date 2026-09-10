# AGENTS.md

## 项目介绍

RolePilot 是一个专注于简历生成、深度诊断与面试物料准备的 **Agent系统**。系统基于确定性合同与策略路由，驱动 LLM 完成高质量求职交付，核心目标是**杜绝无证据脑补、避免盲目重写死循环、保障离线可复现**。

## 不要过度检查哈希。

## 主线

标准处理流水线：

```text
Mine -> JD Analysis -> Preflight -> Write -> Review Loop (Proposal -> Router -> Action -> Re-review) -> Final -> 可选 Interview
```

当前事实见 `docs/architecture.md`；实施记录见 `PROGRESS.md` 顶部。历史方案不覆盖当前源码和最新修复记录。

## 边界

- **业务边界**：仅限求职简历与面试物料链路，不承揽通用任务规划。
- **LLM 权责**：LLM 仅负责结构化诊断与建议（Proposal），调度与执行权完全归属确定性代码（Policy/Router）。
- **工具与图约束**：一阶段不引入开放式 Tool Calling 与动态运行时 Task Graph，执行层仅调用白名单 Helper。
- **预算约束**：Review 优化每轮仅执行 1 个 Action，总轮数受硬性 `maxOptimizationActions`（Budget）限制。

## 禁止

- **禁止无凭虚构**：原稿与有效补充同为来源；缺证据不得强化主张。有有效问题和额度才 `ASK_USER`，否则按事实限定范围写作或删除无据主张。资格信息未知不阻断、不虚构；有据新增经历本身不是风险。
- **禁止越级执行**：严禁执行非白名单 Action；严禁绕过 Router 校验直接调用 Writer/修改代码。
- **禁止死循环**：严禁无限优化；单个 Proposal 被拒不等于整轮 STOP，允许当前诊断上下文一次重选；连续两次执行无改善或预算耗尽必须停止优化。补充恢复不得重置预算。
- **禁止隐式容错**：严禁隐藏自动重试与静默 Fallback，所有降级必须显式策略化、可审计。
- **禁止代码冗余与破坏隔离**：严禁在 Executor 中为单点 Action 重复实现一套 Writer/Reviewer 逻辑；严禁手改 `dist/` 与 `node_modules/`。
- **在用户能看到的界面中加入过多补充性说明**用户并不需要太多说明文字。对于按钮、界面、UI等，不需要添加说明

## 项目架构

### 工作流拓扑

```text
Input (原简历 / 经历文本 / JD)
  ↓
Mine / Timeline Normalize (时间线规范化)
  ↓
JD Analysis (岗位需求解析)
  ↓
Preflight (质量补全与事实限定；STOP_UNSUPPORTED 为兼容词汇)
  ├─ [ASK_USER] ──> 发布有效 questions / 存 Checkpoint 挂起
  └─ [PROCEED] (输出 safeWritingScope)
       ↓
     Write (受限安全域初稿)
       ↓
┌──> Review (多维评审，输出 OptimizationDecision)
│      ↓
│    Action Router (确定性策略校验: 白名单 / 证据链 / 预算 / 防复读)
│      ├─ [PASS / STOP] ───────────────┐
│      ├─ [ASK_USER] ──> 挂起补充材料   │
│      └─ [REWRITE_SECTION / KEYWORD_OPTIMIZE / DROP / REORDER]
│           ↓                          │
│         Action Executor (白名单能力执行)│
│           ↓                          │
└──────── Re-review (复评比对，未改善不晋级)│
                                       ↓
                                Final (Best 或 SOURCE_ONLY)
                                       ↓
                                可选 Interview & Cheatsheet (绑定 Final)
```

- Preflight / Review 共用最多两轮已发布问题，每轮最多两题；live 发布前语义筛选资格、重复缺口和来源已有答案。
- Preflight 补充恢复重跑 Preflight；Review 新证据恢复先重新诊断，保留 Best 和累计预算。回答合同 live 显式重试一次，仍失败可重提；“跳过并继续”不调用回答模型。
- Final 不再调用模型 Polish；SOURCE_ONLY 是冻结原稿应用已接受明确更正后的副本，原稿不变。Web 固定 `includeInterview: false`，核心链路可配置。
- 工作台原稿/新稿分别手动保存；保存不回写 Final、不自动重诊断。DOCX/服务端 PDF 输出已退役，输入解析及历史清理保留。

### 模块职责矩阵

| 模块 | 核心定位与职责 |
|---|---|
| `apps/rolepilot-engine` | 唯一业务层：CLI 入口、工作流装配（`slice-workflow.ts`）、步骤编排（`slice-steps.ts`）、动作执行（`optimization-actions.ts`） |
| `apps/rolepilot-web` / `packages/resume-workbench` | React/Vite 产品界面与同站 `/workbench/` 原生工作台 |
| `apps/rolepilot-web-service` | 薄 API、队列 Worker、交付读取及手动保存；Worker 调用 rolepilot-engine 公开入口，不复制 Agent 决策 |
| `packages/platform-contracts` | Review / Preflight / OptimizationDecision 合同；应用层另负责模型 envelope 与回答解析 |
| `packages/platform-policy` | 确定性规则、Supervisor、Review Action Router 与停止策略；应用层装配 Preflight |
| `packages/platform-runtime` | 运行层：工作流 Task 驱动、生命周期调度、受控停止机制（`blocked` / `needs-user-input`） |
| `packages/platform-state` | 状态层：Checkpoint 持久化、恢复校验与 durable memory；Manifest 由 runtime/app 装配 |
| `packages/platform-adapters` | 适配层：模型与 Provider 接入抽象，管理 `live` / `stub` / `replay` 隔离 |
| `packages/platform-testkit` | 测试层：预置 Fixtures、合同校验脚手架与离线回归套件 |

