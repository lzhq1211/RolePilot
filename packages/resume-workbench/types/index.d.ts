import type { ResumeContentV3 } from "web-contracts/resume-document";

export type WorkbenchDocument = ResumeContentV3;

export interface WorkbenchOptions {
  document?: WorkbenchDocument;
  loadSample?: boolean;
  onChange?: (document: WorkbenchDocument) => void;
  onSave?: (
    document: WorkbenchDocument,
  ) => boolean | void | Promise<boolean | void>;
}

export declare function startWorkbench(options?: WorkbenchOptions): void;
export declare function loadDocument(content: WorkbenchDocument): void;
export declare function readDocument(): WorkbenchDocument;
export declare function isDirty(): boolean;
export declare function clearDirty(): void;
