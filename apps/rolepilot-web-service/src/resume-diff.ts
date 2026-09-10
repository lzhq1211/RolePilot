import type { DiffBlockDto, ResumeViewDto } from "web-contracts";
export function diffResumes(before: ResumeViewDto, after: ResumeViewDto): DiffBlockDto[] {
  const out: DiffBlockDto[] = [];
  const sections = new Set([...before.sections.map((s) => s.id), ...after.sections.map((s) => s.id)]);
  for (const id of sections) {
    const a = before.sections.find((s) => s.id === id); const b = after.sections.find((s) => s.id === id);
    if (!a || !b) { out.push({ id: `section:${id}`, sectionId: id, kind: "unaligned", before: a?.title ?? null, after: b?.title ?? null }); continue; }
    const entries = new Set([...a.entries.map((e) => e.id), ...b.entries.map((e) => e.id)]);
    for (const eid of entries) {
      const x = a.entries.find((e) => e.id === eid); const y = b.entries.find((e) => e.id === eid);
      if (!x || !y) { out.push({ id: `${id}:${eid}`, sectionId: id, kind: x ? "removed" : "added", before: x ? entryText(x) : null, after: y ? entryText(y) : null }); continue; }
      const xb = entryText(x); const yb = entryText(y);
      out.push({ id: `${id}:${eid}`, sectionId: id, kind: xb === yb ? "unchanged" : "changed", before: xb, after: yb });
    }
  }
  return out;
}

function entryText(entry: ResumeViewDto["sections"][number]["entries"][number]): string {
  return [entry.title, entry.date, entry.location, ...entry.bullets].filter((value): value is string => Boolean(value)).join("\n");
}
