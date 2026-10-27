// @vitest-environment happy-dom
import type { ChatCitedDocument } from "@grasp-os/shared/chat";
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

import { AnswerSources, useCited } from "./sources.tsx";

// The documents an answer cites, under it, against core's chats as the
// page reaches them over RPC, faked: beside the answer's actions, "Based
// on N sources" opens what core says the answer cites, numbered in its
// order, each opening on its collection's page.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

/** The row under answer `messageId` of chat `chatId`, as the thread shows it. */
const Sources = ({
  chatId,
  messageId,
}: {
  chatId: string;
  messageId: number;
}) => (
  <AnswerSources cited={useCited({ chatId, messageId })}>
    <button type="button">Copy</button>
  </AnswerSources>
);

/** Lets the page's work after a core answer run. */
const settled = async (): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 0);
    await promise;
  });
};

/**
 * Answer `messageId` of chat `chatId`, which core says cites `cited`,
 * once `answered` settles (at once without it).
 */
const shown = async (
  chatId: string,
  messageId: number,
  cited: Record<string, ChatCitedDocument[]>,
  answered: Promise<unknown> = Promise.resolve()
) => {
  const asked: string[] = [];
  const chats = {
    cited: async (chat: string, message: number) => {
      asked.push(`${chat}/${message}`);
      await answered;
      return cited[`${chat}/${message}`] ?? [];
    },
  };
  const core = {
    withSession: async <T,>(
      action: (session: { chats: typeof chats }) => Promise<T>
    ): Promise<T> => await action({ chats }),
  };
  const rootRoute = createRootRoute({ component: Outlet });
  const answer = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <Sources chatId={chatId} messageId={messageId} />,
  });
  const collection = createRoute({
    getParentRoute: () => rootRoute,
    path: "/brain/collections/$collection",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([answer, collection]),
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
  await settled();
  return { router, asked };
};

/** The buttons under the answer, by their text. */
const buttons = (): string[] =>
  [...document.querySelectorAll("button")].map((button) => button.textContent);

const plan: ChatCitedDocument = {
  documentId: "plan",
  collectionId: "plans",
  title: "Route plan",
  path: "routes/plan.md",
  snippet: "Where the route goes, and when.",
  spans: [],
};

const leave: ChatCitedDocument = {
  documentId: "leave",
  collectionId: "handbook",
  title: "Parental leave",
  path: "leave.md",
  snippet: "Parental leave lasts sixteen weeks.",
  spans: [],
};

describe(AnswerSources, () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("says beside the actions how many documents the answer cites, and opens them numbered, each on its collection's page", async () => {
    const { router, asked } = await shown("chat", 7, {
      "chat/7": [plan, leave],
    });
    const closed = {
      buttons: buttons(),
      listed: document.querySelector("ol") !== null,
    };
    const trigger = [...document.querySelectorAll("button")].find((button) =>
      button.textContent.startsWith("Based on")
    );

    await act(async () => {
      trigger?.click();
      await Promise.resolve();
    });
    const listed = [...document.querySelectorAll("li")].map(
      (item) => item.textContent
    );
    const link = [...document.querySelectorAll("a")].find((each) =>
      each.textContent.includes("Parental leave")
    );
    await act(async () => {
      link?.click();
      await router.load();
    });

    expect({
      asked,
      closed,
      listed,
      at: router.state.location.pathname,
      search: { ...router.state.location.search },
    }).toStrictEqual({
      asked: ["chat/7"],
      closed: { buttons: ["Copy", "Based on 2 sources"], listed: false },
      listed: [
        "1Route planroutes/plan.mdWhere the route goes, and when.",
        "2Parental leaveleave.mdParental leave lasts sixteen weeks.",
      ],
      at: "/brain/collections/handbook",
      search: { doc: "leave" },
    });
  });

  it("keeps the focus on an action while core's answer adds the sources beside it", async () => {
    const answered = Promise.withResolvers<boolean>();
    await shown("chat", 9, { "chat/9": [plan] }, answered.promise);
    const copy = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Copy"
    );
    copy?.focus();
    const before = {
      buttons: buttons(),
      focused: document.activeElement === copy,
    };

    answered.resolve(true);
    await settled();

    expect({
      before,
      after: { buttons: buttons(), focused: document.activeElement === copy },
    }).toStrictEqual({
      before: { buttons: ["Copy"], focused: true },
      after: { buttons: ["Copy", "Based on 1 source"], focused: true },
    });
  });

  it("keeps only the actions for an answer core says cites nothing it may show", async () => {
    await shown("chat", 8, {});

    expect({
      buttons: buttons(),
      listed: document.querySelector("ol") !== null,
    }).toStrictEqual({ buttons: ["Copy"], listed: false });
  });
});
