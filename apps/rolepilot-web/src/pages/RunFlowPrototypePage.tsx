import { useState } from "react";
import { MultiStepLoader } from "../components/MultiStepLoader";

const loadingStates = ["启程", "寻迹", "对焦", "织稿", "成稿"].map((text) => ({ text }));

export function RunFlowPrototypePage() {
  const [loading, setLoading] = useState(false);
  return <section className="run-flow-prototype"><p className="eyebrow">RUN / FLOW PROTOTYPE</p><h1>字节跳动</h1><p className="run-flow-prototype-subtitle">AI 产品经理 · MultiStepLoader 真实组件预览</p><MultiStepLoader loadingStates={loadingStates} loading={loading} duration={1400} onClose={() => setLoading(false)} /><button className="button button-primary" onClick={() => setLoading(true)}>开始查看</button><p className="run-flow-prototype-note">这是独立预览入口，确认效果后再接入正式运行页。</p></section>;
}
