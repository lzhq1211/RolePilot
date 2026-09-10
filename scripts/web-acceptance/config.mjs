import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

export const root = fileURLToPath(new URL("../../", import.meta.url));
export const outputRoot = path.join(root, ".rolepilot-acceptance");

export async function config() {
  const env = { ...process.env };
  try {
    for (const line of (await fs.readFile(path.join(root, ".env.web-acceptance.local"), "utf8")).split(/\r?\n/)) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (match && env[match[1]] === undefined) env[match[1]] = match[2].trim().replace(/^(["'])(.*)\1$/, "$2");
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const url = new URL(env.ROLEPILOT_TEST_SUPABASE_URL || "https://missing.invalid");
  const project = env.ROLEPILOT_TEST_PROJECT_REF;
  const key = env.ROLEPILOT_TEST_SERVICE_ROLE_KEY;
  const prefix = env.ROLEPILOT_TEST_INSTANCE_PREFIX || "w6-acceptance";
  const publishable = key?.startsWith("sb_publishable_");
  if (!project || !/^[a-z0-9]+$/.test(project) || url.origin !== `https://${project}.supabase.co` || url.pathname !== "/" || url.search || url.hash || url.username || url.password || !key || publishable || !/^w6-[a-z0-9-]+$/.test(prefix) || prefix.length > 45 || env.ROLEPILOT_TEST_CLOUD_CONFIRM !== "ROLEPILOT_TEST_DATA_ONLY") {
    throw new Error("请先填写 .env.web-acceptance.local：专用项目 URL、服务端 service_role/secret key、匹配的 project ref 和测试数据确认值；publishable key 不可用于验收。");
  }
  const port = (value, fallback) => { const n = Number(value || fallback); if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new Error("验收端口无效。"); return n; };
  return { url: url.origin, serviceRoleKey: key, project, prefix, apiPort: port(env.ROLEPILOT_TEST_API_PORT, 4184), webPort: port(env.ROLEPILOT_TEST_WEB_PORT, 4183), python: env.ROLEPILOT_TEST_PYTHON || "python3" };
}

export async function session(settings, fresh = false) {
  const file = path.join(outputRoot, "session.json");
  if (!fresh) {
    try {
      const saved = JSON.parse(await fs.readFile(file, "utf8"));
      if (saved.project !== settings.project || !/^w6-[a-z0-9-]+$/.test(saved.instanceA) || saved.instanceB !== `${saved.instanceA}-b` || saved.workDir !== path.join(outputRoot, saved.instanceA)) throw new Error("验收 session 与当前项目不匹配，请使用 --new 创建新 session。");
      return saved;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const id = `${settings.prefix}-${randomUUID()}`;
  const saved = { project: settings.project, instanceA: id, instanceB: `${id}-b`, workDir: path.join(outputRoot, id) };
  await fs.mkdir(outputRoot, { recursive: true });
  await fs.writeFile(file, JSON.stringify(saved, null, 2), { mode: 0o600 });
  return saved;
}

export async function until(operation, predicate, label, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await operation();
    if (predicate(result)) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待超时：${label}`);
}
