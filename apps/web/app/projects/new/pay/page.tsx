import { NewProjectForm } from "@/components/NewProjectForm";
import { PageIntro } from "@/components/PageIntro";
import { PageShell } from "@/components/PageShell";

export default function PaymentPage() { return <PageShell compact><PageIntro eyebrow="购买" title="开始制作">支付由 Kaipay 安全处理；只有服务端确认支付成功后才会开始生成。</PageIntro><NewProjectForm /></PageShell>; }
