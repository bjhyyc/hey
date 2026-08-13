import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../..");

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), "utf8");
}

function textContent(html) {
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, "");
}

describe("GitHub Pages landing page", () => {
  test("declares an independent Vite landing build", () => {
    const packageJson = JSON.parse(readProjectFile("package.json"));
    const viteConfig = readProjectFile("vite.landing.config.js");

    expect(packageJson.scripts["landing:dev"]).toBe("vite --config vite.landing.config.js");
    expect(packageJson.scripts["landing:build"]).toBe("vite build --config vite.landing.config.js");
    expect(viteConfig).toContain('root: "landing"');
    expect(viteConfig).toContain('outDir: "../dist/pages"');
  });

  test("renders the locked story sections and GitHub CTA", () => {
    const html = readProjectFile("landing/index.html");
    const requiredCopy = [
      "把你家的宠物带到屏幕上",
      "Bring your own pet to life on your desktop.",
      "一点回应，足够治愈一整天",
      "A tiny response can soften the whole day.",
      "它认得你的光标，像认得脚步声",
      "It knows your cursor like footsteps.",
      "拖住它，放在你想要的角落",
      "Hold it, then place it where it belongs.",
      "藏着只有你懂的小细节",
      "Little rituals only you understand.",
      "有它在，安静也是一种陪伴",
      "Quiet can still feel like company.",
      "你的桌面就是它的新家",
      "Your desktop is its new home.",
      "查看 GitHub"
    ];

    const normalizedText = textContent(html);

    for (const copy of requiredCopy) {
      expect(normalizedText).toContain(copy.replace(/\s+/g, ""));
    }

    expect(html).toContain("https://github.com/duzexu/desktop-pet");
    expect(html).toContain("下载 macOS");
    expect(html).toContain("下载 Windows");
    expect(html).toContain("releases/latest/download/Desktop-Pet-mac.dmg");
    expect(html).toContain("releases/latest/download/Desktop-Pet-windows.exe");
    expect(html).toContain('class="download-actions"');
    expect(html).toContain('class="github-cta"');
    expect(html).toContain('class="primary-cta js-app-download"');
    expect(html).toContain('id="download-guide"');
    expect(html).toContain("点击“导入体验包”，应用会自动下载并导入");
    expect(html).toContain("知道了，安装后体验");
    expect(html).toContain("/src/styles.css");
    expect(html).toContain("hero-loop.mp4");
    expect((html.match(/class="story-section/g) || []).length).toBe(7);
  });

  test("keeps layout variants and scroll behavior explicit", () => {
    const css = readProjectFile("landing/src/styles.css");
    const js = readProjectFile("landing/src/main.js");

    for (const className of [
      "layout-left-copy",
      "layout-right-copy",
      "layout-split-copy",
      "layout-top-copy",
      "layout-low-subject"
    ]) {
      expect(css).toContain(className);
    }

    expect(css).toContain("object-fit: cover");
    expect(css).toContain("transition: color");
    expect(css).toContain("prefers-reduced-motion");
    expect(css).toContain(".download-actions");
    expect(css).toContain(".github-cta");
    expect(css).toContain(".download-guide");
    expect(css).toContain("flex-direction: column");
    expect(js).toContain("handleWheel");
    expect(js).toContain("opacityForDistance");
    expect(js).toContain("wheelSensitivity");
    expect(js).toContain("minWheelStep");
    expect(js).toContain("targetProgress");
    expect(js).toContain("startProgressAnimation");
    expect(js).toContain("touchSensitivity");
    expect(js).toContain("snapDelayMs");
    expect(js).toContain("scheduleSnap");
    expect(js).toContain("touchmove");
    expect(js).toContain("hashchange");
    expect(js).toContain("active-section");
    expect(js).toContain("showDownloadGuide");
    expect(js).toContain("downloadDialog.showModal");
  });

  test("adds a sample petpack quick path without changing the manual hero", () => {
    const html = readProjectFile("landing/manual.html");

    expect(html).toContain("如何驯养<br />你的桌面宠物");
    expect(html).toContain("先用体验包跑起来，再慢慢换成你家的宠物");
    expect(html).toContain('class="starter-callout"');
    expect(html).toContain("点击“导入体验包”，1 分钟看到桌宠动起来");
    expect(html).toContain("无需手动选择文件");
    expect(html).toContain('<a class="hero-chip" href="#petpack">素材制作</a>');
    expect(html).toContain('class="download-link" href="#petpack"');
    expect(html).toContain("查看素材制作方法");
  });

  test("documents the end-user quick start before source development", () => {
    const readme = readProjectFile("README.md");

    expect(readme).toContain("下载并安装 [macOS 版本]");
    expect(readme).toContain("首次启动时控制面板会自动打开");
    expect(readme).toContain("导入体验包 / Import sample petpack");
    expect(readme.indexOf("## 快速开始")).toBeLessThan(readme.indexOf("### 从源码运行"));
  });

  test("uses one bilingual bottom navigation for the five middle scenes", () => {
    const html = readProjectFile("landing/index.html");
    const sectionTabs = html.match(/<nav class="section-tabs"[\s\S]*?<\/nav>/)?.[0] ?? "";

    expect(html).not.toContain("class=\"site-nav\"");

    for (const target of ["Response", "Cursor", "Drag", "Ritual", "Focus"]) {
      expect(sectionTabs).toContain(`data-tab-target="${target}"`);
    }

    expect(sectionTabs).not.toContain('data-tab-target="New Home"');
    expect(sectionTabs).toContain("<strong>回应</strong>");
    expect(sectionTabs).toContain("<em>Click Response</em>");
    expect(sectionTabs).toContain("<strong>感知</strong>");
    expect(sectionTabs).toContain("<strong>安放</strong>");
    expect(sectionTabs).toContain("<strong>默契</strong>");
    expect(sectionTabs).toContain("<em>Little Rituals</em>");
  });

  test("ships the selected stable asset names", () => {
    const assetDir = path.join(rootDir, "landing/public/assets");
    const assets = [
      "hero-loop.mp4",
      "hero-loop.webm",
      "hero-loop-small.webm",
      "pet-click.png",
      "pet-click.webp",
      "pet-click-small.webp",
      "pet-cursor.png",
      "pet-cursor.webp",
      "pet-cursor-small.webp",
      "pet-drag.png",
      "pet-drag.webp",
      "pet-drag-small.webp",
      "pet-ritual.png",
      "pet-ritual.webp",
      "pet-ritual-small.webp",
      "pet-quiet.png",
      "pet-quiet.webp",
      "pet-quiet-small.webp",
      "pet-home.png",
      "pet-home.webp",
      "pet-home-small.webp"
    ];

    for (const asset of assets) {
      expect(fs.existsSync(path.join(assetDir, asset))).toBe(true);
    }
  });
});
