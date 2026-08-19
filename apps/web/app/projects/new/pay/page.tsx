import { NewProjectForm } from "@/components/NewProjectForm";
import { PageIntro } from "@/components/PageIntro";
import { PageShell } from "@/components/PageShell";

export default function PaymentPage() {
  return <PageShell compact>
    <PageIntro title="创建订单">确认宠物信息，使用支付宝完成付款。</PageIntro>
    <NewProjectForm />
  </PageShell>;
}
