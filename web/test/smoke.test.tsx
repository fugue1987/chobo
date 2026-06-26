import { it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../src/App.js";

afterEach(() => vi.restoreAllMocks());

function mockApi() {
  const fn = vi.fn(async (url: string) => {
    if (url.includes("/v1/stats/overview")) return { ok: true, json: async () => ({ totals: { events: 5, input_tokens: 0, output_tokens: 0, total_tokens: 1000, cost_by_currency: [{ currency: "CNY", total_cost: "3.50" }], by_status: { success: 5, failure: 0 } } }) };
    if (url.includes("/v1/stats/timeseries")) return { ok: true, json: async () => ({ bucket: "day", series: [] }) };
    if (url.includes("/v1/stats/by-account")) return { ok: true, json: async () => ({ dimension: "account", rows: [{ key: "five-elements", events: 7, total_tokens: 2000, cost_by_currency: [{ currency: "CNY", total_cost: "2.00" }] }] }) };
    if (url.includes("/v1/stats/by-")) return { ok: true, json: async () => ({ dimension: "user_id", rows: [{ key: "alice", events: 3, total_tokens: 1000, cost_by_currency: [{ currency: "CNY", total_cost: "1.00" }] }] }) };
    if (url.includes("/v1/events")) return { ok: true, json: async () => ({ events: [], next_cursor: null }) };
    return { ok: true, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

it("App renders brand and wires the overview KPI from the API", async () => {
  mockApi();
  render(<App />);
  expect(screen.getByText("帳簿 chobo")).toBeInTheDocument();
  await waitFor(() => expect(screen.getByText("¥3.50")).toBeInTheDocument());
});

it("nav switches to the audit page", async () => {
  mockApi();
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: "审计明细" }));
  await waitFor(() => expect(screen.getByText(/暂无事件/)).toBeInTheDocument());
});

it("drilling a ranking row writes the correct filter (by-user→user_id)", async () => {
  mockApi();
  render(<App />);
  await waitFor(() => expect(screen.getByText("alice")).toBeInTheDocument());
  await userEvent.click(screen.getByText("alice"));
  expect(screen.getByLabelText("user_id")).toHaveValue("alice");
});

it("switching dimension tab fetches the by-org endpoint", async () => {
  const fetchSpy = mockApi();
  render(<App />);
  await waitFor(() => expect(screen.getByText("alice")).toBeInTheDocument());
  await userEvent.click(screen.getByRole("button", { name: "按机构" }));
  await waitFor(() => expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes("/v1/stats/by-org"))).toBe(true));
});

it("drilling a by-account row writes the account filter", async () => {
  mockApi();
  render(<App />);
  await waitFor(() => expect(screen.getByText("alice")).toBeInTheDocument());
  await userEvent.click(screen.getByRole("button", { name: "按账户" }));
  await waitFor(() => expect(screen.getByText("five-elements")).toBeInTheDocument());
  await userEvent.click(screen.getByText("five-elements"));
  expect(screen.getByLabelText("account")).toHaveValue("five-elements");
});
