// @vitest-environment happy-dom
import type { PendingAction, UnknownOutcome } from "@grasp-os/shared/connect";
import {
  appIdSchema,
  collectionIdSchema,
  connectionIdSchema,
  permissionIdSchema,
  runIdSchema,
  triggerIdSchema,
  workflowIdSchema,
  workflowResourceIdSchema,
} from "@grasp-os/shared/ids";
import type { Permission } from "@grasp-os/shared/permissions";
import type {
  BindingApprovalItem,
  SignInAgainItem,
} from "@grasp-os/shared/waiting";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vite-plus/test";

import { inInbox } from "../dashboard/in-inbox.tsx";
import type { Waiting } from "../dashboard/waiting.ts";
import { inboxItems, listed, unread } from "./items.ts";
import type { Target } from "./items.ts";
import { TargetLink } from "./target-link.tsx";

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

/** The person's Microsoft 365 account, whose access ran out, as core's feed lists it. */
const signInAgain: SignInAgainItem = {
  kind: "signInAgain",
  id: "signInAgain:connection-1",
  at: null,
  urgent: true,
  waitsOn: { type: "person", userId: "me" },
  verdicts: [],
  connection: {
    id: "connection-1",
    source: "native",
    provider: "microsoft",
    scope: "personal",
    status: "needs_reauth",
    ownerUserId: "me",
    connectedBy: "me",
    connectedByName: "Me",
    accountName: "anna@acme.test",
    createdAt: "2026-10-01T00:00:00.000Z",
  },
  integration: { source: "native", id: "microsoft", name: "Microsoft 365" },
};

const bindingApproval: BindingApprovalItem = {
  kind: "bindingApproval",
  id: "bindingApproval:workflow-quotes:2",
  at: null,
  urgent: true,
  waitsOn: { type: "admin" },
  verdicts: [],
  pending: {
    workflow: { id: "workflow-quotes", name: "Quotes" },
    version: 2,
    bindings: [
      {
        alias: "summary",
        kind: "model",
        contractId: "summary-v1",
        offered: [
          {
            target: { kind: "model", model: "openai/gpt-5" },
            label: "openai/gpt-5",
          },
        ],
      },
    ],
  },
};

/** What waits, every part read. */
const waiting = (ranOut = true) =>
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
    notifications: {
      state: "ready",
      data: {
        page: {
          notifications: [
            {
              id: "asked-1",
              type: "gap_asked",
              gap: "gap-invoices",
              question: "How many invoices come in a month?",
              owner: "Head of finance",
              at: "2026-10-13T09:00:00.000Z",
              read: false,
            },
            {
              id: "stopped-1",
              type: "trigger_stopped",
              trigger: "trigger-1",
              workflow: "workflow-1",
              workflowName: "Nightly report",
              at: "2026-10-12T09:00:00.000Z",
              read: false,
            },
            {
              id: "revoked-1",
              type: "package_revoked",
              app: "app-invoices",
              appName: "Invoices",
              package: { name: "left-pad", version: "1.3.0" },
              advisory: "MAL-2026-1",
              at: "2026-10-12T10:00:00.000Z",
              read: false,
            },
            {
              id: "deaf-1",
              type: "events_stopped",
              connection: "connection-1",
              event: "m365.mail.received",
              resource: "invoices@acme.test",
              reason: "refused",
              at: "2026-10-12T10:00:00.000Z",
              read: false,
            },
          ],
          unread: 4,
          more: false,
        },
        accounts: new Map([
          [
            "connection-1",
            { name: "Acme mail", source: "native", provider: "microsoft" },
          ],
        ]),
      },
    },
    reconnect: { state: "ready", data: ranOut ? [signInAgain] : [] },
    requests: {
      state: "ready",
      data: {
        requests: [request],
        directory: { people: new Map(), teams: new Map(), apps: new Map() },
      },
    },
    heldStarts: {
      state: "ready",
      data: [
        {
          id: "held-start-1",
          workflow: "greet",
          workflowName: "Greet",
          version: 1,
          args: { who: "Ada" },
          argsHash: "hash-1",
          chatId: "chat-1",
          requestedAt: "2026-10-12T07:00:00.000Z",
          expiresAt: "2026-10-13T07:00:00.000Z",
        },
      ],
    },
    decisions: {
      state: "ready",
      data: [
        {
          id: "decision-1",
          workflowResource: {
            id: workflowResourceIdSchema.parse("approve"),
            name: "approve",
          },
          workflow: workflowIdSchema.parse("approve"),
          run: runIdSchema.parse("run-2"),
          description: "Approve this invoice?",
          input: { amount: 5000 },
          status: "open",
          expiresAt: "2026-10-20T08:00:00.000Z",
          revision: "revision-1",
        },
      ],
    },
    bindings: { state: "ready", data: [bindingApproval] },
  }) satisfies Waiting;

const admin = { role: "admin", staff: false, name: "Ada Admin" } as const;
const member = { role: "user", staff: false, name: "Max Member" } as const;

describe(inboxItems, () => {
  it("makes an item of everything that waits, each kind from what core lists", () => {
    const ids = inboxItems(waiting(), admin, readAt).map(({ id }) => id);
    expect(ids.toSorted()).toStrictEqual(
      [
        "asked:asked-1",
        "bindingApproval:workflow-quotes:2",
        "decision:decision-1",
        "heldStart:held-start-1",
        "held:held-new",
        "held:held-old",
        `outcome:${JSON.stringify([outcome("mail-1", readAt).key, 1])}`,
        "request:request-1",
        "packageNotice:revoked-1",
        "signIn:connection-1",
        "stopped:stopped-1",
        "stoppedEvents:deaf-1",
      ].toSorted()
    );
  });

  it("tells of packages revoked as malware as urgent, with the package, its advisory and where it is fixed", () => {
    const revoked = inboxItems(waiting(), member, readAt).find(
      ({ id }) => id === "packageNotice:revoked-1"
    );
    expect({
      kind: revoked?.kind,
      title: revoked?.title,
      facts: revoked?.facts.slice(0, 2),
      about: revoked?.about,
      urgent: revoked?.urgent,
    }).toStrictEqual({
      kind: "packageNotice",
      title: "Packages of Invoices were revoked as malware",
      facts: [
        { label: "Package", value: "left-pad@1.3.0" },
        { label: "Advisory", value: "MAL-2026-1" },
      ],
      about: { kind: "app", app: "app-invoices" },
      urgent: true,
    });
  });

  it("tells of a mailbox connect stopped hearing as urgent, by its account, with a way to the connection", () => {
    const deaf = inboxItems(waiting(), member, readAt).find(
      ({ id }) => id === "stoppedEvents:deaf-1"
    );
    expect({
      title: deaf?.title,
      facts: deaf?.facts.slice(0, 1),
      about: deaf?.about,
      urgent: deaf?.urgent,
    }).toStrictEqual({
      title: "Your triggers stopped hearing new mail at Acme mail",
      facts: [{ label: "Mailbox", value: "invoices@acme.test" }],
      about: { kind: "integration", integration: "native:microsoft" },
      urgent: true,
    });
  });

  it("names a trigger asking for a permission by its kind and what starts it", () => {
    const triggerAsks = (
      id: string,
      object: Permission["object"],
      actions: string[],
      trigger?: Permission["trigger"]
    ): Permission => ({
      ...request,
      id: permissionIdSchema.parse(id),
      subject: { type: "trigger", triggerId: triggerIdSchema.parse(id) },
      object,
      actions,
      ...(trigger === undefined ? {} : { trigger }),
    });
    const workflow = {
      type: "workflow",
      workflowId: workflowResourceIdSchema.parse("workflow-1"),
    } as const;
    const read = waiting();
    read.requests = {
      state: "ready",
      data: {
        requests: [
          triggerAsks("schedule-1", workflow, ["start"], {
            kind: "schedule",
            schedule: { cron: "0 9 * * 1-5", timeZone: "Europe/Berlin" },
            event: null,
            connection: null,
            source: null,
          }),
          triggerAsks(
            "mail-1",
            {
              type: "connection",
              connectionId: connectionIdSchema.parse("connection-1"),
            },
            ["mail.list"],
            {
              kind: "connector",
              schedule: null,
              event: "m365.mail.received",
              connection: { connectionId: "connection-1", resource: null },
              source: null,
            }
          ),
          triggerAsks("email-1", workflow, ["start"], {
            kind: "email",
            schedule: null,
            event: null,
            connection: null,
            source: null,
          }),
          triggerAsks("webhook-1", workflow, ["start"], {
            kind: "webhook",
            schedule: null,
            event: "order.paid",
            connection: null,
            source: { id: "source-1", name: "Shop system", deleted: false },
          }),
          // Listed without what it is: by its ID, as before.
          triggerAsks("unknown-1", workflow, ["start"]),
        ],
        directory: { people: new Map(), teams: new Map(), apps: new Map() },
      },
    };

    const titles = inboxItems(read, admin, readAt)
      .filter(({ kind }) => kind === "permissionRequest")
      .map(({ context }) => context);

    expect(titles.toSorted()).toStrictEqual(
      [
        "Schedule trigger (On the schedule 0 9 * * 1-5, in Europe/Berlin): start on Workflow workflow-1",
        "Connection trigger (New mail in Microsoft 365, at connection-1): mail.list on Connection connection-1",
        "Email trigger (When an email arrives at its own address): start on Workflow workflow-1",
        "Webhook trigger (On order.paid events from Shop system): start on Workflow workflow-1",
        "Trigger unknown-1: start on Workflow workflow-1",
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

  it("leaves the permission requests and the bindings to approve to admins, who decide them", () => {
    const kinds = inboxItems(waiting(), member, readAt).map(({ kind }) => kind);
    expect(kinds).not.toContain("permissionRequest");
    expect(kinds).not.toContain("bindingApproval");
  });

  it("lets go of an item once what it is about is settled", () => {
    const settled = {
      ...waiting(false),
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

describe(inInbox, () => {
  it("leads the dashboard to every item it has no card or row of its own for", () => {
    // The pile settles changes, lost answers and requests; rows
    // under it lead to connections.
    const onDashboard = new Set(["held", "outcome", "request", "reconnect"]);
    const all = inboxItems(waiting(), admin, readAt);
    const elsewhere = all.filter(({ source }) => !onDashboard.has(source.type));
    expect(
      inInbox(waiting(), admin, readAt)
        .map(({ id }) => id)
        .toSorted()
    ).toStrictEqual(elsewhere.map(({ id }) => id).toSorted());
    expect(elsewhere.map(({ id }) => id).toSorted()).toStrictEqual([
      "asked:asked-1",
      "bindingApproval:workflow-quotes:2",
      "decision:decision-1",
      "heldStart:held-start-1",
      "packageNotice:revoked-1",
      "stopped:stopped-1",
      "stoppedEvents:deaf-1",
    ]);
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
    ).toStrictEqual([
      "decision",
      "bindingApproval",
      "stoppedEvents",
      "heldStart",
      "stoppedSchedule",
    ]);
    expect(
      listed(items, "brain", "urgent").map(({ kind, title, about }) => ({
        kind,
        title,
        about,
      }))
    ).toStrictEqual([
      {
        kind: "openQuestion",
        title: "How many invoices come in a month?",
        about: { kind: "brain" },
      },
    ]);
    const stopped = items.find(({ kind }) => kind === "stoppedSchedule");
    expect({ title: stopped?.title, about: stopped?.about }).toStrictEqual({
      title: "The schedule of Nightly report stopped",
      // Its workflow's Triggers, where it is turned on again.
      about: {
        kind: "independentWorkflow",
        workflow: "workflow-1",
        section: "triggers",
      },
    });
    expect(listed(items, "apps", "urgent")).toHaveLength(items.length - 6);
  });
});

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** Where the inbox's link to `about` leads, as the page renders it. */
const hrefOf = async (about: Target | undefined): Promise<string | null> => {
  if (about === undefined) {
    return null;
  }
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => createElement(TargetLink, { destination: about }),
    }),
    history: createMemoryHistory(),
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(RouterProvider, { router }));
    await router.load();
  });
  const href = host.querySelector("a")?.getAttribute("href") ?? null;
  act(() => {
    root.unmount();
  });
  host.remove();
  return href;
};

describe(TargetLink, () => {
  it("opens the section of an App's settings where what it is about is decided, and its page otherwise", async () => {
    const items = inboxItems(waiting(), admin, readAt);
    const about = (id: string) => items.find((item) => item.id === id)?.about;

    expect({
      revoked: await hrefOf(about("packageNotice:revoked-1")),
      request: await hrefOf(about("request:request-1")),
      app: await hrefOf({ kind: "app", app }),
    }).toStrictEqual({
      revoked: `/apps/${app}`,
      request: `/apps/${app}/settings?section=connections`,
      app: `/apps/${app}`,
    });
  });
});
