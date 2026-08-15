import Link from "next/link";
import { PageIntro } from "@/components/PageIntro";
import { PageShell } from "@/components/PageShell";

export default function NewProjectPage() {
  return <PageShell>
    <PageIntro title="制作独属于你的桌宠">上传 2 张正面全身照和 1~2 张 45° 全身照，其余自动完成。</PageIntro>
    <section className="plan-card">
      <div>
        <p className="eyebrow">PETPACK</p>
        <h2>一个素材包，包含 7 个视频</h2>
        <ul className="check-list">
          <li><span className="check-list-number" aria-hidden="true">1</span>生成并确认宠物形象</li>
          <li><span className="check-list-number" aria-hidden="true">2</span>自动生成睡姿与动作</li>
          <li><span className="check-list-number" aria-hidden="true">3</span>自动抠图、校正并打包</li>
          <li><span className="check-list-number" aria-hidden="true">4</span><span>下载 <Link className="check-list-client-link" href="/download-client" target="_blank">客户端</Link>，导入下载的素材包</span></li>
        </ul>
      </div>
      <div className="plan-cta">
        <Link className="button button-primary" href="/projects/new/pay">选择支付方式</Link>
      </div>
    </section>
  </PageShell>;
}
