import YAML from "yaml";
import { adaptResumeContent, type ResumeContentV3 } from "web-contracts/resume-document";

export type OriginalResumeSourceKind = "imported-text" | "provided-timeline" | "legacy-offline-text";

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** The miner proposes content only; document and node identities belong to code. */
export function materializeOriginalResume(value: unknown, documentId: string): ResumeContentV3 {
  if (!record(value)) throw new TypeError("Miner originalResume must be an object.");
  const rejectIdentity = (item: unknown): void => {
    if (Array.isArray(item)) item.forEach(rejectIdentity);
    else if (record(item)) for (const [key, child] of Object.entries(item)) {
      if (["id", "documentId", "schemaVersion"].includes(key)) {
        throw new TypeError(`Miner originalResume must not assign ${key}; identities and schema are assigned by code.`);
      }
      rejectIdentity(child);
    }
  };
  rejectIdentity(value);
  return adaptResumeContent({ ...value, schemaVersion: 2 }, { legacyDocumentId: documentId });
}

/** Offline legacy responses cannot supply a reconstructed original: preserve raw input. */
export function originalFromImportedText(text: string, documentId: string): ResumeContentV3 {
  return materializeOriginalResume({
    resumeName: "原始简历", profile: {},
    sections: [{ type: "custom", title: "原始提取文字", blocks: [{ type: "text", content: text }] }],
  }, documentId);
}

/** User-supplied timeline is itself the source, never an uploaded-resume replica. */
export function originalFromProvidedTimeline(text: string, documentId: string): ResumeContentV3 {
  const parsed: unknown = YAML.parse(text);
  if (!record(parsed)) throw new TypeError("Provided timeline must be a YAML object.");
  const content = record(parsed.content) ? parsed.content : parsed;
  const asText = (value: unknown): string => value === undefined || value === null ? ""
    : typeof value === "string" ? value : YAML.stringify(value).trimEnd();
  const sections: Record<string, unknown>[] = [];
  const custom = (title: string, value: unknown) => {
    if (value !== undefined) sections.push({ type: "custom", title, blocks: [{ type: "text", content: asText(value) }] });
  };
  const basics = record(content.basics) ? content.basics : {};
  if (content.basics !== undefined && !record(content.basics)) custom("basics", content.basics);
  const profile: Record<string, unknown> = {};
  for (const field of ["name", "headline", "phone", "email", "website", "portfolio", "github", "location"]) {
    profile[field] = asText(basics[field]);
  }
  const extraContacts = Object.entries(basics)
    .filter(([key]) => !(key in profile) && key !== "summary")
    .map(([label, value]) => ({ label, value: asText(value) }));
  if (extraContacts.length) profile.extraContacts = extraContacts;
  custom("个人简介", basics.summary);
  const entry = (value: Record<string, unknown>, type: string) => {
    const nameKey = type === "education" ? "institution" : type === "experience" ? "company" : "name";
    const roleKey = type === "education" ? "degree" : type === "experience" ? "position" : "role";
    const used = new Set([nameKey, roleKey, "title", "date", "startDate", "endDate", "location", "summary", "highlights", "type"]);
    const bullets: string[] = [];
    if (value.summary !== undefined) bullets.push(asText(value.summary));
    if (Array.isArray(value.highlights)) bullets.push(...value.highlights.map(asText));
    else if (value.highlights !== undefined) bullets.push(asText(value.highlights));
    for (const [key, detail] of Object.entries(value)) if (!used.has(key)) bullets.push(`${key}: ${asText(detail)}`);
    // A distinct title is retained even when position/name is present.
    if (value.title !== undefined && value[roleKey] !== undefined) bullets.push(`title: ${asText(value.title)}`);
    if (value.date !== undefined) for (const key of ["startDate", "endDate"]) {
      if (value[key] !== undefined) bullets.push(`${key}: ${asText(value[key])}`);
    }
    return {
      name: asText(value[nameKey]), role: asText(value[roleKey] ?? value.title),
      date: asText(value.date ?? [asText(value.startDate), asText(value.endDate)].filter(Boolean).join("–")),
      location: asText(value.location), bullets,
    };
  };
  const groups: Record<string, string> = { education: "education", work: "experience", projects: "projects", skills: "skills" };
  for (const [key, value] of Object.entries(content)) {
    if (key === "basics") continue;
    if (key === "timeline" && Array.isArray(value)) {
      // Keep the user's order, including mixed and unknown experience types.
      for (const item of value) {
        if (!record(item)) { custom("用户提供经历", item); continue; }
        const type = groups[String(item.type)] ?? (item.type === "project" ? "projects" : null);
        if (type) sections.push({ type, entries: [entry(item, type)] });
        else custom(asText(item.type) || "用户提供经历", item);
      }
    } else if (groups[key] && Array.isArray(value) && value.every(record)) {
      sections.push({ type: groups[key], entries: value.map((item) => entry(item, groups[key])) });
    } else custom(key, value);
  }
  if (content !== parsed) for (const [key, value] of Object.entries(parsed)) {
    if (key !== "content") custom(key, value);
  }
  return materializeOriginalResume({ resumeName: "用户提供经历", profile, sections }, documentId);
}
