import type { ReactNode } from "react";

/** The card every account screen sits in: a header line, the content, an optional footer. */
export function AuthCard({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className="page">
      <section className="card" aria-labelledby="card-title">
        <div className="card-header">
          <span className="brand">
            <span className="brand-mark" aria-hidden="true" />
            {__DEPO_JS_NAME__}
          </span>
          <span>Your account</span>
        </div>
        <div className="card-body">
          <h1 id="card-title">{title}</h1>
          {subtitle ? <p className="subtitle">{subtitle}</p> : null}
          {children}
        </div>
        {footer ? <div className="card-footer">{footer}</div> : null}
      </section>
    </main>
  );
}
