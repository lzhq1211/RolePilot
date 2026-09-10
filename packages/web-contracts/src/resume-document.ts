export interface ResumeBulletV3 {
  id: string;
  content: string;
}

export interface ResumeEntryV3 {
  id: string;
  name: string;
  role: string;
  date: string;
  location: string;
  bullets: ResumeBulletV3[];
}

export type ResumeBlockV3 =
  | { id: string; type: "text"; content: string }
  | { id: string; type: "list"; items: ResumeBulletV3[] }
  | (ResumeEntryV3 & { type: "entry" });

export const RESUME_PROFILE_FIELDS = [
  "name", "headline", "location", "phone", "email", "website", "portfolio", "github",
] as const;

export type ResumeProfileV3 = Record<(typeof RESUME_PROFILE_FIELDS)[number], string> & {
  extraContacts?: Array<{ label: string; value: string }>;
};

export type ResumeSectionV3 =
  | { id: string; type: "education" | "experience" | "projects" | "skills"; title: string; entries: ResumeEntryV3[] }
  | { id: string; type: "custom"; title: string; blocks: ResumeBlockV3[] };

export interface ResumeContentV3 {
  schemaVersion: 3;
  documentId: string;
  resumeName: string;
  profile: ResumeProfileV3;
  sections: ResumeSectionV3[];
}

const SECTION_TITLES = {
  education: "教育背景", experience: "实习经历", projects: "项目经历", skills: "技能特长",
};

export interface ResumeContentOptions {
  /** Use a stable record ID for repeated historical adaptation; omit for a new local import. */
  legacyDocumentId?: string;
  createId?: () => string;
}

/** Strict content boundary. Layout and editor tokens never enter this contract. */
export function parseResumeContentV3(value: unknown): ResumeContentV3 {
  return readResumeContent(value, false, {});
}

/** External v1/v2 files contain string bullets, unlike the private editor state. */
export function adaptResumeContent(value: unknown, options: ResumeContentOptions = {}): ResumeContentV3 {
  const root = objectAt(value, "resume");
  if (root.schemaVersion === 3) return parseResumeContentV3(root);
  if (root.schemaVersion !== 1 && root.schemaVersion !== 2) {
    throw new TypeError("schemaVersion 必须为 1、2 或 3。");
  }
  return readResumeContent(root, true, options);
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} 必须为对象。`);
  return value as Record<string, unknown>;
}

function keysAt(value: Record<string, unknown>, keys: string[], path: string): void {
  const unknown = Object.keys(value).find((key) => !keys.includes(key));
  if (unknown) throw new TypeError(`${path}.${unknown} 是无法解释的字段。`);
}

function readResumeContent(value: unknown, legacy: boolean, options: ResumeContentOptions): ResumeContentV3 {
  const root = objectAt(value, "resume");
  keysAt(root, ["schemaVersion", "documentId", "resumeName", "profile", "sections"], "resume");
  if (!legacy && root.schemaVersion !== 3) throw new TypeError("schemaVersion 必须为 3。");
  const str = (v: unknown, path: string): string => {
    if (legacy && v === undefined) return "";
    if (typeof v !== "string") throw new TypeError(`${path} 必须为字符串。`);
    return v;
  };
  const array = (v: unknown, path: string): unknown[] => {
    if (!Array.isArray(v)) throw new TypeError(`${path} 必须为数组。`);
    return v;
  };
  const makeId = options.createId ?? (() => globalThis.crypto.randomUUID());
  const documentId = legacy
    ? options.legacyDocumentId ?? (root.documentId === undefined ? makeId() : str(root.documentId, "documentId"))
    : str(root.documentId, "documentId");
  if (!documentId.trim()) throw new TypeError("documentId 不能为空。");
  const ids = new Set<string>();
  const id = (v: unknown, path: string): string => {
    const result = legacy && v === undefined
      ? options.legacyDocumentId ? `${documentId}:${path}` : makeId()
      : str(v, `${path}.id`);
    if (!result.trim() || ids.has(result)) throw new TypeError(`${path}.id 为空或重复：${result}`);
    ids.add(result);
    return result;
  };
  const bullets = (v: unknown, path: string): ResumeBulletV3[] => array(legacy && v === undefined ? [] : v, path).map((item, i) => {
    const p = `${path}[${i}]`;
    if (legacy) {
      if (typeof item !== "string") throw new TypeError(`${p} 必须为字符串，不能导入编辑器 token 状态。`);
      return { id: id(undefined, p), content: item };
    }
    const b = objectAt(item, p);
    keysAt(b, ["id", "content"], p);
    return { id: id(b.id, p), content: str(b.content, `${p}.content`) };
  });
  const entry = (v: unknown, path: string, block = false): ResumeEntryV3 => {
    const e = objectAt(v, path);
    keysAt(e, ["id", "name", "role", "date", "location", "bullets", ...(block ? ["type"] : [])], path);
    return {
      id: id(e.id, path), name: str(e.name, `${path}.name`), role: e.role === undefined ? "" : str(e.role, `${path}.role`),
      date: str(e.date, `${path}.date`), location: str(e.location, `${path}.location`), bullets: bullets(e.bullets, `${path}.bullets`),
    };
  };
  const block = (v: unknown, path: string): ResumeBlockV3 => {
    const b = objectAt(v, path);
    if (b.type === "entry") return { type: "entry", ...entry(b, path, true) };
    if (b.type === "text") {
      keysAt(b, ["id", "type", "content"], path);
      return { id: id(b.id, path), type: "text", content: str(b.content, `${path}.content`) };
    }
    if (b.type === "list") {
      keysAt(b, ["id", "type", "items"], path);
      return { id: id(b.id, path), type: "list", items: bullets(b.items, `${path}.items`) };
    }
    throw new TypeError(`${path}.type 必须为 text、list 或 entry。`);
  };
  const rawProfile = objectAt(root.profile, "profile");
  keysAt(rawProfile, [...RESUME_PROFILE_FIELDS, "extraContacts"], "profile");
  const profile: ResumeProfileV3 = { name: "", headline: "", location: "", phone: "", email: "", website: "", portfolio: "", github: "" };
  for (const key of RESUME_PROFILE_FIELDS) profile[key] = str(rawProfile[key], `profile.${key}`);
  if (rawProfile.extraContacts !== undefined) {
    profile.extraContacts = array(rawProfile.extraContacts, "profile.extraContacts").map((v, i) => {
      const path = `profile.extraContacts[${i}]`;
      const c = objectAt(v, path);
      keysAt(c, ["label", "value"], path);
      return { label: str(c.label, `${path}.label`), value: str(c.value, `${path}.value`) };
    });
  }
  const sections = array(root.sections, "sections").map((v, i): ResumeSectionV3 => {
    const path = `sections[${i}]`;
    const s = objectAt(v, path);
    const type = str(s.type, `${path}.type`);
    if (!type) throw new TypeError(`${path}.type 不能为空。`);
    const known = Object.hasOwn(SECTION_TITLES, type);
    if (!legacy && !known && type !== "custom") throw new TypeError(`${path}.type 不受支持。`);
    const sectionId = id(s.id, path);
    const title = legacy && s.title === undefined ? known ? SECTION_TITLES[type as keyof typeof SECTION_TITLES] : type : str(s.title, `${path}.title`);
    if (!known) {
      keysAt(s, ["id", "type", "title", "blocks", ...(legacy ? ["entries"] : [])], path);
      // Old exports included an empty entries array beside custom blocks.
      if (s.blocks !== undefined) {
        if (s.entries !== undefined && array(s.entries, `${path}.entries`).length) throw new TypeError(`${path} 同时包含 blocks 和 entries。`);
        return { id: sectionId, type: "custom", title, blocks: array(s.blocks, `${path}.blocks`).map((b, j) => block(b, `${path}.blocks[${j}]`)) };
      }
      if (legacy && type !== "custom" && s.entries !== undefined) {
        return { id: sectionId, type: "custom", title, blocks: array(s.entries, `${path}.entries`).map((e, j) => ({ type: "entry", ...entry(e, `${path}.entries[${j}]`) })) };
      }
      throw new TypeError(`${path}.blocks 必须为数组。`);
    }
    keysAt(s, ["id", "type", "title", "entries"], path);
    return { id: sectionId, type: type as keyof typeof SECTION_TITLES, title, entries: array(s.entries, `${path}.entries`).map((e, j) => entry(e, `${path}.entries[${j}]`)) };
  });
  return { schemaVersion: 3, documentId, resumeName: str(root.resumeName, "resumeName"), profile, sections };
}
