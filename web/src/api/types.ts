export interface Filters {
  from?: string; to?: string;
  user_id?: string; org_id?: string; project?: string; account?: string;
  provider?: string; service?: string; request_model?: string; status?: string;
}
// 注意:计数/ token 字段是 number(服务端已 Number 收窄),安全范围 < 2^53;
// 而金额 total_cost 始终保持 string(numeric 精度无损),两者不可混用。
// 多币种:聚合成本永不跨币种相加 —— 按 currency 分列(CostByCurrency[]);单事件仍单币种。
export interface CostByCurrency { currency: string; total_cost: string; }
export interface CostLine { component: string; modality: string | null; tokens: number; rate_per_mtok: string; cost: string; }
export interface CostBreakdown { currency: string; price_table_version: string; lines: CostLine[]; }
export interface Overview {
  totals: {
    events: number; input_tokens: number; output_tokens: number; total_tokens: number;
    cost_by_currency: CostByCurrency[];
    by_status: { success: number; failure: number };
  };
}
export type Bucket = "hour" | "day" | "week" | "month";
export interface TimeseriesPoint { ts: string; events: number; total_tokens: number; cost_by_currency: CostByCurrency[]; }
export interface Timeseries { bucket: Bucket; series: TimeseriesPoint[]; }
export interface DimRow { key: string | null; events: number; total_tokens: number; cost_by_currency: CostByCurrency[]; }
export interface DimRanking { dimension: string; rows: DimRow[]; }
export interface EventRow {
  event_id: string; created_at: string;
  user_id: string | null; org_id: string | null; project: string | null; account: string | null;
  provider: string; service: string; request_model: string; operation: string; status: string;
  input_tokens: number | null; output_tokens: number | null; total_tokens: number | null;
  total_cost: string | null; currency: string | null;
  cost_breakdown?: CostBreakdown | null;
  request_payload?: unknown; response_payload?: unknown; truncated?: boolean; redacted?: boolean;
  [k: string]: unknown;
}
export interface EventsPage { events: EventRow[]; next_cursor: string | null; }
export type Dimension = "by-user" | "by-org" | "by-project" | "by-account";
