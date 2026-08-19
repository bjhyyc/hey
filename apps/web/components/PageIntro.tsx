import type { ReactNode } from "react";

export function PageIntro({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-intro">
      <h1>{title}</h1>
      {children ? <p className="page-intro-copy">{children}</p> : null}
    </div>
  );
}
