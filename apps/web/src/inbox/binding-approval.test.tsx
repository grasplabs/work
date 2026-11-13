// @vitest-environment happy-dom
import type { BindingApprovalItem } from "@grasp-os/shared/waiting";
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

import type { Waiting } from "../dashboard/waiting.ts";
import { ItemDetail } from "./item-detail.tsx";
import { inboxItems } from "./items.ts";

// A workflow's bindings that wait on an admin, in the inbox, against core's
// workflowResources as the page reaches them over RPC, faked: each binding
// core offers targets for is approved with exactly the chosen target, for
// the version shown; a connector it offers none for leads to the
// workflow's page, where such kinds are offered targets, and a binding
// nothing serves says it needs a grant; neither offers anything to press.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const readAt = "2026-10-30T12:00:00.000Z";

const item: BindingApprovalItem = {
  kind: "bindingApproval",
  id: "bindingApproval:workflow-quotes:2",
  at: null,
  urgent: true,
  waitsOn: { type: "admin" },
  verdicts: [],
  pending: {
    workflow: { id: "workflow-quotes", name: "Quotes" },
    version: 2,
    live: true,
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
          {
            target: { kind: "model", model: "anthropic/claude" },
            label: "anthropic/claude",
          },
        ],
      },
      {
        alias: "crm",
        kind: "connector",
        contractId: "crm/contacts",
        offered: [],
      },
      {
        alias: "docs",
        kind: "brain",
        contractId: "docs-v1",
        offered: [],
      },
    ],
  },
};

/** The item's detail, with what core was asked to approve. */
const shown = async () => {
  const approved: { id: string; input: unknown }[] = [];
  const workflowResources = {
    approveBinding: async (id: string, input: unknown) => {
      await Promise.resolve();
      approved.push({ id, input });
      return {};
    },
  };
  const core = {
    withSession: async <T,>(
      action: (session: {
        workflowResources: typeof workflowResources;
      }) => Promise<T>
    ): Promise<T> => await action({ workflowResources }),
  };
  const waiting = {
    held: { state: "ready", data: [] },
    outcomes: { state: "ready", data: [] },
    notifications: {
      state: "ready",
      data: { page: { notifications: [], unread: 0, more: false } },
    },
    reconnect: { state: "ready", data: [] },
    requests: undefined,
    decisions: { state: "ready", data: [] },
    workflowGoLives: { state: "ready", data: [] },
    heldStarts: { state: "ready", data: [] },
    bindings: { state: "ready", data: [item] },
  } satisfies Waiting;
  const [shownItem] = inboxItems(
    waiting,
    { role: "admin", staff: false, name: "Ada Admin" },
    readAt
  );
  if (shownItem === undefined) {
    throw new Error("No item");
  }
  const said: string[] = [];
  const rootRoute = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <ItemDetail
        item={shownItem}
        onBack={() => {}}
        onSaid={(line) => {
          said.push(line);
        }}
      />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([page]),
    history: createMemoryHistory(),
    context: { core },
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
  return { approved, said, title: shownItem.title };
};

/** The button named `name`. */
const button = (name: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find(
    (each) => each.getAttribute("aria-label") === name
  );

describe("a workflow's bindings in the inbox", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("approves a binding with exactly the target chosen, for the version shown", async () => {
    const { approved, said, title } = await shown();
    const select = document.querySelector("select");
    await act(async () => {
      if (select !== null) {
        select.value = "1";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
      await Promise.resolve();
    });
    await act(async () => {
      button("Approve summary")?.click();
      await Promise.resolve();
    });

    expect({ title, approved, said }).toStrictEqual({
      title: "Approve what Quotes reaches",
      approved: [
        {
          id: "workflow-quotes",
          input: {
            alias: "summary",
            target: { kind: "model", model: "anthropic/claude" },
            reviewed: { version: 2 },
          },
        },
      ],
      said: ["Approved: summary of Quotes."],
    });
  });

  it("leads to the workflow's page for a connector it offers no target for, and says a binding nothing serves needs a grant, with nothing to press", async () => {
    await shown();

    expect({
      approve: [button("Approve crm"), button("Approve docs")],
      grant: document.body.textContent.includes(
        "Nothing the workflow may use serves it now: grant the workflow what it needs, or try again later."
      ),
      leads: [...document.querySelectorAll("a")]
        .filter(
          (link) =>
            link.textContent.trim() === "Approve it on the workflow's page"
        )
        .map((link) => link.getAttribute("href")),
    }).toStrictEqual({
      approve: [undefined, undefined],
      grant: true,
      leads: ["/workflows/workflow-quotes?view=settings&section=files"],
    });
  });
});
