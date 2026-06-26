import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TimeseriesChart } from "../src/components/TimeseriesChart.js";
import type { Timeseries } from "../src/api/types.js";

const ts: Timeseries = { bucket: "day", series: [
  { ts: "2026-06-01T00:00:00.000Z", events: 10, total_tokens: 1000, cost_by_currency: [{ currency: "CNY", total_cost: "1.50" }] },
  { ts: "2026-06-02T00:00:00.000Z", events: 20, total_tokens: 3000, cost_by_currency: [{ currency: "CNY", total_cost: "4.00" }] },
  { ts: "2026-06-03T00:00:00.000Z", events: 15, total_tokens: 2000, cost_by_currency: [] },
] };

it("draws a polyline with one vertex per point", () => {
  const { container } = render(<TimeseriesChart data={ts} bucket="day" onBucket={() => {}} />);
  const poly = container.querySelector("polyline.line") as SVGPolylineElement;
  expect(poly).toBeTruthy();
  expect(poly.getAttribute("points")!.trim().split(/\s+/)).toHaveLength(3);
});

it("bucket switch fires callback", async () => {
  const onBucket = vi.fn();
  render(<TimeseriesChart data={ts} bucket="day" onBucket={onBucket} />);
  await userEvent.click(screen.getByRole("button", { name: "week" }));
  expect(onBucket).toHaveBeenCalledWith("week");
});

it("empty series → EmptyState, no svg", () => {
  const { container } = render(<TimeseriesChart data={{ ...ts, series: [] }} bucket="day" onBucket={() => {}} />);
  expect(container.querySelector("polyline.line")).toBeNull();
  expect(screen.getByText(/暂无/)).toBeInTheDocument();
});

it("单点序列也能渲染(不崩)", () => {
  const single: Timeseries = { ...ts, series: [ts.series[0]] };
  const { container } = render(<TimeseriesChart data={single} bucket="day" onBucket={() => {}} />);
  const poly = container.querySelector("polyline.line") as SVGPolylineElement;
  expect(poly).toBeTruthy();
  expect(poly.getAttribute("points")!.trim().split(/\s+/)).toHaveLength(1);
  expect(poly.getAttribute("points")).not.toContain("NaN");
});
