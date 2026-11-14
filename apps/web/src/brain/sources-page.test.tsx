// @vitest-environment happy-dom
import type { Connection } from "@grasp-os/shared/brain";
import type {
  BrainSearchPack,
  BrainSourceListed,
  BrainSourceRef,
  BrainSourcesAfter,
} from "@grasp-os/shared/brain-sources";
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
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { SourcesPage } from "./sources-page.tsx";

// The Brain's Sources page, against core's `brainSources` as the page
// reaches it over RPC, faked: the sources core lists, a page at a time,
// one opened at its newest version and then an older one; search shows
// recall's pack as core gives it, in its order, with what it didn't find
// and that it was cut short, and opens a result's source at its version;
// each connection says how it feeds the Brain; a refusal is said.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const handbook: BrainSourceRef = { producer: "upload", id: "u-1" };
const minutes: BrainSourceRef = { producer: "chat", id: "c-1" };
const older: BrainSourceRef = { producer: "run", id: "r-1" };

const listed = (
  source: BrainSourceRef,
  firstLine: string,
  versions = 1,
  personal = false
): BrainSourceListed => ({
  source,
  version: versions,
  addedAt: "2026-11-10T09:00:00.000Z",
  firstLine,
  personal,
  versions,
});

const texts: Record<string, string> = {
  "u-1@2": "Handbook\nInvoices are paid on Fridays.",
  "u-1@1": "Handbook draft\nInvoices are paid monthly.",
  "c-1@1": "Board minutes",
};

const pack: BrainSearchPack = {
  items: [
    {
      source: handbook,
      version: 1,
      position: 0,
      text: "Invoices are paid monthly.",
      whole: true,
      found: "exact",
    },
    {
      source: minutes,
      version: 1,
      position: 0,
      text: "Board minutes",
      whole: false,
      found: "meaning",
    },
  ],
  memories: [
    {
      store: "own",
      id: "m-1",
      statement: "I pay invoices on Fridays",
      quote: "pay them on Fridays",
      context: {
        position: 0,
        text: "Remember: I pay them on Fridays, always.",
      },
      source: null,
      said: "you",
      confirmed: true,
      contested: false,
      found: "words",
    },
    {
      store: "shared",
      id: "m-2",
      statement: "Invoices are paid on Fridays",
      quote: null,
      context: null,
      source: { source: handbook, version: 2 },
      said: "outside",
      confirmed: false,
      contested: true,
      found: "entities",
    },
    {
      store: "shared",
      id: "m-3",
      statement: "Invoices over 10,000 need a second approval",
      quote: null,
      context: null,
      source: null,
      said: "system",
      confirmed: false,
      contested: false,
      found: "words",
    },
  ],
  notFound: ["refunds", "INV-7"],
  truncated: true,
};

/** A question only memories answer: its pack holds no passage. */
const remembered = "fridays";

/** Lets every pending read settle. */
const settle = async (): Promise<void> => {
  await act(async () => {
    for (let tick = 0; tick < 8; tick += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one tick after another
      await Promise.resolve();
    }
  });
};

/** How the faked core answers. */
interface Faked {
  /** Refuses every call with this. */
  refusal?: string;
  /** Holds each search until it settles. */
  searched?: Promise<boolean>;
  /** Holds each read of a source's first version until it settles. */
  firstRead?: Promise<boolean>;
  /** Lists no source at all. */
  empty?: boolean;
}

/** A question nothing the person may read holds: its pack is empty. */
const unmatched = "zeppelin";

/** Shows the page on a faked core, answering as `faked` says. */
const shown = async (
  connections: Connection[],
  { refusal, searched, firstRead, empty = false }: Faked = {}
) => {
  const calls: string[] = [];
  const brainSources = {
    list: async (after?: BrainSourcesAfter) => {
      await Promise.resolve();
      calls.push(
        `list${after === undefined ? "" : ` after ${after.source.id}`}`
      );
      if (refusal !== undefined) {
        throw new Error(refusal);
      }
      if (empty) {
        return { sources: [], next: null };
      }
      return after === undefined
        ? {
            sources: [
              listed(handbook, "Handbook", 2, true),
              listed(minutes, "Board minutes"),
            ],
            next: { addedAt: "2026-11-10T09:00:00.000Z", source: minutes },
          }
        : { sources: [listed(older, "")], next: null };
    },
    versions: async (source: BrainSourceRef) => {
      await Promise.resolve();
      calls.push(`versions ${source.id}`);
      return {
        versions:
          source.id === handbook.id
            ? [
                { version: 2, addedAt: "2026-11-10T09:00:00.000Z" },
                { version: 1, addedAt: "2026-11-09T09:00:00.000Z" },
              ]
            : [{ version: 1, addedAt: "2026-11-10T09:00:00.000Z" }],
        before: null,
      };
    },
    read: async (source: BrainSourceRef, version: number) => {
      await Promise.resolve();
      calls.push(`read ${source.id}@${version}`);
      if (version === 1) {
        await (firstRead ?? Promise.resolve(true));
      }
      const text = texts[`${source.id}@${version}`];
      return text === undefined
        ? null
        : { source, version, addedAt: "2026-11-10T09:00:00.000Z", text };
    },
    search: async (question: string) => {
      calls.push(`search ${question}`);
      await (searched ?? Promise.resolve());
      if (question === unmatched) {
        return {
          items: [],
          memories: [],
          notFound: [unmatched],
          truncated: false,
        };
      }
      return question === remembered ? { ...pack, items: [] } : pack;
    },
  };
  const core = {
    withSession: async <T,>(
      action: (session: { brainSources: typeof brainSources }) => Promise<T>
    ): Promise<T> => await action({ brainSources }),
  };
  const rootRoute = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <SourcesPage connections={connections} />,
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
  return { calls };
};

/** Presses the button whose text starts with `label`. */
const press = async (label: string): Promise<void> => {
  const button = [...document.querySelectorAll("button")].find((each) =>
    each.textContent.startsWith(label)
  );
  if (!button) {
    throw new TypeError(`No button ${label}`);
  }
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
  await settle();
};

/** Searches for `question`. */
const search = async (question: string): Promise<void> => {
  const box = document.querySelector("input");
  const form = document.querySelector("form");
  if (!box || !form) {
    throw new TypeError("No search box");
  }
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set?.call(box, question);
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
  await act(async () => {
    form.requestSubmit();
    await Promise.resolve();
  });
  await settle();
};

/** The text of the opened source's panel. */
const panel = (): string =>
  document.querySelector("[data-slot=card]")?.textContent ?? "";

/** The text of the section whose heading is `heading`. */
const section = (heading: string): string =>
  [...document.querySelectorAll("section[aria-labelledby]")].find(
    (each) =>
      document.querySelector(`[id="${each.getAttribute("aria-labelledby")}"]`)
        ?.textContent === heading
  )?.textContent ?? "";

describe(SourcesPage, () => {
  beforeEach(() => {
    // Core's route of the person's own export, at the page's foot
    // (own-export.tsx, its own tests): none started.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => await Promise.resolve(Response.json({ export: null })))
    );
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("lists the sources core gives a page at a time, and opens one at its newest version, then an older one", async () => {
    const { calls } = await shown([]);
    await press("Show more");
    const listedText = document.body.textContent;
    await press("Handbook");
    const newest = panel();
    await press("Version 1");
    const oldest = panel();

    expect({
      listed: [
        "Handbook",
        "Board minutes",
        "No first line",
        "2 versions",
        "Only you",
        "Those marked Only you are yours alone",
      ].map((text) => listedText.includes(text)),
      moreGone: listedText.includes("Show more"),
      newest: newest.includes("Invoices are paid on Fridays."),
      oldest: oldest.includes("Invoices are paid monthly."),
      calls,
    }).toStrictEqual({
      listed: [true, true, true, true, true, true],
      moreGone: false,
      newest: true,
      oldest: true,
      calls: [
        "list",
        "list after c-1",
        "versions u-1",
        "read u-1@2",
        "read u-1@1",
      ],
    });
  });

  it("shows recall's pack as core gives it, and opens a result's source at its version", async () => {
    const { calls } = await shown([]);
    await search("  invoices refunds  ");
    const resultText = section("Results");
    await press("Invoices are paid monthly.");

    expect({
      order:
        resultText.indexOf("Invoices are paid monthly.") <
        resultText.indexOf("Board minutes"),
      found: ["Exact match", "By meaning", "The best part of its passage"].map(
        (text) => resultText.includes(text)
      ),
      notFound: resultText.includes(
        "Nothing you may read holds refunds and INV-7."
      ),
      truncated: resultText.includes("More was found than fits"),
      opened: panel().includes("Invoices are paid monthly."),
      calls,
    }).toStrictEqual({
      order: true,
      found: [true, true, true],
      notFound: true,
      truncated: true,
      opened: true,
      calls: ["list", "search invoices refunds", "versions u-1", "read u-1@1"],
    });
  });

  it("shows every memory of the pack with where it came from, the passage around it on asking, and opens its source at its version", async () => {
    const { calls } = await shown([]);
    await search(remembered);
    const resultText = section("Results");
    const before = document.body.textContent;
    await press("The passage around it");
    const opened = document.body.textContent;
    await press("Open version 2");

    expect({
      memories: [
        "What the Brain remembers",
        "I pay invoices on Fridays",
        "pay them on Fridays",
        "Your own word",
        "Only you",
        "Confirmed",
        "By its words",
        "Invoices are paid on Fridays",
        "Upload",
        "Sources disagree",
        "Through what you asked about",
        "Invoices over 10,000 need a second approval",
        "A system's word",
        "An outside party's word",
      ].map((text) => resultText.includes(text)),
      nothingMatched: resultText.includes("Nothing you may read matched."),
      notFound: resultText.includes(
        "Nothing you may read holds refunds and INV-7."
      ),
      passage: {
        before: before.includes("Remember: I pay them on Fridays, always."),
        opened: opened.includes("Remember: I pay them on Fridays, always."),
      },
      source: panel().includes("Invoices are paid on Fridays."),
      calls,
    }).toStrictEqual({
      memories: Array.from({ length: 14 }, () => true),
      nothingMatched: false,
      notFound: true,
      passage: { before: false, opened: true },
      source: true,
      calls: ["list", `search ${remembered}`, "versions u-1", "read u-1@2"],
    });
  });

  it("opens a result at the version it cites, even after another version was picked in its panel", async () => {
    await shown([]);
    await search("invoices");
    await press("Invoices are paid monthly.");
    const cited = panel();
    await press("Version 2");
    const picked = panel();
    await press("Invoices are paid monthly.");

    expect({
      cited: cited.includes("Invoices are paid monthly."),
      picked: picked.includes("Invoices are paid on Fridays."),
      again: panel().includes("Invoices are paid monthly."),
    }).toStrictEqual({ cited: true, picked: true, again: true });
  });

  it("shows a version picked as loading until its own text arrives, never the text of the one before", async () => {
    const read = Promise.withResolvers<boolean>();
    await shown([], { firstRead: read.promise });
    await press("Handbook");
    const newest = panel();
    await press("Version 1");
    const waiting = panel();
    read.resolve(true);
    await settle();

    expect({
      newest: newest.includes("Invoices are paid on Fridays."),
      waiting: waiting.includes("Invoices are paid on Fridays."),
      arrived: panel().includes("Invoices are paid monthly."),
    }).toStrictEqual({ newest: true, waiting: false, arrived: true });
  });

  it("says once that a search found nothing, and what wasn't found only beside what was", async () => {
    await shown([]);
    await search(unmatched);
    const nothing = section("Results");
    await search("invoices refunds");
    const some = section("Results");

    expect({
      nothing: [
        "Nothing you may read matched.",
        `Nothing you may read holds ${unmatched}.`,
      ].map((text) => nothing.includes(text)),
      some: some.includes("Nothing you may read holds refunds and INV-7."),
    }).toStrictEqual({ nothing: [true, false], some: true });
  });

  it("says what Only you means only when there are sources to mark", async () => {
    await shown([], { empty: true });
    const empty = section("Sources you may read");
    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    await shown([]);
    const listedText = section("Sources you may read");

    expect({
      empty: {
        onlyYou: empty.includes("Those marked Only you"),
        documents: empty.includes(
          "Documents and workflow runs show here once they reach the Brain."
        ),
      },
      listed: listedText.includes("Those marked Only you"),
    }).toStrictEqual({
      empty: { onlyYou: false, documents: true },
      listed: true,
    });
  });

  it("asks one search at a time: a question sent while one is searched is not asked", async () => {
    const answered = Promise.withResolvers<boolean>();
    const { calls } = await shown([], { searched: answered.promise });
    await search("invoices");
    await search("refunds");
    answered.resolve(true);
    await settle();

    expect({
      calls,
      shown: section("Results").includes("Invoices are paid monthly."),
    }).toStrictEqual({ calls: ["list", "search invoices"], shown: true });
  });

  it("says what the Brain keeps of a person's own connections, marks each it keeps reads from, and says when there are none", async () => {
    await shown([
      {
        name: "Gmail",
        status: "connected",
        via: "direct",
        matches: [],
        keepsReads: true,
      },
      {
        name: "Microsoft 365",
        status: "connected",
        via: "direct",
        matches: [],
      },
      { name: "HubSpot", status: "connected", via: "composio", matches: [] },
    ]);
    const feeds = section("How your connections feed the Brain");
    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    await shown([]);
    const none = section("How your connections feed the Brain");

    expect({ feeds, none }).toStrictEqual({
      feeds:
        "How your connections feed the Brain" +
        "The Brain keeps one Gmail message or attachment, or one OneNote page, when an agent reads it for you through an account you connected yourself, and keeps it for you alone. Everything else agents search live when you ask, and the Brain keeps nothing of it." +
        "GmailThe Brain keeps the messages and pages an agent reads for you from this." +
        "Microsoft 365Searched live, nothing kept." +
        "HubSpotSearched live, nothing kept.",
      none: "How your connections feed the BrainYou have no connections yet.",
    });
  });

  it("says why core refused, and shows nothing as listed", async () => {
    await shown([], { refusal: "You aren't a member of this organization." });
    const text = document.body.textContent;

    expect({
      refusal: text.includes("You aren't a member of this organization."),
      empty: text.includes("Nothing in the Brain you may read yet"),
    }).toStrictEqual({ refusal: true, empty: false });
  });
});
