import { AsyncLocalStorage } from "node:async_hooks";

export interface Identity {
  user_id: string | null;
  org_id: string | null;
  project: string | null;
  identity_source: "header" | "jwt" | "missing" | "default";
}

const als = new AsyncLocalStorage<Identity>();

const MISSING: Identity = {
  user_id: null, org_id: null, project: null, identity_source: "missing",
};

/** Establish identity for the duration of fn (use at the request boundary, e.g. middleware). */
export function runWithIdentity<T>(identity: Partial<Identity>, fn: () => T): T {
  const store: Identity = {
    user_id: identity.user_id ?? null,
    org_id: identity.org_id ?? null,
    project: identity.project ?? null,
    identity_source: identity.identity_source ?? "header",
  };
  return als.run(store, fn);
}

/** Read the current identity (a copy). Returns the "missing" identity outside any context. */
export function getIdentity(): Identity {
  const store = als.getStore();
  return store ? { ...store } : { ...MISSING };
}

/** Merge fields into the active identity (no-op outside a context). */
export function updateIdentity(partial: Partial<Identity>): void {
  const store = als.getStore();
  if (store) Object.assign(store, partial);
}
