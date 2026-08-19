import Link from "next/link";
import { PageIntro } from "@/components/PageIntro";
import { PageShell } from "@/components/PageShell";

export default function PaymentReturnPage() {
  return (
    <PageShell compact>
      <PageIntro title="正在确认付款">
        支付结果以服务端通知为准，不需要重复付款。
      </PageIntro>
      <section className="workflow-card stack-form">
        <p className="form-message">
          确认通常很快完成。返回项目列表后，页面会显示最新状态。
        </p>
        <Link className="primary-button inline-button" href="/projects">
          查看我的项目
        </Link>
      </section>
    </PageShell>
  );
}
