// @vitest-environment happy-dom
import { decisionErrors } from "@grasp-os/shared/decisions";
import type { DecisionWithheld } from "@grasp-os/shared/decisions";
import type { WorkflowsToday } from "@grasp-os/shared/workflows";
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

import { TodayLanes } from "./today-lanes.tsx";

// A run of Today that waits on the reader, as they open it: what its
// decision asks and the answers it takes, as its decision's own page has
// them (GRA-1988). Withheld, it says so and offers Reject alone; not
// shown for now, it says so and takes no answer.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

/** What the decision asks while it is shown. */
const prompt = "Pay Globex the 50,000 it asked for?";

/** Today with one run that waits on the reader, its ask as `withheld` has it. */
const todayWith = (withheld?: DecisionWithheld): WorkflowsToday => {
  const now = new Date();
  const since = new Date(now.getTime() - 60_000).toISOString();
  return {
    from: new Date(now.getTime() - 3_600_000).toISOString(),
    now: now.toISOString(),
    timeZone: "Europe/Amsterdam",
    lanes: [
      {
        id: "wr-1",
        name: "invoices",
        runs: [
          {
            id: "run-1",
            startedAt: since,
            endedAt: null,
            status: "running",
            went: "people",
            waits: {
              decision: "decision-1",
              on: { kind: "you" },
              since,
              asks: withheld === undefined ? prompt : "Not shown.",
              ...(withheld === undefined ? {} : { withheld }),
            },
            waitsOnOthers: false,
            from: null,
          },
        ],
      },
    ],
    cutOff: 0,
    unseen: 0,
  };
};

/** Lets renders settle. */
const settle = async (): Promise<void> => {
  await act(async () => {
    for (let tick = 0; tick < 10; tick += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one tick after another
      await Promise.resolve();
    }
  });
};

/**
 * Shows Today as its page's loader reads it (`read`, called again when the
 * page reads it again), on a faked core whose `decisions` are `decisions`,
 * and opens its waiting run as the reader does.
 */
const opened = async (
  read: () => WorkflowsToday,
  decisions: Readonly<Record<string, unknown>> = {}
): Promise<void> => {
  const core = {
    withSession: async <T,>(
      action: (session: {
        decisions: typeof decisions;
        workflows: { today: () => Promise<WorkflowsToday> };
      }) => Promise<T>
    ): Promise<T> =>
      await action({
        decisions,
        workflows: { today: async () => await Promise.resolve(read()) },
      }),
  };
  const rootRoute = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    loader: () => read(),
    component: () => <TodayLanes today={page.useLoaderData()} />,
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
  await settle();
  const run = document.querySelector("button[aria-label]");
  if (!(run instanceof HTMLButtonElement)) {
    throw new TypeError("No run to open");
  }
  await act(async () => {
    run.click();
    await Promise.resolve();
  });
  await settle();
};

/** Presses the button whose text is `label`. */
const press = async (label: string): Promise<void> => {
  const button = [...document.querySelectorAll("button")].find(
    (each) => each.textContent.trim() === label
  );
  if (!button) {
    throw new TypeError(`No ${label} button`);
  }
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
  await settle();
};

/** Waits `ms`, letting renders settle. */
const waited = async (ms: number): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, ms);
    await promise;
  });
  await settle();
};

/** What the reader sees of the opened wait. */
const seen = () => {
  const text = document.body.textContent;
  return {
    prompt: text.includes(prompt),
    withheldNote: text.includes(
      "What this decision asks is withheld, so you can only reject it."
    ),
    uncheckedNote: text.includes(
      "What this decision asks can't be shown right now, so it can't be answered yet. Try again in a moment."
    ),
    answers: [...document.querySelectorAll("button")]
      .map((button) => button.textContent.trim())
      .filter((label) => label === "Approve" || label === "Reject"),
  };
};

describe("a run of Today that waits on the reader", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("asks what its decision asks, and takes either answer", async () => {
    await opened(() => todayWith());

    expect(seen()).toStrictEqual({
      prompt: true,
      withheldNote: false,
      uncheckedNote: false,
      answers: ["Reject", "Approve"],
    });
  });

  it("says what it asks is withheld and offers Reject alone", async () => {
    await opened(() => todayWith("revoked"));

    expect(seen()).toStrictEqual({
      prompt: false,
      withheldNote: true,
      uncheckedNote: false,
      answers: ["Reject"],
    });
  });

  it("says what it asks can't be shown right now and takes no answer", async () => {
    await opened(() => todayWith("unchecked"));

    expect(seen()).toStrictEqual({
      prompt: false,
      withheldNote: false,
      uncheckedNote: true,
      answers: [],
    });
  });

  // It waits out the confirmation's delay and the seconds to undo it.
  it(
    "reads Today again when a confirmed approval is refused, and shows what it asks withheld, Reject alone",
    { timeout: 15_000 },
    async () => {
      let today = todayWith();
      const view = {
        id: "decision-1",
        workflowResource: { id: "wr-1", name: "invoices" },
        workflow: "invoices",
        run: "run-1",
        description: prompt,
        status: "open",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        revision: "revision-asked",
      };
      await opened(() => today, {
        review: async (_id: string, response: { approved: boolean }) =>
          await Promise.resolve({ state: "review", decision: view, response }),
        confirm: async () => {
          // Withheld since Today was read.
          today = todayWith("revoked");
          await Promise.resolve();
          throw decisionErrors.create("decision.withheld");
        },
      });

      await press("Approve");
      // Past the confirmation's delay, then past the seconds to undo it.
      await waited(1100);
      await press("Confirm");
      for (let second = 0; second < 6; second += 1) {
        // oxlint-disable-next-line no-await-in-loop -- a second at a time, each one's render landing
        await waited(1000);
      }

      expect(seen()).toStrictEqual({
        prompt: false,
        withheldNote: true,
        uncheckedNote: false,
        answers: ["Reject"],
      });
    }
  );
});
