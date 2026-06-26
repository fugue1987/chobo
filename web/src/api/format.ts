// 钱永远以服务端给的 numeric 字符串呈现 —— 绝不转 JS number(精度坏账),缺价显「未定价」绝不 ¥0。
export function groupThousands(intPart: string): string {
  const neg = intPart.startsWith("-");
  const digits = neg ? intPart.slice(1) : intPart;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return neg ? "-" + grouped : grouped;
}

export function isUnpriced(cost: string | null): boolean {
  return cost == null;
}

const SYMBOL: Record<string, string> = { CNY: "¥", USD: "$" };
// 已知币种给符号,未知币种回退为 "<code> " 前缀(诚实标注,不冒充 ¥/$)。
export function currencySymbol(c: string): string { return SYMBOL[c] ?? (c + " "); }

export function formatCost(cost: string | null, currency = "CNY"): string {
  if (cost == null) return "未定价";
  const sym = currencySymbol(currency);
  const dot = cost.indexOf(".");
  return dot === -1 ? sym + groupThousands(cost) : sym + groupThousands(cost.slice(0, dot)) + cost.slice(dot);
}

// 多币种成本分列展示 —— 永不跨币种相加,各币种各自一段,用 " · " 连接。空 → 未定价。
export function formatCostList(list: { currency: string; total_cost: string }[]): string {
  if (!list || list.length === 0) return "未定价";
  return list.map((c) => formatCost(c.total_cost, c.currency)).join(" · ");
}

export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

// 大数紧凑展示(用于 token/计数,非金额)。输入契约:非负有限整数。
// 单位在四舍五入之后选取,避免 999_999 显示成 "1000.0K"(应进位为 "1.0M")。
export function formatCompact(n: number): string {
  if (n < 1000) return String(n);
  for (const [suf, div] of [["B", 1e9], ["M", 1e6], ["K", 1e3]] as const) {
    const rounded = Math.round(n / div * 10) / 10;
    if (rounded >= 1 && rounded < 1000) return rounded.toFixed(1) + suf;
    // rounded < 1 → 不够大,尝试下一级;rounded >= 1000 → 进位到上一级(已在前面迭代处理)
  }
  return formatCount(n);   // 万亿级以上 → 退回千分位整串
}
