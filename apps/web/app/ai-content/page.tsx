import { PageIntro } from "@/components/PageIntro";
import { PageShell } from "@/components/PageShell";

// The explicit AI-generated-content disclosure the regulations ask for
// (生成式人工智能服务管理暂行办法 / 深度合成管理规定 / 生成合成内容标识办法).
// It states only what the pipeline actually does: two image models draw the
// masters, a video model animates them, the customer approves the masters
// before any video is generated, and nothing here is a photograph.
export default function AiContentPage() {
  return (
    <PageShell compact>
      <PageIntro title="AI 生成内容说明">更新日期：2026 年 9 月 2 日</PageIntro>
      <article className="legal-copy">
        <h2>这些内容是 AI 生成的</h2>
        <p>
          你购买的素材包里的形象与全部动作，
          <strong>都由人工智能依据你上传的照片重新绘制与生成</strong>，不是照片本身，也不是实拍视频。
          生成由具备相应资质的第三方大模型服务完成，处理方名单见<a href="/privacy">隐私政策</a>。
        </p>

        <h2>它如何生成</h2>
        <ol>
          <li>你上传 3–4 张宠物照片，付款前先做一次自动预检：够不够清晰、是不是同一只宠物。</li>
          <li>AI 依据照片画出正面与侧面两张形象图；<strong>你亲自确认</strong>像不像你的宠物，每张可免费重画最多 2 次。</li>
          <li>确认之后，其余动作全部自动生成，并逐一自动检查效果，不合格的会自动重做。</li>
          <li>完成后打包为素材包，供 Hey 桌宠客户端导入。</li>
        </ol>

        <h2>你需要知道的差异</h2>
        <p>
          AI 重绘会尽量贴近毛色、花纹与神态，但细节上会与真实宠物有差异，动作也是生成的而非你的宠物真实做出的。
          这是本服务的本质，也是我们在生成动作前先请你确认形象的原因。
        </p>

        <h2>使用边界</h2>
        <ul>
          <li>素材包仅供你个人在桌面客户端使用，不得转售、不得用于误导他人、不得用于违法用途。</li>
          <li>请只上传你自己宠物的照片，不要上传含他人肖像的照片；含真人肖像的照片会被预检拒绝或人工拒绝生成。</li>
          <li>我们保留对违法、违规或明显不适宜内容拒绝生成并退款的权利。</li>
        </ul>

        <h2>标识</h2>
        <p>
          本页面、用户服务协议以及下单前的确认勾选共同构成本服务对 AI 生成内容的显式说明。
          如你将素材用于任何公开场合，请自行标注“AI 生成”。
        </p>
      </article>
    </PageShell>
  );
}
