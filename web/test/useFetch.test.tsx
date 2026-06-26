import { renderHook, waitFor } from "@testing-library/react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { useFetch, toQuery } from "../src/api/useFetch.js";

afterEach(() => { vi.restoreAllMocks(); });

describe("toQuery", () => {
  it("跳过 undefined/null/空串,拼非空查询串", () => {
    expect(toQuery({ a: "1", b: undefined, c: "", d: 2 })).toBe("?a=1&d=2");
    expect(toQuery({})).toBe("");
  });
});

describe("useFetch", () => {
  it("success → data,loading 落定", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ hello: 1 }) })));
    const { result } = renderHook(() => useFetch<{ hello: number }>("/v1/x"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual({ hello: 1 });
    expect(result.current.error).toBeNull();
  });
  it("非 2xx → error 态(绝不当空成功)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    const { result } = renderHook(() => useFetch("/v1/x"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toContain("500");
    expect(result.current.data).toBeNull();
  });
  it("网络错 → error 态", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const { result } = renderHook(() => useFetch("/v1/x"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toContain("network down");
  });
  it("初始为 loading:true,data 为 null", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));  // 永不 resolve
    const { result } = renderHook(() => useFetch("/v1/x"));
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();
  });
  it("path/params 变化时重新取数", async () => {
    const fetchMock = vi.fn<(url: string) => Promise<{ ok: boolean; json: () => Promise<{ n: number }> }>>(
      async () => ({ ok: true, json: async () => ({ n: 1 }) })
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result, rerender } = renderHook(({ p }) => useFetch("/v1/x", { p }), { initialProps: { p: "a" } });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    rerender({ p: "b" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[1][0])).toContain("p=b");
  });
});
