import { useState } from "react";
import type { Filters, Overview, Timeseries, DimRanking, Bucket, Dimension } from "../api/types.js";
import { useFetch } from "../api/useFetch.js";
import { KpiCards } from "../components/KpiCards.js";
import { TimeseriesChart } from "../components/TimeseriesChart.js";
import { DimensionRanking } from "../components/DimensionRanking.js";
import { ErrorBanner } from "../components/ErrorBanner.js";
import { EmptyState } from "../components/EmptyState.js";

export function OverviewPage({ filters, onDrill }: { filters: Filters; onDrill: (d: Dimension, key: string) => void }) {
  const [bucket, setBucket] = useState<Bucket>("day");
  const [dim, setDim] = useState<Dimension>("by-user");
  const ov = useFetch<Overview>("/v1/stats/overview", { ...filters });
  const ts = useFetch<Timeseries>("/v1/stats/timeseries", { ...filters, bucket });
  const rk = useFetch<DimRanking>(`/v1/stats/${dim}`, { ...filters });

  return (
    <>
      {ov.error ? <ErrorBanner message={ov.error} /> : ov.loading ? <EmptyState text="加载中…" /> : ov.data ? <KpiCards data={ov.data} /> : <EmptyState text="暂无数据" />}
      {ts.error ? <ErrorBanner message={ts.error} /> : ts.loading ? <EmptyState text="加载中…" /> : ts.data ? <TimeseriesChart data={ts.data} bucket={bucket} onBucket={setBucket} /> : <EmptyState text="暂无数据" />}
      {rk.error ? <ErrorBanner message={rk.error} /> : rk.loading ? <EmptyState text="加载中…" /> : rk.data ? <DimensionRanking data={rk.data} dimension={dim} onTab={setDim} onDrill={onDrill} /> : <EmptyState text="暂无数据" />}
    </>
  );
}
