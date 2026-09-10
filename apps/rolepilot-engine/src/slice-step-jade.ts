import YAML from "yaml";
import type { ResumeContentV3 } from "web-contracts/resume-document";

type YamlResumeContent = {
  basics?: {
    name?: string;
    headline?: string;
    phone?: string;
    email?: string;
    summary?: string;
    profiles?: unknown[];
  };
  education?: {
    institution?: string;
    degree?: string;
    area?: string;
    startDate?: string;
    endDate?: string;
    gpa?: string;
  }[];
  work?: {
    company?: string;
    name?: string;
    position?: string;
    location?: string;
    startDate?: string;
    endDate?: string;
    summary?: string;
    keywords?: string[];
  }[];
  projects?: {
    name?: string;
    description?: string;
    url?: string;
    startDate?: string;
    endDate?: string;
    summary?: string;
    keywords?: string[];
  }[];
  skills?: {
    name?: string;
    level?: string;
    keywords?: string[];
  }[];
  certificates?: {
    name?: string;
    issuer?: string;
    date?: string;
    url?: string;
  }[];
};

function stripMarkdownFences(text: string): string {
  return text
    .replace(/^```(?:ya?ml|json)?\s*\n?/gm, "")
    .replace(/\n?```\s*$/gm, "")
    .trim();
}

function parseSimpleYaml(text: string): YamlResumeContent {
  const cleaned = stripMarkdownFences(text);
  const parsed = YAML.parse(cleaned);
  if (!parsed || typeof parsed !== "object") return {};
  const content = (parsed as { content?: unknown }).content ?? parsed;
  return content as YamlResumeContent;
}

function normDate(dateStr: string): string {
  const months: Record<string, string> = {
    jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
    jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
  };
  const m = dateStr.match(/^(\w+)\s+\d+,?\s+(\d{4})$/);
  if (m) {
    const mon = months[m[1].toLowerCase().slice(0, 3)] ?? "01";
    return `${m[2]}-${mon}`;
  }
  if (/^\d{4}-\d{2}$/.test(dateStr)) return dateStr;
  return dateStr;
}

function summaryToHighlights(summary: string): string[] {
  return summary
    .split("\n")
    .map((l) => l.replace(/^\s*-\s*/, "").trim())
    .filter(Boolean);
}

/** Legacy replay/CLI records become one deterministic v3 delivery document. */
export function convertLegacyYamlToResumeContentV3(
  yamlText: string,
  documentId: string,
): ResumeContentV3 {
  const source = parseSimpleYaml(yamlText);
  const entry = (
    section: string,
    index: number,
    name: string,
    role: string,
    date: string,
    location: string,
    bullets: string[],
  ) => ({
    id: `${documentId}:${section}:entry:${index + 1}`,
    name,
    role,
    date,
    location,
    bullets: bullets.map((content, bulletIndex) => ({
      id: `${documentId}:${section}:entry:${index + 1}:bullet:${bulletIndex + 1}`,
      content,
    })),
  });
  const period = (start?: string, end?: string) => [start, end]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(" - ");
  const sections: ResumeContentV3["sections"] = [];

  if (source.basics?.summary?.trim()) {
    sections.push({
      id: `${documentId}:summary`,
      type: "custom",
      title: "个人简介",
      blocks: [{
        id: `${documentId}:summary:text:1`,
        type: "text",
        content: source.basics.summary,
      }],
    });
  }
  if (source.work?.length) {
    sections.push({
      id: `${documentId}:experience`,
      type: "experience",
      title: "工作经历",
      entries: source.work.map((item, index) => entry(
        "experience", index, item.company ?? item.name ?? "", item.position ?? "",
        period(item.startDate, item.endDate), item.location ?? "", summaryToHighlights(item.summary ?? ""),
      )),
    });
  }
  if (source.projects?.length) {
    sections.push({
      id: `${documentId}:projects`,
      type: "projects",
      title: "项目经历",
      entries: source.projects.map((item, index) => entry(
        "projects", index, item.name ?? "", item.url ?? "",
        period(item.startDate, item.endDate), "", [
          ...(item.description?.trim() ? [item.description] : []),
          ...summaryToHighlights(item.summary ?? ""),
        ],
      )),
    });
  }
  if (source.education?.length) {
    sections.push({
      id: `${documentId}:education`,
      type: "education",
      title: "教育背景",
      entries: source.education.map((item, index) => entry(
        "education", index, item.institution ?? "", [item.degree, item.area].filter(Boolean).join(" "),
        period(item.startDate, item.endDate), "", item.gpa?.trim() ? [`GPA: ${item.gpa}`] : [],
      )),
    });
  }
  if (source.skills?.length) {
    sections.push({
      id: `${documentId}:skills`,
      type: "skills",
      title: "技能特长",
      entries: source.skills.map((item, index) => entry(
        "skills", index, item.name ?? "", item.level ?? "", "", "", item.keywords ?? [],
      )),
    });
  }
  if (source.certificates?.length) {
    sections.push({
      id: `${documentId}:certificates`,
      type: "custom",
      title: "证书与奖项",
      blocks: source.certificates.map((item, index) => ({
        type: "entry" as const,
        ...entry("certificates", index, item.name ?? "", item.issuer ?? "", item.date ?? "", "", item.url?.trim() ? [item.url] : []),
      })),
    });
  }

  return {
    schemaVersion: 3,
    documentId,
    resumeName: source.basics?.name?.trim() || "简历",
    profile: {
      name: source.basics?.name ?? "",
      headline: source.basics?.headline ?? "",
      location: "",
      phone: source.basics?.phone ?? "",
      email: source.basics?.email ?? "",
      website: "",
      portfolio: "",
      github: "",
    },
    sections,
  };
}

export function convertResumeYamlToJadeJson(
  yamlText: string,
  baseName: string,
  company: { company?: string; title?: string; [k: string]: unknown },
): string {
  const r = parseSimpleYaml(yamlText);
  const now = new Date().toISOString();
  const title = `${r.basics?.name ?? "Resume"}-${company.title ?? baseName}`;
  let order = 0;

  const mkSection = (id: string, type: string, sTitle: string, content: unknown) => ({
    id,
    resumeId: "",
    type,
    title: sTitle,
    sortOrder: order++,
    visible: true,
    content,
    createdAt: now,
    updatedAt: now,
  });

  const sections: unknown[] = [];

  sections.push(mkSection("personal_info-1", "personal_info", "个人信息", {
    fullName: r.basics?.name ?? "",
    jobTitle: "",
    email: r.basics?.email ?? "",
    phone: r.basics?.phone ?? "",
    location: "",
    website: "",
    linkedin: "",
    github: "",
  }));

  if (r.basics?.summary) {
    const text = r.basics.summary.split("\n")
      .map((l) => l.replace(/^\s*-\s*/, "").trim())
      .filter(Boolean)
      .join("。");
    sections.push(mkSection("summary-2", "summary", "个人简介", { text }));
  }

  if (r.work?.length) {
    sections.push(mkSection("work_experience-3", "work_experience", "工作经历", {
      items: r.work.map((w, i) => ({
        id: `work-${i + 1}`,
        company: w.company ?? w.name ?? "",
        position: w.position ?? "",
        location: "",
        startDate: normDate(w.startDate ?? ""),
        endDate: normDate(w.endDate ?? ""),
        current: false,
        description: summaryToHighlights(w.summary ?? "")[0] ?? "",
        technologies: [],
        highlights: summaryToHighlights(w.summary ?? ""),
      })),
    }));
  }

  if (r.projects?.length) {
    sections.push(mkSection("projects-4", "projects", "项目经历", {
      items: r.projects.map((p, i) => ({
        id: `project-${i + 1}`,
        name: p.name ?? "",
        url: "",
        startDate: normDate(p.startDate ?? ""),
        endDate: normDate(p.endDate ?? ""),
        description: p.description ?? summaryToHighlights(p.summary ?? "")[0] ?? "",
        technologies: [],
        highlights: summaryToHighlights(p.summary ?? ""),
      })),
    }));
  }

  if (r.skills?.length) {
    sections.push(mkSection("skills-5", "skills", "技能特长", {
      categories: r.skills.map((s, i) => ({
        id: `skill-category-${i + 1}`,
        name: s.name ?? "",
        skills: s.keywords ?? [],
      })),
    }));
  }

  if (r.education?.length) {
    sections.push(mkSection("education-6", "education", "教育背景", {
      items: r.education.map((e, i) => ({
        id: `edu-${i + 1}`,
        institution: e.institution ?? "",
        degree: e.degree ?? "",
        field: e.area ?? "",
        location: "",
        startDate: normDate(e.startDate ?? ""),
        endDate: normDate(e.endDate ?? ""),
        gpa: "",
        highlights: [],
      })),
    }));
  }

  if (r.certificates?.length) {
    sections.push(mkSection("certifications-7", "certifications", "荣誉奖项", {
      items: r.certificates.map((c, i) => ({
        id: `cert-${i + 1}`,
        name: c.name ?? "",
        issuer: "",
        date: "",
        url: "",
      })),
    }));
  }

  const jade = {
    title,
    template: "swiss",
    themeConfig: {
      primaryColor: "#1a1a1a",
      accentColor: "#3b82f6",
      fontFamily: "Georgia",
      fontSize: "medium",
      lineSpacing: 1.5,
      margin: { top: 24, right: 24, bottom: 24, left: 24 },
      sectionSpacing: 16,
      avatarStyle: "oneInch",
    },
    isDefault: false,
    language: "zh",
    sections,
  };

  return JSON.stringify(jade, null, 2) + "\n";
}
