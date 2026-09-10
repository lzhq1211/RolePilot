/** The host boundary contains only v3 content. Editor layout stays local. */
function stateToResumeContent(state) {
  const bullet = (b) => ({ id: b.id, content: serializeInlineMarkdown(b.content) });
  const entry = (e) => ({
    id: e.id, name: e.name || "", role: e.role || "", date: e.date || "",
    location: e.location || "", bullets: (e.bullets || []).map(bullet),
  });
  const profile = Object.fromEntries(RESUME_PROFILE_FIELDS.map((field) => [field, state.profile[field] || ""]));
  if (state.profile.extraContacts !== undefined) {
    profile.extraContacts = state.profile.extraContacts.map(({ label, value }) => ({ label, value }));
  }
  return parseResumeContentV3({
    schemaVersion: 3, documentId: state.documentId, resumeName: state.resumeName || "", profile,
    sections: state.sections.map((s) => ({
      id: s.id, type: s.type, title: s.title || "",
      ...(s.type === "custom" ? { blocks: s.blocks.map((b) => {
        if (b.type === "text") return { id: b.id, type: "text", content: serializeInlineMarkdown(b.content) };
        if (b.type === "list") return { id: b.id, type: "list", items: b.bullets.map(bullet) };
        if (b.type === "entry") return { type: "entry", ...entry(b) };
        throw new TypeError(`未知内容块类型：${b.type}`);
      }) } : { entries: s.entries.map(entry) }),
    })),
  });
}

function resumeContentToState(content, fileName = "") {
  const data = parseResumeContentV3(content);
  const state = createDefaultState();
  const bullet = (b) => ({ id: b.id, content: parseBoldTokens(b.content, 0, []) });
  const entry = (e) => ({ ...e, bullets: e.bullets.map(bullet) });
  state.schemaVersion = 3;
  state.documentId = data.documentId;
  state.resumeName = data.resumeName;
  state.profile = data.profile;
  state.sections = data.sections.map((s) => s.type === "custom" ? {
    ...s, entries: [], blocks: s.blocks.map((b) => {
      if (b.type === "text") return { ...b, content: parseBoldTokens(b.content, 0, []) };
      if (b.type === "list") return { id: b.id, type: "list", bullets: b.items.map(bullet) };
      return entry(b);
    }),
  } : { ...s, blocks: [], entries: s.entries.map(entry) });
  // Run 交付没有本地 File 对象，用文档名称作为当前稿件标识，避免显示为“未导入文件”。
  state.source.fileName = fileName || data.resumeName;
  state.source.importedAt = new Date().toISOString();
  touchState(state);
  state.importSnapshot = createImportSnapshot(state);
  return state;
}

/** Feed the existing JSON business-required checks without changing their rules. */
function contentForImportValidation(content) {
  const entry = (e) => ({ ...e, bullets: e.bullets.map((b) => b.content) });
  return {
    ...content, schemaVersion: 2,
    sections: content.sections.map((s) => s.type !== "custom"
      ? { ...s, entries: s.entries.map(entry) }
      : { ...s, blocks: s.blocks.map((b) => b.type === "list"
        ? { ...b, items: b.items.map((item) => item.content) }
        : b.type === "entry" ? entry(b) : b) }),
  };
}

function validatedDocumentState(content) {
  // Run 交付和手动保存使用严格的 v3 合同；其中 headline/date 允许为空，
  // 不能再经过面向旧版导入文件的资格校验。
  if (content && typeof content === "object" && content.schemaVersion === 3) {
    return resumeContentToState(content);
  }
  const result = importJsonResume(JSON.stringify(content), "");
  if (!result.state) throw new TypeError(result.errors.filter((e) => e.level === "error").map((e) => e.message).join("\n"));
  return result.state;
}
