import { CopyableValue } from "@/components/CopyableValue";
import { QqChatButton } from "@/components/QqChatButton";
import { PageIntro } from "@/components/PageIntro";
import { PageShell } from "@/components/PageShell";
import {
  HAS_SUPPORT_CHANNEL,
  SUPPORT_EMAIL,
  SUPPORT_QQ,
  SUPPORT_QQ_CARD_URL,
  SUPPORT_QQ_GROUP,
  SUPPORT_QQ_GROUP_URL,
  SUPPORT_QQ_URL
} from "@/lib/support-channel";

// Every support entry on the site points here rather than at QQ's web-to-chat
// URL. Tencent now sells stranger "temporary sessions" as part of 企点, so that
// URL answers "无法发起临时会话" for an ordinary number and strands exactly the
// customer who most needs help. The channels below are the ones that actually
// open a chat window today: join the group, or add the number as a friend.
export default function SupportPage() {
  return (
    <PageShell compact>
      <PageIntro title="联系客服">制作出问题、想退款、要删除照片，都从这里找到我们。</PageIntro>
      <div className="support-card">
        {HAS_SUPPORT_CHANNEL ? null : (
          <p className="form-message">客服渠道正在开通，请稍后再来。</p>
        )}

        {SUPPORT_QQ_GROUP_URL ? (
          <section className="support-block">
            <h2>加入客服群（最快）</h2>
            <p>进群不需要等我们同意，进去直接说问题就行。</p>
            <p>
              <a className="primary-button inline-button" href={SUPPORT_QQ_GROUP_URL} rel="noopener noreferrer" target="_blank">
                加入客服群
              </a>
            </p>
            {SUPPORT_QQ_GROUP ? <CopyableValue label="群号（也可在 QQ 里搜索）" value={SUPPORT_QQ_GROUP} /> : null}
          </section>
        ) : null}

        {SUPPORT_QQ ? (
          <section className="support-block">
            <h2>{SUPPORT_QQ_GROUP_URL ? "加客服 QQ 好友" : "加客服 QQ 好友（推荐）"}</h2>
            <CopyableValue label="客服 QQ" value={SUPPORT_QQ} />
            <p>
              在 QQ 里搜索这个号码，点<strong>加好友</strong>，验证信息填「Hey」。
              我们通过后就能直接聊，也方便后续找回你的订单。
            </p>
            {SUPPORT_QQ_CARD_URL ? (
              <p>
                <a className="primary-button inline-button" href={SUPPORT_QQ_CARD_URL} rel="noopener noreferrer" target="_blank">
                  打开 QQ 名片加好友
                </a>
              </p>
            ) : null}
            <p>
              <QqChatButton uin={SUPPORT_QQ} webUrl={SUPPORT_QQ_URL} />
            </p>
            <p className="support-hint">
              已经加过好友的话，「尝试直接打开 QQ 会话」会唤起电脑或手机上的 QQ 会话窗口。
              如果 QQ 提示「无法发起临时会话」，说明还不是好友——腾讯已把陌生人临时会话并入付费的企点，
              加一下好友就能正常聊了。
            </p>
          </section>
        ) : null}

        {SUPPORT_EMAIL ? (
          <section className="support-block">
            <h2>邮件</h2>
            <CopyableValue label="客服邮箱" value={SUPPORT_EMAIL} />
            <p>不用 QQ 的话，发邮件同样可以处理，回复会慢一些。</p>
          </section>
        ) : null}

        <section className="support-block">
          <h2>联系时请带上项目编号</h2>
          <p>
            项目编号在项目页最下方，形如 <code>3c87e9d1-5f54-…</code>，点一下就能复制。
            我们不保存你的手机号，<strong>项目编号是找到你订单的唯一线索</strong>。
          </p>
          <p className="support-hint">
            制作中断时请不要重复下单——照片和订单都还在，我们可以直接接着处理。
          </p>
        </section>

        <section className="support-block">
          <h2>处理时间</h2>
          <p>工作日 24 小时内回复。退款按原支付渠道退回，到账时间以支付机构为准。</p>
          <p className="support-hint">
            规则详见<a href="/terms">服务协议</a>与<a href="/privacy">隐私政策</a>。
          </p>
        </section>
      </div>
    </PageShell>
  );
}
