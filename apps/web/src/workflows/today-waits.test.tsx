// @vitest-environment happy-dom
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

/** Shows `today`, and opens its waiting run as the reader does. */
const opened = async (today: WorkflowsToday): Promise<void> => {
  const core = {
    withSession: async <T,>(
      action: (session: Record<string, never>) => Promise<T>
    ): Promise<T> => await action({}),
  };
  const rootRoute = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <TodayLanes today={today} />,
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
    await opened(todayWith());

    expect(seen()).toStrictEqual({
      prompt: true,
      withheldNote: false,
      uncheckedNote: false,
      answers: ["Reject", "Approve"],
    });
  });

  it("says what it asks is withheld and offers Reject alone", async () => {
    await opened(todayWith("revoked"));

    expect(seen()).toStrictEqual({
      prompt: false,
      withheldNote: true,
      uncheckedNote: false,
      answers: ["Reject"],
    });
  });

  it("says what it asks can't be shown right now and takes no answer", async () => {
    await opened(todayWith("unchecked"));

    expect(seen()).toStrictEqual({
      prompt: false,
      withheldNote: false,
      uncheckedNote: true,
      answers: [],
    });
  });
});
