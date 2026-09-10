import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { InputDraftDto, InputDraftInput } from "web-contracts";

import { SOURCE_LIMITS } from "web-contracts";
import {
  createInputDraft,
  getInputDraft,
  InputDraftRequestError,
  updateInputDraft,
} from "./api";
import {
  EMPTY_DRAFT_INPUT,
  type DraftConflict,
  type DraftEditableField,
  type DraftSaveState,
  type DraftUiError,
} from "./types";

export function useInputDraft({
  draftId,
  sourceId,
  onDraftId,
}: {
  draftId: string | null;
  sourceId: string | null;
  onDraftId: (draftId: string) => void;
}) {
  const [input, setInput] = useState<InputDraftInput>({
    ...EMPTY_DRAFT_INPUT,
    resumeSourceId: sourceId,
  });
  const [draft, setDraft] = useState<InputDraftDto | null>(null);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "ready" | "error">(
    draftId ? "loading" : "ready",
  );
  const [saveState, setSaveState] = useState<DraftSaveState>("idle");
  const [error, setError] = useState<DraftUiError | null>(null);
  const [conflict, setConflict] = useState<DraftConflict | null>(null);
  const inputRef = useRef(input);
  const draftRef = useRef<InputDraftDto | null>(draft);
  const draftIdRef = useRef(draftId);
  const dirtyRef = useRef(false);
  const loadVersionRef = useRef(0);
  const saveVersionRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    draftIdRef.current = draftId;
    loadVersionRef.current += 1;
    saveVersionRef.current += 1;
    clearScheduledSave(timerRef);
    controllerRef.current?.abort();
    controllerRef.current = null;
    dirtyRef.current = false;
    setDraft(null);
    draftRef.current = null;
    setConflict(null);
    setError(null);
    setSaveState("idle");
    const initialInput = { ...EMPTY_DRAFT_INPUT, resumeSourceId: sourceId };
    inputRef.current = initialInput;
    setInput(initialInput);

    if (!draftId) {
      setLoadState("ready");
      return;
    }

    const version = loadVersionRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoadState("loading");
    void getInputDraft(draftId, { signal: controller.signal })
      .then((loaded) => {
        if (controller.signal.aborted || version !== loadVersionRef.current) return;
        draftRef.current = loaded;
        setDraft(loaded);
        if (!dirtyRef.current) {
          inputRef.current = draftInput(loaded);
          setInput(inputRef.current);
        }
        setLoadState("ready");
        setSaveState("saved");
      })
      .catch((requestError: unknown) => {
        if (controller.signal.aborted || version !== loadVersionRef.current) return;
        setLoadState("error");
        setSaveState("error");
        setError(toUiError(requestError));
      });

    return () => controller.abort();
  }, [draftId]);

  useEffect(() => {
    if (inputRef.current.resumeSourceId === sourceId) return;
    const next = { ...inputRef.current, resumeSourceId: sourceId };
    inputRef.current = next;
    setInput(next);
    if (sourceId !== null && (draftIdRef.current !== null || hasTargetInput(next))) {
      dirtyRef.current = true;
    }
  }, [draftId, sourceId]);

  useEffect(() => {
    if (!dirtyRef.current || loadState !== "ready" || conflict) return;
    scheduleSave(timerRef, saveVersionRef, controllerRef, saveDraft, SOURCE_LIMITS.draftDebounceMs);
    return () => clearScheduledSave(timerRef);
  }, [input, loadState, conflict]);

  const setField = (field: DraftEditableField, value: string) => {
    saveVersionRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    dirtyRef.current = true;
    setError(null);
    setSaveState("idle");
    setInput((current) => {
      const next = { ...current, [field]: value };
      inputRef.current = next;
      return next;
    });
  };

  const keepLocalDraft = () => {
    if (!conflict) return;
    draftRef.current = conflict.serverDraft;
    setDraft(conflict.serverDraft);
    setConflict(null);
    setError(null);
    dirtyRef.current = true;
    saveVersionRef.current += 1;
    scheduleSave(timerRef, saveVersionRef, controllerRef, saveDraft, 0);
  };

  const useServerDraft = () => {
    if (!conflict) return;
    const next = draftInput(conflict.serverDraft);
    draftRef.current = conflict.serverDraft;
    setDraft(conflict.serverDraft);
    inputRef.current = next;
    setInput(next);
    setConflict(null);
    setError(null);
    dirtyRef.current = false;
    setSaveState("saved");
  };

  async function saveDraft() {
    const version = saveVersionRef.current;
    const currentInput = inputRef.current;
    const currentDraft = draftRef.current;
    const currentDraftId = draftIdRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    setSaveState("saving");
    setError(null);

    try {
      const saved = currentDraftId && currentDraft
        ? await updateInputDraft(currentDraftId, currentDraft.revision, currentInput, { signal: controller.signal })
        : await createInputDraft(currentInput, { signal: controller.signal });
      if (controller.signal.aborted || version !== saveVersionRef.current) return;
      draftRef.current = saved;
      setDraft(saved);
      draftIdRef.current = saved.id;
      dirtyRef.current = false;
      setSaveState("saved");
      onDraftId(saved.id);
    } catch (requestError: unknown) {
      if (controller.signal.aborted || version !== saveVersionRef.current) return;
      if (isConflictError(requestError) && currentDraftId) {
        await loadConflict(currentDraftId, version);
        return;
      }
      setSaveState("error");
      setError(toUiError(requestError));
    }
  }

  async function loadConflict(currentDraftId: string, version: number) {
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    try {
      const serverDraft = await getInputDraft(currentDraftId, { signal: controller.signal });
      if (controller.signal.aborted || version !== saveVersionRef.current) return;
      setConflict({ serverDraft });
      setSaveState("conflict");
      setError({
        code: "DRAFT_CONFLICT",
        message: "草稿已在其他位置更新，请选择保留本地内容或已保存内容。",
        retryable: false,
      });
    } catch (requestError: unknown) {
      if (controller.signal.aborted || version !== saveVersionRef.current) return;
      setSaveState("error");
      setError(toUiError(requestError));
    }
  }

  return {
    conflict,
    draft,
    error,
    input,
    keepLocalDraft,
    loadState,
    saveState,
    setField,
    useServerDraft,
  };
}

function draftInput(draft: InputDraftDto): InputDraftInput {
  return {
    resumeSourceId: draft.resumeSourceId,
    company: draft.company,
    title: draft.title,
    jdText: draft.jdText,
  };
}

function scheduleSave(
  timerRef: MutableRefObject<number | null>,
  saveVersionRef: MutableRefObject<number>,
  controllerRef: MutableRefObject<AbortController | null>,
  save: () => Promise<void>,
  delay: number,
) {
  clearScheduledSave(timerRef);
  controllerRef.current?.abort();
  controllerRef.current = null;
  const version = saveVersionRef.current;
  timerRef.current = window.setTimeout(() => {
    if (version !== saveVersionRef.current) return;
    void save();
  }, delay);
}

function clearScheduledSave(timerRef: MutableRefObject<number | null>) {
  if (timerRef.current !== null) {
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }
}

function hasTargetInput(input: InputDraftInput): boolean {
  return Boolean(input.company.trim() || input.title.trim() || input.jdText.trim());
}

function toUiError(error: unknown): DraftUiError {
  if (error instanceof InputDraftRequestError) return error.apiError;
  return {
    code: "NETWORK_ERROR",
    message: "服务暂时不可用，请稍后重试。",
    retryable: true,
  };
}

function isConflictError(error: unknown): boolean {
  return error instanceof InputDraftRequestError && error.apiError.code === "DRAFT_CONFLICT";
}
