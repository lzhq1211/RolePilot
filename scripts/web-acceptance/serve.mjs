import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { config, session, root, until } from "./config.mjs";

const jsonMode = process.argv.includes("--json");
let app, vite;
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  vite?.kill("SIGTERM");
  await app?.stop();
};
try {
  const settings = await config();
  const saved = await session(settings, process.argv.includes("--new"));
  const { createInstance } = await import("./runtime.mjs");
  app = await createInstance(settings, saved);
  const apiUrl = await app.start(settings.apiPort);
  await fs.mkdir(saved.workDir, { recursive: true });
  const resumeFile = path.join(saved.workDir, "resume.txt");
  await fs.writeFile(resumeFile, app.fixture.resumeText);
  await fs.writeFile(path.join(saved.workDir, "session.json"), JSON.stringify(saved, null, 2));
  const require = createRequire(path.join(root, "apps/rolepilot-web/package.json"));
  const viteBin = path.join(path.dirname(require.resolve("vite/package.json")), "bin/vite.js");
  vite = spawn(process.execPath, [viteBin, "--host", "127.0.0.1", "--strictPort", "--port", String(settings.webPort)], {
    cwd: path.join(root, "apps/rolepilot-web"), env: { ...process.env, ROLEPILOT_API_TARGET: apiUrl }, stdio: ["ignore", "ignore", "inherit"],
  });
  const webUrl = `http://127.0.0.1:${settings.webPort}`;
  await until(async () => {
    if (vite.exitCode !== null) throw new Error("前端启动失败，请检查端口或依赖。");
    return fetch(webUrl).then((r) => r.ok).catch(() => false);
  }, Boolean, "前端启动");
  const ready = () => ({ type: "ready", webUrl, apiUrl, resumeFile, workDir: saved.workDir, instance: app.instance, jdText: app.fixture.jdText, evidenceText: app.fixture.evidenceText });
  process.stdout.write(jsonMode ? `${JSON.stringify(ready())}\n` : `验收页面：${webUrl}/new\n简历 fixture：${resumeFile}\n普通流程公司名用 W6 normal；补证用 W6 evidence；取消用 W6 cancel。Ctrl+C 停止。\n`);
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { void stop().then(() => process.exit(0)); });
  if (jsonMode) {
    for await (const line of readline.createInterface({ input: process.stdin })) {
      const command = JSON.parse(line);
      if (command.type === "quit") break;
      if (!/^[0-9a-f-]{36}$/i.test(command.runId)) throw new Error("控制命令无效。");
      if (command.type === "check-cleaned") {
        await until(async () => { await app.cleanup.scan(); return app.runs.get(command.runId, { includeDeleted: true }); }, (run) => run === null, "Run 物理清理");
        if ((await app.stores.artifacts.list(`instances/${app.instance}/runs/${command.runId}/`)).length) throw new Error("Run 对象未清理。");
        process.stdout.write(`${JSON.stringify({ type: "cleaned" })}\n`);
        continue;
      }
      if (command.type === "wait-idle") {
        await until(() => Promise.resolve(app.gate.busy), (busy) => !busy, "Worker 收尾");
        if ((await app.runs.get(command.runId))?.status !== "CANCELLED") throw new Error("取消终态不一致。");
        process.stdout.write(`${JSON.stringify({ type: "idle" })}\n`);
        continue;
      }
      if (command.type !== "restart-evidence") throw new Error("控制命令无效。");
      if ((await app.runs.get(command.runId))?.status !== "NEEDS_USER_INPUT") throw new Error("只允许重启等待补证的验收 Run。");
      await app.stop();
      await fs.rm(path.join(app.workDir, "runs", command.runId), { recursive: true, force: true });
      app = await createInstance(settings, saved);
      await app.start(settings.apiPort);
      process.stdout.write(`${JSON.stringify({ ...ready(), type: "restarted" })}\n`);
    }
    await stop();
  }
} catch {
  process.stderr.write("验收环境启动/控制失败。检查 .env.web-acceptance.local、W6 migration、构建产物及端口；未执行成功，不会回退云端 Provider。\n");
  await stop();
  process.exitCode = 1;
}
