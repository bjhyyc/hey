import { PageIntro } from "@/components/PageIntro";
import { PageShell } from "@/components/PageShell";
import { ProjectWorkflow } from "@/components/ProjectWorkflow";
export default async function CharacterPage({ params }: { params: Promise<{ projectId: string }> }) { const { projectId } = await params; return <PageShell><PageIntro eyebrow="02" title="确认宠物形象">正面和 45° 母图可以分别重生成。</PageIntro><ProjectWorkflow projectId={projectId} mode="character" /></PageShell>; }
