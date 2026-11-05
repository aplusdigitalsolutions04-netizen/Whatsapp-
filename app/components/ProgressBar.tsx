import type { ReactNode } from "react";

/**
 * One progress bar for every slow job in the app.
 * With a `total` it shows a real percentage; without one (the size of the job is not known yet) it shows a moving bar
 * and the count so far, so the person can still see that work is happening.
 */
export function ProgressBar({
  label, done = 0, total = null, running = true, detail, tone,
}: {
  label: ReactNode;
  done?: number;
  total?: number | null;
  running?: boolean;
  detail?: ReactNode;
  tone?: "ok" | "bad";
}) {
  const known = total != null && total > 0;
  const pct = known ? Math.max(0, Math.min(100, Math.round((done / total!) * 100))) : 0;
  return (
    <div className={`pbar${running ? " live" : ""}${known ? "" : running ? " indet" : ""}${tone ? ` ${tone}` : ""}`}>
      <div className="pbar-head">
        <span className="pbar-label">{label}</span>
        <span className="pbar-num">
          {known ? <><b>{pct}%</b> · {done.toLocaleString()} of {total!.toLocaleString()}</> : done > 0 ? <>{done.toLocaleString()} so far</> : running ? "Working…" : ""}
        </span>
      </div>
      <div
        className="pbar-track"
        role="progressbar"
        aria-label={typeof label === "string" ? label : "Progress"}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={known ? pct : undefined}
      >
        <i className="pbar-fill" style={known ? { width: `${pct}%` } : undefined} />
      </div>
      {detail && <div className="pbar-detail">{detail}</div>}
    </div>
  );
}
