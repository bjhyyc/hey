import { PageIntro } from "@/components/PageIntro";
import { ProjectSupportCode } from "@/components/ProjectSupportCode";
import { PageShell } from "@/components/PageShell";
import { PhotoUploadWorkflow } from "@/components/PhotoUploadWorkflow";
export default async function PhotosPage({ params }: { params: Promise<{ projectId: string }> }) { const { projectId } = await params; return <PageShell><PageIntro title="上传照片">两张正面照必选，侧面照至少一张。</PageIntro><PhotoUploadWorkflow projectId={projectId} /><ProjectSupportCode projectId={projectId} /></PageShell>; }
