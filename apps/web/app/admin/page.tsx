import Link from "next/link";
import { PageIntro } from "@/components/PageIntro";
import { PageShell } from "@/components/PageShell";

// This index renders to anyone who opens /admin, so the descriptions say what
// each tool is for without describing how the product is made.
const links = [
  ["运行管理", "/admin/operations", "订单与处置"],
  ["动作提示词", "/admin/prompts", "版本与发布"],
  ["形象提示词", "/admin/image-prompts", "版本与发布"],
] as const;
export default function AdminPage() { return <PageShell wide sales={false}><PageIntro title="管理后台" /><div className="admin-grid">{links.map(([title, href, copy]) => <Link className="admin-card" href={href} key={href}><strong>{title}</strong><small>{copy}</small></Link>)}</div><p className="form-message">管理员权限由服务端校验；页面本身不授予任何权限。</p></PageShell>; }
