import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { adaptResumeContent, parseResumeContentV3, RESUME_PROFILE_FIELDS } from "web-contracts/resume-document";

const root = new URL("../", import.meta.url);
const sources = [
  "src/js/utils.js",
  "src/js/state.js",
  "src/js/parser.js",
  "src/js/content.js",
  "src/js/json-importer.js",
  "src/js/validator.js",
  "src/js/exporter.js",
];

const context = vm.createContext({
  console,
  crypto: globalThis.crypto,
  structuredClone,
  Date,
  Math,
  setTimeout,
  clearTimeout,
  adaptResumeContent,
  parseResumeContentV3,
  RESUME_PROFILE_FIELDS,
});
context.window = context;
context.document = {
  getElementById: () => null,
  querySelector: () => null,
  createElement: () => ({ appendChild() {}, remove() {} }),
  body: { appendChild() {} },
};

for (const source of sources) {
  vm.runInContext(readFileSync(new URL(source, root), "utf8"), context, { filename: source });
}

function evaluate(markdown, name = "测试简历.md") {
  context.__markdown = markdown;
  context.__fileName = name;
  return vm.runInContext(
    "validateAndBuildState(parseMarkdown(__markdown), __fileName)",
    context,
  );
}

test("匿名 Markdown fixture 可以解析并生成 Resume State", () => {
  const markdown = readFileSync(new URL("fixtures/valid/sample-resume.md", root), "utf8");
  const result = evaluate(markdown, "sample-resume.md");

  assert.ok(result.state);
  assert.equal(result.state.schemaVersion, 3);
  assert.equal(result.state.source.fileName, "sample-resume.md");
  assert.ok(result.state.sections.some((section) => section.type === "experience"));
  assert.equal(result.errors.filter((item) => item.level === "error").length, 0);
});

test("缺少必填字段时拒绝导入并返回具体错误", () => {
  const markdown = readFileSync(
    new URL("fixtures/invalid/missing-required-field.md", root),
    "utf8",
  );
  const result = evaluate(markdown, "missing-required-field.md");
  const codes = result.errors.map((item) => item.code);

  assert.equal(result.state, null);
  assert.ok(codes.includes("MISSING_REQUIRED_FIELD"));
  assert.ok(codes.includes("MISSING_DATE"));
});

test("链接与强调格式保留为结构化 token", () => {
  const markdown = `---
schema_version: 1
resume_name: 格式测试
name: 示例用户
phone: 1xx-xxxx-xxxx
email: example@example.com
---

## 项目经历

### 示例项目
role: 产品负责人
date: 2025.01-2025.03

- 查看[作品页面](https://example.com)，并完成**核心流程**
`;
  const result = evaluate(markdown);
  const tokens = result.state.sections[0].entries[0].bullets[0].content;

  assert.ok(tokens.some((token) => token.href === "https://example.com"));
  assert.ok(tokens.some((token) => token.type === "strong" && token.value === "核心流程"));
});

test("自定义栏目标题会保留在 Resume State 中", () => {
  const markdown = `---
schema_version: 1
resume_name: 标题测试
name: 示例用户
phone: 1xx-xxxx-xxxx
email: example@example.com
---

## 实习经历
title: 工作经历

### 示例公司
role: 产品实习生
date: 2025.01-2025.03

- 负责需求梳理
`;
  const result = evaluate(markdown);
  assert.ok(result.state);
  assert.equal(result.state.sections[0].title, "工作经历");
});

test("任意二级标题可以导入为包含混合内容的自定义板块", () => {
  const markdown = `---
schema_version: 2
resume_name: 自定义板块测试
name: 示例用户
phone: 1xx-xxxx-xxxx
email: example@example.com
---

## 我想展示的内容

这是一段**自由正文**。

- 第一条
- 第二条

### 示例条目
role: 自定义角色
date: 2025.01-2025.06

- 条目描述
`;
  const result = evaluate(markdown);
  const section = result.state.sections[0];

  assert.ok(result.state);
  assert.equal(section.type, "custom");
  assert.equal(section.title, "我想展示的内容");
  assert.deepEqual(Array.from(section.blocks, (block) => block.type), ["text", "list", "entry"]);
  assert.equal(section.blocks[1].bullets.length, 2);
  assert.equal(section.blocks[2].name, "示例条目");
});

test("自定义板块可以通过 Markdown 导出再导入", () => {
  const initial = evaluate(`---
schema_version: 2
resume_name: 往返测试
name: 示例用户
phone: 1xx-xxxx-xxxx
email: example@example.com
---

## 获奖与其他

可编辑正文

- 内容一
`);
  context.__state = initial.state;
  const exported = vm.runInContext("serializeStateToMarkdown(__state)", context);
  const roundTrip = evaluate(exported, "round-trip.md");

  assert.match(exported, /schema_version: 2/);
  assert.match(exported, /## custom\n\ntitle: 获奖与其他/);
  assert.ok(roundTrip.state);
  assert.equal(roundTrip.state.sections[0].blocks[0].content[0].value, "可编辑正文");
  assert.notEqual(roundTrip.state.documentId, initial.state.documentId);
});

test("预置板块与自定义板块可以一起导出再导入", () => {
  const markdown = readFileSync(new URL("fixtures/valid/sample-resume.md", root), "utf8");
  const initial = evaluate(markdown, "sample-resume.md");
  initial.state.sections.push({
    id: "custom-test",
    type: "custom",
    title: "其他经历",
    entries: [],
    blocks: [{ id: "text-test", type: "text", content: [{ type: "text", value: "自定义内容" }] }],
  });
  context.__state = initial.state;
  const exported = vm.runInContext("serializeStateToMarkdown(__state)", context);
  const roundTrip = evaluate(exported, "complete-round-trip.md");

  assert.ok(roundTrip.state);
  assert.deepEqual(Array.from(roundTrip.state.sections, (section) => section.type), [
    "education", "experience", "projects", "skills", "custom",
  ]);
});

test("自定义板块与预置标题同名时仍保留自定义结构", () => {
  const initial = evaluate(`---
schema_version: 2
resume_name: 同名测试
name: 示例用户
phone: 1xx-xxxx-xxxx
email: example@example.com
---

## custom
title: 教育背景

这是自定义内容
`);
  context.__state = initial.state;
  const exported = vm.runInContext("serializeStateToMarkdown(__state)", context);
  const roundTrip = evaluate(exported, "same-title.md");

  assert.equal(roundTrip.state.sections[0].type, "custom");
  assert.equal(roundTrip.state.sections[0].title, "教育背景");
  assert.equal(roundTrip.state.sections[0].blocks[0].type, "text");
});

test("JSON v1/v2 适配 v3 并保留全部自定义内容和稳定身份", () => {
  const legacy = {
    schemaVersion: 2,
    resumeName: "JSON 测试",
    profile: { name: "示例用户", headline: "产品经理", phone: "1xx-xxxx-xxxx", email: "example@example.com", extraContacts: [{ label: "微信", value: "example" }] },
    sections: [{
      type: "custom",
      title: "自定义标题",
      blocks: [
        { type: "text", content: "一段**文字**\n第二行 *斜体* [链接](https://example.com)" },
        { type: "list", items: ["列表内容"] },
        { type: "entry", name: "同名经历", role: "", date: "", location: "", bullets: ["描述"] },
        { type: "entry", name: "同名经历", bullets: ["另一段描述"] },
      ],
    }],
  };
  context.__json = JSON.stringify(legacy);
  const result = vm.runInContext("importJsonResume(__json, 'custom.json')", context);

  assert.ok(result.state);
  assert.equal(result.state.sections[0].title, "自定义标题");
  assert.equal(result.state.sections[0].blocks[1].bullets[0].content[0].value, "列表内容");
  context.__state = result.state;
  const exported = vm.runInContext("serializeStateToJson(__state)", context);
  const content = JSON.parse(exported);
  assert.equal(content.schemaVersion, 3);
  assert.equal(content.sections[0].blocks[0].content, legacy.sections[0].blocks[0].content);
  assert.notEqual(content.sections[0].blocks[2].id, content.sections[0].blocks[3].id);
  assert.deepEqual(content.profile.extraContacts, legacy.profile.extraContacts);
  context.__json = exported;
  const roundTrip = vm.runInContext("importJsonResume(__json, 'v3.json')", context);
  context.__state = roundTrip.state;
  assert.deepEqual(JSON.parse(vm.runInContext("serializeStateToJson(__state)", context)), content);
  const stable = adaptResumeContent(legacy, { legacyDocumentId: "history-record" });
  assert.deepEqual(adaptResumeContent(legacy, { legacyDocumentId: "history-record" }), stable);
  assert.equal(adaptResumeContent({ ...legacy, schemaVersion: 1 }).schemaVersion, 3);
  const invalid = structuredClone(content);
  invalid.sections[0].blocks[1].id = invalid.sections[0].id;
  assert.throws(() => parseResumeContentV3(invalid), /重复/);
  assert.throws(() => parseResumeContentV3({ ...content, layout: {} }), /无法解释/);
  assert.throws(() => adaptResumeContent({ ...legacy, sections: [{ type: "custom", title: "其他", blocks: [{ type: "unknown" }] }] }), /text、list 或 entry/);
  const unknown = adaptResumeContent({ ...legacy, sections: [{ type: "论文", entries: [{ name: "论文原名", bullets: ["内容"] }] }] });
  assert.equal(unknown.sections[0].type, "custom");
  assert.equal(unknown.sections[0].blocks[0].name, "论文原名");
  const missing = structuredClone(content);
  missing.profile.phone = "";
  assert.ok(parseResumeContentV3(missing));
  context.__json = JSON.stringify(missing);
  assert.equal(vm.runInContext("importJsonResume(__json, 'missing.json').state", context), null);
  context.__state = result.state;
  result.state.sections[0].blocks[0].content.push({ type: "text", value: " *字面星号* [文字]", fontSizeDelta: 3 });
  result.state.layout.fontSize = 18;
  const clean = JSON.parse(vm.runInContext("serializeStateToJson(__state)", context));
  assert.equal("layout" in clean, false);
  assert.equal("photo" in clean, false);
  assert.equal("metadata" in clean, false);
  assert.equal(JSON.stringify(clean).includes("fontSizeDelta"), false);
  context.__json = JSON.stringify(clean);
  const literal = vm.runInContext("importJsonResume(__json, 'literal.json')", context);
  assert.ok(literal.state.sections[0].blocks[0].content.some((t) => t.value.includes("*字面星号*")));
  const md = vm.runInContext("serializeStateToMarkdown(__state)", context);
  assert.deepEqual(Array.from(evaluate(md).state.profile.extraContacts, (c) => ({ ...c })), legacy.profile.extraContacts);
});

test("实习经历可以按拖动后的 ID 顺序整体重排", () => {
  const markdown = readFileSync(new URL("fixtures/valid/sample-resume.md", root), "utf8");
  const result = evaluate(markdown, "sample-resume.md");
  const section = result.state.sections.find((item) => item.type === "experience");
  const initialIds = section.entries.map((entry) => entry.id);
  const initialNames = section.entries.map((entry) => entry.name);

  context.__section = section;
  context.__order = [initialIds[1], initialIds[0], initialIds[2]];
  const changed = vm.runInContext("applyEntryOrder(__section, __order)", context);

  assert.equal(changed, true);
  assert.deepEqual(Array.from(section.entries, (entry) => entry.name), [
    initialNames[1], initialNames[0], initialNames[2],
  ]);
  context.__state = result.state;
  context.__json = vm.runInContext("serializeStateToJson(__state)", context);
  const reloaded = vm.runInContext("importJsonResume(__json, 'reordered.json').state", context);
  assert.equal(reloaded.documentId, result.state.documentId);
  assert.deepEqual(Array.from(reloaded.sections.find((s) => s.type === "experience").entries, (e) => e.id), Array.from(context.__order));
});

test("所有简历大板块可以按拖动后的 ID 全局重排", () => {
  const markdown = readFileSync(new URL("fixtures/valid/sample-resume.md", root), "utf8");
  const result = evaluate(markdown, "sample-resume.md");
  const initialIds = result.state.sections.map((section) => section.id);
  const initialTitles = result.state.sections.map((section) => section.title);

  context.__state = result.state;
  context.__sectionOrder = [initialIds[0], initialIds[2], initialIds[1], initialIds[3]];
  const changed = vm.runInContext("applySectionOrder(__state, __sectionOrder)", context);

  assert.equal(changed, true);
  assert.deepEqual(Array.from(result.state.sections, (section) => section.title), [
    initialTitles[0], initialTitles[2], initialTitles[1], initialTitles[3],
  ]);

  context.__state = result.state;
  const exportedMarkdown = vm.runInContext("serializeStateToMarkdown(__state)", context);
  const exportedJson = vm.runInContext("serializeStateToJson(__state)", context);
  assert.ok(exportedMarkdown.indexOf("## 项目经历") < exportedMarkdown.indexOf("## 实习经历"));
  assert.ok(exportedJson.indexOf('"type": "projects"') < exportedJson.indexOf('"type": "experience"'));
  const initialContent = JSON.parse(exportedJson);
  context.__json = exportedJson;
  const reloaded = vm.runInContext("importJsonResume(__json, 'full.json').state", context);
  context.__state = reloaded;
  assert.deepEqual(JSON.parse(vm.runInContext("serializeStateToJson(__state)", context)), initialContent);
});

test("载入旧状态时会清除造成板块重叠的负间距", () => {
  const state = { sections: [
    { id: "negative", spacingBefore: -100 },
    { id: "positive", spacingBefore: 3 },
  ] };
  context.__legacyState = state;
  vm.runInContext("setState(__legacyState)", context);

  assert.equal(state.sections[0].spacingBefore, 0);
  assert.equal(state.sections[1].spacingBefore, 3);
});
