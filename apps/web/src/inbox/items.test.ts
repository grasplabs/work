import type { PendingAction, UnknownOutcome } from "@grasp-os/shared/connect";
import type { DependencyRequest } from "@grasp-os/shared/dependencies";
import {
  appIdSchema,
  collectionIdSchema,
  connectionIdSchema,
  permissionIdSchema,
  runIdSchema,
  workflowIdSchema,
  workflowResourceIdSchema,
} from "@grasp-os/shared/ids";
import type { Permission } from "@grasp-os/shared/permissions";
import type {
  GoLiveItem,
  SignInAgainItem,
  WorkflowGoLiveItem,
} from "@grasp-os/shared/waiting";
import { describe, expect, it } from "vite-plus/test";

import { inInbox } from "../dashboard/in-inbox.tsx";
import type { Waiting } from "../dashboard/waiting.ts";
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

/** A version of Invoices up for review, for the person who answers for it. */
const goLive: GoLiveItem = {
  kind: "goLive",
  id: "goLive:app-invoices:4",
  at: null,
  urgent: false,
  waitsOn: { type: "person", userId: "me" },
  verdicts: [],
  app: { id: app, name: "Invoices" },
  version: 4,
};

/** A version of a workflow asked to go live, waiting on an admin. */
const workflowGoLive: WorkflowGoLiveItem = {
  kind: "workflowGoLive",
  id: "workflowGoLive:workflow-quotes:2",
  at: "2026-10-12T12:00:00.000Z",
  urgent: false,
  waitsOn: { type: "admin" },
  verdicts: ["approve", "reject"],
  workflow: { id: "workflow-quotes", name: "Quotes" },
  version: 2,
  requestedBy: "builder-1",
  revision: 3,
  selfApproval: false,
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
    versions: { state: "ready", data: [goLive] },
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
    workflowGoLives: { state: "ready", data: [workflowGoLive] },
  }) satisfies Waiting;

const admin = { role: "admin", staff: false, name: "Ada Admin" } as const;
const member = { role: "user", staff: false, name: "Max Member" } as const;

describe(inboxItems, () => {
  it("makes an item of everything that waits, each kind from what core lists", () => {
    const ids = inboxItems(waiting(), admin, readAt).map(({ id }) => id);
    expect(ids.toSorted()).toStrictEqual(
      [
        "asked:asked-1",
        "decision:decision-1",
        "failed:failure-1",
        "goLive:app-invoices:4",
        "held:held-new",
        "held:held-old",
        `outcome:${JSON.stringify([outcome("mail-1", readAt).key, 1])}`,
        "packages:packages-1",
        "request:request-1",
        "screens:app-invoices",
        "signIn:connection-1",
        "stopped:stopped-1",
        "stoppedEvents:deaf-1",
        "workflowGoLive:workflow-quotes:2",
      ].toSorted()
    );
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
      ...waiting(false),
      held: { state: "ready", data: [] },
      outcomes: { state: "ready", data: [] },
    } satisfies Waiting;
    const kinds = inboxItems(settled, admin, readAt).map(({ kind }) => kind);
    expect(kinds).not.toContain("signInAgain");
    expect(kinds).not.toContain("heldWrite");
    expect(kinds).not.toContain("unknownOutcome");
  });

  it("marks a go-live the reader asked for, and decides as nobody else may, as self-approved", () => {
    const own = {
      ...waiting(),
      workflowGoLives: {
        state: "ready",
        data: [{ ...workflowGoLive, selfApproval: true }],
      },
    } satisfies Waiting;
    const [mine, theirs] = [own, waiting()].map((read) =>
      inboxItems(read, admin, readAt).find(({ id }) => id === workflowGoLive.id)
    );
    expect({
      mine: mine?.facts,
      theirs: theirs?.facts,
      said: mine?.body.at(-1),
    }).toStrictEqual({
      mine: [
        { label: "Version", value: "2" },
        { label: "Approval", value: "Self-approved" },
      ],
      theirs: [{ label: "Version", value: "2" }],
      said: "You asked for this yourself, and nobody else may approve it, so you decide it. It is recorded as self-approved.",
    });
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
    // The pile settles changes, lost answers, requests and packages; rows
    // under it lead to engines, failed workflows and connections.
    const onDashboard = new Set([
      "held",
      "outcome",
      "request",
      "packages",
      "screens",
      "failed",
      "reconnect",
    ]);
    const all = inboxItems(waiting(), admin, readAt);
    const elsewhere = all.filter(({ source }) => !onDashboard.has(source.type));
    expect(
      inInbox(waiting(), admin, readAt)
        .map(({ id }) => id)
        .toSorted()
    ).toStrictEqual(elsewhere.map(({ id }) => id).toSorted());
    expect(elsewhere.map(({ id }) => id).toSorted()).toStrictEqual([
      "asked:asked-1",
      "decision:decision-1",
      "goLive:app-invoices:4",
      "stopped:stopped-1",
      "stoppedEvents:deaf-1",
      "workflowGoLive:workflow-quotes:2",
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
      "stoppedEvents",
      "goLive",
      "failedRun",
      "goLive",
      "stoppedSchedule",
    ]);
    const quotes = items.find(({ id }) => id === workflowGoLive.id);
    expect({
      title: quotes?.title,
      about: quotes?.about,
      // It waits on an admin, not on the reader by name.
      forWhom: quotes?.forWhom,
    }).toStrictEqual({
      title: "Let version 2 of Quotes go live?",
      about: { kind: "independentWorkflow", workflow: "workflow-quotes" },
      forWhom: undefined,
    });
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
    expect(items.find(({ kind }) => kind === "stoppedSchedule")?.title).toBe(
      "The schedule of Nightly report stopped"
    );
    expect(listed(items, "apps", "urgent")).toHaveLength(items.length - 7);
  });
});
