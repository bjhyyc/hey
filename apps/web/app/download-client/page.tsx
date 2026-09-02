import { PageIntro } from "@/components/PageIntro";
import { PageShell } from "@/components/PageShell";
import { CLIENT_DOWNLOAD_SHA256, CLIENT_DOWNLOAD_URL, CLIENT_VERSION } from "@/lib/support-channel";

export default function DownloadClientPage() {
  return (
    <PageShell compact>
      <PageIntro title="桌宠客户端">安装后导入素材包即可使用。</PageIntro>
      <section className="download-card">
        <div className="client-window" aria-hidden="true">
          <div className="window-dots"><i></i><i></i><i></i></div>
          <div className="window-import">导入素材包</div>
        </div>
        <div>
          <h2>导入一次即可使用</h2>
          <ol className="instruction-list compact-list">
            <li><span>1</span>下载并安装桌宠客户端。</li>
            <li><span>2</span>打开客户端，在概览页点击“导入素材包”。</li>
            <li><span>3</span>选择你的 <code>.petpack</code> 文件。</li>
          </ol>
          {CLIENT_DOWNLOAD_URL ? (
            <>
              <a className="primary-button form-submit" href={CLIENT_DOWNLOAD_URL}>
                下载 Windows 客户端{CLIENT_VERSION ? ` v${CLIENT_VERSION}` : ""}
              </a>
              <p className="form-message download-notes">
                安装时 Windows 可能提示“未知发布者”——安装包暂未购买代码签名证书，
                点击“更多信息 → 仍要运行”即可。
                {CLIENT_DOWNLOAD_SHA256 ? (
                  <>
                    {" "}文件校验值 SHA-256:<code className="download-sha">{CLIENT_DOWNLOAD_SHA256}</code>
                  </>
                ) : null}
              </p>
            </>
          ) : (
            <button className="primary-button form-submit" disabled type="button">
              客户端安装包准备后提供下载
            </button>
          )}
        </div>
      </section>
    </PageShell>
  );
}
