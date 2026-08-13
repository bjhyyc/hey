import { PageIntro } from "@/components/PageIntro";
import { PageShell } from "@/components/PageShell";
import { ProjectWorkflow } from "@/components/ProjectWorkflow";
export default async function ProgressPage({ params }: { params: Promise<{ projectId: string }> }) { const { projectId } = await params; return <PageShell compact><PageIntro eyebrow="03" title="正在制作">睡姿、七个动作、抠图和 PetPack 会自动完成。</PageIntro><ProjectWorkflow projectId={projectId} mode="progress" /></PageShell>; }
