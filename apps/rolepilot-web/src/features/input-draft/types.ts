import type { ApiError, InputDraftDto, InputDraftInput, InputFieldError } from "web-contracts";

export type DraftEditableField = "company" | "title" | "jdText";

export type DraftUiError = Pick<ApiError, "code" | "message" | "retryable"> & {
  fieldErrors?: InputFieldError[];
};

export type DraftConflict = {
  serverDraft: InputDraftDto;
};

export type DraftSaveState = "idle" | "loading" | "saving" | "saved" | "error" | "conflict";

export const EMPTY_DRAFT_INPUT: InputDraftInput = {
  resumeSourceId: null,
  company: "",
  title: "",
  jdText: "",
};
