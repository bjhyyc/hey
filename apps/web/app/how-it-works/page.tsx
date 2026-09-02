import Link from "next/link";

import { PageIntro } from "@/components/PageIntro";
import { PageShell } from "@/components/PageShell";

// Written to be read in fifteen seconds: five numbered steps, each with who
// does it and how long it takes, so a visitor can see the whole shape of the
// service before paying. Every number here matches the running system - the
// two free regenerations per master and the 10-20 minute automatic stretch.
// Price and the download window are stated where they are binding (checkout
// and the terms), not repeated here.
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
    copy: "AI 依据照片画出正面和 45° 两张形象母图，你来看像不像。不满意可以各免费重画 2 次，确认后才继续。"
  },
  {
    title: "自动生成七个动作",
    who: "我们来做",
    time: "10–20 分钟",
    copy: "睡姿母图、七段动作视频、逐段质检、抠背景、打包，全部自动完成。可以关掉页面，回来时进度还在。"
  },
  {
    title: "下载导入",
    who: "你来做",
    time: "2 分钟",
    copy: "下载素材包和 Hey 桌宠客户端，点一下导入就能用。"
  }
];

export default function HowItWorksPage() {
  return (
    <PageShell compact>
      <PageIntro title="制作流程">
        一共 5 步，你只参与其中 3 步：传照片、付款、确认形象。剩下的我们自动完成。
      </PageIntro>

      <ol className="flow-steps">
        {STEPS.map((step, index) => (
          <li key={step.title}>
            <i aria-hidden="true">{String(index + 1).padStart(2, "0")}</i>
            <div>
              <h2>
                {step.title}
                <em>{step.who} · {step.time}</em>
              </h2>
              <p>{step.copy}</p>
            </div>
          </li>
        ))}
      </ol>

      <section className="flow-summary">
        <p>
          <strong>全程通常 15–25 分钟</strong>，其中你真正动手的时间约 5 分钟，其余是等待生成。
        </p>
        <p>
          你会得到：<strong>3 张形象母图</strong>（正面、45°、睡姿）和<strong>7 段动作视频</strong>，
          打包成一个可导入 Hey 桌宠客户端的素材包。
        </p>
        <p className="flow-note">
          成品由 AI 重新绘制，不是照片复刻，细节会有差异——这也是我们在生成动作前先让你确认母图的原因。
          详见<Link href="/ai-content">AI 生成说明</Link>与<Link href="/terms">服务协议</Link>。
        </p>
      </section>

      <div className="flow-actions">
        <Link className="primary-button inline-button" href="/#start">开始制作</Link>
      </div>
    </PageShell>
  );
}
