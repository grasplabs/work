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

/** How the faked core answers: keeping, unreachable, or refusing. */
const core: { answers: "keeps" | "unreachable" | "refuses" } = {
  answers: "keeps",
};

/** A refusal as core sends it. */
const refusal = {
  code: "interview.closed",
  message: "The interviews are over. Thank you for your time.",
};

const answered = async (init?: RequestInit): Promise<Response> => {
  await Promise.resolve();
  if (core.answers === "unreachable") {
    throw new TypeError("Failed to fetch");
  }
  if (core.answers === "refuses") {
    return Response.json(refusal, { status: 403 });
  }
  const sent = typeof init?.body === "string" ? init.body : "{}";
  const body: unknown = JSON.parse(sent);
  const approving =
    typeof body === "object" &&
    body !== null &&
    "action" in body &&
    body.action === "approve";
  return approving
    ? Response.json({
        approved: true,
        receipt: "rb-1",
        at: "2026-11-17T10:00:00.000Z",
      })
    : Response.json({ saved: true, version: 2 });
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

/** The page, its interview agreed to, with the sheet open. */
const sheetOpen = async (): Promise<void> => {
  vi.stubGlobal(
    "fetch",
    vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(
      async (_input, init) => await answered(init)
    )
  );
  holdInterview({ secret: "s".repeat(43), version: 1, progress: finished });
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

const shared = "Shared with your team as how you work";
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
