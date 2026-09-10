import { promises as fs } from "node:fs";

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

export function createProviderConfigApi(envFilePath: string) {
  return {
    async handle(request: Request): Promise<Response> {
      if (request.method === "GET") {
        const values = parseEnv(await fs.readFile(envFilePath, "utf8").catch(() => ""));
        return Response.json({ apiKeyConfigured: Boolean(values.OPENAI_API_KEY), model: values.OPENAI_CHAT_MODEL || values.DEFAULT_MODEL || "", baseUrl: values.OPENAI_BASE_URL || "https://api.openai.com/v1" });
      }
      if (request.method !== "PUT") return new Response(null, { status: 405 });
      const body = await request.json().catch(() => null) as Partial<{ apiKey: string; model: string; baseUrl: string }> | null;
      if (!body || [body.apiKey, body.model, body.baseUrl].some((value) =>
        value !== undefined && (typeof value !== "string" || /[\r\n\0]/.test(value)),
      )) return Response.json({ error: { message: "配置值必须是单行文本。" } }, { status: 400 });
      if (!body.model?.trim()) return Response.json({ error: { message: "Model 不能为空。" } }, { status: 400 });
      let text = await fs.readFile(envFilePath, "utf8").catch(() => "");
      if (body.apiKey?.trim()) text = setEnv(text, "OPENAI_API_KEY", body.apiKey.trim());
      text = setEnv(text, "OPENAI_CHAT_MODEL", body.model.trim());
      if (body.baseUrl?.trim()) text = setEnv(text, "OPENAI_BASE_URL", body.baseUrl.trim());
      await fs.writeFile(envFilePath, text, "utf8");
      const values = parseEnv(text);
      return Response.json({ apiKeyConfigured: Boolean(values.OPENAI_API_KEY), model: values.OPENAI_CHAT_MODEL || "", baseUrl: values.OPENAI_BASE_URL || "https://api.openai.com/v1", restartRequired: true });
    },
  };
}
