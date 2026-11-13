// @vitest-environment happy-dom
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

import type { OwnExport } from "./own-export-route.ts";
import { followEveryMs, OwnExportSection } from "./own-export.tsx";

// The person's own export on Brain › Sources (GRA-1839), against core's
// route faked as `fetch` answers it: each state as core shows it, a start
// followed by a read, while it is written read again until it is done, and
// the page's own rules: one start at a time, the button off while it runs,
// a failed start or read said and read again, and a reply that lands after
// the section left dropped.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const id = "8c1d2f5e-3b4a-4c6d-9e8f-0a1b2c3d4e5f";

const exported = (
  state: OwnExport["state"],
  files: string[] = []
): OwnExport => ({ id, state, versions: 3, files });

/** What the faked route holds and answers. */
interface Route {
  /** The export it shows; null for none. */
  shown: OwnExport | null;
  /** What a start makes it show, if it goes through. */
  started?: OwnExport;
  /** Refuses each start with this core error. */
  refuseStart?: { status: number; code: string; message: string };
  /** Holds each start until it settles. */
  holdStart?: Promise<unknown>;
  /** Fails each read, as a body core never sends. */
  failRead?: boolean;
  /** Every call, in order. */
  calls: string[];
}

/** Answers `fetch` as core's route would, from `route`. */
const serve = (route: Route) =>
  vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(
    async (_input, init) => {
      if (init?.method === "POST") {
        route.calls.push("start");
        await route.holdStart;
        if (route.refuseStart !== undefined) {
          const { status, code, message } = route.refuseStart;
          return Response.json(
            { code, message, details: { requestId: "req-1" } },
            { status }
          );
        }
        route.shown = route.started ?? exported("writing");
        return Response.json({ id });
      }
      route.calls.push("read");
      if (route.failRead === true) {
        return new Response("<html>proxy</html>", { status: 502 });
      }
      return Response.json({ export: route.shown });
    }
  );

/** Lets every pending read settle. */
const settle = async (): Promise<void> => {
  await act(async () => {
    for (let tick = 0; tick < 12; tick += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one tick after another
      await Promise.resolve();
    }
  });
};

/** Shows the section on a faked core, its route answering from `route`. */
const shown = async (route: Route): Promise<void> => {
  vi.stubGlobal("fetch", serve(route));
  const core = {
    withSession: async <T,>(action: (session: object) => Promise<T>) =>
      await action({}),
  };
  const rootRoute = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: OwnExportSection,
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
};

const text = (): string => document.body.textContent;

const buttonOf = (label: string): HTMLButtonElement => {
  const button = [...document.querySelectorAll("button")].find(
    (each) => each.textContent === label
  );
  if (!button) {
    throw new TypeError(`No button ${label}`);
  }
  return button;
};

const press = async (label: string): Promise<void> => {
  await act(async () => {
    buttonOf(label).click();
    await Promise.resolve();
  });
  await settle();
};

const alerts = (): string[] =>
  [...document.querySelectorAll("[role=alert]")].map(
    ({ textContent }) => textContent
  );

const links = (): [string, string | null, boolean][] =>
  [...document.querySelectorAll("a")].map((link) => [
    link.textContent,
    link.getAttribute("href"),
    link.hasAttribute("download"),
  ]);

describe("the person's own export", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("starts one, says it is being written, reads it again until it is done, and offers its files to download", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const route: Route = { shown: null, calls: [] };
    await shown(route);
    await press("Export");
    const writing = text();
    route.shown = exported("done", ["manifest.json", "part-0000.jsonl"]);
    await act(async () => {
      vi.advanceTimersByTime(followEveryMs);
      await Promise.resolve();
    });
    await settle();
    expect({
      writing: writing.includes("Grasp is writing your export."),
      ready: text().includes("Your export is ready."),
      links: links(),
      calls: route.calls,
      again: buttonOf("Export again").disabled,
    }).toStrictEqual({
      writing: true,
      ready: true,
      links: [
        [
          "manifest.json",
          `/api/brain/own-export?id=${id}&file=manifest.json`,
          true,
        ],
        [
          "part-0000.jsonl",
          `/api/brain/own-export?id=${id}&file=part-0000.jsonl`,
          true,
        ],
      ],
      calls: ["read", "start", "read", "read"],
      again: false,
    });
  });

  it("says an export of a store that holds nothing holds nothing", async () => {
    await shown({
      shown: exported("done", ["manifest.json"]),
      calls: [],
    });
    expect(text()).toContain(
      "The Brain keeps nothing that only you may read yet, so your export holds nothing."
    );
  });

  it("says an export something was erased from since is gone, and offers a new one", async () => {
    await shown({ shown: exported("erased"), calls: [] });
    expect({
      said: text().includes("Something your export held was erased since"),
      links: links(),
      again: buttonOf("Export again").disabled,
    }).toStrictEqual({ said: true, links: [], again: false });
  });

  it("says an export that couldn't be finished failed, and offers to try again", async () => {
    await shown({ shown: exported("failed"), calls: [] });
    expect({
      said: text().includes("Your export couldn’t be finished."),
      again: buttonOf("Export again").disabled,
    }).toStrictEqual({ said: true, again: false });
  });

  it("says why a start was refused, reads the export again, and lets the person try again", async () => {
    const route: Route = {
      shown: null,
      refuseStart: {
        status: 500,
        code: "internal.unexpected",
        message: "Something went wrong.",
      },
      calls: [],
    };
    await shown(route);
    await press("Export");
    expect({
      alerts: alerts(),
      calls: route.calls,
      off: buttonOf("Export").disabled,
    }).toStrictEqual({
      alerts: ["Something went wrong. Reference: req-1"],
      calls: ["read", "start", "read"],
      off: false,
    });
  });

  // A start whose answer was lost after core started it: the read since
  // shows it being written, so no failure is said.
  it("says no failure for a start the read since shows under way", async () => {
    const route: Route = {
      shown: null,
      refuseStart: {
        status: 503,
        code: "internal.unexpected",
        message: "Lost.",
      },
      calls: [],
    };
    await shown(route);
    route.shown = exported("writing");
    await press("Export");
    expect({
      alerts: alerts(),
      writing: text().includes("Grasp is writing your export."),
    }).toStrictEqual({ alerts: [], writing: true });
  });

  it("says a read that failed, and reads again when asked", async () => {
    const route: Route = { shown: null, failRead: true, calls: [] };
    await shown(route);
    const failed = alerts();
    route.failRead = false;
    await press("Try again");
    expect({
      failed,
      after: alerts(),
      start: buttonOf("Export").disabled,
      calls: route.calls,
    }).toStrictEqual({
      failed: ["Grasp can’t be reached just now."],
      after: [],
      start: false,
      calls: ["read", "read"],
    });
  });

  it("sends one start for two clicks in one tick, its button off while it runs", async () => {
    const held = Promise.withResolvers<boolean>();
    const route: Route = { shown: null, holdStart: held.promise, calls: [] };
    await shown(route);
    await act(async () => {
      buttonOf("Export").click();
      buttonOf("Export").click();
      await Promise.resolve();
    });
    await settle();
    const whileRunning = buttonOf("Export").disabled;
    await act(async () => {
      held.resolve(true);
      await Promise.resolve();
    });
    await settle();
    expect({
      whileRunning,
      starts: route.calls.filter((call) => call === "start").length,
      writing: text().includes("Grasp is writing your export."),
    }).toStrictEqual({ whileRunning: true, starts: 1, writing: true });
  });

  it("drops a start's reply that lands after the person left the section", async () => {
    const held = Promise.withResolvers<boolean>();
    const route: Route = { shown: null, holdStart: held.promise, calls: [] };
    await shown(route);
    await act(async () => {
      buttonOf("Export").click();
      await Promise.resolve();
    });
    await settle();
    // The person leaves: the section is gone before the reply lands.
    act(() => {
      root?.unmount();
    });
    root = undefined;
    await act(async () => {
      held.resolve(true);
      await Promise.resolve();
    });
    await settle();
    expect({ calls: route.calls, shown: text() }).toStrictEqual({
      calls: ["read", "start"],
      shown: "",
    });
  });
});
