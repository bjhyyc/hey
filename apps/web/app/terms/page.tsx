import { PageIntro } from "@/components/PageIntro";
import { PageShell } from "@/components/PageShell";
export default function TermsPage() { return <PageShell compact><PageIntro title="用户服务协议" /><article className="legal-copy"><p>用户购买的是经过兼容验证、可导入客户端的完整 PetPack，而不是若干次模型调用。</p><p>模型内部重试不消耗用户权益；无法交付时进入人工处理或退款。正式经营条款获批前，生产购买保持关闭。</p></article></PageShell>; }
