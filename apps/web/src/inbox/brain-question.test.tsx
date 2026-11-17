// @vitest-environment happy-dom
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

describe("a question the brain asked, in the inbox", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("answers a question the brain asked, in the person's own words", async () => {
    const answered: { gap: string; answer: string }[] = [];
    const brain = {
      answerGap: async (gap: string, answer: string) => {
        await Promise.resolve();
        answered.push({ gap, answer });
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
        data: { page: { notifications: [asked], unread: 1, more: false } },
      },
      reconnect: { state: "ready", data: [] },
      requests: undefined,
      decisions: { state: "ready", data: [] },
      workflowGoLives: { state: "ready", data: [] },
      heldStarts: { state: "ready", data: [] },
      bindings: { state: "ready", data: [] },
    } satisfies Waiting;
    const [item] = inboxItems(
      waiting,
      { role: "user", staff: false, name: "Sam Sales" },
      "2026-11-17T12:00:00.000Z"
    );
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

    const box = document.querySelector("textarea");
    await act(async () => {
      if (box !== null) {
        box.value = "  The sales director.  ";
        box.dispatchEvent(new Event("input", { bubbles: true }));
      }
      await Promise.resolve();
    });
    await act(async () => {
      [...document.querySelectorAll("button")]
        .find((each) => each.textContent.trim() === "Answer")
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect({ answered, said }).toStrictEqual({
      answered: [{ gap: "gap-7", answer: "The sales director." }],
      said: ["Answered: Who signs off a quote over 10,000 euros?"],
    });
  });
});
