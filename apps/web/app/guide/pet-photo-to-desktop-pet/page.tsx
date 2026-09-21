import type { Metadata } from "next";
import Link from "next/link";
import { PageIntro } from "@/components/PageIntro";
import { PageShell } from "@/components/PageShell";
import { SITE_URL, jsonLd, pageMetadata } from "@/lib/seo";

// An evergreen answer to the search this product exists for. Everything in it
// is what the service does today; when a step, a count or a limit changes,
// change it here in the same commit. It names no model and no pipeline stage.

export const metadata: Metadata = pageMetadata({
  title: "怎么把宠物照片做成会动的桌面宠物",
  description:
    "用 3–4 张自家猫狗的照片，约 20 分钟做出一只会打喷嚏、打滚、伸懒腰、舔脚、睡觉的桌面宠物：照片怎么选、要经过哪几步、成品和照片有什么差异、导入桌面要做什么。",
  path: "/guide/pet-photo-to-desktop-pet"
});

const ARTICLE_LD = {
  "@context": "https://schema.org",
  "@type": "Article",
  headline: "怎么把宠物照片做成会动的桌面宠物",
  inLanguage: "zh-CN",
  author: { "@type": "Organization", name: "Hey" },
  publisher: { "@type": "Organization", name: "Hey", url: SITE_URL },
  mainEntityOfPage: `${SITE_URL}/guide/pet-photo-to-desktop-pet`
};

export default function PetPhotoToDesktopPetGuide() {
  return (
    <PageShell compact>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(ARTICLE_LD) }} />
      <PageIntro title="怎么把宠物照片做成会动的桌面宠物">
        不需要会画画，也不需要会剪视频。你只负责选照片和看像不像，其余的等就行。
      </PageIntro>
      <article className="support-card legal-copy">
        <section className="support-block">
          <h2>先说结果：你会得到什么</h2>
          <p>
            一只按你家宠物的样子重新绘制的桌面宠物，会打喷嚏、打滚、伸懒腰、舔脚、睡觉，安静时自己待机。
            它打包成一个素材包文件，导入 <Link href="/download-client">Hey 桌宠客户端</Link> 后就住在你的桌面上，Windows 和 macOS 都可以。
          </p>
          <p>
            要说清楚的一点：成品是 AI 依据照片<strong>重新绘制</strong>的，不是把照片抠出来动起来。毛色、花纹、神态会尽量贴近，细节上一定有差异。
            所以流程里专门有一步让你先看形象像不像，满意了才往下走。
          </p>
        </section>

        <section className="support-block">
          <h2>第一步：选照片（最影响结果的一步）</h2>
          <p>需要 <strong>3 张必选、第 4 张可选</strong>：两张正面照、一张侧面照，可以再补一张另一侧的侧面照。</p>
          <ul>
            <li><strong>同一只宠物、同一时期。</strong>幼年和成年的照片混在一起，画出来的是一只不存在的宠物。</li>
            <li><strong>五官和身体花色看得清。</strong>逆光、糊掉、只露半张脸的照片，画出来只能靠猜。</li>
            <li><strong>正面照要正面。</strong>侧着脸的照片会被判成侧面照，上传时会当场告诉你。</li>
            <li><strong>花色左右不对称的，两侧都传。</strong>只传一侧，另一侧就是编的。</li>
            <li>只传自己宠物的照片；含真人的照片不会被接受。</li>
          </ul>
          <p>照片选好点「开始制作」，系统会在你付款前先预检一遍：够不够清晰、是不是同一只。不合格逐张告诉你原因，这一步不收费。</p>
        </section>

        <section className="support-block">
          <h2>第二步：付款</h2>
          <p>预检通过才会进入付款，支付宝扫码，78 元一次买断这一份素材包。付款前需要勾选确认你知道成品是 AI 生成的。</p>
        </section>

        <section className="support-block">
          <h2>第三步：确认形象（你唯一需要做判断的地方）</h2>
          <p>
            付款后先画出正面和侧面两张形象图，你回到项目页看像不像。哪张不满意就单独重画哪张，<strong>每张可以免费重画 2 次</strong>。
            确认之后所有动作都按这个形象生成，中途不能再换——所以这一步宁可多花两分钟。
          </p>
        </section>

        <section className="support-block">
          <h2>第四步：等它自己生成（约 10–20 分钟）</h2>
          <p>
            动作全部自动生成，生成完自动检查效果、自动打包。这段时间你可以关掉页面，回来时进度还在，做完了项目页会变成可下载。
          </p>
        </section>

        <section className="support-block">
          <h2>第五步：下载素材包，导入桌面</h2>
          <p>
            在项目页下载 <code>.petpack</code> 文件，安装 <Link href="/download-client">桌宠客户端</Link>，在客户端概览页点「导入素材包」选中它，宠物就出现在桌面上了。
            安装步骤见 <Link href="/guide/install-desktop-pet-client">客户端安装指南</Link>。
          </p>
          <p>
            导入后它自带一套触发规则：单击打喷嚏、双击打滚、右键伸懒腰、鼠标停在它身上舔脚、22 秒没人理就趴下睡觉——睡着以后只有右键能叫醒它。
            详细规则在<Link href="/faq#play">常见问题</Link>。
          </p>
        </section>

        <section className="support-block">
          <h2>整个过程要多久</h2>
          <p>全程约 20 分钟，其中你真正动手的大约 5 分钟：选照片 1 分钟、付款 1 分钟、确认形象 2 分钟、下载导入 2 分钟。剩下的是等待生成。</p>
        </section>

        <section className="support-block">
          <h2>常见的三个疑问</h2>
          <p><strong>能不能做别人家的宠物、或者已经去世的宠物？</strong>——照片是你自己宠物的就可以，有没有还在身边不影响制作。很多人做的正是不在了的那一只。</p>
          <p><strong>手机上能用吗？</strong>——制作在手机浏览器里就能完成，但桌面宠物本身是电脑上的程序，需要在 Windows 或 macOS 上导入。</p>
          <p><strong>一份素材包能装几台电脑？</strong>——素材包是一个文件，供你个人在自己的电脑上使用。</p>
        </section>

        <p className="form-message">
          准备好照片了？<Link href="/">回首页开始制作</Link>。
        </p>
      </article>
    </PageShell>
  );
}
