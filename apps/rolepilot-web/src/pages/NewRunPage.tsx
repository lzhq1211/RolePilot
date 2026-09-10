import { ArrowLeft, ArrowRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  buildCreateRunInput,
  NewRunInputValidationError,
  validateNewRunInput,
  type InputFieldError,
} from "web-contracts";
import { Scanner } from "../components/Scanner";
import { Workflow } from "../components/Workflow";
import { getResumeSource } from "../features/resume-source/api";
import { ResumeCard } from "../features/resume-source/ResumeCard";
import { useResumeSource } from "../features/resume-source/useResumeSource";
import { createRun } from "../features/run/run-api";
import { TargetInputCard } from "../features/input-draft/TargetInputCard";
import { useInputDraft } from "../features/input-draft/useInputDraft";

export function NewRunPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const draftId = searchParams.get("draft");
  const resumeSource = useResumeSource();
  const [validationErrors, setValidationErrors] = useState<InputFieldError[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isSubmittingRef = useRef(false);
  const summaryRef = useRef<HTMLDivElement>(null);
  const submitControllerRef = useRef<AbortController | null>(null);
  const navigate = useNavigate();
  const inputDraft = useInputDraft({
    draftId,
    sourceId: resumeSource.retainedSource?.id ?? null,
    onDraftId: useCallback(
      (nextDraftId: string) => {
        setSearchParams((current) => {
          const next = new URLSearchParams(current);
          next.set("draft", nextDraftId);
          return next;
        }, { replace: true });
      },
      [setSearchParams],
    ),
  });

  const draftSourceId = inputDraft.draft?.resumeSourceId ?? null;
  const activeSourceId = resumeSource.retainedSource?.id ?? null;
  useEffect(() => {
    if (!draftSourceId || draftSourceId === activeSourceId) return;
    const controller = new AbortController();
    void getResumeSource({ sourceId: draftSourceId, signal: controller.signal })
      .then(resumeSource.restoreSource)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) resumeSource.restoreError(error);
      });
    return () => controller.abort();
  }, [activeSourceId, draftSourceId, resumeSource.restoreError, resumeSource.restoreSource]);

  useEffect(() => {
    return () => submitControllerRef.current?.abort();
  }, []);

  const sourceBusy = resumeSource.state.kind === "uploading" || resumeSource.state.kind === "extracting";
  const validationInput = {
    source: resumeSource.retainedSource,
    sourceBusy,
    input: inputDraft.input,
    hasDraftConflict: inputDraft.conflict !== null,
  };
  const currentValidationErrors = validateNewRunInput(validationInput);
  const canSubmit = currentValidationErrors.length === 0 && !isSubmitting;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSubmittingRef.current) return;
    let createRunInput;
    try {
      createRunInput = buildCreateRunInput(validationInput);
    } catch (error) {
      const errors = error instanceof NewRunInputValidationError
        ? error.fieldErrors
        : currentValidationErrors;
      setValidationErrors(errors);
      window.requestAnimationFrame(() => summaryRef.current?.focus());
      return;
    }

    submitControllerRef.current?.abort();
    const controller = new AbortController();
    submitControllerRef.current = controller;
    isSubmittingRef.current = true;
    setValidationErrors([]);
    setIsSubmitting(true);
    try {
      const result = await createRun(createRunInput, controller.signal);
      if (!controller.signal.aborted) navigate(`/runs/${result.id}`);
    } catch (error) {
      if (!controller.signal.aborted) {
        setValidationErrors([{ field: "resume", code: "RUN_FAILED", message: "提交运行失败，请重试。" }]);
      }
    } finally {
      if (!controller.signal.aborted) {
        isSubmittingRef.current = false;
        setIsSubmitting(false);
      }
    }
  };

  return (
    <section className="new-run-page">
      <div className="scanner-hero scanner-hero--compact">
        <Scanner />
        <div className="hero-copy">
          <p className="eyebrow">NEW RUN</p>
          <h1>创建优化任务</h1>
        </div>
      </div>
      <form onSubmit={handleSubmit}>
        <section className="new-run-shell" aria-labelledby="new-run-shell-title">
          <div className="new-run-materials">
            <p className="eyebrow">WORKSPACE</p>
            <h2 id="new-run-shell-title">材料准备</h2>
            <ResumeCard
              onCreateFromFile={resumeSource.createFromFile}
              onCreateFromPastedText={resumeSource.createFromPastedText}
              retainedSource={resumeSource.retainedSource}
              state={resumeSource.state}
            />
            <TargetInputCard
              conflict={inputDraft.conflict}
              error={inputDraft.error}
              input={inputDraft.input}
              keepLocalDraft={inputDraft.keepLocalDraft}
              loadState={inputDraft.loadState}
              saveState={inputDraft.saveState}
              setField={inputDraft.setField}
              useServerDraft={inputDraft.useServerDraft}
              validationErrors={validationErrors}
            />
          </div>
          <Workflow />
        </section>
        {validationErrors.length > 0 && (
          <div ref={summaryRef} className="new-run-validation" role="alert" tabIndex={-1}>
            <strong>请先补全提交信息</strong>
            <ul>
              {validationErrors.map((error) => <li key={`${error.field}-${error.code}`}>{error.message}</li>)}
            </ul>
          </div>
        )}
        <div className="new-run-submit-row">
          <button
            type="submit"
            className="button button-primary"
            disabled={!canSubmit}
            aria-disabled={!canSubmit}
          >
            <ArrowRight aria-hidden="true" />
            {isSubmitting ? "提交中" : "开始分析与改写"}
          </button>
        </div>
      </form>
      <Link className="button button-ghost" to="/">
        <ArrowLeft aria-hidden="true" />
        返回任务
      </Link>
    </section>
  );
}
