import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { createResumeAgentBindings } from "rolepilot-engine";

export const PROVIDER_ENV_FILE_PATH = fileURLToPath(new URL("../../../.env", import.meta.url));
const ROLES = ["writer", "reviewer"] as const;
type ProviderRole = typeof ROLES[number];
type ProviderInput = { apiKey?: string; model?: string; baseUrl?: string };

function providerValues(values: NodeJS.ProcessEnv, role: ProviderRole) {
  const prefix = role === "writer" ? "OPENAI" : "ROLEPILOT_REVIEWER_OPENAI";
  const keys = {
    apiKey: `${prefix}_API_KEY`,
    model: role === "writer" ? "OPENAI_CHAT_MODEL" : `${prefix}_CHAT_MODEL`,
    baseUrl: `${prefix}_BASE_URL`,
  };
  return {
    apiKey: values[keys.apiKey] ?? values.OPENAI_API_KEY ?? "",
    model: values[keys.model] ?? values.OPENAI_CHAT_MODEL ?? values.DEFAULT_MODEL ?? "",
    baseUrl: values[keys.baseUrl] ?? values.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    keys,
  };
}

function publicConfig(values: NodeJS.ProcessEnv) {
  const read = (role: ProviderRole) => {
    const { apiKey, model, baseUrl } = providerValues(values, role);
    return { apiKeyConfigured: Boolean(apiKey), model, baseUrl };
  };
  return { writer: read("writer"), reviewer: read("reviewer") };
}

export function createLiveWorkerBindings(env: NodeJS.ProcessEnv) {
  const writer = providerValues(env, "writer");
  const reviewer = providerValues(env, "reviewer");
  const writerEnv = { OPENAI_API_KEY: writer.apiKey, OPENAI_BASE_URL: writer.baseUrl, OPENAI_CHAT_MODEL: writer.model };
  const reviewerEnv = { OPENAI_API_KEY: reviewer.apiKey, OPENAI_BASE_URL: reviewer.baseUrl, OPENAI_CHAT_MODEL: reviewer.model };
  return createResumeAgentBindings({
    miner: { tool: env.ROLEPILOT_MINER_PROVIDER || "openai-chat", model: writer.model },
    writer: { tool: env.ROLEPILOT_WRITER_PROVIDER || "openai-chat", model: writer.model },
    reviewer: { tool: env.ROLEPILOT_REVIEWER_PROVIDER || "openai-chat", model: reviewer.model },
    interviewer: { tool: env.ROLEPILOT_INTERVIEWER_PROVIDER || "openai-chat" },
  }, {
    miner: { env: writerEnv },
    writer: { env: writerEnv },
    reviewer: { env: reviewerEnv },
  });
}

function parseEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const value = match[2];
    values[match[1]] = value.startsWith("'") && value.endsWith("'")
      ? value.slice(1, -1).replaceAll("'\\''", "'")
      : value.replace(/^["]|["]$/g, "");
  }
  return values;
}

function setEnv(text: string, key: string, value: string): string {
  const line = `${key}='${value.replaceAll("'", "'\\''")}'`;
  const pattern = new RegExp(`^[ \\t]*${key}[ \\t]*=.*$`, "gm");
  return pattern.test(text) ? text.replace(pattern, () => line) : `${text.trimEnd()}\n${line}\n`;
}

async function readEnvFile(envFilePath: string): Promise<string> {
  try {
    return await fs.readFile(envFilePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export function createProviderConfigApi(
  envFilePath = PROVIDER_ENV_FILE_PATH,
  onSaved?: (values: NodeJS.ProcessEnv) => void,
) {
  return {
    async handle(request: Request): Promise<Response> {
      if (request.method === "GET") {
        return Response.json(publicConfig(parseEnv(await readEnvFile(envFilePath))));
      }
      if (request.method !== "PUT") return new Response(null, { status: 405 });
      const body = await request.json().catch(() => null) as Partial<Record<ProviderRole, ProviderInput>> | null;
      for (const role of ROLES) {
        const input = body?.[role];
        if (!input || typeof input !== "object" || Array.isArray(input) || [input.apiKey, input.model, input.baseUrl].some((value) =>
          value !== undefined && (typeof value !== "string" || /[\r\n\0]/.test(value)),
        )) return Response.json({ error: { message: "Writer 和 Reviewer 配置值必须是单行文本。" } }, { status: 400 });
        if (!input.model?.trim()) return Response.json({ error: { message: `${role === "writer" ? "Writer" : "Reviewer"} Model 不能为空。` } }, { status: 400 });
      }
      let text = await readEnvFile(envFilePath);
      const values = parseEnv(text);
      for (const role of ROLES) {
        const input = body![role]!;
        const current = providerValues(values, role);
        text = setEnv(text, current.keys.apiKey, input.apiKey?.trim() || current.apiKey);
        text = setEnv(text, current.keys.model, input.model!.trim());
        text = setEnv(text, current.keys.baseUrl, input.baseUrl?.trim() || current.baseUrl);
      }
      await fs.writeFile(envFilePath, text, "utf8");
      const savedValues = parseEnv(text);
      onSaved?.(savedValues);
      return Response.json({ ...publicConfig(savedValues), restartRequired: false });
    },
  };
}
