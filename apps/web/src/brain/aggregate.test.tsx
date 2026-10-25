// @vitest-environment happy-dom
import type { Source, Statement } from "@grasp-os/shared/brain";
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
import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { StatementsByKind } from "./brain-article/statements-by-kind.tsx";

// What the Brain page says of what the interviews gave it (GRA-1084): a
// statement the onboarding gave is a team's claim five or more of its
// people made, and reads so, never as one person's words; one an admin
// added reads as it always did.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const interviews: Source = {
  id: "onb-src-ops",
  kind: "interview",
  title: "Interviews with Ops",
  date: "2026-10-20",
  how: "7 people",
};

const statement = (id: string, text: string): Statement => ({
  id,
  kind: "tool",
  text,
  sourceId: interviews.id,
  teamIds: ["team-ops"],
  toolIds: [],
});

/** `node` on a page with the brain's note route, as the app has it. */
const shown = async (node: ReactElement): Promise<void> => {
  const rootRoute = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => node,
  });
  const note = createRoute({
    getParentRoute: () => rootRoute,
    path: "/brain/$noteId",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([page, note]),
    history: createMemoryHistory(),
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
};

/** Each statement's line on the page, and what is said under it. */
const lines = () =>
  [...document.querySelectorAll<HTMLElement>("[data-statement]")].map(
    (line) => ({
      id: line.dataset.statement,
      basis: line.textContent?.includes("Said by five or more people") ?? false,
    })
  );

describe("what the Brain page says of the interviews", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("reads a team's claim as said by five or more people, and an admin's statement as it is", async () => {
    const claim = statement(
      "onb-st-0123456789abcdef0123456789abcdef",
      "Tickets come in through Zendesk."
    );
    const added = statement("st-zendesk", "Zendesk holds every ticket.");
    await shown(
      <StatementsByKind
        kern={{ interviewed: [], counts: [{ kind: "tool", count: 2 }] }}
        rows={[claim, added].map((each) => ({
          statement: each,
          place: { source: interviews, context: [], own: 0 },
        }))}
      />
    );
    expect(lines()).toStrictEqual([
      { id: claim.id, basis: true },
      { id: added.id, basis: false },
    ]);
  });
});
