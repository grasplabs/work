// @vitest-environment happy-dom
import type { Gap } from "@grasp-os/shared/brain";
import type { GapAskedNotification } from "@grasp-os/shared/notifications";
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

// A question the brain asked the person, in the inbox: answered there, in
// their own words, through core's brain as the page reaches it over RPC,
// faked; the answer goes to the question that was asked, and the page
// says it was answered.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const asked: GapAskedNotification = {
  id: "notification-1",
  type: "gap_asked",
  gap: "gap-7",
  question: "Who signs off a quote over 10,000 euros?",
  owner: "Sales lead",
  at: "2026-11-16T09:00:00.000Z",
  read: false,
};

/** What core's brain was asked to do, in order. */
type Call = { ask: string } | { answer: string; gap: string };

/**
 * The inbox's one item for `viewer`, from `asked` notifications and the
 * Brain's open `gaps`, shown against a fake core's brain.
 */
const shown = async (
  viewer: { role: "admin" | "user"; staff: false; name: string },
  notifications: GapAskedNotification[],
  gaps: Gap[]
) => {
  const calls: Call[] = [];
  const brain = {
    answerGap: async (gap: string, answer: string) => {
      await Promise.resolve();
      calls.push({ gap, answer });
      return {};
    },
    askAboutGap: async (gap: string) => {
      await Promise.resolve();
      calls.push({ ask: gap });
      return {};
    },
  };
  const core = {
    withSession: async <T,>(
      action: (session: { brain: typeof brain }) => Promise<T>
    ): Promise<T> => await action({ brain }),
  };
  const waiting = {
    held: { state: "ready", data: [] },
    outcomes: { state: "ready", data: [] },
    notifications: {
      state: "ready",
      data: { page: { notifications, unread: 1, more: false } },
    },
    reconnect: { state: "ready", data: [] },
    requests: undefined,
    decisions: { state: "ready", data: [] },
    workflowGoLives: { state: "ready", data: [] },
    heldStarts: { state: "ready", data: [] },
    bindings: { state: "ready", data: [] },
    gaps: { state: "ready", data: gaps },
  } satisfies Waiting;
  const [item] = inboxItems(waiting, viewer, "2026-11-17T12:00:00.000Z");
  if (item === undefined) {
    throw new Error("No item");
  }
  const said: string[] = [];
  const rootRoute = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <ItemDetail
        item={item}
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
  return { calls, said };
};

/** Presses the button that reads `words`, and lets what it starts settle. */
const press = async (words: string) => {
  await act(async () => {
    [...document.querySelectorAll("button")]
      .find((each) => each.textContent.trim() === words)
      ?.click();
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe("a question the brain asked, in the inbox", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("answers a question the brain asked, in the person's own words", async () => {
    const { calls, said } = await shown(
      { role: "user", staff: false, name: "Sam Sales" },
      [asked],
      []
    );
    const box = document.querySelector("textarea");
    await act(async () => {
      if (box !== null) {
        box.value = "  The sales director.  ";
        box.dispatchEvent(new Event("input", { bubbles: true }));
      }
      await Promise.resolve();
    });
    await press("Answer");

    expect({ calls, said }).toStrictEqual({
      calls: [{ gap: "gap-7", answer: "The sales director." }],
      said: ["Answered: Who signs off a quote over 10,000 euros?"],
    });
  });

  it("lets an admin ask a question nobody was asked of whoever holds its role", async () => {
    const { calls, said } = await shown(
      { role: "admin", staff: false, name: "Ada Admin" },
      [],
      [
        {
          id: "gap-9",
          question: "Who approves a refund?",
          owner: "Head of finance",
          sourceId: "src-1",
          about: [],
        },
      ]
    );
    await press("Ask the Head of finance");

    expect({ calls, said }).toStrictEqual({
      calls: [{ ask: "gap-9" }],
      said: ["Asked the Head of finance: Who approves a refund?"],
    });
  });
});
