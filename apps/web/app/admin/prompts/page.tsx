import { PageIntro } from "@/components/PageIntro";
import { PageShell } from "@/components/PageShell";

// See the note in ../image-prompts/page.tsx: an /admin path renders to anyone
// who opens it. This page used to list the internal clip names and state the
// production release rule outright, both of which are the product's own
// know-how. The real list arrives from the admin API, which does check who is
// asking.
export default function PromptsPage() {
  return (
    <PageShell wide sales={false}>
      <PageIntro title="动作提示词" />
      <p className="form-message">登录后由服务端下发当前版本与发布状态。</p>
    </PageShell>
  );
}
