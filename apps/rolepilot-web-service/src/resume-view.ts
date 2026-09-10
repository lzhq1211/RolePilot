import {
  adaptResumeContent,
  parseResumeContentV3,
  validateResumeView,
  type ResumeContentV3,
  type ResumeEntryV3,
  type ResumeEntryDto,
  type ResumeSectionDto,
  type ResumeSectionV3,
  type ResumeViewDto,
} from "web-contracts";

export class ResumeViewError extends Error {
  constructor() {
    super("Resume content does not match the supported result contract.");
    this.name = "ResumeViewError";
  }
}

export function parseResumeViewText(text: string): ResumeViewDto {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ResumeViewError();
  }
  return parseResumeView(value);
}

export function parseResumeView(value: unknown): ResumeViewDto {
  if (isResumeView(value)) return structuredClone(value);
  if (!isRecord(value) || !Array.isArray(value.sections)) throw new ResumeViewError();

  const result: ResumeViewDto = {
    schemaVersion: "v1",
    name: null,
    contact: [],
    summary: null,
    sections: [],
  };
  for (const section of value.sections) {
    if (!isRecord(section) || typeof section.id !== "string" || typeof section.title !== "string") throw new ResumeViewError();
    const content = isRecord(section.content) ? section.content : {};
    if (section.type === "personal_info") {
      const fullName = readText(content.fullName);
      if (fullName) result.name = fullName;
      for (const [key, label] of [["email", "email"], ["phone", "phone"], ["location", "location"], ["website", "website"], ["linkedin", "linkedin"], ["github", "github"]] as const) {
        const field = readText(content[key]);
        if (field) result.contact.push({ label, value: field });
      }
      continue;
    }
    if (section.type === "summary") {
      result.summary = readText(content.text) || null;
      continue;
    }
    result.sections.push({ id: section.id, title: section.title, entries: readEntries(content) });
  }
  const validation = validateResumeView(result);
  if (!validation.valid) throw new ResumeViewError();
  return result;
}

/** Deterministic adapter for completed runs that predate the V3 delivery index. */
export function parseHistoricalResumeContent(value: unknown, documentId: string): ResumeContentV3 {
  try {
    return parseResumeContentV3(value);
  } catch {
    // Continue through the explicitly supported historical record shapes.
  }
  try {
    return adaptResumeContent(value, { legacyDocumentId: documentId });
  } catch {
    // Jade JSON predates the public V1/V2 content schema.
  }
  if (!isRecord(value) || !Array.isArray(value.sections)) throw new ResumeViewError();
  const profile = { name: "", headline: "", location: "", phone: "", email: "", website: "", portfolio: "", github: "" };
  const sections: ResumeSectionV3[] = [];
  for (const [sectionIndex, rawSection] of value.sections.entries()) {
    if (!isRecord(rawSection) || typeof rawSection.type !== "string" || typeof rawSection.title !== "string") throw new ResumeViewError();
    const content = isRecord(rawSection.content) ? rawSection.content : {};
    if (rawSection.type === "personal_info") {
      profile.name = readText(content.fullName);
      profile.phone = readText(content.phone);
      profile.email = readText(content.email);
      profile.location = readText(content.location);
      profile.website = readText(content.website);
      profile.portfolio = readText(content.portfolio);
      profile.github = readText(content.github);
      continue;
    }
    if (rawSection.type === "summary") {
      const text = readText(content.text);
      if (text) sections.push({ id: `${documentId}:section:${sectionIndex}`, type: "custom", title: rawSection.title, blocks: [{ id: `${documentId}:section:${sectionIndex}:text:0`, type: "text", content: text }] });
      continue;
    }
    if (isKnownSectionType(rawSection.type)) {
      sections.push({
        id: `${documentId}:section:${sectionIndex}`,
        type: rawSection.type,
        title: rawSection.title,
        entries: readHistoricalEntries(content, `${documentId}:section:${sectionIndex}`),
      });
      continue;
    }
    const entries = readHistoricalEntries(content, `${documentId}:section:${sectionIndex}`);
    sections.push({
      id: `${documentId}:section:${sectionIndex}`,
      type: "custom",
      title: rawSection.title,
      blocks: entries.map((entry) => ({ type: "entry", ...entry })),
    });
  }
  return { schemaVersion: 3, documentId, resumeName: profile.name || "历史简历", profile, sections };
}

function isKnownSectionType(value: string): value is "education" | "experience" | "projects" | "skills" {
  return value === "education" || value === "experience" || value === "projects" || value === "skills";
}

function readHistoricalEntries(content: Record<string, any>, prefix: string): ResumeEntryV3[] {
  const source = Array.isArray(content.items) ? content.items : Array.isArray(content.categories) ? content.categories : [];
  return source.map((item, index) => {
    if (!isRecord(item)) throw new ResumeViewError();
    const entryId = `${prefix}:entry:${index}`;
    const bullets = arrayText(item.highlights);
    const description = readText(item.description);
    if (description && !bullets.includes(description)) bullets.unshift(description);
    const skills = arrayText(item.skills);
    if (skills.length > 0 && bullets.length === 0) bullets.push(skills.join(", "));
    return {
      id: entryId,
      name: readText(item.company) || readText(item.name) || readText(item.institution) || readText(item.title),
      role: readText(item.position) || readText(item.role),
      date: formatDate(item.startDate, item.endDate) ?? "",
      location: readText(item.location),
      bullets: bullets.map((content, bulletIndex) => ({ id: `${entryId}:bullet:${bulletIndex}`, content })),
    };
  });
}

function readEntries(content: Record<string, any>): ResumeEntryDto[] {
  const source = Array.isArray(content.items) ? content.items : Array.isArray(content.categories) ? content.categories : [];
  return source.map((item, index) => {
    if (!isRecord(item)) throw new ResumeViewError();
    const id = readText(item.id) || `entry-${index + 1}`;
    const title = readText(item.title) || readText(item.position) || readText(item.name) || readText(item.company) || readText(item.institution) || null;
    const date = formatDate(item.startDate, item.endDate);
    const location = readText(item.location) || null;
    const bullets = arrayText(item.highlights);
    const description = readText(item.description);
    if (description && !bullets.includes(description)) bullets.unshift(description);
    const skills = arrayText(item.skills);
    if (skills.length > 0 && bullets.length === 0) bullets.push(skills.join(", "));
    return { id, title, date, location, bullets };
  });
}

function isResumeView(value: unknown): value is ResumeViewDto {
  return validateResumeView(value).valid;
}
function isRecord(value: unknown): value is Record<string, any> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function readText(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function arrayText(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : []; }
function dedupeDatePart(value: string): string {
  // Historical/model payloads can repeat an endpoint (e.g. `2017-092017-09`).
  // Collapse only an exact adjacent duplicate so legitimate date text is untouched.
  const match = value.match(/^(.+)\1$/);
  return match ? match[1] : value;
}
function formatDate(start: unknown, end: unknown): string | null {
  const a = dedupeDatePart(readText(start));
  const b = dedupeDatePart(readText(end));
  if (!a && !b) return null;
  if (a && b) return `${a} - ${b}`;
  return a || b;
}
