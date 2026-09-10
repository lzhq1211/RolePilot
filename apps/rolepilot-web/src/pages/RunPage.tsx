import { ArrowLeft, CircleStop, LogIn, Send, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { RunDto } from "web-contracts";
import { cancelRun, getRun, runEventsUrl, submitEvidence } from "../features/run/run-api";
import { getWorkbench } from "../workbench/run-client";
import { workbenchHref } from "../workbench-link";
import { MultiStepLoader } from "../components/MultiStepLoader";

const runFlowStates = ["启程", "寻迹", "对焦", "织稿", "成稿"].map((text) => ({ text }));
const flowPrompts = [
  ["接过你的履历，这就开工", "翻开第一页，看看主角什么来头", "先盘一盘，你都攒了哪些本事", "带上你的经历，咱们出发"],
  ["等等，这段经历有点东西", "你一笔带过的，可能是个大招", "别藏了，你的高光我看见了", "藏在细节里的本事，一个个请出来"],
  ["岗位出题，咱们挑拿手的来答", "本事不少，看看这次该亮哪一招", "和岗位对个暗号，找找合拍的地方", "这段经历很对路，往前排挪挪"],
  ["套话先让让，真本事要上场了", "经历不加戏，表达加点分", "别让一句“负责过”，盖住你做成的事", "给句子瘦瘦身，把位置留给亮点", "这段你太客气了，功劳得写清楚"],
  ["最后巡一遍，不让小纰漏抢戏", "标点也站好，准备登场", "错别字请留步，你不在出场名单里", "整整衣领，这份新稿准备亮相"],
];

function flowIndex(run: RunDto) {
  const active = run.stepStatuses.findIndex((step) => step.status === "running");
  if (active >= 0) return Math.min(active + 1, runFlowStates.length - 1);
  const completed = run.stepStatuses.filter((step) => step.status === "completed").length;
  return Math.min(Math.max(completed, 1), runFlowStates.length - 1);
}

function groupedStages(run: RunDto) {
  const status = (ids: string[]) => {
    const steps = run.stepStatuses.filter((step) => ids.includes(step.id));
    if (steps.some((step) => step.status === "running")) return "running";
    if (steps.length > 0 && steps.every((step) => step.status === "completed")) return "completed";
    return "pending";
  };
  return [
    { id: "start", label: "启程", status: run.status === "QUEUED" ? "running" : "completed" },
    { id: "mine", label: "寻迹", status: status(["mine"]) },
    { id: "jd", label: "对焦", status: status(["jd-analysis"]) },
    { id: "draft", label: "织稿", status: status(["preflight", "write", "review"]) },
    { id: "final", label: "成稿", status: run.status === "COMPLETED" ? "completed" : "pending" },
  ];
}

function useStagePrompt(stageIndex: number, active: boolean) {
  const [promptIndex, setPromptIndex] = useState(0);
  useEffect(() => {
    setPromptIndex(0);
    if (!active) return;
    const timer = window.setInterval(() => setPromptIndex((index) => (index + 1) % flowPrompts[stageIndex].length), 2400);
    return () => window.clearInterval(timer);
  }, [active, stageIndex]);
  return flowPrompts[stageIndex][promptIndex];
}

export function RunPage() {
  const { runId = "" } = useParams();
  const [run, setRun] = useState<RunDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [evidence, setEvidence] = useState("");
  const [busy, setBusy] = useState(false);
  const [workbenchError, setWorkbenchError] = useState<string | null>(null);
  const promptStage = run ? (run.status === "QUEUED" ? 0 : run.status === "COMPLETED" ? 4 : flowIndex(run)) : 0;
  const activePrompt = useStagePrompt(promptStage, Boolean(run && ["QUEUED", "RUNNING", "NEEDS_USER_INPUT"].includes(run.status)));
  const autoJumpDoneRef = useRef(false);
  const prevStatusRef = useRef<string | null>(null);
  useEffect(() => {
    prevStatusRef.current = null;
    autoJumpDoneRef.current = false;
    setWorkbenchError(null);
  }, [runId]);
  useEffect(() => {
    const controller = new AbortController();
    void getRun(runId, controller.signal).then(setRun).catch((e) => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "加载失败"); });
    return () => controller.abort();
  }, [runId]);
  useEffect(() => {
    if (!run || run.id !== runId) return;
    prevStatusRef.current = run.status;
    if (run.status !== "COMPLETED" || autoJumpDoneRef.current) return;
    autoJumpDoneRef.current = true;
    const controller = new AbortController();
    void getWorkbench(runId, controller.signal)
      .then((workbench) => {
        if (controller.signal.aborted) return;
        if (workbench.availability === "READY") window.location.replace(workbenchHref(runId));
        else setWorkbenchError("工作台稿件暂不可用，可稍后重试进入。");
      })
      .catch((e) => { if (!controller.signal.aborted) setWorkbenchError(e instanceof Error ? e.message : "工作台暂时不可用，可稍后重试进入。"); });
    return () => controller.abort();
  }, [run?.id, run?.status, runId]);
  useEffect(() => {
    if (!runId) return;
    const controller = new AbortController();
    let cursor = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const terminal = (status: string) => ["COMPLETED", "FAILED", "UNSUPPORTED", "CANCELLED"].includes(status);
    const refresh = async () => {
      const next = await getRun(runId, controller.signal);
      setRun((current) => current?.id === next.id && terminal(current.status) && !terminal(next.status) ? current : next);
      setError(null);
      return terminal(next.status);
    };
    const poll = async () => {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const response = await fetch(runEventsUrl(runId, cursor), { headers: { accept: "text/event-stream" }, signal: controller.signal });
        if (response.status === 404) return;
        if (!response.ok || !response.body) throw new Error("连接中断，正在重连。");
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const chunk = await reader.read();
          buffer += decoder.decode(chunk.value, { stream: !chunk.done });
          let boundary;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const sequence = Number(/^id:\s*(\d+)$/m.exec(frame)?.[1]);
            if (Number.isSafeInteger(sequence) && sequence > cursor) {
              const done = await refresh();
              cursor = sequence;
              if (done) return;
            }
          }
          if (chunk.done) break;
        }
        if (await refresh()) return;
      } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "连接中断，正在重连。"); }
      finally { await reader?.cancel().catch(() => undefined); }
      if (!controller.signal.aborted) timer = setTimeout(poll, 1000);
    };
    void poll(); return () => { controller.abort(); clearTimeout(timer); };
  }, [runId]);
  const cancel = async () => { setBusy(true); try { setRun(await cancelRun(runId)); } catch (e) { setError(e instanceof Error ? e.message : "取消失败"); } finally { setBusy(false); } };
  const sendEvidence = async (text = evidence) => { if (!text.trim()) return; setBusy(true); try { await submitEvidence(runId, text); setEvidence(""); setRun(await getRun(runId)); } catch (e) { setError(e instanceof Error ? e.message : "提交失败"); } finally { setBusy(false); } };
  const deleteRun = async () => { if (!window.confirm("确定删除这次运行吗？")) return; setBusy(true); try { const response = await fetch(`/api/runs/${encodeURIComponent(runId)}`, { method: "DELETE", headers: { "x-rolepilot-confirm": "DELETE_RUN" } }); if (!response.ok) { const body = await response.json().catch(() => null); throw new Error(body?.error?.message ?? "删除失败。"); } setRun(null); setError(null); setWorkbenchError(null); } catch (e) { setError(e instanceof Error ? e.message : "删除失败"); } finally { setBusy(false); } };
  return <section className="run-page"><div className="static-page"><p className="eyebrow">RUN</p><h1>{run?.company ?? "运行"}</h1>{run && <><p>{run.title}</p><div className="run-status" role="status">{run.status === "RUNNING" ? "正在推进" : run.status === "QUEUED" ? "等你启程" : run.status === "NEEDS_USER_INPUT" ? "等你补上一笔" : run.status}</div><ol className="run-steps">{groupedStages(run).map((step) => <li key={step.id} data-status={step.status}><strong>{step.label}</strong><span>{step.status === "completed" ? "这一程已走完" : step.status === "running" ? "正在推进" : "未开始"}</span></li>)}</ol><MultiStepLoader loadingStates={runFlowStates} loading={["QUEUED", "RUNNING", "NEEDS_USER_INPUT"].includes(run.status)} currentState={run.status === "QUEUED" ? 0 : flowIndex(run)} heading={run.status === "NEEDS_USER_INPUT" ? "前面有一处空白" : run.status === "QUEUED" ? "等你启程" : "正在推进"} prompt={activePrompt} description={run.status === "NEEDS_USER_INPUT" ? "补充后会从当前步骤继续，不会丢失已经完成的进度。" : "每一步都在沿着真实运行状态向前走。"} onClose={run.status === "NEEDS_USER_INPUT" ? undefined : () => void cancel()} footer={run.status === "NEEDS_USER_INPUT" ? <section className="multi-loader-supplement"><PreflightGuidance run={run} /><textarea value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="写下与岗位相关的真实经历、职责或结果" aria-label="补充证据" /><div className="multi-loader-actions"><button className="button button-primary" onClick={() => void sendEvidence()} disabled={busy}><Send aria-hidden="true" />提交补充</button><button className="button button-ghost" onClick={() => void sendEvidence("跳过")} disabled={busy}>跳过并继续</button></div></section> : undefined} />{(run.status === "UNSUPPORTED") && <PreflightGuidance run={run} />}{["QUEUED", "RUNNING"].includes(run.status) && <button className="button button-ghost" onClick={() => void cancel()} disabled={busy}><CircleStop aria-hidden="true" />取消运行</button>}{run.status === "COMPLETED" && <div className="run-export-actions" aria-label="运行完成">{workbenchError && <p className="run-result-note" role="alert">{workbenchError}</p>}<a className="button button-primary" href={workbenchHref(runId)}><LogIn aria-hidden="true" />进入排版工作台</a><button className="button button-ghost" onClick={() => void deleteRun()} disabled={busy}><Trash2 aria-hidden="true" />删除运行</button></div>}</>}</div>{error && <div className="new-run-validation" role="alert">{error}</div>}{["UNSUPPORTED", "FAILED", "CANCELLED"].includes(run?.status ?? "") && run?.status !== "UNSUPPORTED" && <p className="run-result-note">本次运行没有可展示的结果。</p>}<Link className="button button-ghost" to="/"><ArrowLeft aria-hidden="true" />返回任务</Link></section>;
}

function PreflightGuidance({ run }: { run: RunDto }) {
  const isWaiting = run.status === "NEEDS_USER_INPUT";
  const messages = run.pendingUserQuestions.length > 0
    ? run.pendingUserQuestions
    : [isWaiting
      ? "还需要补充与目标岗位相关的真实经历、职责和结果。"
      : "根据目前提供的材料，暂时无法在不添加未经证实信息的情况下继续生成。"];
  return <section className={`run-guidance run-guidance--${isWaiting ? "request" : "decline"}`} aria-live="polite"><h2>{isWaiting ? "需要你补充" : "暂时无法继续"}</h2>{messages.map((message, index) => <p key={`${message}-${index}`}>{message}</p>)}</section>;
}
