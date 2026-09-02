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
          你购买的 PetPack 素材包——三张母图（正面、45°、睡姿）与七段动作视频（组成 5 个动作）——
          <strong>全部由人工智能依据你上传的照片重新绘制与生成</strong>，不是照片本身，也不是实拍视频。
          图像由火山引擎 Seedream 模型生成，动作视频由 Seedance 模型生成。
        </p>

        <h2>它如何生成</h2>
        <ol>
          <li>你上传 3–4 张宠物照片，付款前由视觉模型预检照片是否清晰、是否为同一只宠物。</li>
          <li>模型依据照片绘制两张清醒母图；<strong>你亲自确认</strong>它们是否像你的宠物，可各重新生成最多 2 次。</li>
          <li>确认后，模型生成睡姿母图，并以母图为首尾帧生成七段动作视频（组成 5 个动作）；每段视频都经过自动质检，未通过的会自动重做。</li>
          <li>视频抠除背景、统一尺寸后打包为素材包，供 Hey 桌宠客户端导入。</li>
        </ol>

        <h2>你需要知道的差异</h2>
        <p>
          AI 重绘会尽量贴近毛色、花纹与神态，但细节上会与真实宠物有差异，动作也是生成的而非你的宠物真实做出的。
          这是本服务的本质，也是我们在购买前要求你确认母图的原因。
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
