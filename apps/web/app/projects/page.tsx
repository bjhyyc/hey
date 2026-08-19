import Link from "next/link";
import { PageIntro } from "@/components/PageIntro";
import { PageShell } from "@/components/PageShell";
import { ProjectList } from "@/components/ProjectList";

export default function ProjectsPage() { return <PageShell><div className="page-heading-row"><PageIntro title="我的项目" /><Link className="primary-button inline-button" href="/projects/new">新建项目</Link></div><ProjectList /></PageShell>; }
