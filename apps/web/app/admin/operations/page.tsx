import { PageIntro } from "@/components/PageIntro";
import { PageShell } from "@/components/PageShell";
export default function OperationsPage() { return <PageShell><PageIntro title="运行管理">订单、来源照、母图、七视频、质检、打包与交付状态。</PageIntro><section className="workflow-card"><p className="empty-state">连接生产服务后显示运行数据。</p></section></PageShell>; }
