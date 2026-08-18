import { PhoneLoginForm } from "@/components/PhoneLoginForm";
import { PageIntro } from "@/components/PageIntro";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";

export default function LoginPage() {
  return <div className="site-shell">
    <SiteHeader />
    <main className="shell auth-page">
      <section className="auth-card">
        <PageIntro title="手机号登录">短信验证码登录，无需密码。</PageIntro>
        <PhoneLoginForm
          enabled={process.env.NEXT_PUBLIC_PETPACK_PHONE_AUTH_ENABLED === "true"}
          environmentId={process.env.NEXT_PUBLIC_CLOUDBASE_ENV_ID}
          region={process.env.NEXT_PUBLIC_CLOUDBASE_REGION}
        />
      </section>
    </main>
    <SiteFooter />
  </div>;
}
