// @vitest-environment happy-dom
import type { Opportunity } from "@grasp-os/shared/opportunities";
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

import { OpportunitiesPage } from "./opportunities-page.tsx";

// The admin's Opportunities page, against core's `opportunities` as the
// page reaches it over RPC, faked: each opportunity proposed as a
// workflow, an App or a skill is drafted through what a builder already
// has (Make something's chat, or Skills), and picking one only leads
// there, asking core nothing more.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

/** Lets every pending call settle. */
const settle = async (): Promise<void> => {
  await act(async () => {
    for (let tick = 0; tick < 12; tick += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one tick after another
      await Promise.resolve();
    }
  });
};

/** The routine `id` proposed as `form`, named `name`. */
const proposed = (
  id: number,
  name: string,
  form: Opportunity["form"],
  hoursPerWeek: number
): Opportunity => ({
  routine: `work-${id}`,
  evidence: `drawing-${id}`,
  name,
  team: "team-1",
  steps: ["Read it", "Do it"],
  casesPerWeek: 10,
  hoursPerWeek,
  basis: "described",
  seen: null,
  differs: null,
  form,
  covers: null,
  setup: [],
  personApproves: [],
  dismissed: false,
});

/** Shows the page on a faked core listing `listed`; the calls it gets. */
const shown = async (listed: Opportunity[]) => {
  const calls: string[] = [];
  const opportunities = {
    list: async () => {
      await Promise.resolve();
      calls.push("list");
      return listed;
    },
  };
  const core = {
    withSession: async <T,>(
      action: (session: { opportunities: typeof opportunities }) => Promise<T>
    ): Promise<T> => await action({ opportunities }),
  };
  const rootRoute = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: "/brain/opportunities",
    component: OpportunitiesPage,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([page]),
    history: createMemoryHistory({
      initialEntries: ["/brain/opportunities"],
    }),
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
  await settle();
  return { calls, router };
};

/** Each card's title, with where its Draft it leads; none when it has none. */
const drafts = (): Record<string, string | null> =>
  Object.fromEntries(
    [...document.querySelectorAll("li")].flatMap((card) => {
      const title = card.querySelector("h2")?.textContent;
      if (title === undefined || title === null) {
        return [];
      }
      const link = [...card.querySelectorAll("a")].find(
        (each) => each.textContent === "Draft it"
      );
      return [[title, link?.getAttribute("href") ?? null]];
    })
  );

describe("Opportunities", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("drafts a workflow or an App in Make something's chat and a skill on Skills, and nothing else", async () => {
    const { calls } = await shown([
      proposed(1, "closing the month", "workflow", 9),
      proposed(2, "tracking tenders", "app", 8),
      proposed(3, "answering how-to questions", "skill", 7),
      proposed(4, "filing receipts", "connection", 6),
      proposed(5, "waiting for a model", null, 5),
    ]);

    expect({ drafts: drafts(), calls }).toStrictEqual({
      drafts: {
        "Closing the month": "/?make=workflow&opportunity=work-1",
        "Tracking tenders": "/?make=app&opportunity=work-2",
        "Answering how-to questions": "/brain/skills?opportunity=work-3",
        "Filing receipts": null,
        "Waiting for a model": null,
      },
      // Read once; picking makes nothing and asks no model.
      calls: ["list"],
    });
  });

  it("offers no Draft it on an opportunity only seen in activity while nothing is proposed for it", async () => {
    await shown([
      {
        ...proposed(1, "exact invoices.read → sheets rows.add", null, 0),
        steps: [],
        casesPerWeek: null,
        hoursPerWeek: null,
        basis: "observed",
        seen: {
          steps: [
            {
              system: "exact",
              step: "invoices.read",
              hoursAfter: null,
              copied: false,
            },
            { system: "sheets", step: "rows.add", hoursAfter: 1, copied: true },
          ],
          variants: [],
        },
      },
    ]);

    expect(drafts()).toStrictEqual({
      "Exact invoices.read → sheets rows.add": null,
    });
  });

  it("names each Draft it for its opportunity, so a list of links tells them apart", async () => {
    await shown([
      proposed(1, "closing the month", "workflow", 9),
      proposed(2, "answering how-to questions", "skill", 7),
    ]);

    expect(
      [...document.querySelectorAll("a")]
        .filter((each) => each.textContent === "Draft it")
        .map((each) => each.getAttribute("aria-label"))
    ).toStrictEqual([
      "Draft it for “Closing the month”",
      "Draft it for “Answering how-to questions”",
    ]);
  });

  it("opens Make something's chat for the opportunity when Draft it is picked", async () => {
    const { calls, router } = await shown([
      proposed(1, "closing the month", "workflow", 9),
    ]);
    const link = [...document.querySelectorAll("a")].find(
      (each) => each.textContent === "Draft it"
    );

    await act(async () => {
      link?.click();
      await Promise.resolve();
    });
    await settle();

    expect({
      at: router.state.location.href,
      calls,
    }).toStrictEqual({
      at: "/?make=workflow&opportunity=work-1",
      calls: ["list"],
    });
  });
});
