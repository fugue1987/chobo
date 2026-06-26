import type { Overview } from "../api/types.js";
import { formatCostList, formatCount, formatCompact } from "../api/format.js";

function Card({ label, value, unpriced, danger }: { label: string; value: string; unpriced?: boolean; danger?: boolean }) {
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div className={unpriced ? "unpriced" : ""} style={{ fontSize: 26, fontWeight: 700, marginTop: 8, color: danger ? "var(--danger)" : undefined }}>{value}</div>
    </div>
  );
}

export function KpiCards({ data }: { data: Overview }) {
  const t = data.totals;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(140px, 1fr))", gap: 12 }}>
      <Card label="总开销" value={formatCostList(t.cost_by_currency)} unpriced={t.cost_by_currency.length === 0} />
      <Card label="调用数" value={formatCount(t.events)} />
      <Card label="Tokens" value={formatCompact(t.total_tokens)} />
      <Card label="失败" value={formatCount(t.by_status.failure)} danger={t.by_status.failure > 0} />
    </div>
  );
}
