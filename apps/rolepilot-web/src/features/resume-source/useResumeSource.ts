import { useCallback, useEffect, useRef, useState } from "react";
import type { ResumeSourceDto } from "web-contracts";

import {
  createClientRequestId,
  createFileResumeSource,
  createPastedResumeSource,
  ResumeSourceRequestError,
} from "./api";
import type { ResumeSourceUiError, ResumeSourceUiState } from "./types";

const EXTRACTING_DELAY_MS = 180;

const EMPTY_STATE: ResumeSourceUiState = { kind: "empty" };

export function useResumeSource() {
  const [state, setState] = useState<ResumeSourceUiState>(EMPTY_STATE);
  const activeSourceRef = useRef<ResumeSourceDto | null>(null);
  const requestRef = useRef<{ controller: AbortController; requestId: string } | null>(null);

  useEffect(() => {
    return () => requestRef.current?.controller.abort();
  }, []);

  const createFromFile = (file: File) => {
    startRequest({
      fileName: file.name,
      request: (requestId, signal) => createFileResumeSource({ file, requestId, signal }),
    });
  };

  const createFromPastedText = (text: string) => {
    if (!text.trim()) {
      setState({
        kind: "failed",
        previous: activeSourceRef.current,
        error: {
          code: "EMPTY_DOCUMENT",
          message: "请粘贴非空的简历正文。",
          retryable: false,
        },
      });
      return;
    }

    startRequest({
      fileName: "粘贴的简历文本",
      request: (requestId, signal) => createPastedResumeSource({ text, requestId, signal }),
    });
  };

  const restoreSource = useCallback((source: ResumeSourceDto) => {
    activeSourceRef.current = source.status === "READY" ? source : null;
    if (source.status === "READY") {
      setState({ kind: "ready", source });
      return;
    }
    setState({
      kind: "failed",
      previous: null,
      error: source.error ?? parserFailedError(),
    });
  }, []);

  const restoreError = useCallback((error: unknown) => {
    setFailed(toUiError(error));
  }, []);

  const startRequest = ({
    fileName,
    request,
  }: {
    fileName: string;
    request: (requestId: string, signal: AbortSignal) => Promise<ResumeSourceDto>;
  }) => {
    requestRef.current?.controller.abort();
    const controller = new AbortController();
    const requestId = createClientRequestId();
    requestRef.current = { controller, requestId };
    setState({ kind: "uploading", fileName, requestId });

    const extractingTimer = window.setTimeout(() => {
      if (requestRef.current?.requestId === requestId) {
        setState({ kind: "extracting", fileName, requestId });
      }
    }, EXTRACTING_DELAY_MS);

    void request(requestId, controller.signal)
      .then((source) => {
        if (requestRef.current?.requestId !== requestId) return;
        if (source.status === "READY") {
          activeSourceRef.current = source;
          setState({ kind: "ready", source });
          return;
        }
        if (source.status === "EXTRACTING" || source.status === "UPLOADING") {
          setState({ kind: "extracting", fileName, requestId });
          return;
        }
        setFailed(source.error ?? parserFailedError());
      })
      .catch((error: unknown) => {
        if (requestRef.current?.requestId !== requestId || isAbortError(error)) return;
        setFailed(toUiError(error));
      })
      .finally(() => window.clearTimeout(extractingTimer));
  };

  const setFailed = (error: ResumeSourceUiError) => {
    setState({ kind: "failed", previous: activeSourceRef.current, error });
  };

  const retainedSource =
    state.kind === "ready"
      ? state.source
      : state.kind === "failed"
        ? state.previous
        : activeSourceRef.current;

  return {
    createFromFile,
    createFromPastedText,
    restoreError,
    restoreSource,
    retainedSource,
    state,
  };
}

function toUiError(error: unknown): ResumeSourceUiError {
  if (error instanceof ResumeSourceRequestError) {
    return error.apiError;
  }
  return {
    code: "NETWORK_ERROR",
    message: "服务暂时不可用，请稍后重试。",
    retryable: true,
  };
}

function parserFailedError(): ResumeSourceUiError {
  return {
    code: "PARSER_FAILED",
    message: "文档暂时无法解析，请更换文件或改为粘贴文本。",
    retryable: true,
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
