import {
  agentIdSchema,
  appIdSchema,
  permissionIdSchema,
  storeIdSchema,
  triggerIdSchema,
  workflowResourceIdSchema,
} from "@grasp-os/shared/ids";
import type { Permission, StoreReach } from "@grasp-os/shared/permissions";
import { describe, expect, it } from "vite-plus/test";

import { objectOf } from "./pending.tsx";

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

const store = "22222222-2222-4222-8222-222222222222";

/** A workflow's request for a workflow's store, its operations reaching `reach`. */
const onStore = (reach: StoreReach[]): Permission => ({
  ...onApp([]),
  subject: {
    type: "workflow",
    workflowId: workflowResourceIdSchema.parse(
      "33333333-3333-4333-8333-333333333333"
    ),
  },
  object: { type: "store", storeId: storeIdSchema.parse(store) },
  actions: reach.map(({ operation }) => operation),
  reach,
});

describe("a pending request on a workflow's store", () => {
  it("says what its operations do to the records: read them, add to them, or read and change them", () => {
    const get: StoreReach = {
      operation: "getOrder",
      table: "orders",
      access: "reads",
    };
    const add: StoreReach = {
      operation: "addOrder",
      table: "orders",
      access: "adds",
    };
    const settle: StoreReach = {
      operation: "settle",
      table: "orders",
      access: "changes",
    };
    expect(
      [[add], [get, add], [settle], [get, add, settle]].map((reach) =>
        objectOf(onStore(reach), directory)
      )
    ).toStrictEqual([
      `Store ${store}, a workflow's. This can add records to orders`,
      `Store ${store}, a workflow's. Whoever owns the records, this can read every record of orders and add records to orders`,
      `Store ${store}, a workflow's. Whoever owns the records, this can read and change every record of orders`,
      `Store ${store}, a workflow's. Whoever owns the records, this can read every record of orders, read and change every record of orders, and add records to orders`,
    ]);
  });
});

const workflow = workflowResourceIdSchema.parse(
  "44444444-4444-4444-8444-444444444444"
);

/** A trigger's request to start `workflow`, named `workflowName` where core named it. */
const startRequest = (workflowName?: string): Permission => ({
  ...onApp(["start"]),
  subject: {
    type: "trigger",
    triggerId: triggerIdSchema.parse("55555555-5555-4555-8555-555555555555"),
  },
  object: { type: "workflow", workflowId: workflow },
  ...(workflowName === undefined ? {} : { workflowName }),
});

describe("a trigger's pending request to start a workflow", () => {
  it("names the workflow it starts, and by its ID only where core couldn't name it", () => {
    expect({
      named: objectOf(startRequest("invoice-approval"), directory),
      unnamed: objectOf(startRequest(), directory),
    }).toStrictEqual({
      named: "Workflow invoice-approval",
      unnamed: `Workflow ${workflow}`,
    });
  });
});
