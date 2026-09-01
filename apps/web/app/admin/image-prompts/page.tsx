import { PageIntro } from "@/components/PageIntro";
import { PageShell } from "@/components/PageShell";
const prompts = [["正面母图", "严格正面"], ["45° 母图", "约 45°，不生成完全侧身"], ["睡姿母图", "两张清醒母图共同锁定身份"]];
export default function ImagePromptsPage() { return <PageShell wide><PageIntro title="母图提示词" /><div className="prompt-list">{prompts.map(([name, copy], index) => <article key={name}><i>{String(index + 1).padStart(2, "0")}</i><strong>{name}</strong><span>{copy}</span></article>)}</div></PageShell>; }
