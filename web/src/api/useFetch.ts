import { useEffect, useState } from "react";

export type QueryParams = Record<string, string | number | boolean | undefined | null>;
export interface FetchState<T> { data: T | null; error: string | null; loading: boolean; }

export function toQuery(params: QueryParams): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    u.set(k, String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : "";
}

export function useFetch<T>(path: string, params: QueryParams = {}): FetchState<T> {
  const url = path + toQuery(params);
  const [state, setState] = useState<FetchState<T>>({ data: null, error: null, loading: true });
  useEffect(() => {
    let alive = true;
    setState({ data: null, error: null, loading: true });
    fetch(url)
      .then(async (r) => { if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`); return (await r.json()) as T; })
      .then((data) => { if (alive) setState({ data, error: null, loading: false }); })
      .catch((e: unknown) => { if (alive) setState({ data: null, error: e instanceof Error ? e.message : String(e), loading: false }); });
    return () => { alive = false; };
  }, [url]);
  return state;
}
