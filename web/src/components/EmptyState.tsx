export function EmptyState({ text = "暂无数据" }: { text?: string }) {
  return <div style={{ color: "var(--muted)", textAlign: "center", padding: "28px 0", fontSize: 14 }}>{text}</div>;
}
