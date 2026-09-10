import type { SourceErrorCode } from "web-contracts";

const SOURCE_ERROR_DETAILS: Record<SourceErrorCode, { message: string; retryable: boolean }> = {
  FILE_TOO_LARGE: {
    message: "文件超过 10 MiB 限制。",
    retryable: false,
  },
  UNSUPPORTED_EXTENSION: {
    message: "仅支持 TXT、PDF 或 DOCX 文件。",
    retryable: false,
  },
  UNSUPPORTED_MEDIA_TYPE: {
    message: "文件类型不受支持。",
    retryable: false,
  },
  CONTENT_SIGNATURE_MISMATCH: {
    message: "文件内容与声明格式不一致。",
    retryable: false,
  },
  EMPTY_DOCUMENT: {
    message: "文档不包含可用文本。",
    retryable: false,
  },
  TEXT_TOO_LONG: {
    message: "提取文本超过 200,000 字符限制。",
    retryable: false,
  },
  ENCODING_UNSUPPORTED: {
    message: "TXT 文件编码不受支持。",
    retryable: false,
  },
  PDF_TEXT_UNAVAILABLE: {
    message: "PDF 中没有可提取文本。",
    retryable: false,
  },
  PDF_ENCRYPTED: {
    message: "PDF 已加密，无法读取。",
    retryable: false,
  },
  DOCX_INVALID: {
    message: "DOCX 文件无效。",
    retryable: false,
  },
  DOCX_ARCHIVE_LIMIT: {
    message: "DOCX 文件超过安全解析限制。",
    retryable: false,
  },
  PARSER_TIMEOUT: {
    message: "解析超时。",
    retryable: true,
  },
  PARSER_FAILED: {
    message: "无法读取这份文档。",
    retryable: false,
  },
};

export class DocumentIngestError extends Error {
  readonly code: SourceErrorCode;
  readonly retryable: boolean;

  constructor(code: SourceErrorCode) {
    const detail = SOURCE_ERROR_DETAILS[code];
    super(detail.message);
    this.name = "DocumentIngestError";
    this.code = code;
    this.retryable = detail.retryable;
  }
}
