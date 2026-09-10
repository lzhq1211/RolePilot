import type { WorkbenchDocumentContent, WorkbenchDocumentDto, WorkbenchDto } from "web-contracts";

export type WorkbenchSession = { runId: string | null; activeVariant: "original" | "generated"; document: WorkbenchDocumentContent | null; revision: number; editSequence: number; requestSequence: number };

export function createSession(runId: string | null): WorkbenchSession {
  return { runId, activeVariant: "generated", document: null, revision: 0, editSequence: 0, requestSequence: 0 };
}

export function documentFor(dto: WorkbenchDto, variant: "original" | "generated"): WorkbenchDocumentDto | null {
  const document = variant === "generated" ? dto.generated : dto.original;
  return document.availability === "AVAILABLE" ? document : null;
}

export function setDocument(session: WorkbenchSession, variant: "original" | "generated", document: WorkbenchDocumentDto): void {
  if (document.availability !== "AVAILABLE") throw new Error("该版本暂无可用正文。");
  session.activeVariant = variant;
  session.document = structuredClone(document.content);
  session.revision = document.revision;
  session.editSequence = 0;
}
