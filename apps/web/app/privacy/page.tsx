import { PageIntro } from "@/components/PageIntro";
import { PageShell } from "@/components/PageShell";
import { SUPPORT_QQ } from "@/lib/support-channel";

// Every claim below is a description of what the system actually does today,
// checked against the code: the phone number really is never stored (migration
// 010 keeps only an opaque login subject), photos really are downscaled in the
// browser for the pre-check, the download window really is thirty days, and
// deletion really is a manual request - the automatic cleanup policy still runs
// in dry-run mode, so this page promises deletion on request, not on a timer.
export default function PrivacyPage() {
  const contact = SUPPORT_QQ ? `客服 QQ ${SUPPORT_QQ}` : "客服渠道（见页脚）";
  return (
    <PageShell compact>
      <PageIntro title="隐私政策">更新日期：2026 年 9 月 2 日</PageIntro>
      <article className="legal-copy">
        <h2>适用范围</h2>
        <p>
          本政策适用于 heyirmy.com 网站与 Hey 桌宠客户端（以下合称“本服务”，运营方以下简称“我们”）。
          网站备案号：蜀ICP备2026044501号。经营主体名称将在营业执照核发后于本页补充公示。
        </p>

        <h2>我们收集哪些信息</h2>
        <ul>
          <li>
            <strong>手机号。</strong>仅用于登录时的短信验证，验证由腾讯云 CloudBase 完成。
            <strong>我们的服务器不保存你的手机号</strong>——包括加密或哈希形式——只保存一个无法反推出号码的登录标识。
          </li>
          <li>
            <strong>宠物照片。</strong>你主动上传的 3–4 张照片。付款前的预检使用浏览器内缩小到 1000 像素的副本；
            原图在付款后上传至私有存储，仅用于生成你的这一份素材包。请勿上传含他人肖像或与宠物无关的照片。
          </li>
          <li>
            <strong>订单与支付信息。</strong>支付由开联（Kaipay）与支付宝处理，我们只保存订单号、金额、支付状态与时间，
            <strong>不接触也不保存你的银行卡或支付账户信息</strong>。
          </li>
          <li>
            <strong>访问与安全日志。</strong>请求时间、IP 地址、错误信息，用于排障、防止刷接口与滥用；不用于画像或广告。
          </li>
          <li>
            <strong>客户端本地设置。</strong>Hey 桌宠客户端的显示设置与你导入的素材包只保存在你自己的电脑上，不上传。
          </li>
        </ul>

        <h2>我们如何使用这些信息</h2>
        <p>
          仅用于三件事：为你生成并交付 PetPack 素材包、处理售后与退款、保障服务安全。
          你的照片与生成素材<strong>不用于训练任何模型</strong>，不出售，不用于广告，不向无关第三方提供。
        </p>

        <h2>为完成服务而委托处理的第三方</h2>
        <ul>
          <li>腾讯云：登录短信验证（CloudBase）、私有对象存储（COS）、服务器与网络。</li>
          <li>火山引擎 ModelArk：AI 图像与视频生成。你的照片会作为生成输入传送给该服务处理，并依其服务协议处理。</li>
          <li>开联（Kaipay）与支付宝：收款、订单查询与退款。</li>
        </ul>

        <h2>保存期限</h2>
        <ul>
          <li>素材包下载链接自交付起有效 <strong>30 天</strong>；过期可联系客服重新开放。</li>
          <li>为保证售后与重新下载，你的照片、母图、动作视频与素材包在交付后至少保留 30 天。</li>
          <li>超过服务期后我们会分批清理不再需要的素材；你也可以随时申请提前删除（见下节）。</li>
          <li>订单与支付记录按法律要求保存。</li>
        </ul>

        <h2>你的权利</h2>
        <p>
          你可以查看、重新下载或要求删除你的照片与生成素材，也可以要求注销账号。
          请通过{contact}联系我们并提供项目页底部的<strong>项目编号</strong>（这是我们在不保存手机号的前提下定位你的唯一方式）。
          删除后无法恢复；已经下载到你电脑上的素材包不受影响。
        </p>

        <h2>安全措施</h2>
        <p>
          所有素材存放在私有存储，仅通过短时签名链接访问；传输全程加密；服务器凭据最小权限；
          管理员的每一次人工处置都记录审计日志。
        </p>

        <h2>未成年人</h2>
        <p>本服务面向成年用户。未成年人请在监护人同意并陪同下使用。</p>

        <h2>变更</h2>
        <p>本政策更新时会修改页首日期；重大变更会在网站显著位置提示。继续使用本服务视为接受更新后的政策。</p>
      </article>
    </PageShell>
  );
}
