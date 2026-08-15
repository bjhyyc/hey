import Link from "next/link";
import { PageIntro } from "@/components/PageIntro";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";

export default function NotFoundPage() {
  return (
    <div className="site-shell">
      <SiteHeader />
      <main className="shell page-main page-space narrow-page compact-page not-found-page">
        <PageIntro eyebrow="404" title="这里没有内容" />
        <Link className="button button-primary inline-button" href="/">
          返回首页
        </Link>
      </main>
      <SiteFooter />
    </div>
  );
}
