import type { InputDraftInput, InputFieldError, CreateRunInput } from "./draft.js";
import { normalizeInputDraft, validateInputDraft } from "./draft.js";
import type { ResumeSourceDto } from "./source.js";

export type NewRunValidationInput = {
  source: ResumeSourceDto | null;
  sourceBusy: boolean;
  input: InputDraftInput;
  hasDraftConflict: boolean;
};

export class NewRunInputValidationError extends Error {
  readonly fieldErrors: InputFieldError[];

  constructor(fieldErrors: InputFieldError[]) {
    super("提交信息无效。");
    this.name = "NewRunInputValidationError";
    this.fieldErrors = fieldErrors;
  }
}

export function validateNewRunInput({
  source,
  sourceBusy,
  input,
  hasDraftConflict,
}: NewRunValidationInput): InputFieldError[] {
  const errors: InputFieldError[] = [];

  if (sourceBusy) {
    errors.push({
      field: "resume",
      code: "PROCESSING",
      message: "简历正在上传或解析，请稍候。",
    });
  } else if (!source) {
    errors.push({
      field: "resume",
      code: "REQUIRED",
      message: "请选择并解析简历。",
    });
  } else if (source.status !== "READY") {
    errors.push({
      field: "resume",
      code: "NOT_READY",
      message: "请等待简历解析完成。",
    });
  }

  if (hasDraftConflict) {
    errors.push({
      field: "resume",
      code: "DRAFT_CONFLICT",
      message: "请先处理草稿冲突。",
    });
  }

  const normalized = normalizeInputDraft(input);
  errors.push(...validateInputDraft(normalized, { requireValues: true }));
  return errors;
}

export function buildCreateRunInput(validationInput: NewRunValidationInput): CreateRunInput {
  const fieldErrors = validateNewRunInput(validationInput);
  if (fieldErrors.length > 0) {
    throw new NewRunInputValidationError(fieldErrors);
  }

  const source = validationInput.source;
  if (!source) {
    throw new NewRunInputValidationError([
      {
        field: "resume",
        code: "REQUIRED",
        message: "请选择并解析简历。",
      },
    ]);
  }

  const normalized = normalizeInputDraft(validationInput.input);
  return Object.freeze({
    resumeSourceId: source.id,
    company: normalized.company,
    title: normalized.title,
    jdText: normalized.jdText,
  });
}
