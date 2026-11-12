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
import { afterEach, describe, expect, it } from "vite-plus/test";

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
  notFound: ["refunds", "INV-7"],
  truncated: true,
};

/** Lets every pending read settle. */
const settle = async (): Promise<void> => {
  await act(async () => {
    for (let tick = 0; tick < 8; tick += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one tick after another
      await Promise.resolve();
    }
  });
};

/** Shows the page on a faked core, refusing every call with `refusal` when given. */
const shown = async (connections: Connection[], refusal?: string) => {
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
      const text = texts[`${source.id}@${version}`];
      return text === undefined
        ? null
        : { source, version, addedAt: "2026-11-10T09:00:00.000Z", text };
    },
    search: async (question: string) => {
      await Promise.resolve();
      calls.push(`search ${question}`);
      return pack;
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
  document.querySelector("section.rounded-lg")?.textContent ?? "";

describe(SourcesPage, () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
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
    const results = document.querySelector("#results")?.parentElement;
    const resultText = results?.textContent ?? "";
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

  it("says for each connection that agents search it live and the Brain keeps nothing, and says when there are none", async () => {
    await shown([
      { name: "Gmail", status: "connected", via: "direct", matches: [] },
      { name: "HubSpot", status: "connected", via: "composio", matches: [] },
    ]);
    const feeds = document.querySelector("#feeds")?.parentElement?.textContent;
    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    await shown([]);
    const none = document.querySelector("#feeds")?.parentElement?.textContent;

    expect({ feeds, none }).toStrictEqual({
      feeds:
        "How your connections feed the Brain" +
        "Gmail: agents search it live when you ask. The Brain keeps nothing from it." +
        "HubSpot: agents search it live when you ask. The Brain keeps nothing from it.",
      none: "How your connections feed the BrainYou have no connections yet.",
    });
  });

  it("says why core refused, and shows nothing as listed", async () => {
    await shown([], "You aren't a member of this organization.");
    const text = document.body.textContent;

    expect({
      refusal: text.includes("You aren't a member of this organization."),
      empty: text.includes("Nothing in the Brain you may read yet"),
    }).toStrictEqual({ refusal: true, empty: false });
  });
});
