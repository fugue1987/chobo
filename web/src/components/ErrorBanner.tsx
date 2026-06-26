export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" style={{ background: "var(--danger-soft)", border: "1px solid var(--danger)", color: "var(--danger)", borderRadius: "var(--radius)", padding: "10px 14px", fontSize: 14 }}>
      加载失败:{message}
      {onRetry && (
        <button
          onClick={onRetry}
          style={{ marginLeft: 12, cursor: "pointer", background: "var(--danger)", color: "#fff", border: "none", borderRadius: 6, padding: "2px 10px", fontSize: 13 }}
        >
          重试
        </button>
      )}
    </div>
  );
}
