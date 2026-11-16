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

import { timeoutMs } from "../core.ts";
import type { OwnExport } from "./own-export-route.ts";
import { followEveryMs, OwnExportSection } from "./own-export.tsx";

// The person's own export on Brain › Sources (GRA-1839), against core's
// route faked as `fetch` answers it: each state as core shows it; a start
// followed by a read, its button off until that read is back; while the
// export may be being written, the next read due only once the last
// landed, read when the page is seen, never over one under way; a start's
// failure said only while the read that followed it is on screen, and
// once; no timer left behind; and the person's focus kept when the button
// they pressed goes. Each step waits for what it is waiting for
// (`until`), never a count of ticks.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const id = "8c1d2f5e-3b4a-4c6d-9e8f-0a1b2c3d4e5f";

const exported = (
  state: OwnExport["state"],
  files: string[] = []
): OwnExport => ({ id, state, versions: 3, files });

const twoFiles = ["manifest.json", "part-0000.jsonl"];

const readySaid = "Your export is ready. Download each of its files:";

const writingSaid = "Grasp is writing your export.";

const unreachable = "Grasp can't be reached right now. Try again in a moment.";

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
  /** Makes each start, then loses its answer, as a network that fails. */
  loseStart?: boolean;
  /** Holds each start until it settles. */
  holdStart?: Promise<unknown>;
  /** Holds each read until it settles. */
  holdRead?: Promise<unknown>;
  /** Fails each read, as a body core never sends. */
  failRead?: boolean;
  /** Refuses each read with this core error. */
  refuseRead?: { status: number; code: string; message: string };
  /** Every call, in order. */
  calls: string[];
  /** Whether each read was sent with a signal to end it. */
  signals: boolean[];
  /** Each read's signal, in order: whether it was ended. */
  seen: AbortSignal[];
}

const route = (shown: OwnExport | null, more: Partial<Route> = {}): Route => ({
  shown,
  calls: [],
  signals: [],
  seen: [],
  ...more,
});

/** Answers `fetch` as core's route would, from `faked`. */
const serve = (faked: Route) =>
  vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(
    async (_input, init) => {
      if (init?.method === "POST") {
        faked.calls.push("start");
        await faked.holdStart;
        const made =
          faked.refuseStart === undefined || faked.startedAnyway === true;
        if (made) {
          faked.shown = faked.started ?? exported("writing");
        }
        if (faked.loseStart === true) {
          throw new TypeError("Failed to fetch");
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
      if (init?.signal instanceof AbortSignal) {
        faked.seen.push(init.signal);
      }
      await faked.holdRead;
      if (faked.failRead === true) {
        return new Response("<html>proxy</html>", { status: 502 });
      }
      if (faked.refuseRead !== undefined) {
        const { status, code, message } = faked.refuseRead;
        return Response.json(
          { code, message, details: { requestId: "req-2" } },
          { status }
        );
      }
      return Response.json({ export: faked.shown });
    }
  );

/**
 * Waits until `ready` says so, React's updates flushed at each look: what
 * a step waits for. Fails with `what` when it doesn't come.
 */
const until = async (ready: () => boolean, what: string): Promise<void> => {
  await vi.waitFor(
    async () => {
      await act(async () => {
        await Promise.resolve();
      });
      if (!ready()) {
        throw new Error(`Still waiting for ${what}`);
      }
    },
    { timeout: 2000, interval: 5 }
  );
};

/** Moves the faked timers on by `ms`, then waits for `ready`. */
const later = async (
  ms: number,
  ready: () => boolean,
  what: string
): Promise<void> => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
  });
  await until(ready, what);
};

const said = (): string => document.querySelector("output")?.textContent ?? "";

const buttonNamed = (label: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find(
    (each) => each.textContent === label
  );

const buttonOf = (label: string): HTMLButtonElement => {
  const button = buttonNamed(label);
  if (!button) {
    throw new TypeError(`No button ${label}`);
  }
  return button;
};

const alerts = (): string[] =>
  [...document.querySelectorAll("[role=alert]")]
    .map(({ textContent }) => textContent)
    .filter((text) => text !== "");

const links = (): [string, string | null, boolean][] =>
  [...document.querySelectorAll("a")].map((link) => [
    link.textContent,
    link.getAttribute("href"),
    link.hasAttribute("download"),
  ]);

/** Shows the section on a faked core, its route answering from `faked`; waits for `ready`. */
const shown = async (
  faked: Route,
  ready: () => boolean,
  what: string
): Promise<void> => {
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
  await until(ready, what);
};

/** Presses the button `label`, its focus on it as a person's, and waits for `ready`. */
const press = async (
  label: string,
  ready: () => boolean,
  what: string
): Promise<void> => {
  await act(async () => {
    buttonOf(label).focus();
    buttonOf(label).click();
    await Promise.resolve();
  });
  await until(ready, what);
};

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
};

/** Moves the faked timers on by `ms`. */
const advance = async (ms: number): Promise<void> => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
  });
};

/** Presses Try again, as a person does. */
const clickTryAgain = (): void => {
  buttonOf("Try again").click();
};

/** The section gone, as the person leaving it. */
const leave = (): void => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
};

describe("the person's own export", () => {
  afterEach(() => {
    leave();
    document.body.replaceChildren();
    Reflect.deleteProperty(document, "visibilityState");
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("starts one, says it is being written, reads it again until it is done, says so, offers its files, and leaves no timer once it stops following", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const faked = route(null);
    await shown(faked, () => buttonNamed("Export") !== undefined, "Export");
    await press("Export", () => said().includes(writingSaid), "writing");
    const focused = document.activeElement?.tagName;
    faked.shown = exported("done", twoFiles);
    await later(followEveryMs, () => said() === readySaid, "done");
    // Its reads' deadlines run out; nothing else is left to fire.
    await later(timeoutMs, () => true, "the deadlines");
    expect({
      focused,
      links: links(),
      calls: faked.calls,
      signals: faked.signals.every(Boolean),
      again: buttonOf("Export again").disabled,
      timers: vi.getTimerCount(),
    }).toStrictEqual({
      focused: "H2",
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
      timers: 0,
    });
  });

  it("leaves no timer once the person left the section while it followed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const faked = route(exported("writing"));
    await shown(faked, () => said().includes(writingSaid), "writing");
    leave();
    await act(async () => {
      vi.advanceTimersByTime(timeoutMs);
      await Promise.resolve();
    });
    expect({
      timers: vi.getTimerCount(),
      calls: faked.calls,
    }).toStrictEqual({ timers: 0, calls: ["read"] });
  });

  it("says an export of a store that holds nothing holds nothing", async () => {
    await shown(
      route(exported("done", ["manifest.json"])),
      () => said().includes("keeps nothing"),
      "nothing"
    );
    expect({
      said: said(),
      links: links().map(([name]) => name),
    }).toStrictEqual({
      said: "The Brain keeps nothing that only you may read yet, so your export holds nothing.",
      links: ["manifest.json"],
    });
  });

  it("says an export something was erased from since is gone, and offers a new one", async () => {
    await shown(
      route(exported("erased")),
      () => said().includes("erased since"),
      "erased"
    );
    expect({
      links: links(),
      again: buttonOf("Export again").disabled,
    }).toStrictEqual({ links: [], again: false });
  });

  it("says an export that couldn't be finished failed, and offers to try again", async () => {
    await shown(
      route(exported("failed")),
      () => said().includes("couldn’t be finished"),
      "failed"
    );
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
    await shown(faked, () => buttonNamed("Export") !== undefined, "Export");
    await press(
      "Export",
      () => alerts().length > 0 && !buttonOf("Export").disabled,
      "the refusal"
    );
    expect({ alerts: alerts(), calls: faked.calls }).toStrictEqual({
      alerts: ["Something went wrong. Reference: req-1"],
      calls: ["read", "start", "read"],
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
    await shown(faked, () => buttonNamed("Export") !== undefined, "Export");
    await press("Export", () => said().includes(writingSaid), "writing");
    const whileWriting = alerts();
    faked.shown = exported("done", twoFiles);
    await later(followEveryMs, () => said() === readySaid, "done");
    expect({ whileWriting, alerts: alerts() }).toStrictEqual({
      whileWriting: [],
      alerts: [],
    });
  });

  // A start whose answer was lost on the way (the network failed), and
  // whose following read failed too: said once, and followed, as core may
  // have taken it.
  it("says once that core can't be reached for a start whose answer was lost, and follows it until a read reaches core", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const faked = route(null, { loseStart: true });
    await shown(faked, () => buttonNamed("Export") !== undefined, "Export");
    faked.failRead = true;
    await press(
      "Export",
      () => alerts().length > 0 && faked.calls.length === 3,
      "the failed read"
    );
    const failed = alerts();
    faked.failRead = false;
    await later(followEveryMs, () => said().includes(writingSaid), "writing");
    expect({ failed, calls: faked.calls, alerts: alerts() }).toStrictEqual({
      failed: [unreachable],
      calls: ["read", "start", "read", "read"],
      alerts: [],
    });
  });

  it("keeps the button off until the read after its start is back, and sends one start for two clicks in one tick", async () => {
    const started = Promise.withResolvers<boolean>();
    const read = Promise.withResolvers<boolean>();
    const faked = route(exported("done", twoFiles), {
      holdStart: started.promise,
      started: exported("done", [...twoFiles, "part-0001.jsonl"]),
    });
    await shown(faked, () => said() === readySaid, "done");
    await act(async () => {
      buttonOf("Export again").click();
      buttonOf("Export again").click();
      await Promise.resolve();
    });
    await until(() => faked.calls.includes("start"), "the start");
    const whileStarting = buttonOf("Export again").disabled;
    faked.holdRead = read.promise;
    await act(async () => {
      started.resolve(true);
      await Promise.resolve();
    });
    await until(() => faked.calls.length === 3, "the read after it");
    const whileReading = buttonOf("Export again").disabled;
    await act(async () => {
      read.resolve(true);
      await Promise.resolve();
    });
    await until(() => !buttonOf("Export again").disabled, "the button back");
    expect({
      whileStarting,
      whileReading,
      calls: faked.calls,
    }).toStrictEqual({
      whileStarting: true,
      whileReading: true,
      calls: ["read", "start", "read"],
    });
  });

  // A read slower than the follow-up's pace: none starts over it, and it
  // lands.
  it("reads again only once the last read landed, however long it takes within its deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const faked = route(exported("writing"));
    await shown(faked, () => said().includes(writingSaid), "writing");
    const slow = Promise.withResolvers<boolean>();
    faked.holdRead = slow.promise;
    await later(followEveryMs, () => faked.calls.length === 2, "a read");
    // Most of a read's deadline on (each look of `until` moves the faked
    // clock a little too): still the one read.
    await later(followEveryMs - 500, () => true, "time");
    const meanwhile = faked.calls.length;
    faked.shown = exported("done", twoFiles);
    faked.holdRead = undefined;
    await act(async () => {
      slow.resolve(true);
      await Promise.resolve();
    });
    await until(() => said() === readySaid, "done");
    expect({ meanwhile, calls: faked.calls.length }).toStrictEqual({
      meanwhile: 2,
      calls: 2,
    });
  });

  // Showing the page again while a read is under way starts no other.
  it("reads nothing more when the page is seen again while a read is under way", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const faked = route(exported("writing"));
    await shown(faked, () => said().includes(writingSaid), "writing");
    const held = Promise.withResolvers<boolean>();
    faked.holdRead = held.promise;
    await later(followEveryMs, () => faked.calls.length === 2, "a read");
    await visibility("hidden");
    await visibility("visible");
    const whileUnderWay = faked.calls.length;
    faked.shown = exported("done", twoFiles);
    faked.holdRead = undefined;
    await act(async () => {
      held.resolve(true);
      await Promise.resolve();
    });
    await until(() => said() === readySaid, "done");
    expect({ whileUnderWay, calls: faked.calls.length }).toStrictEqual({
      whileUnderWay: 2,
      calls: 2,
    });
  });

  // Hidden and seen again before the next read is due: nothing now, one
  // read when it is due.
  it("reads nothing when the page is seen again before a read is due, and once when it is", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const faked = route(exported("writing"));
    await shown(faked, () => said().includes(writingSaid), "writing");
    await later(1000, () => true, "time");
    await visibility("hidden");
    await visibility("visible");
    const seenAgain = faked.calls.length;
    await later(followEveryMs - 1000, () => faked.calls.length === 2, "due");
    expect({ seenAgain, calls: faked.calls.length }).toStrictEqual({
      seenAgain: 1,
      calls: 2,
    });
  });

  // One that never answers fails at its deadline, as every read does: the
  // page says core can't be reached, and goes on following, one read at a
  // time.
  it("goes on following, one read at a time, after a read that never answered", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const faked = route(exported("writing"));
    await shown(faked, () => said().includes(writingSaid), "writing");
    faked.holdRead = Promise.withResolvers<boolean>().promise;
    await later(followEveryMs, () => faked.calls.length === 2, "a read");
    await later(timeoutMs, () => alerts().length === 1, "its deadline");
    const failed = alerts();
    const askedThen = faked.calls.length;
    faked.holdRead = undefined;
    faked.shown = exported("done", twoFiles);
    await later(followEveryMs, () => said() === readySaid, "done");
    expect({
      failed,
      askedThen,
      asked: faked.calls.length,
    }).toStrictEqual({ failed: [unreachable], askedThen: 2, asked: 3 });
  });

  it("reads nothing while the page is hidden, and once when it is seen again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const faked = route(exported("writing"));
    await shown(faked, () => said().includes(writingSaid), "writing");
    await visibility("hidden");
    await later(followEveryMs * 4, () => true, "time");
    const whileHidden = faked.calls.length;
    faked.shown = exported("done", twoFiles);
    await visibility("visible");
    await until(() => said() === readySaid, "done");
    expect({ whileHidden, after: faked.calls.length }).toStrictEqual({
      whileHidden: 1,
      after: 2,
    });
  });

  it("says a read that failed, and reads again when asked", async () => {
    const faked = route(null, { failRead: true });
    await shown(faked, () => alerts().length === 1, "the failure");
    const failed = alerts();
    faked.failRead = false;
    await press(
      "Try again",
      () => alerts().length === 0 && buttonNamed("Export") !== undefined,
      "Export"
    );
    expect({ failed, calls: faked.calls }).toStrictEqual({
      failed: [unreachable],
      calls: ["read", "read"],
    });
  });

  it("says core can't be reached, in our own words, once, when the network fails a start and its read", async () => {
    await shown(
      route(null),
      () => buttonNamed("Export") !== undefined,
      "Export"
    );
    vi.stubGlobal(
      "fetch",
      vi.fn<() => Promise<Response>>(async () => {
        await Promise.resolve();
        throw new TypeError("Failed to fetch");
      })
    );
    await press("Export", () => alerts().length > 0, "the failure");
    expect(alerts()).toStrictEqual([unreachable]);
  });

  it("drops a start's reply that lands after the person left the section", async () => {
    const held = Promise.withResolvers<boolean>();
    const faked = route(null, { holdStart: held.promise });
    await shown(faked, () => buttonNamed("Export") !== undefined, "Export");
    await act(async () => {
      buttonOf("Export").click();
      await Promise.resolve();
    });
    await until(() => faked.calls.includes("start"), "the start");
    leave();
    await act(async () => {
      held.resolve(true);
      await Promise.resolve();
    });
    expect({
      calls: faked.calls,
      shown: document.body.textContent,
    }).toStrictEqual({ calls: ["read", "start"], shown: "" });
  });

  it("leaves the person's focus where they moved it while a start ran", async () => {
    const held = Promise.withResolvers<boolean>();
    const faked = route(null, { holdStart: held.promise });
    await shown(faked, () => buttonNamed("Export") !== undefined, "Export");
    const elsewhere = document.createElement("input");
    document.body.append(elsewhere);
    await act(async () => {
      buttonOf("Export").focus();
      buttonOf("Export").click();
      await Promise.resolve();
    });
    await until(() => faked.calls.includes("start"), "the start");
    act(() => {
      elsewhere.focus();
    });
    await act(async () => {
      held.resolve(true);
      await Promise.resolve();
    });
    await until(() => said().includes(writingSaid), "writing");
    expect(document.activeElement === elsewhere).toBeTruthy();
  });

  // Core took the start, and the read after it failed to reach core: the
  // page follows on its own until a read lands.
  it("follows a start core took though the read after it failed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const faked = route(null);
    await shown(faked, () => buttonNamed("Export") !== undefined, "Export");
    faked.started = exported("writing");
    faked.failRead = true;
    await press(
      "Export",
      () => alerts().length === 1 && faked.calls.length === 3,
      "the failed read"
    );
    const failed = alerts();
    faked.failRead = false;
    faked.shown = exported("done", twoFiles);
    await later(followEveryMs, () => said() === readySaid, "done");
    expect({ failed, calls: faked.calls, alerts: alerts() }).toStrictEqual({
      failed: [unreachable],
      calls: ["read", "start", "read", "read"],
      alerts: [],
    });
  });

  // A refusal from core (signed out in another tab, say) stops the
  // following, and is said.
  it("stops following once core refuses a read, and says why", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const faked = route(exported("writing"));
    await shown(faked, () => said().includes(writingSaid), "writing");
    faked.refuseRead = {
      status: 401,
      code: "auth.unauthenticated",
      message: "Sign in to continue.",
    };
    await later(followEveryMs, () => alerts().length === 1, "the refusal");
    const refused = alerts();
    await later(followEveryMs * 4, () => true, "time");
    expect({ refused, asked: faked.calls.length }).toStrictEqual({
      refused: ["Sign in to continue. Reference: req-2"],
      asked: 2,
    });
  });

  it("doesn't read again when the page is seen again and nothing is being written", async () => {
    const faked = route(exported("done", twoFiles));
    await shown(faked, () => said() === readySaid, "done");
    await visibility("hidden");
    await visibility("visible");
    await until(() => true, "a flush");
    expect(faked.calls).toStrictEqual(["read"]);
  });

  // Each pair of triggers that can ask for a read while another is under
  // way: the export being written and the last read failed (so Try again
  // shows and the follow-up runs), read A is held in flight and B arrives:
  // A is never ended, no other read starts while it is, at most one
  // follows it, and what is shown is the latest read's answer. With the
  // page hidden when A lands, a read the page asked for on its own waits
  // until it is seen; one a person asked for goes at once. (The read after
  // a start can't overlap these: its button shows only when nothing is
  // followed.)
  const tryAgainBeforeDue = {
    a: "Try again, just before the follow-up comes due",
    b: "the follow-up coming due",
    first: async () => {
      await advance(followEveryMs - 100);
      clickTryAgain();
    },
    arrives: async () => {
      await advance(100);
    },
  };
  const dueBeforeTryAgain = {
    a: "the follow-up coming due",
    b: "Try again",
    first: async () => {
      await advance(followEveryMs);
    },
    arrives: async () => {
      await Promise.resolve();
      clickTryAgain();
    },
  };

  it.each([
    { ...tryAgainBeforeDue, hidden: false, readsWhileHidden: 0 },
    { ...tryAgainBeforeDue, hidden: true, readsWhileHidden: 0 },
    { ...dueBeforeTryAgain, hidden: false, readsWhileHidden: 0 },
    { ...dueBeforeTryAgain, hidden: true, readsWhileHidden: 1 },
    {
      a: "Try again",
      b: "the page seen again, a read due meanwhile",
      first: async () => {
        await visibility("hidden");
        clickTryAgain();
        await advance(followEveryMs);
      },
      arrives: async () => {
        await visibility("visible");
      },
      hidden: false,
      readsWhileHidden: 0,
    },
    {
      a: "the follow-up coming due",
      b: "the page seen again",
      first: async () => {
        await advance(followEveryMs);
      },
      arrives: async () => {
        await visibility("hidden");
        await visibility("visible");
      },
      hidden: false,
      readsWhileHidden: 0,
    },
  ])(
    "ends no read in flight, $a, when $b arrives, and reads once after it at most (hidden when it lands: $hidden)",
    async ({ first, arrives, hidden, readsWhileHidden }) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const faked = route(exported("writing"));
      await shown(faked, () => said().includes(writingSaid), "writing");
      faked.failRead = true;
      await later(
        followEveryMs,
        () => buttonNamed("Try again") !== undefined,
        "a failed read"
      );
      faked.failRead = false;
      const base = faked.calls.length;
      const held = Promise.withResolvers<boolean>();
      faked.holdRead = held.promise;
      await act(first);
      await until(() => faked.calls.length === base + 1, "read A");
      await act(arrives);
      await until(() => true, "B served or kept");
      const whileA = faked.calls.length;
      // While A is in flight: once it landed, the next read's start ends
      // its signal, which then ends nothing.
      const endedA = faked.seen[base]?.aborted;
      if (hidden) {
        await visibility("hidden");
      }
      faked.shown = exported("done", twoFiles);
      faked.holdRead = undefined;
      await act(async () => {
        held.resolve(true);
        await Promise.resolve();
      });
      await until(() => said() === readySaid, "the latest answer");
      await until(() => true, "a read after A, if any");
      const hiddenReads = hidden ? faked.calls.length - whileA : 0;
      await visibility("visible");
      await until(() => true, "a read due once the page is seen, if any");
      const after = faked.calls.length - base;
      expect({
        whileA: whileA - base,
        endedA,
        hiddenReads,
        atMostOneAfter: after === 1 || after === 2,
        shown: said(),
      }).toStrictEqual({
        whileA: 1,
        endedA: false,
        hiddenReads: readsWhileHidden,
        atMostOneAfter: true,
        shown: readySaid,
      });
    }
  );
});
