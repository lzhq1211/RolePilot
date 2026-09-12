import { useEffect, useState } from "react";

type ProviderValues = { apiKeyConfigured: boolean; model: string; baseUrl: string };
type ProviderConfig = { writer: ProviderValues; reviewer: ProviderValues };
type ProviderInput = { apiKey: string; model: string; baseUrl: string };
const emptyConfig: ProviderConfig = {
  writer: { apiKeyConfigured: false, model: "", baseUrl: "https://api.openai.com/v1" },
  reviewer: { apiKeyConfigured: false, model: "", baseUrl: "https://api.openai.com/v1" },
};

function readProviderConfig(payload: unknown): ProviderConfig {
  if (payload && typeof payload === "object" && "writer" in payload && "reviewer" in payload) {
    return payload as ProviderConfig;
  }
  if (payload && typeof payload === "object" && "model" in payload) {
    const legacy = payload as { apiKeyConfigured?: boolean; model?: string; baseUrl?: string };
    const values = { apiKeyConfigured: Boolean(legacy.apiKeyConfigured), model: legacy.model ?? "", baseUrl: legacy.baseUrl ?? "https://api.openai.com/v1" };
    return { writer: values, reviewer: values };
  }
  throw new Error("配置响应格式无效。");
}

export function SettingsPage() {
  const [config, setConfig] = useState<ProviderConfig>(emptyConfig);
  const [apiKeys, setApiKeys] = useState({ writer: "", reviewer: "" });
  const [message, setMessage] = useState("");
  useEffect(() => {
    fetch("/api/provider-config")
      .then(async (response) => {
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw new Error(payload?.error?.message ?? "读取配置失败。");
        return readProviderConfig(payload);
      })
      .then(setConfig)
      .catch((error: unknown) => setMessage(error instanceof Error ? error.message : "读取配置失败。"));
  }, []);
  async function save() {
    const input = (role: "writer" | "reviewer"): ProviderInput => ({ apiKey: apiKeys[role], model: config[role].model, baseUrl: config[role].baseUrl });
    const response = await fetch("/api/provider-config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ writer: input("writer"), reviewer: input("reviewer") }) });
    const payload = await response.json();
    if (!response.ok) { setMessage(payload?.error?.message ?? "保存失败。"); return; }
    setConfig(readProviderConfig(payload)); setApiKeys({ writer: "", reviewer: "" }); setMessage("已保存。");
  }
  return (
    <section className="static-page provider-settings" aria-labelledby="settings-title">
      <p className="eyebrow">SETTINGS</p>
      <h1 id="settings-title">Provider 设置</h1>
      <div className="provider-settings-form">
        {(["writer", "reviewer"] as const).map((role) => (
          <fieldset className="provider-settings-group" key={role}>
            <legend>{role === "writer" ? "WRITER" : "REVIEWER"}</legend>
            <label><span>API KEY</span><input type="password" value={apiKeys[role]} onChange={(event) => setApiKeys({ ...apiKeys, [role]: event.target.value })} placeholder={config[role].apiKeyConfigured ? "已配置，留空表示不修改" : "输入 API Key"} /></label>
            <label><span>MODEL</span><input value={config[role].model} onChange={(event) => setConfig({ ...config, [role]: { ...config[role], model: event.target.value } })} placeholder="例如 gpt-4o-mini" /></label>
            <label><span>BASE URL</span><input value={config[role].baseUrl} onChange={(event) => setConfig({ ...config, [role]: { ...config[role], baseUrl: event.target.value } })} /></label>
          </fieldset>
        ))}
        <button className="button button-primary provider-settings-save" type="button" onClick={save}>保存</button>
      </div>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
