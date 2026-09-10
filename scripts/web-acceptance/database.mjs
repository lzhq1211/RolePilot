import assert from "node:assert/strict";
import { config, session } from "./config.mjs";

const settings = await config();
const saved = await session(settings);
const headers = { apikey: settings.serviceRoleKey, ...(settings.serviceRoleKey.startsWith("sb_") ? {} : { authorization: `Bearer ${settings.serviceRoleKey}` }), "content-type": "application/json" };
async function read(route, options = {}) {
  const response = await fetch(settings.url + route, { ...options, headers, signal: AbortSignal.timeout(30000) });
  if (response.status === 401 || response.status === 403) throw new Error("云端结构检查被拒绝：请使用 service_role/secret key，不要使用 publishable key。");
  assert.ok(response.ok, `云端结构检查失败: HTTP ${response.status}；确认 migration 已应用。`);
  return response.json();
}
await read("/rest/v1/rpc/rolepilot_cleanup_status", { method: "POST", body: JSON.stringify({ p_deployment_instance_id: saved.instanceA }) });
const buckets = await read("/storage/v1/bucket");
for (const name of ["rolepilot-sources", "rolepilot-artifacts"]) assert.equal(buckets.find((b) => b.id === name)?.public, false, `${name} 必须存在且私有`);
console.log("云端维护 RPC 与私有 bucket 检查通过；不代表空库 migration 或 pgTAP 通过。");
