import fs from "node:fs/promises";
import path from "node:path";
import { root } from "./config.mjs";

export async function fixtures() {
  const base = path.join(root, "packages/platform-testkit/fixtures");
  const read = (name) => fs.readFile(path.join(base, name), "utf8");
  const timeline = await read("integration/timeline.yml");
  const resume = await read("integration/resume.yml");
  const proceed = await read("preflight/proceed.json");
  const ask = await read("preflight/ask-user.json");
  const pass = await read("review/pass.json");
  const binding = (texts) => ({ provider: "openai-chat", mode: "replay", replayEntries: texts.map((text) => ({ text })) });
  return {
    resumeText: timeline,
    jdText: "Platform Engineer: build reliable services and lead verified production delivery.",
    evidenceText: "Verified platform delivery: led the production rollout and owned reliability metrics.",
    bindings(evidence) {
      return { miner: binding([timeline]), writer: binding(["language: en\ntitle: Platform Engineer\nsummary: Reliable platform delivery.\n", resume]), reviewer: binding(evidence ? [ask, proceed, pass] : [proceed, pass]), interviewer: binding([]) };
    },
  };
}
