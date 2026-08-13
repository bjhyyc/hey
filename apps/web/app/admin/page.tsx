import Link from "next/link";
import { PageIntro } from "@/components/PageIntro";
import { PageShell } from "@/components/PageShell";

const links = [
  ["运行管理", "/admin/operations", "订单、生成、打包与失败处理"],
  ["动作提示词", "/admin/prompts", "七个动作的发布与回滚"],
  ["母图提示词", "/admin/image-prompts", "正面、45° 与睡姿提示词"],
] as const;
export default function AdminPage() { return <PageShell><PageIntro title="管理后台" /><div className="admin-grid">{links.map(([title, href, copy]) => <Link className="admin-card" href={href} key={href}><strong>{title}</strong><small>{copy}</small></Link>)}</div><p className="form-message">管理员权限由服务端校验；页面本身不授予任何权限。</p></PageShell>; }
