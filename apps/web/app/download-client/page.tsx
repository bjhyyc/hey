import Link from "next/link";
import { PageIntro } from "@/components/PageIntro";
import { PageShell } from "@/components/PageShell";

export default function DownloadClientPage() { return <PageShell compact>
  <PageIntro title="桌宠客户端">安装后导入 PetPack 即可使用。</PageIntro>
  <section className="workflow-card"><ol className="process-steps"><li>下载并安装客户端</li><li>打开客户端首页</li><li>点击“导入我的 PetPack”</li><li>选择从 Hey 下载的素材包</li></ol>
    <p className="form-message">正式签名安装包准备后将在这里提供下载。</p>
    <Link className="primary-button inline-button" href="/projects">导入我的 PetPack</Link>
  </section>
</PageShell>; }
