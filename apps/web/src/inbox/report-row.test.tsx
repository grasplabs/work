// @vitest-environment happy-dom
import { resolveObjectURL } from "node:buffer";

import type { BoardReport } from "@grasp-os/shared/board-report";
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

import type { Loaded } from "../load-from-core.tsx";
import { ReportItem } from "./report-row.tsx";

// The weekly report on the day it is ready, as the Inbox's row: pressed,
// it opens in a sheet, and Download saves it as one HTML file, named by the
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
const shown = async (
  shownProgramme: Programme = programme,
  company = "Acme",
  read: Promise<Loaded<BoardReport>> = ready
) => {
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
            return { name: company };
          },
        },
      }),
  };
  const rootRoute = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
  });
  const Shown = () => <ReportItem programme={shownProgramme} report={read} />;
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

/** Lets what a press started settle. */
const settle = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

/** Presses the button whose words start with `words`. */
const press = async (words: string) => {
  await act(async () => {
    [...document.querySelectorAll("button")]
      .find((each) => each.textContent.trim().startsWith(words))
      ?.click();
    await Promise.resolve();
  });
  await settle();
};

describe("the weekly report in the inbox", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("opens in a sheet, and Download saves it as one HTML file, named by its week, the company's name in it as text", async () => {
    const saved: { name: string; href: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      function save(this: HTMLAnchorElement) {
        saved.push({ name: this.download, href: this.href });
      }
    );
    await shown(programme, "R&D <Labs>");
    await press("Your report on week 6 is ready");
    await vi.waitFor(
      async () => {
        await settle();
        expect(
          [...document.querySelectorAll("button")].some(
            (each) =>
              each.textContent.trim().startsWith("Download") && !each.disabled
          )
        ).toBeTruthy();
      },
      { timeout: 3000 }
    );
    await press("Download");
    await vi.waitFor(() => {
      expect(saved).toHaveLength(1);
    });

    const [file] = saved;
    const html = await resolveObjectURL(file?.href ?? "")?.text();
    expect(file?.name).toBe("weekly-report-week-06.html");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("75% of this week's 4 runs needed nobody.");
    expect(html).toContain("<title>R&amp;D &lt;Labs&gt; week 7</title>");
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
  });

  it("carries its fonts as data in the file it downloads, and prints with them from this origin, the only place the page's policy loads fonts from", async () => {
    const font = document.createElement("style");
    font.textContent = `@font-face{font-family:"Probe";src:url("/fonts/probe.woff2") format("woff2")} body{font-family:"Probe"}`;
    document.head.append(font);
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        await Promise.resolve(
          new Response(new Uint8Array([1, 2, 3]), {
            headers: { "content-type": "font/woff2" },
          })
        )
    );
    const saved: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      function save(this: HTMLAnchorElement) {
        saved.push(this.href);
      }
    );
    const printed: string[] = [];
    try {
      await shown();
      await press("Your report on week 6 is ready");
      await vi.waitFor(
        async () => {
          await settle();
          expect(
            [...document.querySelectorAll("button")].some(
              (each) =>
                each.textContent.trim().startsWith("Download") && !each.disabled
            )
          ).toBeTruthy();
        },
        { timeout: 3000 }
      );
      await press("Download");
      // The frame it prints from, caught on its way into the page.
      vi.spyOn(document.body, "append").mockImplementation((...nodes) => {
        for (const node of nodes) {
          if (node instanceof HTMLIFrameElement) {
            printed.push(node.srcdoc);
          }
        }
      });
      await press("Save as PDF");
      await vi.waitFor(() => {
        expect({ saved: saved.length, printed: printed.length }).toStrictEqual({
          saved: 1,
          printed: 1,
        });
      });
      const file = (await resolveObjectURL(saved[0] ?? "")?.text()) ?? "";
      const here = new URL("/fonts/probe.woff2", location.href).href;

      expect({
        file: file.includes('url("data:font/woff2;base64,AQID")'),
        printed: printed[0]?.includes(`url("${here}")`),
        printedData: printed[0]?.includes("data:font"),
      }).toStrictEqual({ file: true, printed: true, printedData: false });
    } finally {
      font.remove();
    }
  });

  it("dates the week's runs by their calendar days, wherever the reader is", async () => {
    const zone = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      await shown();
      await press("Your report on week 6 is ready");
      await settle();

      expect(document.querySelector("[role='dialog']")?.textContent).toContain(
        "Nov 9, 2026 to Nov 15, 2026"
      );
    } finally {
      if (zone === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = zone;
      }
    }
  });

  it("on a day the week has not closed, is the week so far, with when the report is ready", async () => {
    await shown({
      ...programme,
      nextReport: { inDays: 4, week: 7, through: 3 },
    });

    const row = [...document.querySelectorAll("button")].find((each) =>
      each.textContent.includes("Week 7 so far")
    );
    expect(row?.closest("[data-slot='item']")?.textContent).toContain(
      "Next report in 4 days"
    );
  });

  it("says in its place what core couldn't read, never as nothing that ran, and names what could be better in the reader's words", async () => {
    await shown(
      programme,
      "Acme",
      Promise.resolve({
        state: "ready",
        data: {
          ...report,
          runs: { state: "unread", code: "workflow.unavailable" },
          better: {
            state: "read",
            data: [
              { kind: "failing_step", count: 2 },
              { kind: "cost_per_run", count: 5 },
            ],
          },
        },
      })
    );
    await press("Your report on week 6 is ready");
    await settle();
    const sheet = document.querySelector("[role='dialog']")?.textContent ?? "";

    expect({
      unread: sheet.includes("This couldn't be read when the report was made."),
      noughts: sheet.includes("0 runs"),
      week: sheet.includes("Week 7 of 8"),
      kinds: ["Model cost", "Keeps failing", "failing step"].map((kind) =>
        sheet.includes(kind)
      ),
    }).toStrictEqual({
      unread: true,
      noughts: false,
      week: true,
      kinds: [true, true, false],
    });
  });

  it("says in the sheet why a report core couldn't read failed, never an empty sheet", async () => {
    await shown(programme, "Acme", Promise.resolve({ state: "offline" }));
    await press("Your report on week 6 is ready");
    await settle();

    expect(
      document.querySelector("[role='dialog'] [data-slot='alert']")?.textContent
    ).toContain("Grasp can't be reached right now.");
  });
});
