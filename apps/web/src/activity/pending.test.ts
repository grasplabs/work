import {
  agentIdSchema,
  appIdSchema,
  collectionIdSchema,
  permissionIdSchema,
  triggerIdSchema,
  workflowResourceIdSchema,
} from "@grasp-os/shared/ids";
import type { Permission } from "@grasp-os/shared/permissions";
import { describe, expect, it } from "vite-plus/test";

import { objectOf, subjectOf } from "./pending.tsx";

const app = "11111111-1111-4111-8111-111111111111";

/** An agent's request to call `app`'s functions with `actions`. */
const onApp = (actions: string[]): Permission => ({
  id: permissionIdSchema.parse(crypto.randomUUID()),
  subject: { type: "agent", agentId: agentIdSchema.parse("agent") },
  object: { type: "app", appId: appIdSchema.parse(app) },
  actions,
  binding: "APP",
  status: "requested",
  requestedBy: "person",
  requestedAt: "2026-10-22T00:00:00.000Z",
  grantedBy: null,
  grantedAt: null,
  revokedBy: null,
  revokedAt: null,
  requestedVia: null,
  chat: null,
});

const directory = { people: new Map(), apps: new Map() };

describe("a pending request on an App", () => {
  it("says which of the App's functions each action calls, and no more", () => {
    expect(
      [["read"], ["write"], ["read", "write"]].map((actions) =>
        objectOf(onApp(actions), directory)
      )
    ).toStrictEqual([
      expect.stringMatching(/^Queries of /u),
      expect.stringMatching(/^Mutations and actions of /u),
      expect.stringMatching(/^Queries, mutations and actions of /u),
    ]);
  });
});

/** A workflow's request to read a collection. */
const onCollection = (): Permission => ({
  ...onApp([]),
  subject: {
    type: "workflow",
    workflowId: workflowResourceIdSchema.parse(
      "33333333-3333-4333-8333-333333333333"
    ),
  },
  object: {
    type: "collection",
    collectionId: collectionIdSchema.parse(
      "22222222-2222-4222-8222-222222222222"
    ),
  },
  actions: ["read"],
});

const workflow = workflowResourceIdSchema.parse(
  "44444444-4444-4444-8444-444444444444"
);

/** A trigger's request to start `workflow`, with the names core gave. */
const startRequest = (workflowNames?: Record<string, string>): Permission => ({
  ...onApp(["start"]),
  subject: {
    type: "trigger",
    triggerId: triggerIdSchema.parse("55555555-5555-4555-8555-555555555555"),
  },
  object: { type: "workflow", workflowId: workflow },
  ...(workflowNames === undefined ? {} : { workflowNames }),
});

describe("a pending request that names a workflow", () => {
  it("names the workflow a trigger starts, and by its ID only where core couldn't name it", () => {
    expect({
      named: objectOf(
        startRequest({ [workflow]: "invoice-approval" }),
        directory
      ),
      unnamed: objectOf(startRequest(), directory),
    }).toStrictEqual({
      named: "Workflow invoice-approval",
      unnamed: `Workflow ${workflow}`,
    });
  });

  it("names the workflow that asks", () => {
    const asking = onCollection();
    const { subject } = asking;
    const id = subject.type === "workflow" ? subject.workflowId : "";

    expect({
      named: subjectOf(
        { ...asking, workflowNames: { [id]: "nightly-report" } },
        directory
      ),
      unnamed: subjectOf(asking, directory),
    }).toStrictEqual({
      named: "Workflow nightly-report",
      unnamed: `Workflow ${id}`,
    });
  });
});
