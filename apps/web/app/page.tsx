import { HomeUploadEntry } from "@/components/HomeUploadEntry";
import { ProductionFlow } from "@/components/ProductionFlow";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";

export default function HomePage() {
  return (
    <div className="site-shell home-shell">
      <SiteHeader home />
      <main>
        <section className="pika-home">
          <HomeUploadEntry />
        </section>
        {/* The second screen: what the customer is actually buying into,
            one scroll below the upload card that asks for their photographs. */}
        <section aria-labelledby="flow-heading" className="home-flow-screen" id="flow">
          <div className="home-flow-inner">
            <h2 id="flow-heading">制作流程</h2>
            <p className="home-flow-lede">
              一共 5 步，你只参与其中 3 步：传照片、付款、确认形象。剩下的我们自动完成。
            </p>
            <ProductionFlow />
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
