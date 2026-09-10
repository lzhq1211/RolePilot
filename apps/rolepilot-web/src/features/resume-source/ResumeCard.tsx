import {
  ClipboardPaste,
  FileText,
  LoaderCircle,
  Upload,
} from "lucide-react";
import {
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import type { ResumeSourceDto } from "web-contracts";

import type { ResumeInputMode, ResumeSourceUiState } from "./types";

export function ResumeCard({
  onCreateFromFile,
  onCreateFromPastedText,
  retainedSource,
  state,
}: {
  onCreateFromFile: (file: File) => void;
  onCreateFromPastedText: (text: string) => void;
  retainedSource: ResumeSourceDto | null;
  state: ResumeSourceUiState;
}) {
  const [inputMode, setInputMode] = useState<ResumeInputMode>("file");
  const [pastedText, setPastedText] = useState("");
  const [isDragActive, setIsDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isBusy = state.kind === "uploading" || state.kind === "extracting";
  const status = statusCopy(state, retainedSource);

  const handleFileSelected = (file: File | null) => {
    if (!file) return;
    onCreateFromFile(file);
  };

  const openFilePicker = () => fileInputRef.current?.click();

  const handleFileInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    handleFileSelected(event.target.files?.item(0) ?? null);
    event.target.value = "";
  };

  const handleDrop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setIsDragActive(false);
    handleFileSelected(event.dataTransfer.files.item(0));
  };

  return (
    <section className="resume-card" aria-labelledby="resume-source-title">
      <div className="resume-card-header">
        <div>
          <p className="eyebrow">RESUME SOURCE</p>
          <h2 id="resume-source-title">简历来源</h2>
        </div>
        <div className="source-mode" role="group" aria-label="简历输入方式">
          <button
            type="button"
            aria-pressed={inputMode === "file"}
            className={inputMode === "file" ? "source-mode-button source-mode-button--active" : "source-mode-button"}
            onClick={() => setInputMode("file")}
          >
            上传文件
          </button>
          <button
            type="button"
            aria-pressed={inputMode === "pasted-text"}
            className={inputMode === "pasted-text" ? "source-mode-button source-mode-button--active" : "source-mode-button"}
            onClick={() => setInputMode("pasted-text")}
          >
            粘贴文本
          </button>
        </div>
      </div>

      {inputMode === "file" ? (
        <>
          <input
            ref={fileInputRef}
            className="visually-hidden"
            type="file"
            accept=".pdf,application/pdf,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.txt,text/plain"
            aria-label="本地简历文件输入"
            onChange={handleFileInputChange}
          />
          <button
            type="button"
            className={isDragActive ? "source-dropzone source-dropzone--dragging" : "source-dropzone"}
            aria-label="选择简历文件"
            data-source-dropzone
            disabled={isBusy}
            onClick={openFilePicker}
            onDragEnter={(event) => {
              event.preventDefault();
              setIsDragActive(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => setIsDragActive(false)}
            onDrop={handleDrop}
          >
            {isBusy ? (
              <LoaderCircle className="source-status-icon source-status-icon--spinning" aria-hidden="true" />
            ) : retainedSource ? (
              <FileText className="source-status-icon" aria-hidden="true" />
            ) : (
              <Upload className="source-status-icon" aria-hidden="true" />
            )}
            <span className="source-dropzone-title">{status.title}</span>
            <span className="source-dropzone-detail" title={status.detail}>
              {status.detail}
            </span>
          </button>
        </>
      ) : (
        <div className="source-paste-field">
          <label htmlFor="resume-pasted-text">简历正文</label>
          <textarea
            id="resume-pasted-text"
            aria-label="粘贴简历正文"
            value={pastedText}
            disabled={isBusy}
            placeholder="粘贴简历正文"
            onChange={(event) => setPastedText(event.target.value)}
          />
          {(isBusy || retainedSource) && (
            <div className="source-paste-status" aria-live="polite">
              {isBusy ? (
                <LoaderCircle className="source-paste-status-icon source-status-icon--spinning" aria-hidden="true" />
              ) : (
                <FileText className="source-paste-status-icon" aria-hidden="true" />
              )}
              <span>{status.title}</span>
              <span className="source-paste-status-detail">{status.detail}</span>
            </div>
          )}
          <div className="source-paste-footer">
            <span>{[...pastedText].length} 字</span>
            <button
              type="button"
              className="button button-primary source-parse-button"
              disabled={isBusy}
              onClick={() => onCreateFromPastedText(pastedText)}
            >
              <ClipboardPaste aria-hidden="true" />
              解析并使用
            </button>
          </div>
        </div>
      )}

      {state.kind === "failed" && (
        <div className="source-error" role="alert">
          <span>{state.error.message}</span>
          <div className="source-error-actions">
            <button type="button" className="button button-secondary" onClick={() => setInputMode("file")}>
              替换文件
            </button>
            <button type="button" className="button button-ghost" onClick={() => setInputMode("pasted-text")}>
              改为粘贴
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function statusCopy(state: ResumeSourceUiState, retainedSource: ResumeSourceDto | null) {
  if (state.kind === "uploading") {
    return { title: "正在上传", detail: state.fileName };
  }
  if (state.kind === "extracting") {
    return { title: "正在解析", detail: state.fileName };
  }
  if (retainedSource) {
    const name = retainedSource.originalFileName ?? "粘贴的简历文本";
    const length = retainedSource.textLength === null ? "已解析" : `${retainedSource.textLength.toLocaleString("zh-CN")} 字`;
    return { title: "简历可用", detail: `${name} · ${length}` };
  }
  return { title: "选择简历文件", detail: "支持 PDF、DOCX 或 TXT" };
}
