import { PageIntro } from "@/components/PageIntro";
import { ProjectSupportCode } from "@/components/ProjectSupportCode";
import { PageShell } from "@/components/PageShell";
import { ProjectWorkflow } from "@/components/ProjectWorkflow";
export default async function ProgressPage({ params }: { params: Promise<{ projectId: string }> }) { const { projectId } = await params; return <PageShell compact><PageIntro title="正在制作">剩下的全部自动完成，通常需要 10–20 分钟；可以关闭页面，回来时进度不会丢失。</PageIntro><ProjectWorkflow projectId={projectId} mode="progress" /><ProjectSupportCode projectId={projectId} /></PageShell>; }
