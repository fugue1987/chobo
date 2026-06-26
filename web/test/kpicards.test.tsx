import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { KpiCards } from "../src/components/KpiCards.js";
import type { Overview } from "../src/api/types.js";

const ov: Overview = { totals: {
  events: 48210, input_tokens: 22_100_000, output_tokens: 9_500_000, total_tokens: 31_600_000,
  cost_by_currency: [{ currency: "CNY", total_cost: "1284.07" }], by_status: { success: 47900, failure: 310 },
} };

it("renders cost / calls / tokens / failures", () => {
  render(<KpiCards data={ov} />);
  expect(screen.getByText("¥1,284.07")).toBeInTheDocument();
  expect(screen.getByText("48,210")).toBeInTheDocument();
  expect(screen.getByText("31.6M")).toBeInTheDocument();
  expect(screen.getByText("310")).toBeInTheDocument();
});

it("renders multi-currency split (¥ · $), never summed", () => {
  render(<KpiCards data={{ ...ov, totals: { ...ov.totals, cost_by_currency: [{ currency: "CNY", total_cost: "12.30" }, { currency: "USD", total_cost: "0.01" }] } }} />);
  expect(screen.getByText("¥12.30 · $0.01")).toBeInTheDocument();
});

it("renders 未定价 when cost_by_currency is empty (never ¥0)", () => {
  render(<KpiCards data={{ ...ov, totals: { ...ov.totals, cost_by_currency: [] } }} />);
  expect(screen.getByText("未定价")).toBeInTheDocument();
  expect(screen.queryByText("¥0")).not.toBeInTheDocument();
});

it("failure=0 不显示危险色", () => {
  render(<KpiCards data={{ ...ov, totals: { ...ov.totals, by_status: { success: 48210, failure: 0 } } }} />);
  const el = screen.getByText("0").closest("div");
  expect(el?.getAttribute("style") ?? "").not.toContain("var(--danger)");
});
