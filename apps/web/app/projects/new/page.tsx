import { NewProjectForm } from "@/components/NewProjectForm";
import { PageIntro } from "@/components/PageIntro";
import { PageShell } from "@/components/PageShell";

export default function NewProjectPage() { return <PageShell compact><PageIntro eyebrow="PETPACK" title="制作独属于你的桌宠">上传 2 张正面全身照和 1~2 张 45° 全身照，其余自动完成。</PageIntro><NewProjectForm /><ol className="process-steps"><li>生成并确认宠物形象</li><li>自动生成睡姿与 7 个视频</li><li>自动抠图、校正并打包</li><li>下载客户端，导入下载的素材包</li></ol></PageShell>; }
