// @vitest-environment happy-dom
import type { GapAskedNotification } from "@grasp-os/shared/notifications";
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
// item that is answered leaves, and the one after it opens. Core's brain is
// faked as the page reaches it over RPC.

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
 * The Inbox at `at`, with `asked` as what waits, in a window `width` wide;
 * `notLoaded` are the reads that failed, as the page's loader hands them.
 */
const shown = async (
  asked: GapAskedNotification[],
  width: number,
  at = "/inbox",
  notLoaded: Loaded<unknown>[] = []
) => {
  windowOf(width);
  let open = asked;
  const answered: string[] = [];
  const brain = {
    answerGap: async (gap: string, answer: string) => {
      await Promise.resolve();
      answered.push(`${gap}: ${answer}`);
      open = open.filter((each) => each.gap !== gap);
      return {};
    },
  };
  const core = {
    withSession: async <T,>(
      action: (session: { brain: typeof brain }) => Promise<T>
    ): Promise<T> => await action({ brain }),
  };
  const rootRoute = createRootRoute({ component: Outlet });
  const inbox = createRoute({
    getParentRoute: () => rootRoute,
    path: "/inbox",
    validateSearch: z.object({ item: z.string().optional() }),
    loader: async (): Promise<{ asked: GapAskedNotification[] }> => {
      await Promise.resolve();
      return { asked: open };
    },
  });
  const Inbox = () => {
    const { asked: notifications }: { asked: GapAskedNotification[] } =
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
      requests: undefined,
      decisions: { state: "ready", data: [] },
      heldStarts: { state: "ready", data: [] },
      bindings: { state: "ready", data: [] },
    } satisfies Waiting;
    return (
      <InboxPage
        chosen={item}
        items={inboxItems(
          waiting,
          { role: "user", staff: false, name: "Ada" },
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

/** Presses the button whose words are `words`. */
const press = async (words: string) => {
  await act(async () => {
    [...document.querySelectorAll("button")]
      .find((each) => each.textContent.trim().startsWith(words))
      ?.click();
    await Promise.resolve();
  });
  await settle();
};

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
    await shown([], 1440, "/inbox", [offline, offline, offline]);
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
    const page = await shown(three(), 1440);
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
    await shown(three(), 1440, "/inbox?item=asked:1");
    await press("Skip");

    expect({ rows: rows(), open: beside() }).toStrictEqual({
      rows: ["asked:2", "asked:3", "asked:1"],
      open: { question: "Who pays the invoices?", place: "1 of 3" },
    });
  });

  it("takes an answer in the person's own words, and opens the one after once it is answered", async () => {
    const page = await shown(three(), 1440, "/inbox?item=asked:2");
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
    }).toStrictEqual({
      answered: ["gap-2: The sales lead."],
      open: { question: "Who signs a quote?", place: "2 of 2" },
      said: "Answered: Who pays the invoices?",
    });
  });

  it("opens an item in a sheet on a phone once its row is pressed, and closing it leaves the item", async () => {
    const page = await shown(three(), 390);
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
});
