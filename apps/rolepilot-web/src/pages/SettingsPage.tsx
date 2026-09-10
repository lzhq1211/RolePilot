import { useEffect, useState } from "react";

type ProviderConfig = { apiKeyConfigured: boolean; model: string; baseUrl: string };

export function SettingsPage() {
  const [config, setConfig] = useState<ProviderConfig>({ apiKeyConfigured: false, model: "", baseUrl: "https://api.openai.com/v1" });
  const [apiKey, setApiKey] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => { fetch("/api/provider-config").then((response) => response.json()).then(setConfig).catch(() => setMessage("读取配置失败。")); }, []);
  async function save() {
    const response = await fetch("/api/provider-config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ apiKey, model: config.model, baseUrl: config.baseUrl }) });
    const payload = await response.json();
    if (!response.ok) { setMessage(payload?.error?.message ?? "保存失败。"); return; }
    setConfig(payload); setApiKey(""); setMessage("已保存，重启服务后生效。");
  }
  return (
    <section className="static-page provider-settings" aria-labelledby="settings-title">
      <p className="eyebrow">SETTINGS</p>
      <h1 id="settings-title">Provider 设置</h1>
      <div className="provider-settings-form">
        <label><span>API KEY</span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={config.apiKeyConfigured ? "已配置，留空表示不修改" : "输入 API Key"} /></label>
        <label><span>MODEL</span><input value={config.model} onChange={(event) => setConfig({ ...config, model: event.target.value })} placeholder="例如 gpt-4o-mini" /></label>
        <label><span>BASE URL</span><input value={config.baseUrl} onChange={(event) => setConfig({ ...config, baseUrl: event.target.value })} /></label>
        <button className="button button-primary provider-settings-save" type="button" onClick={save}>保存</button>
      </div>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
