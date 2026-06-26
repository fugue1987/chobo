import { Fragment, useEffect, useRef, useState } from "react";
import type { Filters, EventsPage, EventRow } from "../api/types.js";
import { toQuery } from "../api/useFetch.js";
import { formatCost, formatCompact, isUnpriced, currencySymbol } from "../api/format.js";
import { ErrorBanner } from "./ErrorBanner.js";
import { EmptyState } from "./EmptyState.js";

const COLS = 8;
const fmtTime = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
};

export function EventsTable({ filters }: { filters: Filters }) {
  const filterKey = JSON.stringify(filters);
  const [includePayload, setIncludePayload] = useState(false);
  const [rows, setRows] = useState<EventRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<Set<string>>(new Set());

  // 查询身份 = 筛选 + 是否带 payload。任一变化即「新查询」,在渲染期同步重置累积。
  // 这样 fetch effect 永远不会带着「旧查询的不透明 keyset cursor」去打新查询
  // (否则会发一个 (新筛选+旧cursor) 的语义错误废请求)。
  // 见 React 文档「Adjusting some state when a prop changes」。
  const queryKey = `${filterKey}|${includePayload}`;
  const lastQueryKey = useRef(queryKey);
  if (lastQueryKey.current !== queryKey) {
    lastQueryKey.current = queryKey;
    setRows([]); setCursor(null); setNext(null); setOpen(new Set());
  }

  useEffect(() => {
    let alive = true; setLoading(true); setError(null);
    const url = "/v1/events" + toQuery({ ...filters, limit: 50, cursor: cursor ?? undefined, include_payload: includePayload || undefined });
    fetch(url)
      .then(async (r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return (await r.json()) as EventsPage; })
      .then((p) => { if (!alive) return; setRows((prev) => (cursor ? [...prev, ...p.events] : p.events)); setNext(p.next_cursor); setLoading(false); })
      .catch((e: unknown) => { if (alive) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); } });
    return () => { alive = false; };
    // queryKey 变化时上面渲染期已把 cursor 归零;cursor 变化 = 翻页(append)。
    // filters/includePayload 经 queryKey 间接进入依赖,故此处禁用 exhaustive-deps。
  }, [queryKey, cursor]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <ErrorBanner message={error} onRetry={() => { setCursor(null); setRows([]); }} />;
  if (!loading && rows.length === 0) return <EmptyState text="暂无事件" />;

  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ display: "flex", justifyContent: "flex-end", padding: "8px 12px", borderBottom: "1px solid var(--border)" }}>
        <label style={{ fontSize: 13, color: "var(--muted)", cursor: "pointer", display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={includePayload} onChange={(e) => setIncludePayload(e.target.checked)} />
          显示明细(payload)
        </label>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ color: "var(--muted)", textAlign: "left" }}>
            <th style={{ padding: "8px 12px" }}></th><th style={{ padding: "8px 12px" }}>时间</th><th style={{ padding: "8px 12px" }}>用户</th>
            <th style={{ padding: "8px 12px" }}>provider</th><th style={{ padding: "8px 12px" }}>模型</th><th style={{ padding: "8px 12px" }}>状态</th>
            <th style={{ padding: "8px 12px", textAlign: "right" }}>tokens</th><th style={{ padding: "8px 12px", textAlign: "right" }}>开销</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <Fragment key={e.event_id}>
              <tr style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: "8px 12px" }}>
                  <button aria-label="展开" onClick={() => toggle(e.event_id)} style={{ border: "none", background: "none", cursor: "pointer" }}>{open.has(e.event_id) ? "▾" : "▸"}</button>
                </td>
                <td style={{ padding: "8px 12px" }}>{fmtTime(e.created_at)}</td>
                <td style={{ padding: "8px 12px" }}>{e.user_id ?? "—"}</td>
                <td style={{ padding: "8px 12px" }}>{e.provider}</td>
                <td style={{ padding: "8px 12px" }}>{e.request_model}</td>
                <td style={{ padding: "8px 12px", color: e.status === "failure" ? "var(--danger)" : undefined }}>{e.status}</td>
                <td style={{ padding: "8px 12px", textAlign: "right" }}>{e.total_tokens == null ? "—" : formatCompact(e.total_tokens)}</td>
                <CostCell row={e} />
              </tr>
              {open.has(e.event_id) && (
                <tr><td colSpan={COLS} style={{ padding: "8px 12px", background: "var(--bg)" }}>
                  {includePayload ? (
                    <pre style={{ margin: 0, fontSize: 12, whiteSpace: "pre-wrap" }}>
                      {JSON.stringify({ request: e.request_payload, response: e.response_payload, truncated: e.truncated, redacted: e.redacted }, null, 2)}
                    </pre>
                  ) : (
                    <span style={{ fontSize: 12, color: "var(--muted)" }}>勾选右上角「显示明细」后可查看 payload</span>
                  )}
                </td></tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
      <div style={{ padding: 12, textAlign: "center" }}>
        {next ? <button onClick={() => setCursor(next)}>加载更多</button> : <span style={{ color: "var(--muted)", fontSize: 13 }}>没有更多了</span>}
      </div>
    </div>
  );
}

const COMPONENT_LABEL: Record<string, string> = { input: "输入", output: "输出", cache: "缓存" };
const MODALITY_LABEL: Record<string, string> = { text: "文本", image: "图像" };
const POPOVER_WIDTH = 260;

// 单事件单币种:总价用 e.currency 选符号;有逐项 cost_breakdown 时 hover/点击展开成本明细弹层。
// 未定价(无 breakdown)只显标签,不弹层。手写 CSS、设计令牌、无新依赖。
function CostCell({ row }: { row: EventRow }) {
  // hover = 鼠标悬停时短暂显示;pinned = 点击后常驻(鼠标移开仍在),再次点击取消。
  // 二者独立,避免「悬停已置真 + 点击取反」相互抵消的交互坏账。
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  // 弹层用 position:fixed(相对视口定位),不会被祖先 .card 的 overflow:hidden 裁剪。
  // 触发单元格无 transform/filter/will-change,故 .card 不为 fixed 后代建立包含块。
  // 打开时(hover 或点击 pin)从触发格 getBoundingClientRect() 取屏幕坐标存入 state。
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const cellRef = useRef<HTMLTableCellElement>(null);
  const bd = row.cost_breakdown;
  const cur = row.currency ?? "CNY";
  const label = <span className={isUnpriced(row.total_cost) ? "unpriced" : ""}>{formatCost(row.total_cost, cur)}</span>;
  if (!bd || !bd.lines?.length) return <td style={{ padding: "8px 12px", textAlign: "right" }}>{label}</td>;
  const visible = hover || pinned;

  // 从触发格的视口矩形算出 fixed 坐标:落在格子下方偏右,并夹住左边界保证不出屏。
  const capture = () => {
    const r = cellRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 4, left: Math.max(8, r.right - POPOVER_WIDTH) });
  };
  const open = () => { capture(); setHover(true); };
  const togglePin = () => { capture(); setPinned((v) => !v); };

  return (
    <td ref={cellRef} style={{ padding: "8px 12px", textAlign: "right", cursor: "pointer" }}
        tabIndex={0}
        onMouseEnter={open} onMouseLeave={() => setHover(false)} onClick={togglePin}
        onKeyDown={(ev) => {
          if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); togglePin(); }
          else if (ev.key === "Escape") { setPinned(false); setHover(false); }
        }}
        title="点击固定成本明细">
      <span style={{ textDecoration: "underline dotted" }}>{label}</span>
      {visible && pos && (
        <div role="region" aria-label="成本明细"
          style={{ position: "fixed", top: pos.top, left: pos.left, width: POPOVER_WIDTH, zIndex: 10,
          background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px",
          fontSize: 12, boxShadow: "0 6px 24px rgba(0,0,0,.12)", textAlign: "left", whiteSpace: "nowrap" }}>
          <div style={{ color: "var(--muted)", marginBottom: 6 }}>成本明细 · {bd.currency} · {bd.price_table_version}</div>
          {bd.lines.map((l) => (
            <div key={l.component + "-" + (l.modality ?? "x")} style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
              <span>
                {COMPONENT_LABEL[l.component] ?? l.component}
                {l.modality ? ` · ${MODALITY_LABEL[l.modality] ?? l.modality}` : ""}
                {" · "}{l.tokens.toLocaleString()} tok × {currencySymbol(bd.currency)}{l.rate_per_mtok}/1M
              </span>
              <span style={{ color: "var(--muted)" }}>{formatCost(l.cost, bd.currency)}</span>
            </div>
          ))}
        </div>
      )}
    </td>
  );
}
