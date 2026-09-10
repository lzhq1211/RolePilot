import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useEffect, useState } from "react";

type LoadingState = { text: string };

const agentKeywords = ["经历细节", "岗位重点", "真本事", "表达力度", "亮点排序"];

function CheckIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg>;
}

function CheckFilled() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path fillRule="evenodd" d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12Zm13.36-1.814a.75.75 0 1 0-1.22-.872l-3.236 4.53L9.53 12.22a.75.75 0 0 0-1.06 1.06l2.25 2.25a.75.75 0 0 0 1.14-.094l3.75-5.25Z" clipRule="evenodd" /></svg>;
}

function LoaderCore({ loadingStates, value }: { loadingStates: LoadingState[]; value: number }) {
  return <div className="multi-loader-core">{loadingStates.map((state, index) => {
    const distance = Math.abs(index - value);
    const opacity = Math.max(1 - distance * 0.2, 0);
    return <motion.div key={state.text} className="multi-loader-row" initial={{ opacity: 0, y: -(value * 40) }} animate={{ opacity, y: -(value * 40) }} transition={{ duration: 0.5 }}>
      <span className="multi-loader-icon">{index > value ? <CheckIcon /> : <CheckFilled />}</span>
      <span className={index === value ? "multi-loader-current" : ""}>{state.text}</span>
    </motion.div>;
  })}</div>;
}

function AgentOrbit({ paused }: { paused: boolean }) {
  return <div className={`agent-orbit ${paused ? "agent-orbit--paused" : ""}`} aria-label="Agent 正在发散思考"><div className="agent-orbit-lines" aria-hidden="true" />{agentKeywords.map((keyword, index) => <span className={`agent-orbit-key agent-orbit-key--${index}`} key={keyword}>{keyword}</span>)}<div className="agent-orbit-core">织稿</div></div>;
}

export function MultiStepLoader({ loadingStates, loading, duration = 2000, loop = false, currentState: controlledState, onClose, heading, description, footer, prompt }: { loadingStates: LoadingState[]; loading: boolean; duration?: number; loop?: boolean; currentState?: number; onClose?: () => void; heading?: string; description?: string; footer?: ReactNode; prompt?: string }) {
  const [internalState, setInternalState] = useState(0);
  useEffect(() => {
    if (!loading || controlledState !== undefined) { if (!loading) setInternalState(0); return; }
    const timer = window.setTimeout(() => setInternalState((previous) => loop ? (previous === loadingStates.length - 1 ? 0 : previous + 1) : Math.min(previous + 1, loadingStates.length - 1)), duration);
    return () => window.clearTimeout(timer);
  }, [controlledState, duration, loading, loadingStates.length, loop, internalState]);
  const value = controlledState === undefined ? internalState : Math.min(controlledState, loadingStates.length - 1);
  return <AnimatePresence mode="wait">{loading && <motion.div className="multi-loader-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
    <div className="multi-loader-panel">{heading && <div className="multi-loader-heading"><p>{heading}</p>{prompt && <span className="multi-loader-prompt">{prompt}</span>}{description && <span>{description}</span>}</div>}{value === 3 ? <AgentOrbit paused={Boolean(footer)} /> : <LoaderCore loadingStates={loadingStates} value={value ?? 0} />}{footer}{onClose && <button className="multi-loader-close" onClick={onClose} aria-label="关闭加载动画">×</button>}</div>
    <div className="multi-loader-mask" />
  </motion.div>}</AnimatePresence>;
}
