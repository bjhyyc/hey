import { PageIntro } from "@/components/PageIntro";
import { PageShell } from "@/components/PageShell";
const actions = ["待机", "打喷嚏", "打滚", "入睡", "睡眠循环", "伸懒腰", "悬停关注"];
export default function PromptsPage() { return <PageShell><PageIntro title="动作提示词">老版动作核心 + 稳定性约束；只有完整发布七条才允许生产生成。</PageIntro><div className="prompt-list">{actions.map((name, index) => <article key={name}><i>{String(index + 1).padStart(2, "0")}</i><strong>{name}</strong><span>未连接</span></article>)}</div></PageShell>; }
