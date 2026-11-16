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
    draft: "grasp.interview.test.draft",
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

  it("says what the Brain kept is being removed while core says it still is, never that nothing is used", async () => {
    await shown({
      withdrawn: true,
      at: "2026-11-16T10:00:00.000Z",
      removing: true,
    });
    await choose("Withdraw instead");
    await until(() => text().includes("You withdrew."), "the withdrawal");
    expect({
      removing: text().includes(
        "You withdrew. What the Brain kept of it is being removed."
      ),
      nothingUsed: text().includes("Nothing you said is used from now on."),
    }).toStrictEqual({ removing: true, nothingUsed: false });
  });

  it("says nothing they said is used once core removed it all", async () => {
    await shown({ withdrawn: true, at: "2026-11-16T10:00:00.000Z" });
    await choose("Withdraw instead");
    await until(() => text().includes("You withdrew."), "the withdrawal");
    expect({
      removing: text().includes("What the Brain kept of it is being removed."),
      nothingUsed: text().includes(
        "You withdrew. Nothing you said is used from now on."
      ),
    }).toStrictEqual({ removing: false, nothingUsed: true });
  });

  it("says what the Brain kept is being removed after a delete while core says it still is, never that nothing is kept", async () => {
    await shown({ deleted: true, removing: true });
    await choose("Delete it");
    await until(() => text().includes("Deleted."), "the deletion");
    expect({
      removing: text().includes(
        "Deleted. What the Brain kept of it is being removed."
      ),
      nothingKept: text().includes("Nothing you said is kept."),
    }).toStrictEqual({ removing: true, nothingKept: false });
  });

  it("says nothing they said is kept once core removed it all", async () => {
    await shown({ deleted: true });
    await choose("Delete it");
    await until(() => text().includes("Deleted."), "the deletion");
    expect({
      removing: text().includes("What the Brain kept of it is being removed."),
      nothingKept: text().includes("Deleted. Nothing you said is kept."),
    }).toStrictEqual({ removing: false, nothingKept: true });
  });

  it("still says what the Brain kept is being removed when the page opens again while core says it is", async () => {
    await reopened(true);
    expect({
      removing: text().includes(
        "You withdrew. What the Brain kept of it is being removed."
      ),
      nothingUsed: text().includes("Nothing you said is used from now on."),
    }).toStrictEqual({ removing: true, nothingUsed: false });
  });

  it("says nothing they said is used when the page opens again once core removed it all", async () => {
    await reopened(false);
    expect({
      removing: text().includes("What the Brain kept of it is being removed."),
      nothingUsed: text().includes(
        "You withdrew. Nothing you said is used from now on."
      ),
    }).toStrictEqual({ removing: false, nothingUsed: true });
  });
});
