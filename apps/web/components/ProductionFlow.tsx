// The five steps, kept in one place: the home page's second screen renders
// them, and /how-it-works redirects there rather than carrying a copy.
// Every figure matches the running system - two free regenerations per master,
// the 10-20 minute automatic stretch - so the page cannot drift from the
// product by being edited on its own.
const STEPS = [
  {
    title: "上传照片",
    who: "你来做",
    time: "1 分钟",
    copy: "2 张正面照 + 1~2 张侧面照。上传后 AI 立刻预检：够不够清晰、是不是同一只宠物。不合格当场告诉你，这一步不收费。"
  },
  {
    title: "付款",
    who: "你来做",
    time: "1 分钟",
    copy: "预检通过才进入付款，支付宝扫码，一次买断这一份素材包。"
  },
  {
    title: "确认形象",
    who: "你来做",
    time: "2 分钟",
    copy: "AI 依据照片画出正面和侧面两张形象图，你来看像不像。不满意可以各免费重画 2 次，确认后才继续。"
  },
  {
    title: "自动生成动作",
    who: "我们来做",
    time: "10–20 分钟",
    copy: "全部动作自动生成，并自动检查效果、自动打包。可以关掉页面，回来时进度还在。"
  },
  {
    title: "下载导入",
    who: "你来做",
    time: "2 分钟",
    copy: "下载素材包和 Hey 桌宠客户端，点一下导入就能用。"
  }
];

export function ProductionFlow() {
  return (
    <>
      <ol className="flow-steps">
        {STEPS.map((step, index) => (
          <li key={step.title}>
            <i aria-hidden="true">{String(index + 1).padStart(2, "0")}</i>
            <div>
              <h3>
                {step.title}
                <em>{step.who} · {step.time}</em>
              </h3>
              <p>{step.copy}</p>
            </div>
          </li>
        ))}
      </ol>
      <div className="flow-summary">
        <p>
          <strong>全程约 20 分钟</strong>，其中你真正动手的时间约 5 分钟，其余是等待生成。
        </p>
        <p>
          你会得到：一只会<strong>打喷嚏、打滚、伸懒腰、舔脚、睡觉</strong>的桌宠，安静时会自己待机，
          打包成一个可导入 Hey 桌宠客户端的素材包。
        </p>
        <p className="flow-note">
          成品由 AI 重新绘制，不是照片复刻，细节会有差异——这也是我们在生成动作前先让你确认形象的原因。
          详见<a href="/ai-content">AI 生成说明</a>与<a href="/terms">服务协议</a>。
        </p>
      </div>
    </>
  );
}
