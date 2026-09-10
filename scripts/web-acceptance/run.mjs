import { spawn } from "node:child_process";
import path from "node:path";
import { config, root } from "./config.mjs";

try {
  const mode = process.argv[2];
  const scripts = { integration: "integration.mjs", db: "database.mjs", clean: "clean.mjs", serve: "serve.mjs" };
  let executable = process.execPath;
  let args;
  if (mode === "e2e") {
    const settings = await config();
    executable = settings.python;
    args = [path.join(root, "apps/rolepilot-web/tests/w6_e2e.py")];
  } else if (scripts[mode]) args = [path.join(root, "scripts/web-acceptance", scripts[mode]), ...process.argv.slice(3)];
  else throw new Error("未知验收命令。");
  const child = spawn(executable, args, { cwd: root, env: process.env, stdio: "inherit" });
  child.on("error", () => { process.stderr.write("无法启动验收命令，请检查 Node/Python 与依赖。\n"); process.exitCode = 1; });
  child.on("exit", (code) => { process.exitCode = code ?? 1; });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
