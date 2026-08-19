import { PageIntro } from "@/components/PageIntro";
import { PageShell } from "@/components/PageShell";

// The terms restate what the purchase screen already asked the customer to
// confirm, rather than introducing obligations they meet for the first time
// here. A refund rule buried only in this page would not satisfy the
// requirement that it be shown and confirmed before the order is placed.
export default function TermsPage() {
  return (
    <PageShell compact>
      <PageIntro title="用户服务协议" />
      <article className="legal-copy">
        <h2>你买到的是什么</h2>
        <p>
          你购买的是一份完整的 PetPack 素材包：三张母图、七段动作视频，经过兼容验证、可导入桌宠客户端使用。
          你付的是这份成品，而不是若干次模型调用——生成过程中的重试、重做由我们承担，不消耗你的权益。
        </p>

        <h2>关于 AI 生成</h2>
        <p>
          成品由 AI 依据你上传的照片重新绘制，会尽量贴近毛色、花纹与神态，但<strong>不是照片的复刻</strong>，
          细节上会有差异。在生成七段动作之前，你会先看到两张母图并自行确认；确认之后，七段动作照此生成。
        </p>

        <h2>退换规则</h2>
        <p>
          本商品为按你提供的照片定制生成的数字内容。依据《中华人民共和国消费者权益保护法》第二十五条，
          定作商品与数字化商品交付后不适用七天无理由退货。该说明会在你提交订单前单独告知并需你确认。
        </p>
        <p>出现下列情况，我们免费重做或全额退款：</p>
        <ul>
          <li>文件损坏，或无法导入桌宠客户端</li>
          <li>交付内容与你确认的母图明显不符</li>
          <li>七段动作有缺失</li>
        </ul>
        <p>
          制作失败时不会向你收费；已扣款而无法交付的，转入人工处理或原路退款。
        </p>

        <h2>你的照片</h2>
        <p>
          照片仅用于为你生成这一份素材包，存放在私有存储中，不公开、不用于训练模型。
          详见<a href="/privacy">隐私政策</a>。
        </p>
      </article>
    </PageShell>
  );
}
