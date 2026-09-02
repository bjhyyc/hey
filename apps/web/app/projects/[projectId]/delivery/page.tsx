import { PageIntro } from "@/components/PageIntro";
import { ProjectSupportCode } from "@/components/ProjectSupportCode";
import { PageShell } from "@/components/PageShell";
import { ProjectWorkflow } from "@/components/ProjectWorkflow";
export default async function DeliveryPage({ params }: { params: Promise<{ projectId: string }> }) { const { projectId } = await params; return <PageShell compact><PageIntro title="下载素材包" /><ProjectWorkflow projectId={projectId} mode="delivery" /><ProjectSupportCode projectId={projectId} /></PageShell>; }
