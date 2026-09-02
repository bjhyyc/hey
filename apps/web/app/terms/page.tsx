import { PageIntro } from "@/components/PageIntro";
import { PageShell } from "@/components/PageShell";
import { SUPPORT_QQ } from "@/lib/support-channel";

// The terms restate what the purchase screen already asked the customer to
// confirm, rather than introducing obligations they meet for the first time
// here. A refund rule buried only in this page would not satisfy the
// requirement that it be shown and confirmed before the order is placed.
// The account, retention and contact sections describe the behaviour that is
// actually implemented (thirty-day delivery window the console can reopen,
// account suspension for abuse, project code as the support handle).
export default function TermsPage() {
  const contact = SUPPORT_QQ ? `客服 QQ ${SUPPORT_QQ}` : "页脚的客服渠道";
  return (
    <PageShell compact>
      <PageIntro title="用户服务协议">更新日期：2026 年 9 月 2 日</PageIntro>
      <article className="legal-copy">
        <h2>协议双方</h2>
        <p>
          本协议由你与 heyirmy.com 的运营方（以下简称“我们”）订立，适用于网站与 Hey 桌宠客户端。
          网站备案号：蜀ICP备2026044501号。
          下单即表示你已阅读并同意本协议、<a href="/privacy">隐私政策</a>与<a href="/ai-content">AI 生成内容说明</a>。
        </p>

        <h2>你买到的是什么</h2>
        <p>
          你购买的是一份完整的素材包：三张母图、七段动作视频（组成 5 个动作），经过兼容验证、可导入桌宠客户端使用。
          你付的是这份成品，而不是若干次模型调用——生成过程中的重试、重做由我们承担，不消耗你的权益。
        </p>

        <h2>关于 AI 生成</h2>
        <p>
          成品由 AI 依据你上传的照片重新绘制，会尽量贴近毛色、花纹与神态，但<strong>不是照片的复刻</strong>，
          细节上会有差异。在生成七段动作之前，你会先看到两张母图并自行确认；确认之后，七段动作照此生成。
          详细说明见<a href="/ai-content">AI 生成内容说明</a>。
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
          制作失败时不会向你收费；已扣款而无法交付的，转入人工处理或原路退款。退款沿原支付渠道退回，到账时间以支付机构为准。
        </p>

        <h2>服务期限与素材保留</h2>
        <ul>
          <li>素材包交付后，下载链接有效期为 <strong>30 天</strong>；过期未下载的，可联系客服重新开放。</li>
          <li>素材包下载到你的电脑后即归你保管；请自行备份，客户端不会上传或同步它。</li>
          <li>照片与生成素材的保存与删除规则见<a href="/privacy">隐私政策</a>。</li>
        </ul>

        <h2>账号与使用规范</h2>
        <ul>
          <li>账号通过手机号短信验证登录；请勿将验证码交给他人。</li>
          <li>只上传你自己宠物的照片，不上传含他人肖像、违法或不适宜的内容；我们有权拒绝生成并退款。</li>
          <li>素材包仅供你个人在桌面客户端使用，不得转售、不得批量生成用于商业分发、不得用于误导他人。</li>
          <li>禁止以脚本、刷接口等方式干扰服务。对滥用行为，我们可暂停或终止账号，涉及已付订单的按退换规则处理。</li>
        </ul>

        <h2>你的照片</h2>
        <p>
          照片仅用于为你生成这一份素材包，存放在私有存储中，不公开、不用于训练模型。
          详见<a href="/privacy">隐私政策</a>。
        </p>

        <h2>联系我们</h2>
        <p>
          售后、退款、删除素材等请求请通过<a href="/support">联系客服</a>页面提出（{contact}），并提供项目页底部的<strong>项目编号</strong>。
          我们在工作日 24 小时内回复。
        </p>

        <h2>协议变更与法律适用</h2>
        <p>
          本协议更新时会修改页首日期，重大变更会在网站显著位置提示。本协议适用中华人民共和国法律；
          因本协议产生的争议，双方先行协商，协商不成的，提交我们所在地有管辖权的人民法院解决。
        </p>
      </article>
    </PageShell>
  );
}
