import { useState } from "react";
import type { Timeseries, TimeseriesPoint, Bucket } from "../api/types.js";
import { EmptyState } from "./EmptyState.js";

const BUCKETS: Bucket[] = ["hour", "day", "week", "month"];
const W = 640, H = 160, PAD = 8;

// 注意:此处把 total_cost 字符串 Number() 仅用于「像素定位」(几何),
// 不是金额展示/合计 —— 展示仍走服务端字符串(formatCost)。无该币种该点记为 0 高度。
// 关键不变量:一次只画一种币种,绝不把多币种叠加成一条线。
function costOf(p: TimeseriesPoint, cur: string): number {
  const hit = p.cost_by_currency.find((c) => c.currency === cur);
  const n = hit ? Number(hit.total_cost) : 0;   // 仅像素几何,非金额展示
  return Number.isFinite(n) ? n : 0;
}

// series 内出现过的币种集合(按首次出现顺序),以及合计成本最大的那个(作默认选中)。
function currenciesIn(pts: TimeseriesPoint[]): { list: string[]; top: string } {
  const order: string[] = [];
  const sum = new Map<string, number>();
  for (const p of pts) {
    for (const c of p.cost_by_currency) {
      if (!sum.has(c.currency)) order.push(c.currency);
      const n = Number(c.total_cost);
      sum.set(c.currency, (sum.get(c.currency) ?? 0) + (Number.isFinite(n) ? n : 0));
    }
  }
  let top = "CNY";
  let best = -Infinity;
  for (const c of order) {
    const v = sum.get(c) ?? 0;
    if (v > best) { best = v; top = c; }
  }
  return { list: order, top: order.length ? top : "CNY" };
}

export function TimeseriesChart({ data, bucket, onBucket }: { data: Timeseries; bucket: Bucket; onBucket: (b: Bucket) => void }) {
  const pts = data.series;
  const { list: currencies, top } = currenciesIn(pts);
  const [currency, setCurrency] = useState<string>(top);
  // 数据切换后若先前选中的币种不再出现,退回当前合计最大的币种。
  const active = currencies.includes(currency) ? currency : top;

  const max = Math.max(1, ...pts.map((p) => costOf(p, active)));
  // stepX is 0 when length <= 1 (single-point or empty), preventing division-by-zero
  const stepX = pts.length > 1 ? (W - PAD * 2) / (pts.length - 1) : 0;
  const points = pts.map((p, i) => {
    const x = PAD + i * stepX;
    const y = H - PAD - (costOf(p, active) / max) * (H - PAD * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <span className="label">开销趋势 · {active} · 按{bucket}</span>
        <span style={{ display: "flex", gap: 12, alignItems: "center" }}>
          {currencies.length > 1 && (
            <span style={{ display: "flex", gap: 6 }}>
              {currencies.map((c) => (
                <button key={c} onClick={() => setCurrency(c)}
                  style={{ fontSize: 12, padding: "3px 8px", borderRadius: 6, cursor: "pointer",
                           border: "1px solid var(--border)", background: c === active ? "var(--accent-soft)" : "var(--surface)",
                           color: c === active ? "var(--accent)" : "var(--muted)" }}>{c}</button>
              ))}
            </span>
          )}
          <span style={{ display: "flex", gap: 6 }}>
            {BUCKETS.map((b) => (
              <button key={b} onClick={() => onBucket(b)}
                style={{ fontSize: 12, padding: "3px 8px", borderRadius: 6, cursor: "pointer",
                         border: "1px solid var(--border)", background: b === bucket ? "var(--accent-soft)" : "var(--surface)",
                         color: b === bucket ? "var(--accent)" : "var(--muted)" }}>{b}</button>
            ))}
          </span>
        </span>
      </div>
      {pts.length === 0 ? <EmptyState text="暂无趋势数据" /> : (
        <svg role="img" aria-label={`开销趋势 ${active},按${bucket}`} viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto" }}>
          <polyline className="area" fill="var(--accent)" fillOpacity="0.08" stroke="none"
            points={`${points} ${(PAD + (pts.length - 1) * stepX).toFixed(1)},${H - PAD} ${PAD},${H - PAD}`} />
          <polyline className="line" fill="none" stroke="var(--accent)" strokeWidth="2" points={points} />
        </svg>
      )}
    </div>
  );
}
