import { PageIntro } from "@/components/PageIntro";
import { PageShell } from "@/components/PageShell";

export default function DownloadClientPage() { return <PageShell compact>
  <PageIntro title="桌宠客户端">安装后导入 PetPack 即可使用。</PageIntro>
  <section className="download-card">
    <div className="client-window" aria-hidden="true"><div className="window-dots"><i></i><i></i><i></i></div><div className="window-import">导入我的 PetPack</div></div>
    <div><h2>导入一次即可使用</h2><ol className="instruction-list compact-list"><li><span>1</span>下载并安装桌宠客户端。</li><li><span>2</span>在首页点击“导入我的 PetPack”。</li><li><span>3</span>选择你的 <code>.petpack</code> 文件。</li></ol>
    <button className="button button-primary" disabled type="button">客户端安装包准备后提供下载</button></div>
  </section>
</PageShell>; }
