import { useEffect, useState } from "react";
import type { Filters } from "../api/types.js";

const FIELDS: Array<{ key: keyof Filters; ph: string }> = [
  { key: "user_id", ph: "user_id" }, { key: "org_id", ph: "org_id" }, { key: "project", ph: "project" }, { key: "account", ph: "account" },
  { key: "provider", ph: "provider" }, { key: "service", ph: "service" },
  { key: "request_model", ph: "model" }, { key: "status", ph: "status" },
];

export function FilterBar({ filters, onChange }: { filters: Filters; onChange: (f: Filters) => void }) {
  const set = (key: keyof Filters, v: string) => onChange({ ...filters, [key]: v || undefined });
  // 日期框做成受控:存原始 datetime-local 字符串,外部把 from/to 清掉时同步清空显示值
  const [rawFrom, setRawFrom] = useState("");
  const [rawTo, setRawTo] = useState("");
  useEffect(() => { if (!filters.from) setRawFrom(""); }, [filters.from]);
  useEffect(() => { if (!filters.to) setRawTo(""); }, [filters.to]);
  return (
    <div className="card" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      <input type="datetime-local" aria-label="from" value={rawFrom}
        onChange={(e) => { setRawFrom(e.target.value); set("from", e.target.value ? String(Date.parse(e.target.value)) : ""); }} />
      <span style={{ color: "var(--muted)" }}>→</span>
      <input type="datetime-local" aria-label="to" value={rawTo}
        onChange={(e) => { setRawTo(e.target.value); set("to", e.target.value ? String(Date.parse(e.target.value)) : ""); }} />
      {FIELDS.map((f) => (
        <input key={f.key} placeholder={f.ph} aria-label={f.ph} value={filters[f.key] ?? ""}
          onChange={(e) => set(f.key, e.target.value)}
          style={{ padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 8 }} />
      ))}
      <button onClick={() => onChange({})}
        style={{ padding: "6px 12px", cursor: "pointer", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--muted)" }}>清空</button>
    </div>
  );
}
