// Small dependency-free SVG charts for the dashboard. Hover a bar for exact numbers (native tooltips).

export type Series = { key: string; label: string; color: string };

const niceMax = (n: number) => {
  if (n <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(n));
  const f = n / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
};

/** Stacked vertical bars, one column per item (days, hours...). */
export function StackedBars({
  data, series, label, height = 190, every = 1,
}: {
  data: Record<string, number | string>[];
  series: Series[];
  label: (d: Record<string, number | string>) => string;
  height?: number;
  every?: number;
}) {
  const W = 640;
  const padL = 34;
  const padB = 24;
  const padT = 8;
  const H = height;
  const sum = (d: Record<string, number | string>) => series.reduce((a, s) => a + Number(d[s.key] ?? 0), 0);
  const max = niceMax(Math.max(0, ...data.map(sum)));
  const innerW = W - padL - 6;
  const step = innerW / Math.max(1, data.length);
  const bw = Math.max(3, Math.min(26, step * 0.64));
  const y = (v: number) => padT + (H - padT - padB) * (1 - v / max);
  const empty = data.every((d) => sum(d) === 0);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="ch" role="img" aria-label={series.map((s) => s.label).join(", ")}>
      {[0, 0.25, 0.5, 0.75, 1].map((t) => (
        <g key={t}>
          <line x1={padL} x2={W - 6} y1={y(max * t)} y2={y(max * t)} stroke="#e7dfd5" strokeDasharray={t === 0 ? undefined : "3 4"} />
          <text x={padL - 6} y={y(max * t) + 3.5} textAnchor="end" fontSize="10" fill="#a58e78">{Math.round(max * t)}</text>
        </g>
      ))}
      {data.map((d, i) => {
        const x = padL + i * step + (step - bw) / 2;
        let acc = 0;
        return (
          <g key={i}>
            <title>{`${label(d)}: ${series.map((s) => `${s.label} ${Number(d[s.key] ?? 0)}`).join(", ")}`}</title>
            <rect x={padL + i * step} y={padT} width={step} height={H - padT - padB} fill="transparent" />
            {series.map((s) => {
              const v = Number(d[s.key] ?? 0);
              if (!v) return null;
              const top = y(acc + v);
              const h = y(acc) - top;
              acc += v;
              return <rect key={s.key} x={x} y={top} width={bw} height={Math.max(1, h)} rx={Math.min(3, bw / 2)} fill={s.color} />;
            })}
            {i % every === 0 && <text x={x + bw / 2} y={H - 8} textAnchor="middle" fontSize="10" fill="#a58e78">{label(d)}</text>}
          </g>
        );
      })}
      {empty && <text x={W / 2} y={H / 2} textAnchor="middle" fontSize="12" fill="#a58e78">No data in this period yet</text>}
    </svg>
  );
}

/** Tiny trend line with a soft fill, for headline numbers. */
export function Spark({ values, color = "#80664f" }: { values: number[]; color?: string }) {
  const W = 120;
  const H = 36;
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? W / (values.length - 1) : W;
  const pts = values.map((v, i) => [i * step, H - 3 - (v / max) * (H - 8)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const flat = values.every((v) => v === 0);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="ch-spark" role="img" aria-label="Trend">
      {flat ? (
        <line x1="0" x2={W} y1={H - 3} y2={H - 3} stroke="#e7dfd5" strokeWidth="2" strokeLinecap="round" />
      ) : (
        <>
          <path d={`${line} L${W} ${H} L0 ${H} Z`} fill={color} opacity="0.12" />
          <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
    </svg>
  );
}

/** Ring with a total in the middle. */
export function Donut({ segments, centerLabel }: { segments: { label: string; value: number; color: string }[]; centerLabel: string }) {
  const total = segments.reduce((a, s) => a + s.value, 0);
  const R = 52;
  const C = 2 * Math.PI * R;
  let offset = 0;
  return (
    <svg viewBox="0 0 140 140" className="ch-donut" role="img" aria-label={centerLabel}>
      <circle cx="70" cy="70" r={R} fill="none" stroke="#ede5d8" strokeWidth="16" />
      {total > 0 &&
        segments.map((s) => {
          const len = (s.value / total) * C;
          const el = (
            <circle
              key={s.label} cx="70" cy="70" r={R} fill="none" stroke={s.color} strokeWidth="16"
              strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-offset} transform="rotate(-90 70 70)"
            >
              <title>{`${s.label}: ${s.value}`}</title>
            </circle>
          );
          offset += len;
          return el;
        })}
      <text x="70" y="68" textAnchor="middle" fontSize="22" fontWeight="700" fill="#38291f">{total.toLocaleString()}</text>
      <text x="70" y="85" textAnchor="middle" fontSize="10" fill="#a58e78">{centerLabel}</text>
    </svg>
  );
}
