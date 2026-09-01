import { AdminOperationsConsole } from "@/components/AdminOperationsConsole";
import { PageIntro } from "@/components/PageIntro";
import { PageShell } from "@/components/PageShell";

export default function OperationsPage() {
  return (
    <PageShell wide>
      <PageIntro title="运行管理">检索订单、定位失败环节、授权重跑与补发下载；权限由服务端校验。</PageIntro>
      <AdminOperationsConsole />
    </PageShell>
  );
}
