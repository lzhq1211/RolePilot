const steps = ["整理经历", "分析岗位", "检查证据", "生成简历", "评审优化"] as const;

export function Workflow() {
  return (
    <section className="workflow" aria-labelledby="workflow-title" data-workflow-region data-workflow-version="1">
      <p className="workflow-overline">BOUNDED WORKFLOW</p>
      <h2 id="workflow-title">本次流程</h2>
      <ol>
        {steps.map((step, index) => (
          <li key={step} className={index === 0 ? "workflow-step workflow-step--running" : "workflow-step"}>
            <span className="workflow-marker" aria-hidden="true" />
            <span>{step}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
