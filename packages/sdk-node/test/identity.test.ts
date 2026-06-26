import { describe, it, expect } from "vitest";
import { runWithIdentity, getIdentity, updateIdentity } from "../src/identity.js";

describe("identity", () => {
  it("returns missing outside any context", () => {
    expect(getIdentity()).toEqual({
      user_id: null, org_id: null, project: null, identity_source: "missing",
    });
  });

  it("exposes identity inside runWithIdentity", () => {
    const seen = runWithIdentity({ user_id: "t-1", org_id: "s-9", project: "ggb" }, () =>
      getIdentity(),
    );
    expect(seen).toEqual({
      user_id: "t-1", org_id: "s-9", project: "ggb", identity_source: "header",
    });
  });

  it("propagates across awaits", async () => {
    const seen = await runWithIdentity({ user_id: "t-2" }, async () => {
      await Promise.resolve();
      return getIdentity();
    });
    expect(seen.user_id).toBe("t-2");
  });

  it("updateIdentity merges into the active context", () => {
    const seen = runWithIdentity({ user_id: "t-1" }, () => {
      updateIdentity({ project: "report" });
      return getIdentity();
    });
    expect(seen.user_id).toBe("t-1");
    expect(seen.project).toBe("report");
  });

  it("getIdentity returns a copy (no external mutation)", () => {
    runWithIdentity({ user_id: "t-1" }, () => {
      const got = getIdentity();
      got.user_id = "mutated";
      expect(getIdentity().user_id).toBe("t-1");
    });
  });
});
