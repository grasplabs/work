// @vitest-environment happy-dom
import type {
  BrainCorrection,
  BrainEntityKind,
  BrainEntityListed,
  BrainEntityRef,
  BrainMemoryPageNext,
  BrainMemoryRef,
  BrainMemoryShown,
  BrainStoreCursor,
} from "@grasp-os/shared/brain-memories";
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

import { MemoriesPage } from "./memories-page.tsx";

// The Brain's Memories page, against core's `brainMemories` as the page
// reaches it over RPC, faked: the facts sources disagree on, with their
// sides and where each came from, one confirmed; the entities of a kind a
// page at a time, the person's own marked as theirs alone; what the Brain
// remembers about one, history included; a correction saved as core
// takes it; and a refusal said.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const acme: BrainEntityListed = {
  entity: { store: "shared", id: "e-acme" },
  kind: "customer",
  name: "Acme",
};
const mine: BrainEntityListed = {
  entity: { store: "own", id: "e-mine" },
  kind: "customer",
  name: "Globex",
};
const later: BrainEntityListed = {
  entity: { store: "shared", id: "e-later" },
  kind: "customer",
  name: null,
};

/** A memory about Acme, as core shows it. */
const memory = (
  id: string,
  value: string,
  more: Partial<BrainMemoryShown> = {}
): BrainMemoryShown => ({
  store: "shared",
  id,
  about: acme.entity.id,
  attribute: "status",
  object: null,
  value,
  type: "fact",
  statement: `Acme is ${value}`,
  quote: value,
  source: { source: { producer: "upload", id: `u-${id}` }, version: 2 },
  yours: false,
  learnedAt: "2026-11-10T09:00:00.000Z",
  endedAt: null,
  confirmed: null,
  contested: false,
  ...more,
});

/** Lets every pending read settle. */
const settle = async (): Promise<void> => {
  await act(async () => {
    for (let tick = 0; tick < 8; tick += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one tick after another
      await Promise.resolve();
    }
  });
};

/**
 * Shows the page on a faked core; `refusal` refuses every call with it,
 * and the first `failedSaves` corrections fail after core took them in.
 */
const shown = async (refusal?: string, failedSaves = 0) => {
  let failing = failedSaves;
  const calls: string[] = [];
  const corrections: BrainCorrection[] = [];
  let confirmed = false;
  const sides = () => [
    memory("m-renewing", "Renewing", {
      contested: true,
      confirmed: confirmed
        ? { at: "2026-11-11T09:00:00.000Z", byYou: true }
        : null,
    }),
    memory("m-churned", "Churned", {
      contested: true,
      source: { source: { producer: "chat", id: "c-1" }, version: 1 },
    }),
  ];
  const answer = async <T,>(call: string, value: () => T): Promise<T> => {
    await Promise.resolve();
    calls.push(call);
    if (refusal !== undefined) {
      throw new Error(refusal);
    }
    return value();
  };
  const brainMemories = {
    contested: async (next?: BrainMemoryPageNext | null) =>
      await answer(`contested${next ? ` ${next.store}` : ""}`, () => ({
        facts: [
          {
            about: acme,
            attribute: "status" as const,
            sides: sides(),
            more: true,
          },
        ],
        next: null,
      })),
    entities: async (
      kind: BrainEntityKind,
      next?: BrainMemoryPageNext | null
    ) =>
      await answer(`entities ${kind}${next ? ` ${next.store}` : ""}`, () =>
        next
          ? { entities: [later], next: null }
          : {
              entities: [mine, acme],
              next: { store: "shared" as const, after: { entity: "e-acme" } },
            }
      ),
    entity: async (entity: BrainEntityRef) =>
      await answer(`entity ${entity.id}`, () => acme),
    memories: async (entity: BrainEntityRef, next?: BrainStoreCursor | null) =>
      await answer(`memories ${entity.id}${next ? " next" : ""}`, () =>
        next
          ? {
              memories: [
                memory("m-old", "Prospect", {
                  endedAt: "2026-11-01T09:00:00.000Z",
                }),
              ],
              next: null,
            }
          : {
              memories: [
                ...sides(),
                memory("m-mine", "Paying", {
                  store: "own",
                  source: null,
                  yours: true,
                }),
              ],
              next: { memory: "m-mine" },
            }
      ),
    confirm: async (ref: BrainMemoryRef) =>
      await answer(`confirm ${ref.store} ${ref.memory}`, () => {
        confirmed = true;
        return "done" as const;
      }),
    correct: async (correction: BrainCorrection) =>
      await answer(`correct ${correction.wrong.memory}`, () => {
        corrections.push(correction);
        if (failing > 0) {
          failing -= 1;
          throw new Error("The connection dropped");
        }
        return { memory: "m-new", entity: "e-mine" };
      }),
  };
  const core = {
    withSession: async <T,>(
      action: (session: { brainMemories: typeof brainMemories }) => Promise<T>
    ): Promise<T> => await action({ brainMemories }),
  };
  const rootRoute = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: MemoriesPage,
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
  return { calls, corrections };
};

/** Presses the `nth` button (from 0) whose text starts with `label`. */
const press = async (label: string, nth = 0): Promise<void> => {
  const button = [...document.querySelectorAll("button")].filter((each) =>
    each.textContent.startsWith(label)
  )[nth];
  if (!button) {
    throw new TypeError(`No button ${label}`);
  }
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
  await settle();
};

/** The text of the section whose heading is `heading`. */
const section = (heading: string): string =>
  [...document.querySelectorAll("section[aria-labelledby]")].find(
    (each) =>
      document.querySelector(`[id="${each.getAttribute("aria-labelledby")}"]`)
        ?.textContent === heading
  )?.textContent ?? "";

/** Types `text` into the dialog's box and saves it. */
const correctWith = async (text: string): Promise<void> => {
  const box = document.querySelector("textarea");
  const form = box?.closest("form");
  if (!box || !form) {
    throw new TypeError("No correction box");
  }
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )?.set?.call(box, text);
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
  await act(async () => {
    form.requestSubmit();
    await Promise.resolve();
  });
  await settle();
};

describe(MemoriesPage, () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("shows a fact sources disagree on with both sides and where each came from, and confirms one", async () => {
    const { calls } = await shown();
    const before = section("Where sources disagree");
    await press("This one is right");
    const after = section("Where sources disagree");

    expect({
      before: [
        "Acme",
        "Status: Renewing",
        "Status: Churned",
        "From an upload, version 2",
        "From a chat, version 1",
        "Sources disagree",
        "More sources say other things",
      ].map((text) => before.includes(text)),
      confirmedBefore: before.includes("Confirmed by you"),
      confirmedAfter: after.includes("Confirmed by you"),
      // Offered no longer on the side they confirmed; still on the other.
      offeredAfter: after.split("This one is right").length - 1,
      calls,
    }).toStrictEqual({
      before: [true, true, true, true, true, true, true],
      confirmedBefore: false,
      confirmedAfter: true,
      offeredAfter: 1,
      calls: [
        "contested",
        "entities customer",
        "confirm shared m-renewing",
        "contested",
        "entities customer",
      ],
    });
  });

  it("lists the entities of a kind a page at a time, the person's own marked, and opens one with its history", async () => {
    const { calls } = await shown();
    await press("Show more");
    const listed = section("What the Brain remembers");
    await press("Acme");
    await press("Show more");
    const opened = section("What the Brain remembers");

    expect({
      listed: ["Globex", "Only you", "Acme", "Without a name"].map((text) =>
        listed.includes(text)
      ),
      opened: [
        "Status: Paying",
        "Your own word",
        "Status: Prospect",
        "No longer held since",
      ].map((text) => opened.includes(text)),
      calls: calls.slice(1),
    }).toStrictEqual({
      listed: [true, true, true, true],
      opened: [true, true, true, true],
      calls: [
        "entities customer",
        "entities customer shared",
        "memories e-acme",
        "memories e-acme next",
      ],
    });
  });

  it("saves a correction as core takes it, its id minted once, and reads the page again", async () => {
    const { calls, corrections } = await shown();
    await press("It's wrong");
    await correctWith("  Paused for now  ");

    expect({
      corrections: corrections.map(({ wrong, right, change }) => ({
        wrong,
        right,
        change: /^[\da-f-]{36}$/u.test(change),
      })),
      calls: calls.slice(2),
    }).toStrictEqual({
      corrections: [
        {
          wrong: { store: "shared", entity: "e-acme", memory: "m-renewing" },
          right: "Paused for now",
          change: true,
        },
      ],
      calls: ["correct m-renewing", "contested", "entities customer"],
    });
  });

  it("retries a failed correction under its id, and gives new words a new one", async () => {
    const { corrections } = await shown(undefined, 2);
    const wrongButton = [...document.querySelectorAll("button")].find((each) =>
      each.textContent.startsWith("It's wrong")
    );
    await press("It's wrong");
    await correctWith("Paused");
    const failed = document.body.textContent.includes("The connection dropped");
    await correctWith("Paused");
    await correctWith("Paused for now");
    const [first, retry, edited] = corrections.map(({ change }) => change);

    expect({
      label: wrongButton?.getAttribute("aria-label"),
      failed,
      sameOnRetry: first === retry,
      newOnEdit: edited !== retry,
      rights: corrections.map(({ right }) => right),
    }).toStrictEqual({
      label: "Say this is wrong: Acme is Renewing",
      failed: true,
      sameOnRetry: true,
      newOnEdit: true,
      rights: ["Paused", "Paused", "Paused for now"],
    });
  });

  it("says why core refused", async () => {
    await shown("Not signed in");
    expect(document.body.textContent).toContain("Not signed in");
  });
});
