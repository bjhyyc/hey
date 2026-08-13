import { PhoneLoginForm } from "@/components/PhoneLoginForm";
import { PageIntro } from "@/components/PageIntro";
import { PageShell } from "@/components/PageShell";

export default function LoginPage() {
  return <PageShell compact><PageIntro eyebrow="欢迎" title="手机号登录">短信验证码登录，无需密码。</PageIntro>
    <section className="workflow-card"><PhoneLoginForm
      enabled={process.env.NEXT_PUBLIC_PHONE_AUTH_ENABLED === "true"}
      environmentId={process.env.NEXT_PUBLIC_CLOUDBASE_ENV_ID}
      region={process.env.NEXT_PUBLIC_CLOUDBASE_REGION}
    /></section></PageShell>;
}
