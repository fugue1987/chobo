import type { Sql } from "postgres";

export interface Filters {
  from?: string; to?: string; user_id?: string; org_id?: string; project?: string;
  provider?: string; service?: string; request_model?: string; status?: string;
  account?: string;
}

const toIso = (v: string | undefined): string | undefined => {
  if (v == null) return undefined;
  return /^\d+$/.test(v) ? new Date(Number(v)).toISOString() : v;
};

export function parseFilters(q: Record<string, string | undefined>): Filters {
  return { from: toIso(q.from), to: toIso(q.to), user_id: q.user_id, org_id: q.org_id, project: q.project, provider: q.provider, service: q.service, request_model: q.request_model, status: q.status, account: q.account };
}

export function whereFragment(sql: Sql, f: Filters) {
  const conds = [sql`true`];
  if (f.from) conds.push(sql`created_at >= ${f.from}`);
  if (f.to) conds.push(sql`created_at < ${f.to}`);
  if (f.user_id) conds.push(sql`user_id = ${f.user_id}`);
  if (f.org_id) conds.push(sql`org_id = ${f.org_id}`);
  if (f.project) conds.push(sql`project = ${f.project}`);
  if (f.provider) conds.push(sql`provider = ${f.provider}`);
  if (f.service) conds.push(sql`service = ${f.service}`);
  if (f.request_model) conds.push(sql`request_model = ${f.request_model}`);
  if (f.status) conds.push(sql`status = ${f.status}`);
  if (f.account) conds.push(sql`account = ${f.account}`);
  return conds.reduce((acc, c) => sql`${acc} AND ${c}`);
}
