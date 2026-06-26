import { useState } from "react";
import "./styles/tokens.css";
import "./styles/app.css";
import { FilterBar } from "./components/FilterBar.js";
import { OverviewPage } from "./pages/OverviewPage.js";
import { AuditPage } from "./pages/AuditPage.js";
import type { Filters, Dimension } from "./api/types.js";

type Page = "overview" | "audit";

const DRILL_COL: Record<Dimension, keyof Filters> = {
  "by-user": "user_id",
  "by-org": "org_id",
  "by-project": "project",
  "by-account": "account",
};

export default function App() {
  const [page, setPage] = useState<Page>("overview");
  const [filters, setFilters] = useState<Filters>({});
  const drill = (d: Dimension, key: string) => {
    const col = DRILL_COL[d];
    setFilters((f) => ({ ...f, [col]: key }));
  };
  return (
    <>
      <header className="topbar">
        <span className="brand">帳簿 chobo</span>
        <nav className="nav">
          <button className={page === "overview" ? "active" : ""} onClick={() => setPage("overview")}>概览</button>
          <button className={page === "audit" ? "active" : ""} onClick={() => setPage("audit")}>审计明细</button>
        </nav>
      </header>
      <main className="page">
        <FilterBar filters={filters} onChange={setFilters} />
        {page === "overview" ? <OverviewPage filters={filters} onDrill={drill} /> : <AuditPage filters={filters} />}
      </main>
    </>
  );
}
