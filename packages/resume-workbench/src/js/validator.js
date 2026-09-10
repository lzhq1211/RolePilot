/**
 * Validator module.
 * Validates supported Markdown schemas and builds a Resume State.
 */

/** @type {string[]} */
const REQUIRED_FRONTMATTER_FIELDS = [
  "schema_version",
  "resume_name",
  "phone",
  "email",
];

/** @type {string[]} */
const OPTIONAL_FRONTMATTER_FIELDS = [
  "headline",
  "location",
  "website",
  "portfolio",
  "github",
  "photo",
  "extra_contacts",
];

/**
 * @typedef {object} ValidationResult
 * @property {object[]} errors - Validation errors/warnings/infos
 * @property {object|null} state - Generated Resume State, null if fatal errors
 */

/**
 * Validate a parsed Markdown result and produce a Resume State.
 * @param {object} parseResult - Output from parseMarkdown()
 * @param {string} fileName - Original Markdown file name
 * @returns {ValidationResult}
 */
function validateAndBuildState(parseResult, fileName) {
  const errors = [...(parseResult.errors || [])];
  const frontmatter = parseResult.frontmatter || {};
  const sections = parseResult.sections || [];
  if (frontmatter.extra_contacts !== undefined) {
    try {
      const contacts = JSON.parse(frontmatter.extra_contacts);
      if (!Array.isArray(contacts) || contacts.some((c) => !c || typeof c.label !== "string" || typeof c.value !== "string" || Object.keys(c).some((k) => !["label", "value"].includes(k)))) {
        throw new TypeError("extra_contacts 必须为 label/value 字符串对象数组。");
      }
      frontmatter._extraContacts = contacts;
    } catch (error) {
      errors.push({ level: "error", code: "INVALID_EXTRA_CONTACTS", message: error.message });
    }
  }

  // 1. Validate schema_version
  const schemaVersion = parseInt(frontmatter.schema_version, 10);
  if (!frontmatter.schema_version || frontmatter.schema_version === "") {
    errors.push({
      level: "error",
      code: "MISSING_SCHEMA_VERSION",
      message: "缺少 schema_version 字段。",
      line: frontmatter._startLine + 1,
      suggestion: "请在 Frontmatter 中添加 schema_version: 1。",
    });
  } else if (![1, 2].includes(schemaVersion)) {
    errors.push({
      level: "error",
      code: "UNSUPPORTED_SCHEMA_VERSION",
      message: `不支持的 schema_version：${frontmatter.schema_version}，当前支持版本 1 和 2。`,
      line: frontmatter._startLine + 1,
      suggestion: "请将 schema_version 修改为 2。",
    });
  }

  // 2. Validate required frontmatter fields
  for (const field of REQUIRED_FRONTMATTER_FIELDS) {
    if (!frontmatter[field] || frontmatter[field] === "") {
      errors.push({
        level: "error",
        code: "MISSING_REQUIRED_FIELD",
        field,
        message: `缺少必填字段：${field}。`,
        line: frontmatter._startLine + 1,
        suggestion: `请在 Frontmatter 中添加 ${field}。`,
      });
    }
  }

  // 3. Validate sections
  let sectionTypesSeen = new Set();
  for (const section of sections) {
    if (section.type !== "custom" && sectionTypesSeen.has(section.type)) {
      errors.push({
        level: "warning",
        code: "DUPLICATE_SECTION",
        section: section.type,
        message: `栏目 "${section.type}" 重复。`,
        line: section.line,
        suggestion: "第一个之外的重复栏目将被保留但可能导致排版问题。",
      });
    }
    if (section.type !== "custom") sectionTypesSeen.add(section.type);

    if (section.type === "custom") {
      if (!section.title) {
        errors.push({
          level: "error",
          code: "MISSING_SECTION_TITLE",
          message: "自定义栏目缺少标题。",
          line: section.line,
          suggestion: "请使用 ## 栏目名称。",
        });
      }
      continue;
    }

    for (const entry of (section.entries || [])) {
      // Validate entry fields
      if (section.type !== "skills" && !entry.name) {
        errors.push({
          level: "error",
          code: "MISSING_ENTRY_NAME",
          section: section.type,
          message: `${section.type} 栏目下存在未命名的条目。`,
          line: entry.line,
          suggestion: "请为条目添加名称（### 名称）。",
        });
      }

      if (["education", "experience"].includes(section.type)) {
        if (false && !entry.role) {
          errors.push({
            level: "error",
            code: "MISSING_ROLE",
            section: section.type,
            entry: entry.name,
            message: `${section.type} 栏目下"${entry.name}"缺少 role 字段。`,
            line: entry.line,
            suggestion: `请在该条目中增加 role: 信息。`,
          });
        }
        if (!entry.date) {
          errors.push({
            level: "error",
            code: "MISSING_DATE",
            section: section.type,
            entry: entry.name,
            message: `${section.type} 栏目下"${entry.name}"缺少 date 字段。`,
            line: entry.line,
            suggestion: `请在该条目中增加 date: 时间范围。`,
          });
        }
      }

      if (section.type === "projects") {
        if (false && !entry.role) {
          errors.push({
            level: "warning",
            code: "MISSING_PROJECT_ROLE",
            section: "projects",
            entry: entry.name,
            message: `projects 栏目下"${entry.name}"缺少 role 字段。`,
            line: entry.line,
            suggestion: "建议添加 role 指明项目角色。",
          });
        }
        if (!entry.date) {
          errors.push({
            level: "warning",
            code: "MISSING_PROJECT_DATE",
            section: "projects",
            entry: entry.name,
            message: `projects 栏目下"${entry.name}"缺少 date 字段。`,
            line: entry.line,
            suggestion: "建议添加 date 指明项目时间。",
          });
        }
      }

      if (["experience", "projects"].includes(section.type) && entry.bullets.length === 0) {
        errors.push({
          level: "warning",
          code: "NO_BULLETS",
          section: section.type,
          entry: entry.name,
          message: `${section.type} 栏目下"${entry.name}"没有 Bullet。`,
          line: entry.line,
          suggestion: "建议添加至少一条经历描述。",
        });
      }
    }
  }

  // Check for error-level issues
  const hasErrors = errors.some((e) => e.level === "error");

  // Build state (even with errors — the caller decides whether to use it)
  const state = buildState(frontmatter, sections, fileName);

  // Generate info summary
  const summaryItems = [];
  const eduCount = sections.find((s) => s.type === "education")?.entries?.length || 0;
  const expCount = sections.find((s) => s.type === "experience")?.entries?.length || 0;
  const projCount = sections.find((s) => s.type === "projects")?.entries?.length || 0;
  const skillCount = sections.find((s) => s.type === "skills")?.entries?.[0]?.bullets?.length || 0;
  const customCount = sections.filter((s) => s.type === "custom").length;

  if (eduCount > 0) summaryItems.push(`${eduCount} 条教育经历`);
  if (expCount > 0) summaryItems.push(`${expCount} 条工作经历`);
  if (projCount > 0) summaryItems.push(`${projCount} 个项目`);
  if (skillCount > 0) summaryItems.push(`${skillCount} 条技能`);
  if (customCount > 0) summaryItems.push(`${customCount} 个自定义栏目`);

  const errorCount = errors.filter((e) => e.level === "error").length;
  const warningCount = errors.filter((e) => e.level === "warning").length;

  errors.push({
    level: "info",
    code: "IMPORT_SUMMARY",
    message: `已导入：${fileName}。识别到：${summaryItems.join("、") || "无内容"}。存在：${errorCount} 个错误、${warningCount} 个警告。`,
  });

  return { errors, state: hasErrors ? null : state };
}

/**
 * Build a Resume State from parsed frontmatter and sections.
 * @param {object} frontmatter
 * @param {object[]} sections
 * @param {string} fileName
 * @returns {object}
 */
function buildState(frontmatter, sections, fileName) {
  const now = new Date().toISOString();
  const state = createDefaultState();

  state.documentId = generateId();
  state.resumeName = frontmatter.resume_name || "";
  state.source.fileName = fileName;
  state.source.importedAt = now;

  state.profile.name = frontmatter.name || "";
  state.profile.headline = frontmatter.headline || "";
  state.profile.location = frontmatter.location || "";
  state.profile.phone = frontmatter.phone || "";
  state.profile.email = frontmatter.email || "";
  state.profile.website = frontmatter.website || "";
  state.profile.portfolio = frontmatter.portfolio || "";
  state.profile.github = frontmatter.github || "";
  if (frontmatter._extraContacts) state.profile.extraContacts = frontmatter._extraContacts;
  state.photo.source = frontmatter.photo || "";

  state.schemaVersion = Number.parseInt(frontmatter.schema_version, 10) || 1;
  state.sections = sections.map((section) => ({
    id: generateId(),
    type: section.type,
    title: section.title || getSectionTitle(section.type),
    blocks: (section.blocks || []).map((block) => buildCustomBlock(block)),
    entries: (section.entries || []).map((entry) => ({
      id: generateId(),
      name: entry.name || "",
      role: entry.role || "",
      date: entry.date || "",
      location: entry.location || "",
      bullets: (entry.bullets || []).map((b) => ({
        id: generateId(),
        content: b.content || [{ type: "text", value: b.raw || "" }],
      })),
    })),
  }));

  touchState(state);
  state.importSnapshot = createImportSnapshot(state);

  const normalized = resumeContentToState(stateToResumeContent(state), fileName);
  normalized.photo.source = state.photo.source;
  return normalized;
}

function buildCustomBlock(block) {
  if (block.type === "text") {
    return {
      id: generateId(),
      type: "text",
      content: block.content || [{ type: "text", value: "" }],
    };
  }
  if (block.type === "list") {
    return {
      id: generateId(),
      type: "list",
      bullets: (block.bullets || []).map((bullet) => ({
        id: generateId(),
        content: bullet.content || [{ type: "text", value: bullet.raw || "" }],
      })),
    };
  }
  return {
    id: generateId(),
    type: "entry",
    name: block.name || "",
    role: block.role || "",
    date: block.date || "",
    location: block.location || "",
    bullets: (block.bullets || []).map((bullet) => ({
      id: generateId(),
      content: bullet.content || [{ type: "text", value: bullet.raw || "" }],
    })),
  };
}
