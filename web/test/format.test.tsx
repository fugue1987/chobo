import { formatCost, formatCostList, currencySymbol, formatCount, formatCompact, isUnpriced } from "../src/api/format.js";

describe("formatCost — 计费铁律", () => {
  it("null → 未定价(绝不 ¥0)", () => {
    expect(formatCost(null)).toBe("未定价");
    expect(formatCost(null, "USD")).toBe("未定价");
    expect(isUnpriced(null)).toBe(true);
  });
  it("保留完整精度字符串,不经 JS number", () => {
    expect(formatCost("0.04800000")).toBe("¥0.04800000");
  });
  it("千分位分组(字符串级)", () => {
    expect(formatCost("1284.07")).toBe("¥1,284.07");
    expect(formatCost("31600000")).toBe("¥31,600,000");
  });
  it("整数无小数部分", () => {
    expect(formatCost("500")).toBe("¥500");
  });
  it("按币种选符号(默认 CNY=¥,USD=$)", () => {
    expect(formatCost("12.34", "USD")).toBe("$12.34");
    expect(formatCost("12.34", "CNY")).toBe("¥12.34");
    expect(formatCost("1284.07", "USD")).toBe("$1,284.07");
  });
  it("未知币种回退为 '<code> ' 前缀", () => {
    expect(currencySymbol("EUR")).toBe("EUR ");
    expect(formatCost("5.00", "EUR")).toBe("EUR 5.00");
  });
});

describe("formatCostList — 多币种分列(永不跨币种相加)", () => {
  it("多币种用 ' · ' 连接,各自带符号", () => {
    expect(formatCostList([{ currency: "CNY", total_cost: "12.30" }, { currency: "USD", total_cost: "0.01" }]))
      .toBe("¥12.30 · $0.01");
  });
  it("单币种只显一项", () => {
    expect(formatCostList([{ currency: "CNY", total_cost: "412.88" }])).toBe("¥412.88");
  });
  it("空列表 → 未定价", () => {
    expect(formatCostList([])).toBe("未定价");
  });
});

describe("formatCount / formatCompact", () => {
  it("count 千分位", () => { expect(formatCount(48210)).toBe("48,210"); });
  it("compact 大数", () => {
    expect(formatCompact(31_600_000)).toBe("31.6M");
    expect(formatCompact(9_200)).toBe("9.2K");
    expect(formatCompact(310)).toBe("310");
  });
  it("compact 进位边界(999999→1.0M,不显示 1000.0K)", () => {
    expect(formatCompact(999_999)).toBe("1.0M");
    expect(formatCompact(0)).toBe("0");
    expect(formatCompact(1_500_000_000)).toBe("1.5B");
  });
});
