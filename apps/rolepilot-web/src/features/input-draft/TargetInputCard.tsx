import { AlertTriangle, Check, LoaderCircle } from "lucide-react";
import { useState, type ReactNode } from "react";
import { validateInputDraft, type InputFieldError } from "web-contracts";

import type { DraftConflict, DraftEditableField, DraftSaveState, DraftUiError } from "./types";
import type { InputDraftInput } from "web-contracts";

export function TargetInputCard({
  conflict,
  error,
  input,
  keepLocalDraft,
  loadState,
  saveState,
  setField,
  useServerDraft,
  validationErrors,
}: {
  conflict: DraftConflict | null;
  error: DraftUiError | null;
  input: InputDraftInput;
  keepLocalDraft: () => void;
  loadState: "idle" | "loading" | "ready" | "error";
  saveState: DraftSaveState;
  setField: (field: DraftEditableField, value: string) => void;
  useServerDraft: () => void;
  validationErrors: InputFieldError[];
}) {
  const [touched, setTouched] = useState<Set<DraftEditableField>>(() => new Set());
  const localErrors = validateInputDraft(input, { requireValues: true });
  const isLoading = loadState === "loading";

  const markTouched = (field: DraftEditableField) => {
    setTouched((current) => new Set(current).add(field));
  };

  const fieldError = (field: DraftEditableField): InputFieldError | undefined => {
    const contractField = field === "jdText" ? "jd" : field;
    const submitError = validationErrors.find((item) => item.field === contractField);
    if (submitError) return submitError;
    if (error?.fieldErrors?.some((item) => item.field === contractField)) {
      return error.fieldErrors.find((item) => item.field === contractField);
    }
    return touched.has(field)
      ? localErrors.find((item) => item.field === contractField)
      : undefined;
  };

  return (
    <section className="target-input-card" aria-labelledby="target-input-title">
      <div className="target-input-header">
        <div>
          <p className="eyebrow">TARGET ROLE</p>
          <h2 id="target-input-title">目标信息</h2>
        </div>
        <DraftStatus loadState={loadState} saveState={saveState} />
      </div>

      <div className="target-input-fields">
        <div className="target-company-field">
          <input
            id="target-company"
            aria-label="公司名称"
            className={fieldError("company") ? "target-company-input target-field--error" : "target-company-input"}
            disabled={isLoading}
            placeholder="公司名称"
            value={input.company}
            onBlur={() => markTouched("company")}
            onChange={(event) => setField("company", event.target.value)}
          />
          <FieldError error={fieldError("company")} />
        </div>
        <div className="target-title-field">
          <label htmlFor="target-job-title">目标岗位</label>
          <input
            id="target-job-title"
            className={fieldError("title") ? "target-input target-field--error" : "target-input"}
            disabled={isLoading}
            value={input.title}
            onBlur={() => markTouched("title")}
            onChange={(event) => setField("title", event.target.value)}
          />
          <FieldError error={fieldError("title")} />
        </div>
      </div>

      <div className="target-jd-field">
        <label htmlFor="target-jd-text">岗位描述（JD）</label>
        <textarea
          id="target-jd-text"
          className={fieldError("jdText") ? "target-textarea target-field--error" : "target-textarea"}
          disabled={isLoading}
          placeholder="粘贴岗位描述"
          value={input.jdText}
          onBlur={() => markTouched("jdText")}
          onChange={(event) => setField("jdText", event.target.value)}
        />
        <div className="target-jd-footer">
          <FieldError error={fieldError("jdText")} />
          <span>{[...input.jdText].length.toLocaleString("zh-CN")} 字</span>
        </div>
      </div>

      {error && !error.fieldErrors?.length && (
        <div className="draft-error" role="alert">
          {error.message}
        </div>
      )}

      {conflict && (
        <div className="draft-conflict" role="alert">
          <div>
            <strong>草稿存在新版本</strong>
            <span>选择要保留的内容。</span>
          </div>
          <div className="draft-conflict-actions">
            <button type="button" className="button button-secondary" onClick={keepLocalDraft}>
              保留本地内容
            </button>
            <button type="button" className="button button-ghost" onClick={useServerDraft}>
              使用已保存内容
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function DraftStatus({
  loadState,
  saveState,
}: {
  loadState: "idle" | "loading" | "ready" | "error";
  saveState: DraftSaveState;
}) {
  if (loadState === "loading") {
    return <Status className="draft-status--loading" icon={<LoaderCircle />} text="正在恢复" />;
  }
  if (saveState === "saving") {
    return <Status className="draft-status--loading" icon={<LoaderCircle />} text="保存中" />;
  }
  if (saveState === "saved") {
    return <Status className="draft-status--saved" icon={<Check />} text="已保存" />;
  }
  if (saveState === "conflict") {
    return <Status className="draft-status--error" icon={<AlertTriangle />} text="需要确认" />;
  }
  if (loadState === "error" || saveState === "error") {
    return <Status className="draft-status--error" icon={<AlertTriangle />} text="保存失败" />;
  }
  return null;
}

function Status({
  className,
  icon,
  text,
}: {
  className: string;
  icon: ReactNode;
  text: string;
}) {
  return (
    <span className={`draft-status ${className}`} aria-live="polite">
      {icon}
      {text}
    </span>
  );
}

function FieldError({ error }: { error: InputFieldError | undefined }) {
  return error ? <span className="target-field-error">{error.message}</span> : null;
}
