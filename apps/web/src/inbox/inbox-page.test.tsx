// @vitest-environment happy-dom
import { setTimeout as sleep } from "node:timers/promises";

import { brainGapErrors } from "@grasp-os/shared/brain-records";
import {
  appIdSchema,
  connectionIdSchema,
  permissionIdSchema,
} from "@grasp-os/shared/ids";
import type { GapAskedNotification } from "@grasp-os/shared/notifications";
import { permissionErrors } from "@grasp-os/shared/permissions";
import type { Permission } from "@grasp-os/shared/permissions";
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

import type { Loaded } from "../load-from-core.tsx";
import { InboxPage } from "./inbox-page.tsx";
import { inboxItems } from "./items.ts";
import type { Waiting } from "./waiting.ts";

// The Inbox on Damsko: the item to decide stands in the side panel beside
// the list on a wide window, and opens in a sheet on a phone once its row
// is pressed; J and K walk what waits, Skip puts an item at the back; an
// item that is answered leaves, and the one after it opens, its answers
// held back a moment; one whose answer core refused stays, with core's
// reason, until the person moves on. Core's brain and permissions are
// faked as the page reaches them over RPC.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

/** A question the Brain asked the person, as core notifies them of it. */
const askedOf = (id: string, question: string): GapAskedNotification => ({
  id,
  type: "gap_asked",
  gap: `gap-${id}`,
  question,
  owner: "Head of finance",
  // The newest first: the inbox's own order.
  at: `2026-11-1${String(5 - Number(id))}T09:00:00.000Z`,
  read: false,
});

/** A permission request of App `name`'s, waiting for an admin. */
const requestOf = (id: string, name: string): Permission => ({
  id: permissionIdSchema.parse(id),
  subject: { type: "app", appId: appIdSchema.parse(`app-${id}`) },
  object: {
    type: "connection",
    connectionId: connectionIdSchema.parse("invoices"),
  },
  actions: ["read"],
  binding: name.toUpperCase(),
  status: "requested",
  requestedBy: "builder",
  requestedAt: `2026-11-1${id}T09:00:00.000Z`,
  grantedBy: null,
  grantedAt: null,
  revokedBy: null,
  revokedAt: null,
  requestedVia: null,
  chat: null,
});

/**
 * How core answers a grant or a decline of request `id`: `drop` takes it
 * off what waits, as core does once it is answered, here or elsewhere.
 */
type Answers = (drop: (id: string) => void) => {
  grant: (id: string) => Promise<unknown>;
  decline: (id: string) => Promise<unknown>;
};

/**
 * Core refuses the first grant (another version of the App was published,
 * say) and the request still waits; it takes every answer after that.
 */
const refusedOnce: Answers = (drop) => {
  let refused = false;
  return {
    grant: async (id) => {
      await Promise.resolve();
      if (!refused) {
        refused = true;
        throw permissionErrors.create("permission.conflict");
      }
      drop(id);
      return {};
    },
    decline: async (id) => {
      await Promise.resolve();
      drop(id);
      return {};
    },
  };
};

/** Core takes every answer. */
const taken: Answers = (drop) => ({
  grant: async (id) => {
    await Promise.resolve();
    drop(id);
    return {};
  },
  decline: async (id) => {
    await Promise.resolve();
    drop(id);
    return {};
  },
});

/**
 * Someone answered every request elsewhere just before: core refuses the
 * answer given here (`permission.not_requested`), and lists it no more.
 */
const answeredElsewhere: Answers = (drop) => {
  const refuse = async (id: string) => {
    await Promise.resolve();
    drop(id);
    throw permissionErrors.create("permission.not_requested");
  };
  return { grant: refuse, decline: refuse };
};

const three = (): GapAskedNotification[] => [
  askedOf("1", "Who approves a refund?"),
  askedOf("2", "Who pays the invoices?"),
  askedOf("3", "Who signs a quote?"),
];

/** The width a `(min-width: Nrem)` query asks about. */
const minWidth = /^\(min-width:\s*(?<at>[\d.]+)rem\)$/u;

/** A window `width` wide: happy-dom lays nothing out, so the width queries say it. */
const windowOf = (width: number): void => {
  vi.stubGlobal("matchMedia", (query: string) => {
    const at = Number(minWidth.exec(query)?.groups?.at) * 16;
    return Object.assign(new EventTarget(), {
      matches: width >= at,
      media: query,
    });
  });
};

/**
 * The Inbox at `at`, in a window `width` wide, for an admin: `asked` and
 * `requests` wait, core answering requests as `answers` says and Brain
 * questions as `answerGap` does; `notLoaded` are the reads that failed,
 * as the page's loader hands them.
 */
const shown = async ({
  asked = [],
  requests = [],
  width = 1440,
  at = "/inbox",
  notLoaded = [],
  answers = taken,
  gapClosed = false,
}: {
  asked?: GapAskedNotification[];
  requests?: Permission[];
  width?: number;
  at?: string;
  notLoaded?: Loaded<unknown>[];
  answers?: Answers;
  /** Someone answered every Brain question just before: core refuses an answer. */
  gapClosed?: boolean;
}) => {
  windowOf(width);
  let open = asked;
  let waits = requests;
  const answered: string[] = [];
  // Every answer to a Brain question that reached core, taken or not.
  const tried: string[] = [];
  const brain = {
    answerGap: async (gap: string, answer: string) => {
      tried.push(gap);
      await Promise.resolve();
      open = open.filter((each) => each.gap !== gap);
      if (gapClosed) {
        throw brainGapErrors.create("brain.gap_closed");
      }
      answered.push(`${gap}: ${answer}`);
      return {};
    },
  };
  const answering = answers((id) => {
    waits = waits.filter((each) => each.id !== id);
  });
  const permissions = {
    grant: async (id: string, _reviewed: unknown) => {
      answered.push(`grant ${id}`);
      return await answering.grant(id);
    },
    decline: async (id: string) => {
      answered.push(`decline ${id}`);
      return await answering.decline(id);
    },
  };
  const core = {
    withSession: async <T,>(
      action: (session: {
        brain: typeof brain;
        permissions: typeof permissions;
      }) => Promise<T>
    ): Promise<T> => await action({ brain, permissions }),
  };
  const rootRoute = createRootRoute({ component: Outlet });
  const inbox = createRoute({
    getParentRoute: () => rootRoute,
    path: "/inbox",
    validateSearch: z.object({ item: z.string().optional() }),
    loader: async (): Promise<{
      asked: GapAskedNotification[];
      requests: Permission[];
    }> => {
      await Promise.resolve();
      return { asked: open, requests: waits };
    },
  });
  const Inbox = () => {
    const {
      asked: notifications,
      requests: pending,
    }: { asked: GapAskedNotification[]; requests: Permission[] } =
      inbox.useLoaderData();
    const { item } = inbox.useSearch();
    const waiting = {
      held: { state: "ready", data: [] },
      outcomes: { state: "ready", data: [] },
      notifications: {
        state: "ready",
        data: { page: { notifications, unread: notifications.length } },
      },
      reconnect: { state: "ready", data: [] },
      requests: {
        state: "ready",
        data: {
          requests: pending,
          directory: { people: new Map(), teams: new Map(), apps: new Map() },
        },
      },
      decisions: { state: "ready", data: [] },
      heldStarts: { state: "ready", data: [] },
      bindings: { state: "ready", data: [] },
    } satisfies Waiting;
    return (
      <InboxPage
        chosen={item}
        items={inboxItems(
          waiting,
          { role: "admin", staff: false, name: "Ada" },
          "2026-11-17T12:00:00.000Z"
        )}
        notLoaded={notLoaded}
      />
    );
  };
  inbox.update({ component: Inbox });
  const router = createRouter({
    routeTree: rootRoute.addChildren([inbox]),
    history: createMemoryHistory({ initialEntries: [at] }),
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
  return {
    /** The item in the address, as a link would carry it. */
    item: () => router.state.location.search.item,
    /** What core was told. */
    answered,
    /** The Brain questions core was asked to take an answer to. */
    tried,
  };
};

/** Lets what a press or a key started settle. */
const settle = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

const key = async (name: string) => {
  await act(async () => {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: name, bubbles: true })
    );
    await Promise.resolve();
  });
  await settle();
};

/** The button whose words are `words`. */
const buttonOf = (words: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find((each) =>
    each.textContent.trim().startsWith(words)
  );

/** Presses the button whose words are `words`, focused first as a press does. */
const press = async (words: string) => {
  await act(async () => {
    const button = buttonOf(words);
    button?.focus();
    button?.click();
    await Promise.resolve();
  });
  await settle();
};

/** Whether the button can be pressed. */
const pressable = (button: HTMLButtonElement | undefined): boolean =>
  button !== undefined &&
  !button.disabled &&
  !button.matches(":disabled") &&
  button.getAttribute("aria-disabled") !== "true";

/** The words of what has focus. */
const focused = (): string => document.activeElement?.textContent ?? "";

/** Presses the row of item `id`, as its link leads to it. */
const pressRow = async (id: string) => {
  await act(async () => {
    document
      .querySelector<HTMLAnchorElement>(
        `ul[aria-label='What waits on you'] a[href$='item=${encodeURIComponent(id)}']`
      )
      ?.click();
    await Promise.resolve();
  });
  await settle();
};

const asked = /Who [^?]+\?/u;
const placed = /\d of \d/u;

/** The item a panel shows and where the walk stands; nothing while there is none. */
const walkIn = (
  panel: Element | null
): { question: string; place: string } | undefined => {
  const said = panel?.textContent;
  return said === undefined
    ? undefined
    : {
        question: asked.exec(said)?.[0] ?? "",
        place: placed.exec(said)?.[0] ?? "",
      };
};

/** What the side panel shows, beside the list. */
const beside = () =>
  walkIn(document.querySelector("aside[aria-label='Asked of you']"));

/** What the sheet shows, on a phone. */
const sheet = () => walkIn(document.querySelector("[role='dialog']"));

/** The rows, in the list's order, by the item each leads to. */
const rows = (): string[] =>
  [...document.querySelectorAll("ul[aria-label='What waits on you'] a")].map(
    (row) =>
      new URL(row.getAttribute("href") ?? "", "http://x").searchParams.get(
        "item"
      ) ?? ""
  );

/** Two permission requests, the newer first in the list. */
const twoRequests = (): Permission[] => [
  requestOf("1", "Ledger"),
  requestOf("2", "Payroll"),
];

/** Core's reason for an answer to a request answered already. */
const stale =
  "This request was answered already, so it can no longer be granted or declined.";

/** What the side panel says. */
const panelText = (): string =>
  document.querySelector("aside")?.textContent ?? "";

/** What the side panel's item asks. */
const panelTitle = (): string | undefined =>
  document.querySelector("aside [data-slot='confirmation-request']")
    ?.textContent ?? undefined;

/** Whether both of the panel's answers can be pressed. */
const answersOn = (): boolean => {
  const answers = [
    ...document.querySelectorAll<HTMLButtonElement>(
      "aside [data-slot='confirmation-action']"
    ),
  ];
  return (
    answers.length === 2 &&
    answers.every(
      (button) =>
        !button.disabled && button.getAttribute("aria-disabled") !== "true"
    )
  );
};

describe("the inbox", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("says once why nothing loaded, however many reads failed for that reason, with Try again", async () => {
    const offline: Loaded<unknown> = { state: "offline" };
    await shown({ notLoaded: [offline, offline, offline] });
    const said = "Grasp can't be reached right now. Try again in a moment.";
    expect({
      // On the page once: what is said to a screen reader as it appears stands apart.
      once: document.querySelector("[data-slot='empty-description']")
        ?.textContent,
      title: document.body.textContent.includes("The inbox didn't load"),
      retry: [...document.querySelectorAll("button")].some((button) =>
        button.textContent.includes("Try again")
      ),
    }).toStrictEqual({ once: said, title: true, retry: true });
  });

  it("shows the first item in the side panel beside the list, and J and K walk what waits", async () => {
    const page = await shown({ asked: three() });
    const first = beside();
    await key("j");
    const next = { ...beside(), item: page.item() };
    await key("k");
    const back = { ...beside(), item: page.item() };

    expect({ first, next, back }).toStrictEqual({
      first: { question: "Who approves a refund?", place: "1 of 3" },
      next: {
        question: "Who pays the invoices?",
        place: "2 of 3",
        item: "asked:2",
      },
      back: {
        question: "Who approves a refund?",
        place: "1 of 3",
        item: "asked:1",
      },
    });
  });

  it("puts a skipped item at the back of the list, and opens the one after it", async () => {
    await shown({ asked: three(), at: "/inbox?item=asked:1" });
    await press("Skip");

    expect({ rows: rows(), open: beside() }).toStrictEqual({
      rows: ["asked:2", "asked:3", "asked:1"],
      open: { question: "Who pays the invoices?", place: "1 of 3" },
    });
  });

  it("takes an answer in the person's own words, and opens the one after once it is answered", async () => {
    const page = await shown({ asked: three(), at: "/inbox?item=asked:2" });
    const box = document.querySelector("textarea");
    await act(async () => {
      if (box !== null) {
        box.value = "The sales lead.";
        box.dispatchEvent(new Event("input", { bubbles: true }));
      }
      await Promise.resolve();
    });
    await press("Answer");
    await settle();

    expect({
      answered: page.answered,
      open: beside(),
      said: document.querySelector("output")?.textContent,
      // The one after it holds its Answer back a moment, and says so.
      pause: panelText().includes("Its answers can be used in a moment"),
    }).toStrictEqual({
      answered: ["gap-2: The sales lead."],
      open: { question: "Who signs a quote?", place: "2 of 2" },
      said: "Answered: Who pays the invoices?",
      pause: true,
    });
  });

  it("puts the one that opens after an answer in the address, the first after the last", async () => {
    /** Answers the Brain question open in words of the person's own. */
    const answer = async () => {
      const box = document.querySelector("textarea");
      await act(async () => {
        if (box !== null) {
          box.value = "The sales lead.";
          box.dispatchEvent(new Event("input", { bubbles: true }));
        }
        await Promise.resolve();
      });
      await press("Answer");
      await settle();
    };
    const middle = await shown({ asked: three(), at: "/inbox?item=asked:2" });
    await answer();
    const afterMiddle = { open: beside(), item: middle.item() };
    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    const last = await shown({ asked: three(), at: "/inbox?item=asked:3" });
    await answer();

    expect({
      afterMiddle,
      afterLast: { open: beside(), item: last.item() },
    }).toStrictEqual({
      afterMiddle: {
        open: { question: "Who signs a quote?", place: "2 of 2" },
        item: "asked:3",
      },
      afterLast: {
        open: { question: "Who approves a refund?", place: "1 of 2" },
        item: "asked:1",
      },
    });
  });

  it("opens an item in a sheet on a phone once its row is pressed, and closing it leaves the item", async () => {
    const page = await shown({ asked: three(), width: 390 });
    const atFirst = { sheet: sheet(), beside: beside() };
    await pressRow("asked:2");
    const opened = sheet();
    await key("Escape");

    expect({ atFirst, opened }).toStrictEqual({
      atFirst: { sheet: undefined, beside: undefined },
      opened: { question: "Who pays the invoices?", place: "2 of 3" },
    });
    expect({ sheet: sheet(), item: page.item() }).toStrictEqual({
      sheet: undefined,
      item: undefined,
    });
  });

  it("goes round at the ends with J and K, as the arrows do, and leaves them to what is being typed", async () => {
    await shown({ asked: three(), at: "/inbox?item=asked:3" });
    await key("j");
    const pastTheEnd = beside();
    await key("k");
    const beforeTheFirst = beside();
    const box = document.querySelector("textarea");
    await act(async () => {
      box?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "j", bubbles: true })
      );
      await Promise.resolve();
    });
    await settle();

    expect({
      pastTheEnd,
      beforeTheFirst,
      typed: beside(),
    }).toStrictEqual({
      pastTheEnd: { question: "Who approves a refund?", place: "1 of 3" },
      beforeTheFirst: { question: "Who signs a quote?", place: "3 of 3" },
      typed: { question: "Who signs a quote?", place: "3 of 3" },
    });
  });

  it("grants a request, and the one after it opens with its answers held back a moment, so a second press can't answer it", async () => {
    const page = await shown({ requests: twoRequests() });
    await press("Grant it");
    const arrived = {
      open: panelTitle(),
      answers: answersOn(),
      // The button pressed went with its item: focus lands on the next one's heading.
      focus: focused(),
      // Its answers' pause is said, not only drawn.
      pause: panelText().includes("Its answers can be used in a moment"),
    };
    // Longer than the pause the arriving item's answers hold for.
    await act(async () => {
      await sleep(1100);
    });

    expect({
      answered: page.answered,
      rows: rows(),
      arrived,
      later: answersOn(),
      said: document.querySelector("output")?.textContent,
    }).toStrictEqual({
      answered: ["grant 2"],
      rows: ["request:1"],
      arrived: {
        open: "Grant app-1: read on Connection invoices?",
        answers: false,
        focus: "Grant app-1: read on Connection invoices?",
        pause: true,
      },
      later: true,
      said: "Approved: Grant app-2: read on Connection invoices?",
    });
  });

  it.each(["Grant it", "Decline"])(
    "keeps a request answered elsewhere in place with core's reason when %s is refused, until the person moves on",
    async (answer) => {
      const page = await shown({
        requests: twoRequests(),
        answers: answeredElsewhere,
      });
      await press(answer);
      const kept = {
        open: panelTitle(),
        // Its answers went off: focus lands on its heading.
        focus: focused(),
        reason: panelText().includes(stale),
        head: panelText().includes("No longer waits for you"),
        answers: answersOn(),
        rows: rows(),
      };
      await act(async () => {
        document
          .querySelector<HTMLButtonElement>("button[aria-label='The next one']")
          ?.click();
        await Promise.resolve();
      });
      await settle();

      expect({
        answered: page.answered,
        kept,
        movedOn: { open: panelTitle(), answers: answersOn() },
      }).toStrictEqual({
        answered: [`${answer === "Decline" ? "decline" : "grant"} 2`],
        kept: {
          open: "Grant app-2: read on Connection invoices?",
          focus: "Grant app-2: read on Connection invoices?",
          reason: true,
          head: true,
          answers: false,
          rows: ["request:1"],
        },
        movedOn: {
          open: "Grant app-1: read on Connection invoices?",
          answers: true,
        },
      });
    }
  );

  it("keeps a Brain question answered elsewhere in place, with core's reason alone, its box and Answer off", async () => {
    const page = await shown({
      asked: three(),
      at: "/inbox?item=asked:2",
      gapClosed: true,
    });
    const box = document.querySelector("textarea");
    await act(async () => {
      if (box !== null) {
        box.value = "The sales lead.";
        box.dispatchEvent(new Event("input", { bubbles: true }));
      }
      await Promise.resolve();
    });
    await press("Answer");
    await settle();
    const kept = {
      focus: focused(),
      // Off as a disabled fieldset turns off what it holds (which happy-dom
      // doesn't carry to `:disabled` itself).
      box:
        document
          .querySelector("aside textarea")
          ?.closest("fieldset[disabled]") !== null,
      words:
        document.querySelector<HTMLTextAreaElement>("aside textarea")?.value,
      answer: pressable(buttonOf("Answer")),
    };
    // Pressed again, and Enter in the box: nothing more goes to core.
    await press("Answer");
    await act(async () => {
      document
        .querySelector("aside textarea")
        ?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
        );
      await Promise.resolve();
    });
    await settle();

    expect({
      tried: page.tried,
      open: beside()?.question,
      reason: panelText().includes("That question is closed already."),
      sendFailed: panelText().includes("Could not send"),
      alerts: document.querySelectorAll("aside [role='alert']").length,
      open_: buttonOf("Open") === undefined,
      head: panelText().includes("No longer waits for you"),
      rows: rows(),
      kept,
    }).toStrictEqual({
      tried: ["gap-2"],
      open: "Who pays the invoices?",
      reason: true,
      sendFailed: false,
      alerts: 1,
      open_: true,
      head: true,
      rows: ["asked:1", "asked:3"],
      kept: {
        // Focus left with the answer's button: it lands on the item's heading.
        focus: "Asked of you as the Head of finance",
        box: true,
        words: "The sales lead.",
        answer: false,
      },
    });
  });

  it("lets the item kept after a refused answer go once another row is pressed", async () => {
    const page = await shown({
      asked: three(),
      at: "/inbox?item=asked:2",
      gapClosed: true,
    });
    const box = document.querySelector("textarea");
    await act(async () => {
      if (box !== null) {
        box.value = "The sales lead.";
        box.dispatchEvent(new Event("input", { bubbles: true }));
      }
      await Promise.resolve();
    });
    await press("Answer");
    await settle();
    const kept = beside();
    await pressRow("asked:3");

    expect({ kept, open: beside(), item: page.item() }).toStrictEqual({
      kept: { question: "Who pays the invoices?", place: "" },
      open: { question: "Who signs a quote?", place: "2 of 2" },
      item: "asked:3",
    });
  });

  it("keeps a request whose grant core refused while it still waits, and opens the one after it once a second grant is through", async () => {
    const page = await shown({
      requests: twoRequests(),
      answers: refusedOnce,
    });
    await press("Grant it");
    const refused = {
      open: panelTitle(),
      place: panelText().includes("1 of 2"),
      answers: answersOn(),
    };
    // Past the time the button says it failed.
    await act(async () => {
      await sleep(1700);
    });
    await press("Grant it");

    expect({
      answered: page.answered,
      refused,
      after: { open: panelTitle(), rows: rows() },
    }).toStrictEqual({
      answered: ["grant 2", "grant 2"],
      refused: {
        open: "Grant app-2: read on Connection invoices?",
        place: true,
        answers: true,
      },
      after: {
        open: "Grant app-1: read on Connection invoices?",
        rows: ["request:1"],
      },
    });
  });
});
