export type InputDraftDto = {
  id: string;
  resumeSourceId: string | null;
  company: string;
  title: string;
  jdText: string;
  revision: number;
  updatedAt: string;
};

export type InputDraftInput = Pick<
  InputDraftDto,
  "resumeSourceId" | "company" | "title" | "jdText"
>;

export type CreateRunInput = {
  resumeSourceId: string;
  company: string;
  title: string;
  jdText: string;
};

export type InputFieldError = {
  field: "resume" | "company" | "title" | "jd";
  code: string;
  message: string;
};

export function normalizeInputDraft(input: InputDraftInput): InputDraftInput {
  return {
    resumeSourceId: normalizeSourceId(input.resumeSourceId),
    company: input.company,
    title: input.title,
    jdText: normalizeLineEndings(input.jdText),
  };
}

export function validateInputDraft(
  input: InputDraftInput,
  { requireValues = false }: { requireValues?: boolean } = {},
): InputFieldError[] {
  const errors: InputFieldError[] = [];
  addTextError(errors, "company", input.company, 200, "公司名称", requireValues);
  addTextError(errors, "title", input.title, 200, "岗位名称", requireValues);
  addTextError(errors, "jd", input.jdText, 50_000, "JD", requireValues);
  return errors;
}

function addTextError(
  errors: InputFieldError[],
  field: InputFieldError["field"],
  value: string,
  maxCodePoints: number,
  label: string,
  requireValue: boolean,
) {
  if (requireValue && value.trim().length === 0) {
    errors.push({ field, code: "REQUIRED", message: `请输入${label}。` });
    return;
  }
  if ([...value].length > maxCodePoints) {
    errors.push({
      field,
      code: "TOO_LONG",
      message: `${label}不能超过 ${maxCodePoints.toLocaleString("zh-CN")} 字。`,
    });
  }
}

function normalizeSourceId(sourceId: string | null): string | null {
  if (sourceId === null) return null;
  const normalized = sourceId.trim();
  return normalized || null;
}

function normalizeLineEndings(value: string): string {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}
