import type { DependencyApprovals } from "@grasp-os/shared/dependencies";
import { describe, expect, it } from "vite-plus/test";

import { loadEnginePage } from "./engine-page.ts";
import type { EngineReaders } from "./engine-page.ts";

// The engine's page for someone core doesn't let read the engine (not a
// member): core alone decides whether they may list its approved packages,
// whatever their organization role, so the page shows those when core
// lists them and "not found" only when it lists neither.

const listed: DependencyApprovals = {
  policyGeneration: 1,
  decides: true,
  subject: { type: "app", id: "billing", name: "Billing" },
  approvals: [],
};

/**
 * Core as someone who isn't a member of the engine reads it: the engine
 * isn't found, as for one that isn't there, and its approvals are listed
 * only for an approver.
 */
const coreFor = ({ approver }: { approver: boolean }): EngineReaders => ({
  engine: async () => await Promise.resolve({ state: "missing" }),
  approvals: async () =>
    await Promise.resolve(
      approver ? { state: "ready", data: listed } : { state: "missing" }
    ),
});

describe("an engine's page for someone who isn't its member", () => {
  it("shows an approver who builds other engines its packages alone", async () => {
    const reads = await loadEnginePage(coreFor({ approver: true }), true);
    expect(reads.page.state).toBe("missing");
    await expect(reads.packagesOnly).resolves.toStrictEqual({
      state: "ready",
      data: listed,
    });
  });

  it("shows an approver who doesn't build its packages alone", async () => {
    const reads = await loadEnginePage(coreFor({ approver: true }), false);
    await expect(reads.packagesOnly).resolves.toStrictEqual({
      state: "ready",
      data: listed,
    });
  });

  it("finds nothing to show a builder whom core lets list neither", async () => {
    const reads = await loadEnginePage(coreFor({ approver: false }), true);
    expect(reads.page.state).toBe("missing");
    await expect(reads.packagesOnly).resolves.toStrictEqual({
      state: "missing",
    });
  });

  it("finds nothing to show anyone else whom core lets list neither", async () => {
    const reads = await loadEnginePage(coreFor({ approver: false }), false);
    await expect(reads.packagesOnly).resolves.toStrictEqual({
      state: "missing",
    });
  });
});
