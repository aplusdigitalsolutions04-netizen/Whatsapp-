import { useEffect, useState, type ReactNode } from "react";

type Tone = "success" | "warning" | "critical" | "info" | undefined;

export function Page({ title, subtitle, actions, children }: { title: string; subtitle?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="o-page">
      <header className="o-head">
        <div>
          <h1 className="o-title">{title}</h1>
          {subtitle && <p className="o-sub">{subtitle}</p>}
        </div>
        {actions && <div className="o-row">{actions}</div>}
      </header>
      {children}
    </div>
  );
}

export function Card({ title, action, children }: { title?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="o-card">
      {(title || action) && (
        <div className="o-card-head">
          {title && <h2>{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Banner({ tone, children }: { tone?: Tone; children: ReactNode }) {
  return <div className={`o-banner ${tone ?? ""}`} role={tone === "critical" ? "alert" : "status"}>{children}</div>;
}

export function Badge({ tone, children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`o-badge ${tone ?? ""}`}>{children}</span>;
}

export function Stat({ label, value, bad }: { label: string; value: number; bad?: boolean }) {
  return (
    <div className={`o-stat ${bad && value > 0 ? "bad" : ""}`}>
      <div className="o-stat-label">{label}</div>
      <div className="o-stat-value">{value}</div>
    </div>
  );
}

/**
 * Renders its children only in the browser. Pages show dates, times and numbers in the viewer's own locale and
 * time zone, which can never match the server's HTML; rendering them after mount avoids hydration errors.
 */
export function ClientOnly({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted ? <>{children}</> : <div className="o-page"><p className="o-muted">Loading…</p></div>;
}
