// @vitest-environment happy-dom
import type { PendingAction, UnknownOutcome } from "@grasp-os/shared/connect";
import {
  connectionIdSchema,
  runIdSchema,
  workflowResourceIdSchema,
} from "@grasp-os/shared/ids";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { HeldCard } from "../dashboard/pile-cards.tsx";
import type { Waiting } from "../dashboard/waiting.ts";
import { ItemDetail } from "./item-detail.tsx";
import { inboxItems } from "./items.ts";

// A run's held write and its call of unknown outcome in the inbox, as core
// lists them (GRA-1999): while the run may still read what it read, their
// input is there to read and approve; once core withholds it, the inbox
// shows why, nothing of it, and only what sends nothing: Reject, or "It
// happened".

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const readAt = "2026-11-17T12:00:00.000Z";
const workflowId = workflowResourceIdSchema.parse("workflow-mail");
const context = {
  type: "workflowRun" as const,
  workflowId,
  runId: runIdSchema.parse("run-1"),
};
const input = JSON.stringify({ to: "ben@acme.test", subject: "Invoice 42" });

/** A send a run's restricted App start had held, as core lists it. */
const heldSend: PendingAction = {
  id: "pending-1",
  subject: { type: "workflow", workflowId },
  appVersion: null,
  mode: "workflow",
  context,
  restricted: true,
  permissionId: "permission-1",
  binding: null,
  connectionId: "connection-1",
  connectionName: "Outlook",
  resource: null,
  action: "mail.send",
  idempotencyKey: "run-1:send:task",
  input,
  inputHash: "c".repeat(64),
  requestedAt: "2026-11-17T10:00:00.000Z",
};

/** A send of the run whose answer was lost, as core lists it. */
const lostSend: UnknownOutcome = {
  key: {
    subject: { type: "workflow", workflowId },
    connectionId: connectionIdSchema.parse("connection-1"),
    action: "mail.send",
    idempotencyKey: "run-1:send:task",
  },
  connectionName: "Outlook",
  resource: null,
  input,
  sentAt: "2026-11-17T10:00:00.000Z",
  claim: 1,
  origin: {
    mode: "workflow",
    appVersion: null,
    permissionId: "permission-1",
    context,
  },
  cursor: "1.a",
};

/** What `node`, rendered in a router, shows: its text and its buttons, by label, each whether it is off. */
const rendered = async (node: () => React.ReactNode) => {
  const rootRoute = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: node,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([page]),
    history: createMemoryHistory(),
    context: { core: {} },
  });
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nProvider>
    );
    await router.load();
  });
  const buttons = [...host.querySelectorAll("button")];
  return {
    text: host.textContent ?? "",
    // Each act by its label, whether it is off: a bar may show them twice.
    actions: Object.fromEntries(
      buttons
        .map((button) => [button.textContent ?? "", button.disabled] as const)
        .filter(([label]) =>
          ["Approve", "Reject", "It happened", "It didn't happen"].includes(
            label
          )
        )
    ),
  };
};

/** The inbox item of `held` or `lost`, opened. */
const opened = async ({
  held = [],
  lost = [],
}: {
  held?: PendingAction[];
  lost?: UnknownOutcome[];
}) => {
  const waiting = {
    held: { state: "ready", data: held },
    outcomes: { state: "ready", data: lost },
    notifications: {
      state: "ready",
      data: { page: { notifications: [], unread: 0, more: false } },
    },
    reconnect: { state: "ready", data: [] },
    requests: undefined,
    decisions: { state: "ready", data: [] },
    heldStarts: { state: "ready", data: [] },
    bindings: { state: "ready", data: [] },
  } satisfies Waiting;
  const [item] = inboxItems(
    waiting,
    { role: "user", staff: false, name: "Ada" },
    readAt
  );
  if (item === undefined) {
    throw new Error("No item");
  }
  return await rendered(() => (
    <ItemDetail item={item} onBack={() => {}} onSaid={() => {}} />
  ));
};

describe("a run's held or lost write in the inbox", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("shows what a held write would send and takes Approve, and once withheld shows why, nothing of it, and Reject alone", async () => {
    const open = await opened({ held: [heldSend] });
    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    const withheld = await opened({
      held: [
        {
          ...heldSend,
          input: "",
          inputHash: "",
          withheld: "revoked",
        },
      ],
    });

    expect({
      open: { shows: open.text.includes("Invoice 42"), actions: open.actions },
      withheld: {
        shows: withheld.text.includes("Invoice 42"),
        says: withheld.text.includes(
          "the run that asked for it may no longer read what it read"
        ),
        actions: withheld.actions,
      },
    }).toStrictEqual({
      open: {
        shows: true,
        actions: { Approve: false, Reject: false },
      },
      withheld: {
        shows: false,
        says: true,
        actions: { Reject: false },
      },
    });
  });

  it("shows a withheld held write on the dashboard's pile with Approve off, said why", async () => {
    const { text, actions } = await rendered(() => (
      <HeldCard
        action={{ ...heldSend, input: "", inputHash: "", withheld: "revoked" }}
        pile={{
          answering: () => true,
          settled: () => {},
          deciding: false,
          answered: () => {},
        }}
      />
    ));
    const approve = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Approve"
    );
    const whyId = approve?.getAttribute("aria-describedby") ?? "";
    const why = document.querySelector(`[id="${whyId}"]`);

    expect({
      shows: text.includes("Invoice 42"),
      actions,
      why: why?.textContent?.includes("may no longer read what it read"),
    }).toStrictEqual({
      shows: false,
      actions: { Approve: true, Reject: false },
      why: true,
    });
  });

  it("says a lost write can't be shown for now while it can't be checked, and only takes that it happened", async () => {
    const { input: _input, ...unshown } = lostSend;
    const { text, actions } = await opened({
      lost: [{ ...unshown, input: null, withheld: "unchecked" }],
    });

    expect({
      shows: text.includes("Invoice 42"),
      says: text.includes("What was sent can't be shown right now."),
      saysGone: text.includes("no longer kept"),
      actions,
    }).toStrictEqual({
      shows: false,
      says: true,
      saysGone: false,
      actions: { "It happened": false, "It didn't happen": true },
    });
  });
});
