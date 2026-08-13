import { HomeUploadEntry } from "@/components/HomeUploadEntry";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";

export default function HomePage() {
  return (
    <div className="site-shell home-shell">
      <SiteHeader />
      <main className="home-main">
        <HomeUploadEntry />
      </main>
      <SiteFooter />
    </div>
  );
}
