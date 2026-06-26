import type { DimRanking, Dimension } from "../api/types.js";
import { formatCostList, formatCount, formatCompact } from "../api/format.js";

const TABS: Array<{ dim: Dimension; label: string }> = [
  { dim: "by-user", label: "按用户" }, { dim: "by-org", label: "按机构" }, { dim: "by-project", label: "按任务" }, { dim: "by-account", label: "按账户" },
];

export function DimensionRanking({ data, dimension, onTab, onDrill }: {
  data: DimRanking; dimension: Dimension;
  onTab: (d: Dimension) => void; onDrill: (d: Dimension, key: string) => void;
}) {
  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ display: "flex", gap: 14, padding: "10px 14px", borderBottom: "1px solid var(--border)", fontSize: 13 }}>
        {TABS.map((t) => (
          <button key={t.dim} className="tab-btn" onClick={() => onTab(t.dim)}
            style={{ background: "none", border: "none", cursor: "pointer",
                     color: t.dim === dimension ? "var(--text)" : "var(--muted)", fontWeight: t.dim === dimension ? 600 : 400 }}>
            {t.label}
          </button>
        ))}
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ color: "var(--muted)", textAlign: "right" }}>
            <th style={{ textAlign: "left", padding: "8px 14px" }}>键</th>
            <th style={{ padding: "8px 14px" }}>调用</th><th style={{ padding: "8px 14px" }}>tokens</th><th style={{ padding: "8px 14px" }}>开销</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r, i) => (
            <tr key={r.key ?? i} onClick={() => r.key != null && onDrill(dimension, r.key)}
                style={{ cursor: r.key != null ? "pointer" : "default", borderTop: "1px solid var(--border)" }}>
              <td style={{ padding: "8px 14px" }}>{r.key ?? <span className="unpriced">(空)</span>}</td>
              <td style={{ padding: "8px 14px", textAlign: "right" }}>{formatCount(r.events)}</td>
              <td style={{ padding: "8px 14px", textAlign: "right" }}>{formatCompact(r.total_tokens)}</td>
              <td style={{ padding: "8px 14px", textAlign: "right" }} className={r.cost_by_currency.length === 0 ? "unpriced" : ""}>{formatCostList(r.cost_by_currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
