// @vitest-environment happy-dom
import type { InterviewProgress } from "@grasp-os/shared/interview-links";
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

import type { OpenSession } from "./api.ts";
import { holdInterview, releaseInterview } from "./kept.ts";
import { InterviewPage } from "./page.tsx";

// Deleting and withdrawing on the interview page (GRA-329, GRA-1790),
// against core's route faked as `fetch` answers it: each is done at once,
// and the page says exactly what is true then. While what the Brain kept
// of the interview is still being removed (core's answer says
// `removing`), it says so, never that nothing is kept or used.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

/** An interview they finished, having taken part. */
const finished: InterviewProgress = {
  person: "completed",
  told: true,
  mode: "type",
  lines: [
    { from: "stephen", text: "What starts one?" },
    { from: "person", text: "A ticket." },
  ],
  facts: [],
  phase: "result",
  wants: "end",
  startedAt: 1,
  confirmed: 0,
  adding: false,
  addedAt: 0,
};

const session: OpenSession = {
  state: "open",
  name: "Oli",
  team: "Ops",
  lead: null,
  kind: "own",
  closes: "2026-12-31",
  closed: false,
  progress: finished,
  version: 1,
  withdrawn: false,
  removing: false,
};

/**
 * Waits until `ready` says so, React's updates flushed at each look. Fails
 * with `what` when it doesn't come.
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

const buttonNamed = (label: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find(
    (each) => each.textContent === label
  );

const text = (): string => document.body.textContent ?? "";

/**
 * The page, on a faked core whose delete or withdrawal answers `removed`,
 * opened as `opened` says (the link's session, as core answered it).
 */
const shown = async (
  removed: object,
  opened: OpenSession = session
): Promise<void> => {
  vi.stubGlobal(
    "fetch",
    vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(
      async (_input, init) => {
        await Promise.resolve();
        const sent = typeof init?.body === "string" ? init.body : "{}";
        const body: unknown = JSON.parse(sent);
        const action =
          typeof body === "object" && body !== null && "action" in body
            ? body.action
            : null;
        return action === "withdraw" || action === "delete"
          ? Response.json(removed)
          : Response.json({ saved: true, version: 2 });
      }
    )
  );
  holdInterview({
    secret: "s".repeat(43),
    kind: "own",
    version: 1,
    progress: finished,
  });
  const rootRoute = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <InterviewPage session={opened} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([page]),
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
  await until(
    () => buttonNamed("Delete my interview") !== undefined,
    "the delete button"
  );
};

/** Opened again, as a reload does, after they withdrew: as core says now. */
const reopened = async (removing: boolean): Promise<void> => {
  await shown({}, { ...session, withdrawn: true, removing });
};

/** Holds the delete button for its four seconds, then presses `choice`. */
const choose = async (
  choice: "Delete it" | "Withdraw instead"
): Promise<void> => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  await act(async () => {
    buttonNamed("Delete my interview")?.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true })
    );
    await Promise.resolve();
  });
  await act(async () => {
    vi.advanceTimersByTime(4000);
    await Promise.resolve();
  });
  await until(() => buttonNamed(choice) !== undefined, choice);
  await act(async () => {
    buttonNamed(choice)?.click();
    await Promise.resolve();
  });
};

describe("deleting and withdrawing on the interview page", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    releaseInterview();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const removed = "What the Brain kept of it is being removed.";
  const withdrawn = {
    withdrawn: true,
    at: "2026-11-16T10:00:00.000Z",
  };

  it.each([
    [true, "withdrawing"],
    [false, "withdrawing"],
    [true, "deleting"],
    [false, "deleting"],
    [true, "opening the page again"],
    [false, "opening the page again"],
  ] as const)(
    "says what the Brain kept is being removed, or that nothing is used or kept, as core answers (removing: %s) when %s",
    async (removing, how) => {
      const done = how === "deleting" ? "Deleted." : "You withdrew.";
      const nothing =
        how === "deleting"
          ? "Nothing you said is kept."
          : "Nothing you said is used from now on.";
      if (how === "withdrawing") {
        await shown(removing ? { ...withdrawn, removing } : withdrawn);
        await choose("Withdraw instead");
      } else if (how === "deleting") {
        await shown(removing ? { deleted: true, removing } : { deleted: true });
        await choose("Delete it");
      } else {
        await reopened(removing);
      }
      await until(() => text().includes(done), done);
      expect({
        says: text().includes(`${done} ${removing ? removed : nothing}`),
        saysTheOther: text().includes(removing ? nothing : removed),
      }).toStrictEqual({ says: true, saysTheOther: false });
    }
  );
});
