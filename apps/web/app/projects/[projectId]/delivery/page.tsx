import { PageIntro } from "@/components/PageIntro";
import { PageShell } from "@/components/PageShell";
import { ProjectWorkflow } from "@/components/ProjectWorkflow";
export default async function DeliveryPage({ params }: { params: Promise<{ projectId: string }> }) { const { projectId } = await params; return <PageShell compact><PageIntro eyebrow="04" title="下载 PetPack" /><ProjectWorkflow projectId={projectId} mode="delivery" /></PageShell>; }
