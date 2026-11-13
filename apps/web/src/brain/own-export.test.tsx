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
// route faked as `fetch` answers it: each state as core shows it; a start
// followed by a read, its button off until that read is back; while the
// export is written, the next read only once the last landed, never while
// the page is hidden, and once when it is seen again; a start's failure
// said only while the read that followed it is on screen; and the person's
// focus kept when the button they pressed goes.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const id = "8c1d2f5e-3b4a-4c6d-9e8f-0a1b2c3d4e5f";

const exported = (
  state: OwnExport["state"],
  files: string[] = []
): OwnExport => ({ id, state, versions: 3, files });

const twoFiles = ["manifest.json", "part-0000.jsonl"];

const ready = "Your export is ready. Download each of its files:";

/** What the faked route holds and answers. */
interface Route {
  /** The export it shows; null for none. */
  shown: OwnExport | null;
  /** What a start makes it show, if it goes through. */
  started?: OwnExport;
  /** Refuses each start with this core error. */
  refuseStart?: { status: number; code: string; message: string };
  /** Whether a refused start was made all the same (its answer lost). */
  startedAnyway?: boolean;
  /** Holds each start until it settles. */
  holdStart?: Promise<unknown>;
  /** Holds each read until it settles. */
  holdRead?: Promise<unknown>;
  /** Fails each read, as a body core never sends. */
  failRead?: boolean;
  /** Every call, in order. */
  calls: string[];
  /** Whether each read was sent with a signal to end it. */
  signals: boolean[];
}

const route = (shown: OwnExport | null, more: Partial<Route> = {}): Route => ({
  shown,
  calls: [],
  signals: [],
  ...more,
});

/** Answers `fetch` as core's route would, from `faked`. */
const serve = (faked: Route) =>
  vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(
    async (_input, init) => {
      if (init?.method === "POST") {
        faked.calls.push("start");
        await faked.holdStart;
        if (faked.refuseStart === undefined || faked.startedAnyway === true) {
          faked.shown = faked.started ?? exported("writing");
        }
        if (faked.refuseStart !== undefined) {
          const { status, code, message } = faked.refuseStart;
          return Response.json(
            { code, message, details: { requestId: "req-1" } },
            { status }
          );
        }
        return Response.json({ id });
      }
      faked.calls.push("read");
      faked.signals.push(init?.signal instanceof AbortSignal);
      await faked.holdRead;
      if (faked.failRead === true) {
        return new Response("<html>proxy</html>", { status: 502 });
      }
      return Response.json({ export: faked.shown });
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

/** Moves the faked timers on by `ms`, and lets what they started settle. */
const later = async (ms: number): Promise<void> => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
  });
  await settle();
};

/** Shows the section on a faked core, its route answering from `faked`. */
const shown = async (faked: Route): Promise<void> => {
  vi.stubGlobal("fetch", serve(faked));
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

const said = (): string => document.querySelector("output")?.textContent ?? "";

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
    buttonOf(label).focus();
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

/** The page hidden, or seen again, as the browser says it. */
const visibility = async (state: "hidden" | "visible"): Promise<void> => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: state,
  });
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
  });
  await settle();
};

describe("the person's own export", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
    Reflect.deleteProperty(document, "visibilityState");
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("starts one, says it is being written, reads it again until it is done, says so, and offers its files to download", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const faked = route(null);
    await shown(faked);
    await press("Export");
    const writing = said();
    const focused = document.activeElement?.tagName;
    faked.shown = exported("done", twoFiles);
    await later(followEveryMs);
    expect({
      writing: writing.includes("Grasp is writing your export."),
      focused,
      done: said(),
      links: links(),
      calls: faked.calls,
      signals: faked.signals.every(Boolean),
      again: buttonOf("Export again").disabled,
    }).toStrictEqual({
      writing: true,
      focused: "OUTPUT",
      done: ready,
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
      signals: true,
      again: false,
    });
  });

  it("says an export of a store that holds nothing holds nothing", async () => {
    await shown(route(exported("done", ["manifest.json"])));
    expect({
      said: said(),
      links: links().map(([name]) => name),
    }).toStrictEqual({
      said: "The Brain keeps nothing that only you may read yet, so your export holds nothing.",
      links: ["manifest.json"],
    });
  });

  it("says an export something was erased from since is gone, and offers a new one", async () => {
    await shown(route(exported("erased")));
    expect({
      said: said().includes("Something your export held was erased since"),
      links: links(),
      again: buttonOf("Export again").disabled,
    }).toStrictEqual({ said: true, links: [], again: false });
  });

  it("says an export that couldn't be finished failed, and offers to try again", async () => {
    await shown(route(exported("failed")));
    expect({
      said: said(),
      again: buttonOf("Export again").disabled,
    }).toStrictEqual({
      said: "Your export couldn’t be finished. Try making it again.",
      again: false,
    });
  });

  it("says why a start was refused, reads the export again, and lets the person try again", async () => {
    const faked = route(null, {
      refuseStart: {
        status: 500,
        code: "internal.unexpected",
        message: "Something went wrong.",
      },
    });
    await shown(faked);
    await press("Export");
    expect({
      alerts: alerts(),
      calls: faked.calls,
      off: buttonOf("Export").disabled,
    }).toStrictEqual({
      alerts: ["Something went wrong. Reference: req-1"],
      calls: ["read", "start", "read"],
      off: false,
    });
  });

  // A start whose answer was lost after core started it: the read since
  // shows it being written, and its failure never comes back, also once
  // the export is done.
  it("never says a failure for a start the read since shows under way, through to its end", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const faked = route(null, {
      refuseStart: {
        status: 503,
        code: "internal.unexpected",
        message: "Lost.",
      },
      startedAnyway: true,
    });
    await shown(faked);
    await press("Export");
    const whileWriting = alerts();
    faked.shown = exported("done", twoFiles);
    await later(followEveryMs);
    expect({
      whileWriting,
      done: said(),
      alerts: alerts(),
    }).toStrictEqual({ whileWriting: [], done: ready, alerts: [] });
  });

  it("keeps the button off until the read after its start is back, and sends one start for two clicks in one tick", async () => {
    const started = Promise.withResolvers<boolean>();
    const read = Promise.withResolvers<boolean>();
    const faked = route(exported("done", twoFiles), {
      holdStart: started.promise,
      started: exported("done", [...twoFiles, "part-0001.jsonl"]),
    });
    await shown(faked);
    await act(async () => {
      buttonOf("Export again").click();
      buttonOf("Export again").click();
      await Promise.resolve();
    });
    await settle();
    const whileStarting = buttonOf("Export again").disabled;
    faked.holdRead = read.promise;
    await act(async () => {
      started.resolve(true);
      await Promise.resolve();
    });
    await settle();
    const whileReading = buttonOf("Export again").disabled;
    await act(async () => {
      read.resolve(true);
      await Promise.resolve();
    });
    await settle();
    expect({
      whileStarting,
      whileReading,
      after: buttonOf("Export again").disabled,
      calls: faked.calls,
    }).toStrictEqual({
      whileStarting: true,
      whileReading: true,
      after: false,
      calls: ["read", "start", "read"],
    });
  });

  // A read slower than the follow-up's pace: none starts over it, and it
  // lands.
  it("reads again only once the last read landed, however long it takes within its deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const faked = route(exported("writing"));
    await shown(faked);
    const slow = Promise.withResolvers<boolean>();
    faked.holdRead = slow.promise;
    await later(followEveryMs);
    const asked = faked.calls.length;
    await later(followEveryMs - 1);
    const meanwhile = faked.calls.length;
    faked.shown = exported("done", twoFiles);
    faked.holdRead = undefined;
    await act(async () => {
      slow.resolve(true);
      await Promise.resolve();
    });
    await settle();
    expect({ asked, meanwhile, done: said() }).toStrictEqual({
      asked: 2,
      meanwhile: 2,
      done: ready,
    });
  });

  // One that never answers fails at its deadline, as every read does: the
  // page says core can't be reached, and goes on following, one read at a
  // time.
  it("goes on following, one read at a time, after a read that never answered", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const faked = route(exported("writing"));
    await shown(faked);
    faked.holdRead = Promise.withResolvers<boolean>().promise;
    await later(followEveryMs);
    await later(followEveryMs);
    const failed = alerts();
    const askedThen = faked.calls.length;
    faked.holdRead = undefined;
    faked.shown = exported("done", twoFiles);
    await later(followEveryMs);
    expect({
      failed,
      askedThen,
      asked: faked.calls.length,
      done: said(),
    }).toStrictEqual({
      failed: ["Grasp can’t be reached just now."],
      askedThen: 2,
      asked: 3,
      done: ready,
    });
  });

  it("reads nothing while the page is hidden, and once when it is seen again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const faked = route(exported("writing"));
    await shown(faked);
    await visibility("hidden");
    await later(followEveryMs * 4);
    const whileHidden = faked.calls.length;
    faked.shown = exported("done", twoFiles);
    await visibility("visible");
    expect({
      whileHidden,
      after: faked.calls.length,
      done: said(),
    }).toStrictEqual({ whileHidden: 1, after: 2, done: ready });
  });

  it("says a read that failed, and reads again when asked", async () => {
    const faked = route(null, { failRead: true });
    await shown(faked);
    const failed = alerts();
    faked.failRead = false;
    await press("Try again");
    expect({
      failed,
      after: alerts(),
      start: buttonOf("Export").disabled,
      calls: faked.calls,
    }).toStrictEqual({
      failed: ["Grasp can’t be reached just now."],
      after: [],
      start: false,
      calls: ["read", "read"],
    });
  });

  it("says core can't be reached, in our own words, when the network fails a start", async () => {
    await shown(route(null));
    vi.stubGlobal(
      "fetch",
      vi.fn<() => Promise<Response>>(async () => {
        await Promise.resolve();
        throw new TypeError("Failed to fetch");
      })
    );
    await press("Export");
    expect(alerts()).toContain(
      "Grasp can't be reached right now. Try again in a moment."
    );
  });

  it("drops a start's reply that lands after the person left the section", async () => {
    const held = Promise.withResolvers<boolean>();
    const faked = route(null, { holdStart: held.promise });
    await shown(faked);
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
    expect({ calls: faked.calls, shown: text() }).toStrictEqual({
      calls: ["read", "start"],
      shown: "",
    });
  });
});
