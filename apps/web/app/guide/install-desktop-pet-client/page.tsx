import type { Metadata } from "next";
import Link from "next/link";
import { PageIntro } from "@/components/PageIntro";
import { PageShell } from "@/components/PageShell";
import { SITE_URL, jsonLd, pageMetadata } from "@/lib/seo";

// The install guide for both systems, written for someone who has never
// opened Terminal. Everything here matches the download page's current
// build; when the installer, the script or a system prompt changes, change
// it here in the same commit.

export const metadata: Metadata = pageMetadata({
  title: "桌宠客户端安装指南（Windows 与 macOS）",
  description:
    "Hey 桌宠客户端在 Windows 10/11 和 macOS 上的安装步骤，包括「未知发布者」提示怎么处理、Mac 为什么用一行命令安装、装好以后怎么导入素材包、怎么卸载。",
  path: "/guide/install-desktop-pet-client"
});

const ARTICLE_LD = {
  "@context": "https://schema.org",
  "@type": "Article",
  headline: "桌宠客户端安装指南（Windows 与 macOS）",
  inLanguage: "zh-CN",
  author: { "@type": "Organization", name: "Hey" },
  publisher: { "@type": "Organization", name: "Hey", url: SITE_URL },
  mainEntityOfPage: `${SITE_URL}/guide/install-desktop-pet-client`
};

export default function InstallDesktopPetClientGuide() {
  return (
    <PageShell compact>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(ARTICLE_LD) }} />
      <PageIntro title="桌宠客户端安装指南">
        客户端是免费的，装一次就够；之后每一份素材包都是导入进来用。
      </PageIntro>
      <article className="support-card legal-copy">
        <section className="support-block">
          <h2>先确认你的电脑</h2>
          <ul>
            <li><strong>Windows</strong>：Windows 10 或 11，64 位。</li>
            <li><strong>Mac</strong>：Apple Silicon（M 系列芯片）和 Intel 芯片都支持，安装命令会自动识别。</li>
            <li>手机和 iPad 上不能安装——桌面宠物是电脑上的程序。</li>
          </ul>
        </section>

        <section className="support-block" id="windows">
          <h2>Windows：三步</h2>
          <ol>
            <li>到<Link href="/download-client">下载页</Link>点「下载 Windows 客户端」，得到 <code>Hey-Setup-1.0.0.exe</code>。</li>
            <li>双击安装。Windows 可能弹出蓝色的 SmartScreen 提示「Windows 已保护你的电脑」——这是因为安装包暂时没有购买代码签名证书。点「<strong>更多信息</strong>」，再点「<strong>仍要运行</strong>」。</li>
            <li>安装完成会自动打开。之后从开始菜单或桌面图标打开即可；关闭窗口后它会缩到右下角托盘，左键点托盘图标能重新打开控制面板。</li>
          </ol>
          <p>如果想核对下载的文件没有损坏，下载页列出了安装包的 SHA-256 校验值。</p>
        </section>

        <section className="support-block" id="macos">
          <h2>macOS：一行命令</h2>
          <p>
            Mac 版暂时没有取得 Apple 的开发者签名，直接双击下载的程序会被系统拦下、而且没法从「系统设置」里放行。
            所以用一行命令安装，它会下载、校验、装进「应用程序」并打开：
          </p>
          <ol>
            <li>到<Link href="/download-client#macos">下载页</Link>点「<strong>复制安装命令</strong>」。</li>
            <li>打开「终端」：在启动台里搜「终端」，或者按 <code>⌘ + 空格</code> 输入「终端」。</li>
            <li>粘贴，按回车。等它跑完，Hey 会自己打开。</li>
          </ol>
          <p>
            过程中会看到它检测芯片、下载、校验文件完整性、安装、然后启动。全程不会弹出「无法验证开发者」之类的窗口。
            装好以后和普通应用一样，从启动台或「应用程序」文件夹打开。
          </p>
          <p>
            <strong>右键的小提示</strong>：Mac 上第一次在宠物身上点右键，可能需要点两下——第一下被系统用来激活窗口了。新版客户端已经处理了这个问题。
          </p>
        </section>

        <section className="support-block">
          <h2>装好以后：导入素材包</h2>
          <ol>
            <li>在项目页下载你的 <code>.petpack</code> 文件（制作完成后项目页会出现下载按钮）。</li>
            <li>打开客户端，在「概览」页点「<strong>导入素材包</strong>」，选中那个文件。</li>
            <li>宠物出现在桌面上。大小会按你的屏幕自动选好；想调大小或透明度，在客户端「显示」页拖滑块。</li>
          </ol>
          <p>还没有素材包？先看<Link href="/guide/pet-photo-to-desktop-pet">怎么把宠物照片做成桌面宠物</Link>。</p>
        </section>

        <section className="support-block">
          <h2>卸载</h2>
          <ul>
            <li><strong>Windows</strong>：设置 → 应用 → 找到 Hey → 卸载。</li>
            <li><strong>Mac</strong>：把「应用程序」里的 Hey 拖到废纸篓；或在终端执行 <code>rm -rf /Applications/Hey.app</code>。</li>
          </ul>
        </section>

        <section className="support-block">
          <h2>装不上？</h2>
          <p>
            把你看到的提示原文（Windows 截图、或 Mac 终端里从头到尾的输出）发给<Link href="/support">客服</Link>，我们直接处理，不用自己折腾。
          </p>
        </section>
      </article>
    </PageShell>
  );
}
