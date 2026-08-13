import Link from "next/link";
import { PageIntro } from "@/components/PageIntro";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";

export default function NotFoundPage() {
  return (
    <div className="site-shell">
      <SiteHeader />
      <main className="page-main compact-page">
        <PageIntro eyebrow="404" title="这里没有内容" />
        <Link className="primary-button inline-button" href="/">
          返回首页
        </Link>
      </main>
      <SiteFooter />
    </div>
  );
}
