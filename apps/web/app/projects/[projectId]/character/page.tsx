import { PageIntro } from "@/components/PageIntro";
import { ProjectSupportCode } from "@/components/ProjectSupportCode";
import { PageShell } from "@/components/PageShell";
import { ProjectWorkflow } from "@/components/ProjectWorkflow";
export default async function CharacterPage({ params }: { params: Promise<{ projectId: string }> }) { const { projectId } = await params; return <PageShell><PageIntro title="确认宠物形象">正面和侧面可以分别重新生成。</PageIntro><ProjectWorkflow projectId={projectId} mode="character" /><ProjectSupportCode projectId={projectId} /></PageShell>; }
