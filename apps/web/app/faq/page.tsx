import type { Metadata } from "next";
import Link from "next/link";
import { PageIntro } from "@/components/PageIntro";
import { PageShell } from "@/components/PageShell";

export const metadata: Metadata = {
  title: "常见问题",
  description: "照片要求、制作时长、形象确认、素材包导入、桌宠玩法。"
};

// Every answer here states what the system actually does today. When a rule
// changes (a limit, a window, a trigger), change it here in the same commit.
const INTERACTIONS: Array<[string, string]> = [
  ["单击", "打喷嚏"],
  ["双击", "打滚"],
  ["右键", "伸懒腰，也是唯一能叫醒它的操作"],
  ["鼠标停在它身上 2 秒", "舔脚（20 秒内不重复）"],
  ["22 秒没人理", "趴下睡觉"]
];

export default function FaqPage() {
  return (
    <PageShell compact>
      <PageIntro title="常见问题">从上传照片到桌宠动起来，最常被问到的事。</PageIntro>
      <div className="support-card faq-card">
        <section className="support-block" id="photos">
          <h2>需要什么样的照片？</h2>
          <p>
            <strong>3 张必选，第 4 张可选</strong>：两张正面照、一张侧面照，可以再补一张另一侧的侧面照。
            要同一只宠物、同一时期，五官和身体花色看得清；花色左右不对称的宠物建议把两侧都传。
          </p>
          <p>
            上传前会先在你的浏览器里做一次预检，逐张告诉你哪张不合适（比如更像侧面照、看不到全身），
            预检通过才会进入付款。预检结果 24 小时内有效。
          </p>
        </section>

        <section className="support-block" id="time">
          <h2>要等多久？中间需要我做什么？</h2>
          <p>
            全程约 <strong>20 分钟</strong>。付款后系统先生成正面和 45° 两张形象母图，
            这一步需要你回到项目页<strong>确认形象</strong>；确认后睡姿母图和七段动作视频自动生成，页面会自己刷新，关掉稍后回来也不会丢进度。
          </p>
        </section>

        <section className="support-block" id="likeness">
          <h2>形象不像怎么办？</h2>
          <p>
            AI 是依据照片重新绘制，会尽量贴近，但不是照片复刻。确认页上正面、45° 两张各可<strong>免费重新生成 2 次</strong>，
            单独重做不满意的那张即可。确认之后七个动作都按这个形象生成，中途不能再换，所以请在确认前挑到满意为止。
          </p>
        </section>

        <section className="support-block" id="import">
          <h2>素材包怎么用？</h2>
          <p>
            项目完成后在项目页下载 <code>.petpack</code> 文件，再安装
            <Link href="/download-client">桌宠客户端</Link>，在客户端概览页点「导入素材包」选中这个文件，宠物就会出现在桌面上。
          </p>
          <p>
            导入后客户端会按你的屏幕自动选一个合适的大小；想改大改小、调透明度，在客户端「显示」页拖滑块。
          </p>
        </section>

        <section className="support-block" id="play">
          <h2>桌宠会做什么？怎么触发？</h2>
          <p>素材包自带触发规则，导入即生效，不用设置：</p>
          <ul className="faq-interactions">
            {INTERACTIONS.map(([trigger, action]) => (
              <li key={trigger}><strong>{trigger}</strong><span aria-hidden="true">→</span>{action}</li>
            ))}
          </ul>
          <p>
            <strong>睡着后只有右键单击能叫醒它</strong>——单击、双击、悬停都会被刻意忽略，
            这样它才不会一被碰到就醒。
          </p>
          <p className="support-hint">
            按住宠物可以拖到任何位置；每次启动客户端它会先伸个懒腰。
            托盘图标<strong>左键单击</strong>重新打开控制面板，<strong>右键</strong>是菜单。
          </p>
        </section>

        <section className="support-block" id="client">
          <h2>安装客户端时提示“未知发布者”？</h2>
          <p>
            安装包目前没有购买代码签名证书，Windows 会弹出 SmartScreen 提示，点「更多信息 → 仍要运行」即可。
            下载页列出了安装包的 SHA-256 校验值，可以对照核验。客户端支持 Windows 10 / 11（64 位）。
          </p>
        </section>

        <section className="support-block" id="pay">
          <h2>怎么付款？</h2>
          <p>
            下单时选择支付宝或微信支付，扫码完成。一个项目对应一笔订单、一份素材包。
          </p>
        </section>

        <section className="support-block" id="more">
          <h2>还有其他问题？</h2>
          <p>
            具体条款见<Link href="/terms">服务协议</Link>、<Link href="/privacy">隐私政策</Link>与<Link href="/ai-content">AI 生成说明</Link>；
            其余情况可通过<Link href="/support">联系客服</Link>说明，并带上项目页底部的<strong>项目编号</strong>。
          </p>
        </section>
      </div>
    </PageShell>
  );
}
