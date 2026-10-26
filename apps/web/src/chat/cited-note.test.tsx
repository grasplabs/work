// @vitest-environment happy-dom
import { Toaster } from "@grasp-os/ui/components/toast";
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

import { MessageResponse } from "./message.tsx";

// An answer's links to notes, against core's Knowledge as the page reaches
// it over RPC, faked: a note the answer cites opens on its collection's
// page, looked up as the reader when followed; one it doesn't cite, or one
// the reader can't read, opens nothing.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

/** A refusal as core sends one: a code the page reads. */
const notFound = (): Error =>
  Object.assign(new Error("There's no such document."), {
    code: "knowledge.not_found",
  });

/** The answer `text`, citing `cited`, on a page whose reader may read `readable`. */
const shown = async (
  text: string,
  cited: string[],
  readable: Record<string, string>
) => {
  const looked: string[] = [];
  const knowledge = {
    getDocument: async (documentId: string) => {
      looked.push(documentId);
      await Promise.resolve();
      const collectionId = readable[documentId];
      if (collectionId === undefined) {
        throw notFound();
      }
      return { id: documentId, collectionId };
    },
  };
  const core = {
    withSession: async <T,>(
      action: (session: { knowledge: typeof knowledge }) => Promise<T>
    ): Promise<T> => await action({ knowledge }),
  };
  const rootRoute = createRootRoute({ component: Outlet });
  const answer = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <MessageResponse cited={cited} text={text} />,
  });
  const collection = createRoute({
    getParentRoute: () => rootRoute,
    path: "/knowledge/$collection",
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
        <Toaster>
          <RouterProvider router={router} />
        </Toaster>
      </I18nProvider>
    );
    await router.load();
  });
  return { router, looked };
};

/** Lets every pending promise and render settle. */
const settled = async (): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 0);
    await promise;
  });
};

/** Follows the link labelled `label`. */
const follow = async (label: string): Promise<void> => {
  const link = [...document.querySelectorAll("button, a")].find(
    (each) => each.textContent === label
  );
  if (!(link instanceof HTMLElement)) {
    throw new TypeError(`No link ${label}`);
  }
  await act(async () => {
    link.click();
    await Promise.resolve();
  });
  await settled();
};

/** What each label of the answer is: a link to follow, or text. */
const kinds = (...labels: string[]) =>
  Object.fromEntries(
    labels.map((label) => {
      const element = [...document.querySelectorAll("button, a, span")].find(
        (each) => each.textContent === label
      );
      return [label, element?.tagName.toLowerCase() ?? "none"];
    })
  );

describe(MessageResponse, () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("opens a note the answer cites on its collection's page, looked up only once it is followed", async () => {
    const { router, looked } = await shown(
      "See [Leave](grasp:note/leave), [Travel](grasp:note/travel) and [Docs](https://example.com).",
      ["leave"],
      { leave: "handbook", travel: "handbook" }
    );
    const before = {
      kinds: kinds("Leave", "Travel", "Docs"),
      looked: [...looked],
    };

    await follow("Leave");

    expect({
      before,
      at: router.state.location.pathname,
      search: { ...router.state.location.search },
      looked,
    }).toStrictEqual({
      before: {
        // A link out of Grasp is a button too, which asks before it opens
        // (answer-markdown.test.tsx).
        kinds: { Leave: "button", Travel: "span", Docs: "button" },
        looked: [],
      },
      at: "/knowledge/handbook",
      search: { doc: "leave" },
      looked: ["leave"],
    });
  });

  it("stays where it is for a cited note its reader can't read, and says so", async () => {
    const { router, looked } = await shown(
      "See [Minutes](grasp:note/minutes).",
      ["minutes"],
      {}
    );

    await follow("Minutes");

    expect({
      at: router.state.location.pathname,
      looked,
      said: document.body.textContent.includes("This note can't be opened"),
    }).toStrictEqual({
      at: "/",
      looked: ["minutes"],
      said: true,
    });
  });
});
