import { PageIntro } from "@/components/PageIntro";
import { PageShell } from "@/components/PageShell";
import { PhotoUploadWorkflow } from "@/components/PhotoUploadWorkflow";
export default async function PhotosPage({ params }: { params: Promise<{ projectId: string }> }) { const { projectId } = await params; return <PageShell><PageIntro title="上传照片">两张正面全身照必选，45° 全身照至少一张。</PageIntro><PhotoUploadWorkflow projectId={projectId} /></PageShell>; }
