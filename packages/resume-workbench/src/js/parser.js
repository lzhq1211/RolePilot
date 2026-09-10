/**
 * Markdown Parser module.
 * Parses Schema v1 Markdown into intermediate parse result.
 * Does NOT do validation — that's validator's job.
 */

/** @type {string[]} */
const SUPPORTED_SECTIONS = ["education", "experience", "projects", "skills"];

/** @type {Record<string, string>} */
const SECTION_ALIASES = {
  "教育经历": "education",
  "教育背景": "education",
  "实习经历": "experience",
  "工作经历": "experience",
  "项目经历": "projects",
  "技能": "skills",
  "技能特长": "skills",
};

/**
 * @typedef {object} ParseResult
 * @property {object} frontmatter - Parsed YAML frontmatter key-value pairs
 * @property {object[]} sections - Parsed sections
  - line numbers reserved for error reporting
 */

/**
 * Parse a raw Markdown string into a structured result.
 * @param {string} raw
 * @returns {ParseResult}
 */
function parseMarkdown(raw) {
  const lines = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

  let lineIndex = 0;
  const errors = [];

  // Parse frontmatter
  const frontmatter = parseFrontmatter(lines, lineIndex, errors);
  // Advance past frontmatter
  lineIndex = frontmatter._endLine + 1;

  // Parse body sections
  const sections = parseSections(lines, lineIndex, errors);

  return {
    frontmatter,
    sections,
    errors,
  };
}

/**
 * Parse YAML frontmatter delimited by --- lines.
 * Only supports single-line key: value pairs.
 * Handles URLs by splitting only on first colon.
 * @param {string[]} lines
 * @param {number} startLine
 * @param {object[]} errors
 * @returns {object}
 */
function parseFrontmatter(lines, startLine, errors) {
  const result = { _startLine: startLine, _endLine: startLine };
  let i = startLine;

  // First line must be ---
  if (lines[i]?.trim() !== "---") {
    errors.push({
      level: "error",
      code: "MISSING_FRONTMATTER",
      message: "文件缺少 Frontmatter（以 --- 开头）。",
      line: i + 1,
    });
    result._endLine = i;
    return result;
  }
  i++;

  // Parse key: value pairs until closing ---
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "---") {
      result._endLine = i;
      return result;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) {
      errors.push({
        level: "warning",
        code: "INVALID_FRONTMATTER_LINE",
        message: `Frontmatter 第 ${i + 1} 行无法解析：${line}`,
        line: i + 1,
        suggestion: "Frontmatter 只支持 `key: value` 格式。",
      });
      i++;
      continue;
    }

    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();

    if (key in result) {
      errors.push({
        level: "error",
        code: "DUPLICATE_FIELD",
        field: key,
        message: `Frontmatter 字段 "${key}" 重复。`,
        line: i + 1,
        suggestion: "请删除重复字段。",
      });
    } else {
      result[key] = value;
    }

    i++;
  }

  // Reached end without closing ---
  errors.push({
    level: "error",
    code: "UNCLOSED_FRONTMATTER",
    message: "Frontmatter 缺少结束标记 ---。",
    line: lines.length,
    suggestion: "请在 Frontmatter 末尾添加 ---。",
  });
  result._endLine = Math.min(i, lines.length - 1);
  return result;
}

/**
 * Parse body sections from Markdown lines.
 * @param {string[]} lines
 * @param {number} startLine
 * @param {object[]} errors
 * @returns {object[]}
 */
function parseSections(lines, startLine, errors) {
  const sections = [];
  let currentSection = null;
  let currentEntry = null;
  let currentBullets = null;
  let currentListBlock = null;

  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Indented continuation belongs to the preceding bullet, including blank lines.
    if (/^ {2}/.test(line) && currentBullets?.length) {
      const bullet = currentBullets[currentBullets.length - 1];
      bullet.raw += `\n${line.slice(2)}`;
      bullet.content = parseBoldTokens(bullet.raw, i, errors);
      continue;
    }

    // Empty line
    if (trimmed === "") continue;

    // ## section
    if (trimmed.startsWith("## ") || trimmed === "##") {
      const rawName = trimmed.slice(2).trim();
      const alias = SECTION_ALIASES[rawName] || rawName;
      const name = SUPPORTED_SECTIONS.includes(alias) ? alias : "custom";
      if (name && !name.startsWith("#")) {
        currentSection = {
          type: name,
          ...(name === "custom" ? { title: rawName, blocks: [] } : {}),
          line: i + 1,
          entries: [],
        };
        currentEntry = null;
        currentBullets = null;
        currentListBlock = null;
        sections.push(currentSection);

        // skills has no ### entries — use one synthetic entry
        if (name === "skills") {
          currentEntry = { name: "", role: "", date: "", location: "", bullets: [], line: i + 1 };
          currentSection.entries.push(currentEntry);
          currentBullets = currentEntry.bullets;
        }
        continue;
      }
    }

    // Optional custom display title, placed directly below a section heading.
    if (trimmed.startsWith("title:") && currentSection && (!currentEntry
      || (currentSection.type === "skills" && currentEntry.bullets.length === 0))) {
      currentSection.title = trimmed.slice("title:".length).trim();
      continue;
    }

    // ### entry
    if (trimmed.startsWith("### ") || trimmed === "###") {
      if (!currentSection) {
        errors.push({
          level: "warning",
          code: "ENTRY_OUTSIDE_SECTION",
          message: `条目 "${trimmed}" 不在任何栏目内。`,
          line: i + 1,
        });
        continue;
      }
      if (currentSection.type === "skills") {
        const first = currentSection.entries[0];
        if (currentSection.entries.length === 1 && !first.name && !first.role && !first.date && !first.location && first.bullets.length === 0) {
          currentSection.entries = [];
        }
      }
      const name = trimmed.slice(3).trim();
      currentEntry = { name, role: "", date: "", location: "", bullets: [], line: i + 1 };
      if (currentSection.type === "custom") {
        currentEntry.type = "entry";
        currentEntry.id = "";
        currentSection.blocks.push(currentEntry);
      } else {
        currentSection.entries.push(currentEntry);
      }
      currentBullets = currentEntry.bullets;
      currentListBlock = null;
      continue;
    }

    // role: / date: / location: fields
    if (trimmed.startsWith("role:") || trimmed.startsWith("date:") || trimmed.startsWith("location:")) {
      if (!currentEntry) {
        errors.push({
          level: "warning",
          code: "FIELD_OUTSIDE_ENTRY",
          message: `字段 "${trimmed.split(":")[0]}" 不在任何条目内。`,
          line: i + 1,
        });
        continue;
      }
      const colonIndex = trimmed.indexOf(":");
      const key = trimmed.slice(0, colonIndex).trim();
      const value = trimmed.slice(colonIndex + 1).trim();

      if (currentEntry[key] !== "") {
        errors.push({
          level: "error",
          code: "DUPLICATE_ENTRY_FIELD",
          field: key,
          entry: currentEntry.name,
          message: `${currentSection.type} 栏目下"${currentEntry.name}"的 ${key} 字段重复。`,
          line: i + 1,
          suggestion: "请删除重复字段。",
        });
      } else {
        currentEntry[key] = value;
      }
      continue;
    }

    // - bullet
    if (trimmed.startsWith("- ")) {
      if (currentSection?.type === "custom" && !currentBullets) {
        if (!currentListBlock) {
          currentListBlock = { type: "list", bullets: [], line: i + 1 };
          currentSection.blocks.push(currentListBlock);
        }
        currentBullets = currentListBlock.bullets;
      }
      if (!currentBullets) {
        errors.push({
          level: "warning",
          code: "BULLET_OUTSIDE_ENTRY",
          message: `Bullet 不在任何条目内。`,
          line: i + 1,
        });
        continue;
      }
      const content = trimmed.slice(2);
      if (content.trim() === "") {
        errors.push({
          level: "warning",
          code: "EMPTY_BULLET",
          message: "存在空 Bullet。",
          line: i + 1,
        });
      }
      currentBullets.push({
        line: i + 1,
        raw: content,
        content: parseBoldTokens(content, i, errors),
      });
      continue;
    }

    // Free-form paragraph in a custom section.
    if (currentSection?.type === "custom") {
      currentSection.blocks.push({
        type: "text",
        line: i + 1,
        content: parseBoldTokens(trimmed, i, errors),
      });
      currentEntry = null;
      currentBullets = null;
      currentListBlock = null;
      continue;
    }

    // Unsupported markup
    if (/^\s*#{1,4}\s/.test(trimmed)) {
      errors.push({
        level: "error",
        code: "UNSUPPORTED_HEADING",
        message: `不支持的标题层级（第 ${i + 1} 行）。`,
        line: i + 1,
        suggestion: "请使用 ## 定义栏目、### 定义条目。",
      });
      continue;
    }

    if (/^>\s/.test(trimmed)) {
      errors.push({
        level: "warning",
        code: "UNSUPPORTED_BLOCKQUOTE",
        message: `不支持引用块（第 ${i + 1} 行）。`,
        line: i + 1,
      });
      continue;
    }

    if (/\|.*\|/.test(trimmed)) {
      errors.push({
        level: "warning",
        code: "UNSUPPORTED_TABLE",
        message: `不支持表格（第 ${i + 1} 行）。`,
        line: i + 1,
      });
      continue;
    }
  }

  return sections;
}

/**
 * Parse supported inline emphasis: **bold**, *italic*, and ***both***.
 * @param {string} text
 * @param {number} line
 * @param {object[]} errors
 * @returns {object[]}
 */
function parseBoldTokens(text, line, errors) {
  const tokens = [];
  // Protect escaped Markdown punctuation while interpreting format markers.
  const escaped = [];
  let escapePrefix = "\u0000";
  while (text.includes(escapePrefix)) escapePrefix += "\u0000";
  text = text.replace(/\\([\\*\[\]])/g, (_, value) => {
    escaped.push(value);
    return `${escapePrefix}${escaped.length - 1}\u0001`;
  });
  let remaining = text;

  while (remaining.length > 0) {
    const openIdx = remaining.indexOf("*");
    if (openIdx === -1) {
      if (remaining) {
        tokens.push({ type: "text", value: remaining });
      }
      break;
    }

    if (openIdx > 0) {
      tokens.push({ type: "text", value: remaining.slice(0, openIdx) });
    }

    const marker = remaining.startsWith("***", openIdx)
      ? "***"
      : remaining.startsWith("**", openIdx) ? "**" : "*";
    const afterOpen = remaining.slice(openIdx + marker.length);
    const closeIdx = afterOpen.indexOf(marker);

    if (closeIdx === -1) {
      errors.push({
        level: "warning",
        code: "UNCLOSED_EMPHASIS",
        message: `格式标记 ${marker} 未闭合（第 ${line + 1} 行）。`,
        line: line + 1,
      });
      tokens.push({ type: "text", value: remaining.slice(openIdx) });
      break;
    }

    const value = afterOpen.slice(0, closeIdx);
    if (value) {
      tokens.push({
        type: marker === "*" ? "text" : "strong",
        value,
        ...(marker === "*" || marker === "***" ? { italic: true } : {}),
      });
    }

    remaining = afterOpen.slice(closeIdx + marker.length);
  }

  return parseMarkdownLinkTokens(tokens).map((token) => ({
    ...token,
    value: token.value.replace(new RegExp(`${escapePrefix}(\\d+)\u0001`, "g"), (_, index) => escaped[Number(index)]),
  }));
}

function parseMarkdownLinkTokens(tokens) {
  const result = [];
  const linkPattern = /\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^)\s]+)\)/gi;

  for (const token of tokens) {
    if (token.href) {
      result.push(token);
      continue;
    }
    let cursor = 0;
    let match;
    linkPattern.lastIndex = 0;
    while ((match = linkPattern.exec(token.value || ""))) {
      if (match.index > cursor) {
        result.push({ ...token, value: token.value.slice(cursor, match.index) });
      }
      result.push({ ...token, value: match[1], href: match[2] });
      cursor = match.index + match[0].length;
    }
    if (cursor < (token.value || "").length) {
      result.push({ ...token, value: token.value.slice(cursor) });
    }
  }

  return result;
}
