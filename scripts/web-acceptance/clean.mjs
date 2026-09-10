import fs from "node:fs/promises";
import path from "node:path";
import { config, session, outputRoot, until } from "./config.mjs";
import { client } from "./client.mjs";

await fs.access(path.join(outputRoot, "session.json"));
const settings = await config();
const saved = await session(settings);
const { createInstance } = await import("./runtime.mjs");
for (const which of ["A", "B"]) {
  const app = await createInstance(settings, saved, which);
  try {
    const api = client(await app.start());
    for (const run of await app.runs.list()) if (["QUEUED", "RUNNING"].includes(run.status)) await api.request(`/api/runs/${run.id}/cancel`, "POST");
    await until(() => app.runs.list(), (runs) => !runs.some((run) => ["QUEUED", "RUNNING"].includes(run.status)), "Worker 退出");
    await api.clear();
    await until(() => app.cleanup.status(), (s) => { if (s.failed || s.errorCode) throw new Error("清理失败；请使用维护重试入口。"); return !s.maintaining && s.pending === 0; }, "实例清理");
  } finally { await app.stop(); }
}
console.log("已清理当前 session 的 A/B 云端 fixture；本地下载文件保留供人工检查。");
