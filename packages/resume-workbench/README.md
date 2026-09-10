# resume-workbench

RolePilot 内部简历排版包。源码来自同级 `rolepilot-workbench` 当前工作区版本，并按原依赖顺序拼装为单一 ESM；运行时不依赖该同级目录。

## 模块边界

- `src/template.html` 只包含工作台 body/控件/A4 DOM，由 Web 页面负责 head、样式加载和模块入口。
- `src/js/*.js` 保持原生 JavaScript 和共享作用域；`scripts/build.mjs` 只生成 `dist/index.js`，缺少任一必要源码、样式、模板或示例时立即失败。
- 默认示例只在 `startWorkbench({ loadSample: true })` 时装载。集成页面应显式传入正文或调用 `loadDocument()`。
- `startWorkbench()` 只注册一次监听器；页面热更新使用整页刷新，不提供局部销毁协议。

正文 v3 适配、RolePilot Web 接线和服务端手动保存已实现。`/workbench/` 为同站 MPA：独立态本地导入/保存/打印，集成态通过 runId 读取 original/generated，在同一画布切换并分别手动保存。

冻结 initialContent 与可保存 content 分离，revision 冲突返回 409。正文不自动保存；保存不回写 Agent Final、不自动重诊断或生成 Interview。布局/照片不云同步。PDF 使用浏览器打印；旧 DOCX/服务端 PDF 输出已退役。实现完成不代表本轮已做页面人工验收。
