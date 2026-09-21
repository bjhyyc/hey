import type { Metadata } from "next";
import { SOFTWARE_LD, jsonLd, pageMetadata } from "@/lib/seo";
import type { ReactNode } from "react";
import { MacInstall } from "@/components/MacInstall";
import { PageIntro } from "@/components/PageIntro";
import { PageShell } from "@/components/PageShell";
import {
  CLIENT_DOWNLOAD_SHA256,
  CLIENT_DOWNLOAD_URL,
  CLIENT_VERSION,
  MACOS_CLIENT_ARM64_SHA256,
  MACOS_CLIENT_ARM64_URL,
  MACOS_CLIENT_NOTARIZED,
  MACOS_CLIENT_VERSION,
  MACOS_CLIENT_X64_SHA256,
  MACOS_CLIENT_X64_URL,
  MACOS_INSTALL_SCRIPT_URL
} from "@/lib/support-channel";

// Two platforms, one page, and the visitor picks. What differs between them is
// what the two systems do to an app they cannot attribute. Windows interrupts
// once and takes "run anyway". macOS, for a build with no Apple developer
// account behind it, refuses outright and offers no way through from 系统设置 -
// so on macOS the page leads with an install script that does the one thing a
// double-click cannot, and says plainly what that is.

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

function Checksum({ value }: { value: string }) {
  if (!value) return null;
  return (
    <p className="form-message download-notes">
      文件校验值 SHA-256:<code className="download-sha">{value}</code>
    </p>
  );
}

function VersionLabel({ version }: { version: string }) {
  return version ? <span className="download-platform-version">v{version}</span> : null;
}

function PlatformDownload({ platform }: { platform: Platform }) {
  return (
    <div className="download-platform" id={platform.id}>
      {/* The heading carries the version, so the button says what it does
          rather than repeating it. Only alongside a real download: a version
          label on a build nobody can fetch reads as if the button broke. */}
      <h3>
        {platform.name}
        {platform.url ? <VersionLabel version={platform.version} /> : null}
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
          <Checksum value={platform.sha256} />
        </>
      ) : (
        // A disabled button is a control that does nothing; when there is
        // simply no build yet, say so in words instead.
        <p className="form-message">{platform.pending}</p>
      )}
    </div>
  );
}

// The two archives, one per chip. Offered directly once the build is
// notarized; until then they are the manual route under the script.
const MAC_ARCHIVES = [
  { id: "arm64", label: "Apple Silicon（M 系列芯片）", url: MACOS_CLIENT_ARM64_URL, sha256: MACOS_CLIENT_ARM64_SHA256 },
  { id: "intel", label: "Intel 芯片", url: MACOS_CLIENT_X64_URL, sha256: MACOS_CLIENT_X64_SHA256 }
].filter((archive) => archive.url);

function MacDownload() {
  const available = MACOS_CLIENT_NOTARIZED ? MAC_ARCHIVES.length > 0 : Boolean(MACOS_INSTALL_SCRIPT_URL);
  return (
    <div className="download-platform" id="macos">
      <h3>
        macOS
        {available ? <VersionLabel version={MACOS_CLIENT_VERSION} /> : null}
      </h3>
      {!available ? (
        <p className="form-message">macOS 版安装包还在准备中。</p>
      ) : MACOS_CLIENT_NOTARIZED ? (
        // A notarized build opens with no prompt at all, so it is offered like
        // any other download and nothing is said about Gatekeeper.
        MAC_ARCHIVES.map((archive) => (
          <div key={archive.id} className="download-archive">
            <a className="primary-button form-submit" href={archive.url}>下载 {archive.label} 版</a>
            <Checksum value={archive.sha256} />
          </div>
        ))
      ) : (
        <>
          <MacInstall command={`bash -c "$(curl -fsSL ${MACOS_INSTALL_SCRIPT_URL})"`} />
          <p className="form-message download-notes">
            安装包未经 Apple 签名，双击会被拦下，所以用命令安装。
            <a href={MACOS_INSTALL_SCRIPT_URL} target="_blank" rel="noopener noreferrer">查看脚本</a>
          </p>
          {MAC_ARCHIVES.length > 0 ? (
            <details className="download-manual">
              <summary>手动下载（不推荐）</summary>
              <p className="form-message download-notes">
                {MAC_ARCHIVES.map((archive, index) => (
                  <span key={archive.id}>
                    {index > 0 ? " · " : ""}
                    <a href={archive.url}>{archive.label}</a>
                  </span>
                ))}
              </p>
              {MAC_ARCHIVES.map((archive) => (
                <p key={archive.id} className="form-message download-notes">
                  {archive.label} SHA-256:<code className="download-sha">{archive.sha256}</code>
                </p>
              ))}
              <p className="form-message download-notes">
                解压，把 Hey.app 拖进「应用程序」，再在终端跑一次：
                <code className="download-sha">xattr -cr /Applications/Hey.app && codesign --force --deep --sign - /Applications/Hey.app</code>
              </p>
            </details>
          ) : null}
        </>
      )}
    </div>
  );
}

export const metadata: Metadata = pageMetadata({
  title: '桌宠客户端下载（Windows / macOS）',
  description: '下载 Hey 桌宠客户端，导入你的 .petpack 素材包，宠物就会出现在桌面上。支持 Windows 10/11 与 macOS（Apple Silicon 和 Intel）。',
  path: '/download-client'
});

export default function DownloadClientPage() {
  return (
    <PageShell compact>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(SOFTWARE_LD) }} />
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
          <MacDownload />
        </div>
      </section>
    </PageShell>
  );
}
