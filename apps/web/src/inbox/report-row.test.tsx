// @vitest-environment happy-dom
import { resolveObjectURL } from "node:buffer";

import type { BoardReport } from "@grasp-os/shared/dashboard";
import type { Programme } from "@grasp-os/shared/onboarding";
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
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ReportItem } from "./report-row.tsx";

// The weekly report on the day it is ready, as the Inbox's item: pressed,
// it opens in the library's artifact viewer as one HTML file, named by the
// week it is on, that says what the report says and follows the colour
// scheme of whatever opens it. Core is faked as the page reaches it over RPC.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

// The Monday after week 6 closed: its report is ready today.
const programme: Programme = {
  start: "2026-10-05",
  weeks: 8,
  stage: "open",
  today: "2026-11-16",
  week: 7,
  inProgramme: true,
  nextReport: { inDays: 0, week: 6, through: 7 },
  reportWindow: { to: "2026-11-15", days: 7 },
};

const report: BoardReport = {
  programme: { state: "read", data: programme },
  runs: {
    state: "read",
    data: {
      from: "2026-11-09",
      to: "2026-11-15",
      days: [
        {
          day: "2026-11-09",
          completed: 3,
          failed: 1,
          waiting: 0,
          other: 0,
          withPerson: 1,
        },
      ],
      runs: { total: 4, withPerson: 1, withoutPerson: 3 },
      decisions: { approved: 1, rejected: 0, timedOut: 0, open: 0 },
      workflows: [],
    },
  },
  idleWorkflows: { state: "read", data: 0 },
  better: { state: "read", data: null },
};

/** The report as the route reads it: not awaited, ready at once. */
const ready = Promise.resolve({ state: "ready" as const, data: report });

/** The report's item on a page of its own, against a fake core. */
const shown = async (shownProgramme: Programme = programme) => {
  const core = {
    withSession: async <T,>(
      action: (session: {
        organization: { get: () => Promise<{ name: string }> };
      }) => Promise<T>
    ): Promise<T> =>
      await action({
        organization: {
          get: async () => {
            await Promise.resolve();
            return { name: "Acme" };
          },
        },
      }),
  };
  const rootRoute = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
  });
  const Shown = () => <ReportItem programme={shownProgramme} report={ready} />;
  page.update({ component: Shown });
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
};

/** The viewer's own download of the file it shows: a link to the file, saved under its name. */
const download = (): HTMLAnchorElement | null =>
  document.querySelector(
    "section[aria-label='weekly-report-week-06.html'] a[download]"
  );

describe("the weekly report in the inbox", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("opens in the artifact viewer as one HTML file, named by its week", async () => {
    await shown();
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          "button[aria-label='Your report on week 6 is ready']"
        )
        ?.click();
      await Promise.resolve();
    });
    // The page is read into its file over a few frames, then the viewer loads.
    await vi.waitFor(
      async () => {
        await act(async () => {
          await Promise.resolve();
        });
        expect(download()).not.toBeNull();
      },
      { timeout: 3000 }
    );

    const link = download();
    const file = await resolveObjectURL(link?.href ?? "")?.text();
    expect(link?.download).toBe("weekly-report-week-06.html");
    expect(file).toContain("<!doctype html>");
    expect(file).toContain("75% of this week's 4 runs needed nobody.");
    expect(file).toContain("<title>Acme week 7</title>");
    expect(file).toContain('<meta name="color-scheme" content="light dark">');
  });

  it("on a day the week has not closed, is the week so far, with when the report is ready", async () => {
    await shown({
      ...programme,
      nextReport: { inDays: 4, week: 7, through: 3 },
    });

    const row = document.querySelector<HTMLButtonElement>(
      "button[aria-label='Week 7 so far']"
    );
    expect(row?.textContent).toContain("Next report in 4 days");
  });
});
