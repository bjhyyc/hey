import type { ReactNode } from "react";
import { PageIntro } from "@/components/PageIntro";
import { PageShell } from "@/components/PageShell";
import {
  CLIENT_DOWNLOAD_SHA256,
  CLIENT_DOWNLOAD_URL,
  CLIENT_VERSION,
  MACOS_CLIENT_DOWNLOAD_SHA256,
  MACOS_CLIENT_DOWNLOAD_URL,
  MACOS_CLIENT_NOTARIZED,
  MACOS_CLIENT_VERSION
} from "@/lib/support-channel";

// Two platforms, one page, and the visitor picks. Each one carries the same
// three things - a button, the version it is, and the checksum to verify it -
// so neither reads as the afterthought. What differs is the warning, because
// what the two systems do to an app they cannot attribute differs: Windows
// interrupts once and takes "run anyway"; macOS refuses outright until the
// customer goes and changes a setting.

type Platform = {
  id: string;
  name: string;
  url: string;
  version: string;
  sha256: string;
  /** Shown under the button. Null when the download needs no explanation. */
  note: ReactNode | null;
  /** Shown in place of the button when this platform has no build yet. */
  pending: string;
};

const WINDOWS: Platform = {
  id: "windows",
  name: "Windows",
  url: CLIENT_DOWNLOAD_URL,
  version: CLIENT_VERSION,
  sha256: CLIENT_DOWNLOAD_SHA256,
  note: (
    <>安装时 Windows 可能提示“未知发布者”——安装包暂未购买代码签名证书，点击“更多信息 → 仍要运行”即可。</>
  ),
  pending: "Windows 版安装包还在准备中。"
};

const MACOS: Platform = {
  id: "macos",
  name: "macOS",
  url: MACOS_CLIENT_DOWNLOAD_URL,
  version: MACOS_CLIENT_VERSION,
  sha256: MACOS_CLIENT_DOWNLOAD_SHA256,
  // A notarized build opens with no prompt at all, so saying anything would
  // only invite the customer to look for a problem that is not there.
  note: MACOS_CLIENT_NOTARIZED ? null : (
    <>
      安装包暂未向 Apple 申请签名与公证，macOS 会拦下它。首次打开时如果提示无法验证开发者，请打开
      “系统设置 → 隐私与安全性”，在页面下方点“仍要打开”，再确认一次即可。
      （macOS 15 起，右键“打开”这个老办法已经不管用了。）
    </>
  ),
  pending: "macOS 版安装包还在准备中。"
};

function PlatformDownload({ platform }: { platform: Platform }) {
  return (
    <div className="download-platform" id={platform.id}>
      {/* The heading carries the version, so the button says what it does
          rather than repeating it. */}
      <h3>
        {platform.name}
        {/* Only alongside a real download: a version label on a build nobody
            can fetch reads as if something went wrong with the button. */}
        {platform.url && platform.version ? (
          <span className="download-platform-version">v{platform.version}</span>
        ) : null}
      </h3>
      {platform.url ? (
        <>
          <a
            className="primary-button form-submit"
            href={platform.url}
            aria-label={`下载 ${platform.name} 客户端${platform.version ? ` v${platform.version}` : ""}`}
          >
            下载 {platform.name} 客户端
          </a>
          {platform.note ? <p className="form-message download-notes">{platform.note}</p> : null}
          {platform.sha256 ? (
            <p className="form-message download-notes">
              文件校验值 SHA-256:<code className="download-sha">{platform.sha256}</code>
            </p>
          ) : null}
        </>
      ) : (
        // A disabled button is a control that does nothing; when there is
        // simply no build yet, say so in words instead.
        <p className="form-message">{platform.pending}</p>
      )}
    </div>
  );
}

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
          <p className="form-message">
            导入后宠物会按你的屏幕自动选好大小；它会做什么、怎么触发，见<a href="/faq#play">常见问题</a>。
          </p>
        </div>
        {/* Its own row across the whole card, rather than squeezed into the
            column beside the illustration: the choice is the point of the page,
            and side by side at full width neither platform looks secondary. */}
        <div className="download-platforms">
          <PlatformDownload platform={WINDOWS} />
          <PlatformDownload platform={MACOS} />
        </div>
      </section>
    </PageShell>
  );
}
