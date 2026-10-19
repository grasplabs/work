import type { PendingAction, UnknownOutcome } from "@grasp-os/shared/connect";
import type { DependencyRequest } from "@grasp-os/shared/dependencies";
import {
  appIdSchema,
  collectionIdSchema,
  connectionIdSchema,
  permissionIdSchema,
} from "@grasp-os/shared/ids";
import type { Permission } from "@grasp-os/shared/permissions";
import { describe, expect, it } from "vite-plus/test";

import type { Integration } from "../connections/integrations.ts";
import type { Waiting } from "../dashboard/to-do.tsx";
import { inboxItems, listed, unread } from "./items.ts";

// The inbox's items (items.ts), as the prototype derives them
// (`lib/inbox.test.ts`): each made from what core says waits now, in the
// inbox's own order, and filtered and ordered as the person asks.

const app = appIdSchema.parse("app-invoices");
const readAt = "2026-10-14T09:00:00.000Z";

const held = (id: string, requestedAt: string): PendingAction => ({
  id,
  subject: { type: "app", appId: app },
  appVersion: 3,
  mode: "interactive",
  context: { type: "app", appId: app },
  restricted: false,
  permissionId: "permission-1",
  connectionId: "connection-1",
  connectionName: "Microsoft 365 (anna@acme.test)",
  resource: null,
  action: "send_mail",
  description: { title: "Send an email", fields: [], complete: true },
  idempotencyKey: `key-${id}`,
  input: "{}",
  inputHash: "0".repeat(64),
  requestedAt,
  binding: null,
});

/** A mail Grasp sent for the person whose answer was lost. */
const outcome = (idempotencyKey: string, sentAt: string): UnknownOutcome => ({
  key: {
    subject: { type: "app", appId: app },
    connectionId: connectionIdSchema.parse("connection-1"),
    action: "send_mail",
    idempotencyKey,
  },
  connectionName: "Microsoft 365 (anna@acme.test)",
  resource: null,
  description: { title: "Send an email", fields: [], complete: true },
  input: "{}",
  sentAt,
  claim: 1,
  origin: {
    mode: "workflow",
    appVersion: 3,
    permissionId: "permission-1",
    context: { type: "app", appId: app },
  },
  cursor: "1.abc",
});

const packages = (id: string, requestedAt: string): DependencyRequest => ({
  id,
  subject: { type: "app", id: app, name: "Invoices" },
  status: "pending",
  sourceRevision: "rev-1",
  purpose: "Draw the monthly totals as a chart.",
  targets: ["browser"],
  graphHash: "hash",
  counts: { direct: 1, packages: 2, findings: 0, refused: 0 },
  summary: { direct: ["charts@3.1.0"], findings: [] },
  requestedBy: { userId: "builder", name: "Bea Builder" },
  requestedAt,
  requestedVia: null,
  policyGeneration: 1,
});

const request: Permission = {
  id: permissionIdSchema.parse("request-1"),
  subject: { type: "app", appId: app },
  object: {
    type: "collection",
    collectionId: collectionIdSchema.parse("invoices"),
  },
  actions: ["read"],
  binding: "invoices",
  status: "requested",
  requestedBy: "builder",
  requestedAt: "2026-10-12T08:00:00.000Z",
  grantedBy: null,
  grantedAt: null,
  revokedBy: null,
  revokedAt: null,
  requestedVia: null,
  chat: null,
};

const microsoft = (status: "active" | "needs_reauth"): Integration => ({
  key: "native:microsoft",
  source: "native",
  id: "microsoft",
  name: "Microsoft 365",
  categories: [],
  group: "Email and calendar",
  auth: "managed",
  description: null,
  logo: null,
  toolCount: 3,
  offered: true,
  listed: true,
  connections: [
    {
      id: "connection-1",
      source: "native",
      provider: "microsoft",
      scope: "personal",
      status,
      ownerUserId: "me",
      connectedBy: "me",
      connectedByName: "Me",
      accountName: "anna@acme.test",
      createdAt: "2026-10-01T00:00:00.000Z",
    },
  ],
});

/** What waits, every part read. */
const waiting = (status: "active" | "needs_reauth" = "needs_reauth") =>
  ({
    held: {
      state: "ready",
      data: [
        held("held-old", "2026-10-10T08:00:00.000Z"),
        held("held-new", "2026-10-13T08:00:00.000Z"),
      ],
    },
    outcomes: {
      state: "ready",
      data: [outcome("mail-1", "2026-10-12T08:00:00.000Z")],
    },
    failed: {
      state: "ready",
      data: {
        model: "model-1",
        page: {
          notifications: [
            {
              id: "failure-1",
              type: "run_failed",
              app,
              appName: "Invoices",
              workflow: "tally",
              run: "run-1",
              failures: 2,
              at: "2026-10-13T10:00:00.000Z",
              read: false,
            },
          ],
          unread: 1,
          more: false,
        },
      },
    },
    integrations: { state: "ready", data: [microsoft(status)] },
    requests: {
      state: "ready",
      data: {
        requests: [request],
        directory: { people: new Map(), apps: new Map() },
        exports: new Map(),
      },
    },
    dependencies: {
      state: "ready",
      data: {
        policyGeneration: 1,
        requests: [packages("packages-1", "2026-10-11T08:00:00.000Z")],
      },
    },
    screens: {
      state: "ready",
      data: [{ app, name: "Invoices", version: 3, screens: ["Overview"] }],
    },
  }) satisfies Waiting;

const admin = { role: "admin", staff: false, name: "Ada Admin" } as const;
const member = { role: "user", staff: false, name: "Max Member" } as const;

describe(inboxItems, () => {
  it("makes an item of everything that waits, each kind from what core lists", () => {
    const ids = inboxItems(waiting(), admin, readAt).map(({ id }) => id);
    expect(ids.toSorted()).toStrictEqual(
      [
        "failed:failure-1",
        "held:held-new",
        "held:held-old",
        `outcome:${JSON.stringify([outcome("mail-1", readAt).key, 1])}`,
        "packages:packages-1",
        "request:request-1",
        "screens:app-invoices",
        "signIn:connection-1",
      ].toSorted()
    );
  });

  it("puts what blocks something first, then the newest", () => {
    const items = inboxItems(waiting(), admin, readAt);
    const firstCalm = items.findIndex((item) => !item.urgent);
    expect(firstCalm).toBeGreaterThan(0);
    expect(items.slice(firstCalm).every((item) => !item.urgent)).toBeTruthy();
    for (const part of [items.slice(0, firstCalm), items.slice(firstCalm)]) {
      const dates = part.map(({ date }) => date);
      expect(dates).toStrictEqual(dates.toSorted().toReversed());
    }
  });

  it("leaves the permission requests to admins, who decide them", () => {
    const kinds = inboxItems(waiting(), member, readAt).map(({ kind }) => kind);
    expect(kinds).not.toContain("permissionRequest");
    expect(kinds).toContain("packages");
  });

  it("lets go of an item once what it is about is settled", () => {
    const settled = {
      ...waiting("active"),
      held: { state: "ready", data: [] },
      outcomes: { state: "ready", data: [] },
    } satisfies Waiting;
    const kinds = inboxItems(settled, admin, readAt).map(({ kind }) => kind);
    expect(kinds).not.toContain("signInAgain");
    expect(kinds).not.toContain("heldWrite");
    expect(kinds).not.toContain("unknownOutcome");
  });

  it("makes nothing of a part that couldn't be read, and says which", () => {
    const offline = { ...waiting(), held: { state: "offline" } } as const;
    const kinds = inboxItems(offline, admin, readAt).map(({ kind }) => kind);
    expect(kinds).not.toContain("heldWrite");
    expect(unread(offline)).toStrictEqual([{ state: "offline" }]);
    expect(unread(waiting())).toStrictEqual([]);
  });
});

describe(listed, () => {
  const items = inboxItems(waiting(), admin, readAt);

  it("keeps the inbox's own order unless asked for another", () => {
    expect(listed(items, "all", "urgent")).toStrictEqual(items);
    const oldest = listed(items, "all", "oldest").map(({ date }) => date);
    expect(oldest).toStrictEqual(oldest.toSorted());
    const newest = listed(items, "all", "newest").map(({ date }) => date);
    expect(newest).toStrictEqual(newest.toSorted().toReversed());
  });

  it("shows one group of kinds when asked", () => {
    expect(
      listed(items, "workflows", "urgent").map(({ kind }) => kind)
    ).toStrictEqual(["failedRun"]);
    expect(listed(items, "brain", "urgent")).toStrictEqual([]);
    expect(listed(items, "apps", "urgent")).toHaveLength(items.length - 1);
  });
});
