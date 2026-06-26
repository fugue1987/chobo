import type { Filters } from "../api/types.js";
import { EventsTable } from "../components/EventsTable.js";

export function AuditPage({ filters }: { filters: Filters }) {
  return <EventsTable filters={filters} />;
}
