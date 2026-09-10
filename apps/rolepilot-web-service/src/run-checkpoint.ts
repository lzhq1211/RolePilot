import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 2048;
type RecoveryBundle = { version: 1; runId: string; root: string; files: Array<{ path: string; base64: string }> };

export class CheckpointRecoveryError extends Error {
  constructor() { super("CHECKPOINT_INVALID"); }
}

/** Persist the checkpoint store plus all dependent artifacts, including hidden state. */
export async function packRunCheckpoint(root: string, runId: string): Promise<Uint8Array> {
  const files: RecoveryBundle["files"] = [];
  let total = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new CheckpointRecoveryError();
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        const bytes = await readFile(absolute);
        total += bytes.byteLength;
        if (total > MAX_BYTES || files.length >= MAX_FILES) throw new CheckpointRecoveryError();
        files.push({ path: path.relative(root, absolute).split(path.sep).join("/"), base64: bytes.toString("base64") });
      } else throw new CheckpointRecoveryError();
    }
  };
  await visit(root);
  if (!files.some((file) => file.path === checkpointPath(runId))) throw new CheckpointRecoveryError();
  return Buffer.from(JSON.stringify({ version: 1, runId, root: path.resolve(root), files } satisfies RecoveryBundle));
}

export async function restoreRunCheckpoint(bytes: Uint8Array, root: string, runId: string): Promise<void> {
  try {
    if (bytes.byteLength > MAX_BYTES * 1.5) throw new CheckpointRecoveryError();
    const bundle = JSON.parse(Buffer.from(bytes).toString("utf8")) as RecoveryBundle;
    // Existing rolepilot-engine snapshots contain absolute paths. A changed work root is
    // explicitly rejected rather than rewriting arbitrary snapshot content.
    if (bundle.version !== 1 || bundle.runId !== runId || bundle.root !== path.resolve(root) || !Array.isArray(bundle.files) || bundle.files.length > MAX_FILES) throw new CheckpointRecoveryError();
    const seen = new Set<string>();
    let total = 0;
    const files = bundle.files.map((file) => {
      if (typeof file.path !== "string" || typeof file.base64 !== "string" || !file.path || path.isAbsolute(file.path) || file.path.includes("\\") || file.path.includes("\0") || file.path.split("/").some((part) => !part || part === "." || part === "..") || seen.has(file.path)) throw new CheckpointRecoveryError();
      seen.add(file.path);
      const content = Buffer.from(file.base64, "base64");
      total += content.byteLength;
      if (total > MAX_BYTES || content.toString("base64") !== file.base64) throw new CheckpointRecoveryError();
      return { ...file, content };
    });
    if (!seen.has(checkpointPath(runId))) throw new CheckpointRecoveryError();
    await mkdir(root, { recursive: true });
    if ((await lstat(root)).isSymbolicLink()) throw new CheckpointRecoveryError();
    for (const file of files) {
      let directory = root;
      for (const segment of file.path.split("/").slice(0, -1)) {
        directory = path.join(directory, segment);
        await mkdir(directory, { recursive: true });
        if (!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink()) throw new CheckpointRecoveryError();
      }
      // A resumed workspace is restored once into an empty run directory.
      await writeFile(path.join(root, file.path), file.content, { flag: "wx" });
    }
  } catch { throw new CheckpointRecoveryError(); }
}

function checkpointPath(runId: string): string {
  return `.state/checkpoints/${runId}/resume-vertical-slice.json`;
}
