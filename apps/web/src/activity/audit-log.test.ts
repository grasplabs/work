import { auditActorSchema } from "@grasp-os/shared/audit";
import { describe, expect, it } from "vite-plus/test";

import type { Directory } from "../directory.ts";
import { actorOf } from "./audit-log.tsx";

// Who did what, as the audit log reads it (GRA-1088): work a Grasp staff
// member started says so whoever does it for them, and a member's never.

const directory: Directory = {
  people: new Map([
    ["staff-1", "Sam Support"],
    ["ann", "Ann"],
  ]),
  apps: new Map(),
};

describe("an audit entry's actor", () => {
  it("names the Grasp staff member who started the work, and no one for a member's", () => {
    const agent = {
      type: "agent",
      agentId: "org",
      onBehalfOf: "staff-1",
    } as const;
    const run = {
      type: "workflow",
      runId: "00000000-0000-4000-8000-000000000001",
      appId: "00000000-0000-4000-8000-000000000002",
      workflowId: "report",
    } as const;
    expect({
      staffTurn: actorOf({ ...agent, staff: "staff-1" }, directory).label,
      staffRun: actorOf(
        auditActorSchema.parse({ ...run, staff: "staff-1" }),
        directory
      ).label,
      memberTurn: actorOf({ ...agent, onBehalfOf: "ann" }, directory).label,
    }).toStrictEqual({
      staffTurn:
        "Agent org for Sam Support, started by Sam Support (Grasp staff)",
      staffRun:
        "00000000-0000-4000-8000-000000000002: run of report, started by Sam Support (Grasp staff)",
      memberTurn: "Agent org for Ann",
    });
  });
});
