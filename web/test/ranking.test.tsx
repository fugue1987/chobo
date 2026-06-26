import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DimensionRanking } from "../src/components/DimensionRanking.js";
import type { DimRanking } from "../src/api/types.js";

const byUser: DimRanking = { dimension: "user_id", rows: [
  { key: "teacher-0420", events: 12004, total_tokens: 9_200_000, cost_by_currency: [{ currency: "CNY", total_cost: "412.88" }] },
  { key: "teacher-1187", events: 8110, total_tokens: 6_100_000, cost_by_currency: [] },
] };

it("renders rows with cost and 未定价", () => {
  render(<DimensionRanking data={byUser} dimension="by-user" onTab={() => {}} onDrill={() => {}} />);
  expect(screen.getByText("teacher-0420")).toBeInTheDocument();
  expect(screen.getByText("¥412.88")).toBeInTheDocument();
  expect(screen.getByText("未定价")).toBeInTheDocument();
});

it("tab switch fires onTab with the dimension", async () => {
  const onTab = vi.fn();
  render(<DimensionRanking data={byUser} dimension="by-user" onTab={onTab} onDrill={() => {}} />);
  await userEvent.click(screen.getByRole("button", { name: "按机构" }));
  expect(onTab).toHaveBeenCalledWith("by-org");
});

it("by-account tab fires onTab", async () => {
  const onTab = vi.fn();
  render(<DimensionRanking data={byUser} dimension="by-user" onTab={onTab} onDrill={() => {}} />);
  await userEvent.click(screen.getByRole("button", { name: "按账户" }));
  expect(onTab).toHaveBeenCalledWith("by-account");
});

it("row click drills down (dimension + key)", async () => {
  const onDrill = vi.fn();
  render(<DimensionRanking data={byUser} dimension="by-user" onTab={() => {}} onDrill={onDrill} />);
  await userEvent.click(screen.getByText("teacher-0420"));
  expect(onDrill).toHaveBeenCalledWith("by-user", "teacher-0420");
});

it("null-key 行点击不下钻", async () => {
  const onDrill = vi.fn();
  const withNullKey: DimRanking = { dimension: "user_id", rows: [
    { key: null, events: 3, total_tokens: 10000, cost_by_currency: [] },
  ] };
  render(<DimensionRanking data={withNullKey} dimension="by-user" onTab={() => {}} onDrill={onDrill} />);
  await userEvent.click(screen.getByText("(空)"));
  expect(onDrill).not.toHaveBeenCalled();
});
