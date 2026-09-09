import { PageIntro } from "@/components/PageIntro";
import { PageShell } from "@/components/PageShell";

// Everything on an /admin page renders to whoever opens the URL - the route is
// not gated, only the APIs behind it are. This page used to state each master
// prompt's design intent in hardcoded text, so the whole prompt strategy was
// readable at heyirmy.com/admin/image-prompts by anyone who guessed the path.
// The editors themselves live behind the admin APIs; this page is navigation,
// and it now says nothing a competitor could use.
const VIEWS = [
  { id: "front", label: "正面" },
  { id: "side", label: "侧面" },
  { id: "sleep", label: "睡眠" }
] as const;

export default function ImagePromptsPage() {
  return (
    <PageShell wide sales={false}>
      <PageIntro title="形象提示词" />
      <div className="prompt-list">
        {VIEWS.map((view, index) => (
          <article key={view.id}>
            <i>{String(index + 1).padStart(2, "0")}</i>
            <strong>{view.label}</strong>
            <span>登录后可编辑</span>
          </article>
        ))}
      </div>
      <p className="form-message">内容与历史版本由服务端按管理员身份下发。</p>
    </PageShell>
  );
}
