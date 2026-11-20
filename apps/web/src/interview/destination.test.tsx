import { setTimeout as sleep } from "node:timers/promises";

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
import { z } from "zod";

import type { OpenSession } from "./api.ts";
import { holdInterview, progressNow, releaseInterview } from "./kept.ts";
import { InterviewPage } from "./page.tsx";

// Moving a line after agreeing to it, in "Where your lines go" (GRA-1987),
// against core's route faked as `fetch` answers it. Until core keeps the
// change and the approval of it, the move shows as on its way, never as
// done: a connection lost, or a change core refuses, is said there with a
// way to try again, and each line shows where core holds it.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

/** An interview they agreed to: a step shared with their team, a wish counted anonymously. */
const finished: InterviewProgress = {
  person: "completed",
  told: true,
  mode: "type",
  lines: [
    { from: "stephen", text: "What starts one?" },
    { from: "person", text: "A ticket." },
  ],
  facts: [
    {
      id: "f1",
      tag: "step",
      text: "You open the ticket.",
      record: "Opens the ticket.",
      agreed: true,
      share: "team",
    },
    {
      id: "f2",
      tag: "wish",
      text: "You would like the number filled in.",
      record: "Wishes the number were filled in.",
      agreed: true,
    },
    // Said after they agreed, and not agreed to (yet): not in the sheet.
    {
      id: "f3",
      tag: "step",
      text: "You file the ticket.",
      record: "Files the ticket.",
      share: "team",
    },
  ],
  phase: "result",
  wants: "end",
  startedAt: 1,
  confirmed: 1,
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
 * How the faked core answers saves (keeping, unreachable, refusing, or
 * refusing them as agreed to an older notice) and approvals (keeping,
 * unreachable, or held until the test lets each go); and what each save
 * and approval it was sent named.
 */
const core: {
  answers: "keeps" | "unreachable" | "refuses" | "older notice";
  approvals: "keeps" | "unreachable" | "held";
  saves: number;
  approved: string[][];
  held: (() => void)[];
} = {
  answers: "keeps",
  approvals: "keeps",
  saves: 0,
  approved: [],
  held: [],
};

const approvedSchema = z.object({
  action: z.literal("approve"),
  facts: z.array(z.object({ id: z.string() })),
});

/** A refusal as core sends it. */
const refusal = {
  code: "interview.closed",
  message: "The interviews are over. Thank you for your time.",
};

/** What core answers a save from a page whose taking part was agreed to an older notice. */
const olderNotice = {
  code: "interview.notice_changed",
  message:
    "What this interview is for has changed. Read it again before you go on.",
};

/** An approval, answered as `core.approvals` says: the ids it named are noted first. */
const approvalAnswered = async (ids: string[]): Promise<Response> => {
  if (core.approvals === "unreachable") {
    throw new TypeError("Failed to fetch");
  }
  core.approved.push(ids);
  if (core.approvals === "held") {
    const until = Promise.withResolvers<null>();
    core.held.push(() => {
      until.resolve(null);
    });
    await until.promise;
  }
  return Response.json({
    approved: true,
    receipt: `rb-${core.approved.length}`,
    at: "2026-11-17T10:00:00.000Z",
  });
};

const answered = async (init?: RequestInit): Promise<Response> => {
  await Promise.resolve();
  const sent = typeof init?.body === "string" ? init.body : "{}";
  const approval = approvedSchema.safeParse(JSON.parse(sent));
  if (approval.success) {
    return await approvalAnswered(approval.data.facts.map(({ id }) => id));
  }
  core.saves += 1;
  if (core.answers === "unreachable") {
    throw new TypeError("Failed to fetch");
  }
  if (core.answers === "refuses") {
    return Response.json(refusal, { status: 403 });
  }
  if (core.answers === "older notice") {
    return Response.json(olderNotice, { status: 409 });
  }
  return Response.json({ saved: true, version: 1 + core.saves });
};

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
    { timeout: 3000, interval: 5 }
  );
};

const buttonNamed = (label: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find(
    (each) => each.textContent === label
  );

const press = async (label: string): Promise<void> => {
  await until(() => buttonNamed(label) !== undefined, label);
  await act(async () => {
    buttonNamed(label)?.click();
    await Promise.resolve();
  });
};

const text = (): string => document.body.textContent ?? "";

/** Where the sheet shows the step going: the switch under it. */
const stepGoes = (): string | null => {
  const sheet = document.querySelector("[role=dialog]");
  const step = [...(sheet?.querySelectorAll("li") ?? [])].find((line) =>
    line.textContent?.startsWith("You open the ticket.")
  );
  return step?.querySelector("button")?.textContent ?? null;
};

/** Where the sheet shows the wish going: the switch under it. */
const wishGoes = (): string | null => {
  const sheet = document.querySelector("[role=dialog]");
  const wish = [...(sheet?.querySelectorAll("li") ?? [])].find((line) =>
    line.textContent?.startsWith("You would like the number filled in.")
  );
  return wish?.querySelector("button")?.textContent ?? null;
};

/** What the sheet says of the change sent: its note, none before one. */
const sheetSays = (): string | null =>
  document.querySelector("[role=dialog] [aria-live]")?.textContent ?? null;

/** Lets the oldest approval held go. */
const letGo = async (): Promise<void> => {
  await act(async () => {
    core.held.shift()?.();
    await Promise.resolve();
  });
};

/** The page, its interview agreed to, with the sheet open. */
const sheetOpen = async (): Promise<void> => {
  vi.stubGlobal(
    "fetch",
    vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(
      async (_input, init) => await answered(init)
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
    component: () => <InterviewPage session={session} />,
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
  await press("Where your lines go");
  await until(() => stepGoes() !== null, "the sheet");
};

const shared = "Shared as how your team works";
const anonymous = "Only counted anonymously";

describe("moving a line after agreeing to it", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    releaseInterview();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    core.answers = "keeps";
    core.approvals = "keeps";
    core.saves = 0;
    core.approved = [];
    core.held = [];
  });

  it("never says a later move is saved while an earlier move's approval is still on its way: each is kept and approved, and shown where core holds it", async () => {
    await sheetOpen();
    core.approvals = "held";
    await press(shared);
    await press("Save where they go");
    await until(() => core.held.length === 1, "the first approval asked");
    // Closed and opened again while the first approval waits; the wish moved too.
    await press("Close");
    await until(() => stepGoes() === null, "the sheet closed");
    await press("Where your lines go");
    await until(() => wishGoes() !== null, "the sheet again");
    await press(anonymous);
    await press("Save where they go");
    await letGo();
    await until(() => core.held.length === 1, "the second approval asked");
    const second = { says: sheetSays(), wish: wishGoes() };
    await letGo();
    await until(() => wishGoes() === shared, "the wish moved");
    expect({
      second,
      approved: core.approved,
      says: sheetSays(),
    }).toStrictEqual({
      // The step's move is approved; the wish's not yet: where core holds it.
      second: { says: null, wish: anonymous },
      approved: [
        ["f1", "f2"],
        ["f1", "f2"],
      ],
      says: "Saved",
    });
  });

  it("says a move that is kept but not approved counts nowhere until it is", async () => {
    await sheetOpen();
    core.approvals = "unreachable";
    await press(shared);
    await press("Save where they go");
    await until(() => buttonNamed("Try again") !== undefined, "the trouble");
    expect({ says: sheetSays(), goes: stepGoes() }).toStrictEqual({
      says: "Not saved yet. Until it is, the lines you moved count nowhere.",
      goes: shared,
    });
  });

  it("keeps a move refused for an older notice on the page, and shows what the interview is for again instead of trying it over and over", async () => {
    await sheetOpen();
    core.answers = "older notice";
    await press(shared);
    await press("Save where they go");
    await until(
      () =>
        text().includes("Which language do you want to do this interview in?"),
      "what this interview is for"
    );
    // Longer than a save waits to be tried again, more than once.
    await act(async () => {
      await sleep(1500);
    });
    const step = progressNow().facts.find(({ id }) => id === "f1");
    expect({
      saves: core.saves,
      share: step?.share ?? "anonymous",
    }).toStrictEqual({
      saves: 1,
      share: "anonymous",
    });
  });

  it("approves only the lines the sheet shows, as they go now", async () => {
    await sheetOpen();
    await press(shared);
    await press("Save where they go");
    await until(() => stepGoes() === anonymous, "the move kept");
    expect(core.approved).toStrictEqual([["f1", "f2"]]);
  });

  it("shows a move whose save is lost as not done, the line where core holds it, and keeps it once tried again", async () => {
    await sheetOpen();
    core.answers = "unreachable";
    await press(shared);
    await press("Save where they go");
    await until(() => buttonNamed("Try again") !== undefined, "the trouble");
    const lost = {
      said: text().includes(
        "Not saved yet. Until it is, your lines still go where they went before."
      ),
      goes: stepGoes(),
    };
    core.answers = "keeps";
    await press("Try again");
    await until(() => stepGoes() === anonymous, "the move kept");
    expect({
      lost,
      trouble: buttonNamed("Try again") !== undefined,
    }).toStrictEqual({
      lost: { said: true, goes: shared },
      trouble: false,
    });
  });

  it("shows a move core refuses as refused, in core's words, the line where core holds it, also after the sheet closes", async () => {
    await sheetOpen();
    core.answers = "refuses";
    await press(shared);
    await press("Save where they go");
    await until(() => text().includes(refusal.message), "the refusal");
    const refused = {
      goes: stepGoes(),
      saving: buttonNamed("Saving…") !== undefined,
    };
    await press("Close");
    await until(() => stepGoes() === null, "the sheet closed");
    expect({
      refused,
      onScreen: text().includes(refusal.message),
    }).toStrictEqual({
      refused: { goes: shared, saving: false },
      onScreen: true,
    });
  });
});
