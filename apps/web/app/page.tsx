import { HomeUploadEntry } from "@/components/HomeUploadEntry";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";

export default function HomePage() {
  return (
    <div className="site-shell home-shell">
      <SiteHeader home />
      <main className="pika-home">
        <HomeUploadEntry />
      </main>
      <SiteFooter />
    </div>
  );
}
