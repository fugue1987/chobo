import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EventsTable } from "../src/components/EventsTable.js";

afterEach(() => vi.restoreAllMocks());

const breakdown = { currency: "CNY", price_table_version: "2026-06-25a", lines: [
  { component: "input", modality: null, tokens: 100, rate_per_mtok: "3.2", cost: "0.00032000" },
  { component: "output", modality: null, tokens: 50, rate_per_mtok: "16", cost: "0.00080000" },
] };
const page1 = { events: [
  { event_id: "e1", created_at: "2026-06-03T10:00:00.000Z", user_id: "teacher-0420", org_id: null, project: "chat", provider: "doubao", service: "node-ai-proxy", request_model: "doubao-seed-2.0-pro", operation: "chat", status: "success", input_tokens: 100, output_tokens: 50, total_tokens: 150, total_cost: "0.04800000", currency: "CNY", cost_breakdown: breakdown },
  { event_id: "e2", created_at: "2026-06-03T09:00:00.000Z", user_id: "teacher-1187", org_id: null, project: "img", provider: "example-gateway", service: "node-ai-proxy", request_model: "gpt-image-2", operation: "image", status: "success", input_tokens: null, output_tokens: null, total_tokens: null, total_cost: null, currency: "CNY" },
], next_cursor: "CURSOR2" };

const page2 = { events: [
  { event_id: "e3", created_at: "2026-06-03T08:00:00.000Z", user_id: "teacher-3302", org_id: null, project: "chat", provider: "doubao", service: "node-ai-proxy", request_model: "gpt-5.5", operation: "chat", status: "failure", input_tokens: 80, output_tokens: 0, total_tokens: 80, total_cost: "0.01000000", currency: "CNY" },
], next_cursor: null };

it("appends page 2 via next_cursor, then shows 没有更多了", async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => page1 })
    .mockResolvedValueOnce({ ok: true, json: async () => page2 });
  vi.stubGlobal("fetch", fetchMock);
  render(<EventsTable filters={{}} />);
  await waitFor(() => expect(screen.getByText("teacher-0420")).toBeInTheDocument());
  expect(screen.getByText("¥0.04800000")).toBeInTheDocument();
  expect(screen.getByText("未定价")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /加载更多/ }));
  await waitFor(() => expect(screen.getByText("teacher-3302")).toBeInTheDocument()); // page-2 appended
  expect(screen.getByText("teacher-0420")).toBeInTheDocument();                       // page-1 still present
  expect(String(fetchMock.mock.calls.at(-1)![0])).toContain("cursor=CURSOR2");
  expect(screen.getByText(/没有更多了/)).toBeInTheDocument();
});

it("toggling 显示明细 sends include_payload=true and expand shows payload", async () => {
  const withPayload = { events: [{ ...page1.events[0], request_payload: { q: "hi" }, response_payload: { a: "yo" }, truncated: false, redacted: false }], next_cursor: null };
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => page1 })
    .mockResolvedValueOnce({ ok: true, json: async () => withPayload });
  vi.stubGlobal("fetch", fetchMock);
  render(<EventsTable filters={{}} />);
  await waitFor(() => expect(screen.getByText("teacher-0420")).toBeInTheDocument());
  await userEvent.click(screen.getByLabelText(/显示明细/));
  await waitFor(() => expect(String(fetchMock.mock.calls.at(-1)![0])).toContain("include_payload=true"));
  await userEvent.click(screen.getAllByRole("button", { name: "展开" })[0]);
  expect(screen.getByText(/"q": "hi"/)).toBeInTheDocument();
});

it("cost cell reveals breakdown popover on click (priced row) and stays hidden for unpriced row", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => page1 });
  vi.stubGlobal("fetch", fetchMock);
  render(<EventsTable filters={{}} />);
  await waitFor(() => expect(screen.getByText("¥0.04800000")).toBeInTheDocument());
  // 未定价行(e2)无 cost_breakdown → 不出弹层
  expect(screen.queryByRole("region", { name: "成本明细" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByText("¥0.04800000"));
  const tip = await screen.findByRole("region", { name: "成本明细" });
  expect(tip).toHaveTextContent("成本明细");
  expect(tip).toHaveTextContent("2026-06-25a");
  expect(tip).toHaveTextContent(/输入/);
  expect(tip).toHaveTextContent(/输出/);
  expect(tip).toHaveTextContent("¥0.00032000");
});

it("error → ErrorBanner", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
  render(<EventsTable filters={{}} />);
  await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
});
