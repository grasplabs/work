// @vitest-environment happy-dom
import type {
  ConnectionBrainAudience,
  SharedSyncPlaces,
} from "@grasp-os/shared/connect";
import { syncErrors } from "@grasp-os/shared/sync";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { CatalogConnection } from "./integrations.ts";
import { SyncPlaces } from "./sync-places.tsx";

// The places of a shared connection an admin picks to sync into the
// Brain, on its card beside its Brain audience. These start from what an
// admin must not miss: that everyone in the audience will read everything
// in a picked place, whatever the source lets them open, confirmed for
// the audience held now; a save from a stale page undoing another admin's
// pick, or dropping a pick the page didn't show; a save that core refused
// looking as if it went through; two libraries a screen reader can't
// tell apart; an empty list, or a slow one, looking like a failure.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const microsoft: CatalogConnection = {
  id: "c1",
  source: "native",
  provider: "microsoft",
  scope: "shared",
  status: "active",
  ownerUserId: null,
  connectedBy: "u1",
  connectedByName: "Ada",
  accountName: "files@acme.test",
  createdAt: "2026-10-22T08:00:00.000Z",
};

const label = "Microsoft 365 (files@acme.test)";

/** What the page asked of core, by method, and its arguments. */
type Asked = [string, ...unknown[]][];

/** The refusal's words, as core gives them. */
const refusal = "Only the company's admins pick what syncs.";
const unreachable = "Grasp can't be reached right now.";

/** What the admin ticks to confirm, for everyone in the company. */
const everyoneReads = `Everyone in the company will be able to read everything in the places you pick, whatever their permissions in ${label}.`;

/** The connection's Brain audience the card shows, for a test to change. */
let audienceNow: ConnectionBrainAudience = { kind: "everyone" };
const audienceListeners = new Set<() => void>();

/** Has core hold `audience` now, as the card beside the picker reads it. */
const audienceChosen = async (
  audience: ConnectionBrainAudience
): Promise<void> => {
  await act(async () => {
    audienceNow = audience;
    for (const listener of audienceListeners) {
      listener();
    }
    await Promise.resolve();
  });
};

/** The picker with the audience held now, and the Sales team's name. */
const Picker = ({ connection }: { connection: CatalogConnection }) => {
  const audience = useSyncExternalStore(
    (listener) => {
      audienceListeners.add(listener);
      return () => {
        audienceListeners.delete(listener);
      };
    },
    () => audienceNow
  );
  return (
    <SyncPlaces
      audience={audience}
      connection={connection}
      label={label}
      team="Sales"
    />
  );
};

/** How core answers, for each test to set. */
interface Core {
  /** What connect holds: the listing, and every pick. */
  held: SharedSyncPlaces;
  /** Refuse the next save outright. */
  refuseSave?: boolean;
  /** Refuse every listing from the next on. */
  refuseListing?: boolean;
  /** A listing that hasn't answered yet: resolved by the test. */
  pending?: Promise<boolean>;
}

let root: Root | undefined;

/** Shows the picker for `connection` with core as `fake` says, and records what the page asks. */
const shown = async (
  fake: Core,
  connection: CatalogConnection = microsoft
): Promise<Asked> => {
  const asked: Asked = [];
  const session = {
    connections: {
      syncPlaces: async (...given: unknown[]) => {
        asked.push(["syncPlaces", ...given]);
        await fake.pending;
        if (fake.refuseListing === true) {
          throw new Error(unreachable);
        }
        return structuredClone(fake.held);
      },
      pickSyncPlaces: async (request: {
        connectionId: string;
        feed: string;
        from: string[];
        places: string[];
        acknowledged?: ConnectionBrainAudience;
      }) => {
        asked.push(["pickSyncPlaces", request]);
        await Promise.resolve();
        if (fake.refuseSave === true) {
          throw new Error(refusal);
        }
        // As core: a place picked only when confirmed for the audience now.
        const picksMore = request.places.some(
          (place) => !request.from.includes(place)
        );
        if (
          picksMore &&
          JSON.stringify(request.acknowledged) !== JSON.stringify(audienceNow)
        ) {
          throw syncErrors.create("sync.unacknowledged");
        }
        // As connect: only from the picks held now.
        const held = [...fake.held.picks].toSorted();
        if (
          JSON.stringify([...request.from].toSorted()) !== JSON.stringify(held)
        ) {
          throw syncErrors.create("sync.picks_changed");
        }
        fake.held.picks = [...request.places];
        for (const choice of fake.held.choices) {
          choice.picked = request.places.includes(choice.place);
        }
      },
    },
  };
  const core = {
    withSession: async <T,>(action: (given: unknown) => Promise<T>) =>
      await action(session),
  };
  const rootRoute = createRootRoute({
    component: () => <Picker connection={connection} />,
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
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
  await act(async () => {
    await Promise.resolve();
  });
  return asked;
};

/** An element's accessible name, as its `aria-labelledby` makes it. */
const nameOf = (element: Element): string =>
  (element.getAttribute("aria-labelledby") ?? "")
    .split(" ")
    .map((id) => document.querySelector(`#${id}`)?.textContent ?? "")
    .join(" ")
    .trim();

/** The checkbox named `title` (and `within`, when given). */
const boxOf = (title: string, within?: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>('[role="checkbox"]')].find(
    (box) =>
      nameOf(box) === (within === undefined ? title : `${title} ${within}`)
  );

/** Clicks `element`, and lets the page answer. */
const click = async (element: Element | undefined): Promise<void> => {
  await act(async () => {
    if (element instanceof HTMLElement) {
      element.click();
    }
    await Promise.resolve();
  });
};

/** The button reading `text`. */
const button = (text: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find(
    (each) => each.textContent === text
  );

/** Waits until `settled` holds, letting React render what core answered each time. */
const until = async (settled: () => boolean): Promise<void> => {
  await vi.waitFor(async () => {
    await act(async () => {
      await Promise.resolve();
    });
    if (!settled()) {
      throw new Error("Not settled yet");
    }
  });
};

const text = (): string => document.body.textContent ?? "";

const longSite =
  `Sales and marketing ${"of the northern region ".repeat(14)}`.trim();

/** Two sites, each with its own "Documents"; Contracts picked. */
const libraries = (): SharedSyncPlaces => ({
  feed: "libraries",
  choices: [
    { place: "b!docs", title: "Documents", within: longSite, picked: false },
    { place: "b!legal", title: "Documents", within: "Legal", picked: false },
    {
      place: "b!contracts",
      title: "Contracts",
      within: longSite,
      picked: true,
    },
  ],
  picks: ["b!contracts"],
});

describe("picking a shared connection's places to sync", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
    audienceNow = { kind: "everyone" };
  });

  it("names each place with its site, and asks nothing until a place is ticked", async () => {
    await shown({ held: libraries() });
    const boxes = [...document.querySelectorAll('[role="checkbox"]')];
    expect({
      asked: boxOf(everyoneReads) !== undefined,
      // A screen reader tells the two "Documents" apart by their site.
      names: boxes.map(nameOf),
    }).toStrictEqual({
      asked: false,
      names: [
        `Documents ${longSite}`,
        "Documents Legal",
        `Contracts ${longSite}`,
      ],
    });
  });

  it("saves a place ticked only once the admin confirmed the audience reads everything in it, and asks again for another audience", async () => {
    const fake: Core = { held: libraries() };
    const asked = await shown(fake);
    await click(boxOf("Documents", "Legal"));
    const unconfirmed = button("Save the places")?.disabled;
    await click(boxOf(everyoneReads));
    const confirmed = button("Save the places")?.disabled;
    // Another admin narrows the audience to Sales meanwhile.
    await audienceChosen({ kind: "team", teamId: "sales" });
    const teamReads = boxOf(
      `Everyone in the team Sales will be able to read everything in the places you pick, whatever their permissions in ${label}.`
    );
    const again = {
      ticked: teamReads?.getAttribute("aria-checked"),
      save: button("Save the places")?.disabled,
    };
    await click(teamReads);
    await click(button("Save the places"));
    await until(() => fake.held.picks.includes("b!legal"));
    // Un-picking only narrows what is read: nothing to confirm.
    await until(() => button("Save the places")?.disabled === true);
    await click(boxOf("Contracts", longSite));
    const unpicking = {
      asked: document.querySelectorAll('[role="checkbox"]').length,
      save: button("Save the places")?.disabled,
    };
    expect({
      unconfirmed,
      confirmed,
      again,
      unpicking,
      saved: asked
        .filter(([method]) => method === "pickSyncPlaces")
        .map(([, request]) => request),
    }).toStrictEqual({
      unconfirmed: true,
      confirmed: false,
      again: { ticked: "false", save: true },
      unpicking: { asked: 3, save: false },
      saved: [
        {
          connectionId: "c1",
          feed: "libraries",
          from: ["b!contracts"],
          places: ["b!contracts", "b!legal"],
          acknowledged: { kind: "team", teamId: "sales" },
        },
      ],
    });
  });

  it("saves only what was ticked and unticked, from every pick held, a pick the listing didn't show included", async () => {
    const held = libraries();
    // Picked, but this listing doesn't show it.
    held.picks = ["b!contracts", "b!archive"];
    const fake: Core = { held };
    const asked = await shown(fake);
    await click(boxOf("Documents", "Legal"));
    await click(boxOf("Contracts", longSite));
    await click(boxOf(everyoneReads));
    await click(button("Save the places"));
    await until(
      () => asked.filter(([method]) => method === "syncPlaces").length === 2
    );
    expect({
      saved: asked.filter(([method]) => method === "pickSyncPlaces"),
      held: [...fake.held.picks].toSorted(),
    }).toStrictEqual({
      saved: [
        [
          "pickSyncPlaces",
          {
            connectionId: "c1",
            feed: "libraries",
            from: ["b!contracts", "b!archive"],
            places: ["b!archive", "b!legal"],
            acknowledged: { kind: "everyone" },
          },
        ],
      ],
      held: ["b!archive", "b!legal"],
    });
  });

  it("shows what is picked now, and says why, when another admin's change landed first", async () => {
    const fake: Core = { held: libraries() };
    await shown(fake);
    // Another admin picks Legal's Documents meanwhile.
    fake.held.picks = ["b!contracts", "b!legal"];
    for (const choice of fake.held.choices) {
      choice.picked = fake.held.picks.includes(choice.place);
    }
    await click(boxOf("Documents", longSite));
    await click(boxOf(everyoneReads));
    await click(button("Save the places"));
    await until(() => text().includes("changed in the meantime"));
    const checked = [
      ...document.querySelectorAll('[role="checkbox"][aria-checked="true"]'),
    ].map(nameOf);
    expect({
      // Nothing of this page's was saved over the other admin's pick.
      held: [...fake.held.picks].toSorted(),
      checked,
      said: text().includes(
        `The places picked from ${label} were changed in the meantime. These are the ones picked now: pick again if you still want to change them.`
      ),
    }).toStrictEqual({
      held: ["b!contracts", "b!legal"],
      checked: ["Documents Legal", `Contracts ${longSite}`],
      said: true,
    });
  });

  it("keeps the boxes and the save still until the places are read again after a save", async () => {
    const fake: Core = { held: libraries() };
    await shown(fake);
    // The reading after the save is slow.
    const reading = Promise.withResolvers<boolean>();
    fake.pending = reading.promise;
    await click(boxOf("Documents", "Legal"));
    await click(boxOf(everyoneReads));
    await click(button("Save the places"));
    await until(() => fake.held.picks.includes("b!legal"));
    // Ticked while the places are read again: nothing happens.
    await click(boxOf("Documents", longSite));
    const meanwhile = {
      ticked: boxOf("Documents", longSite)?.getAttribute("aria-checked"),
      save: button("Save the places")?.disabled,
    };
    await act(async () => {
      reading.resolve(true);
      await Promise.resolve();
    });
    await until(
      () => boxOf("Documents", "Legal")?.getAttribute("aria-checked") === "true"
    );
    expect({
      meanwhile,
      after: {
        ticked: boxOf("Documents", longSite)?.getAttribute("aria-checked"),
        held: [...fake.held.picks].toSorted(),
      },
    }).toStrictEqual({
      meanwhile: { ticked: "false", save: true },
      after: { ticked: "false", held: ["b!contracts", "b!legal"] },
    });
  });

  it("says the picks changed meanwhile only beside the places read after it, never during the reading", async () => {
    const fake: Core = { held: libraries() };
    const asked = await shown(fake);
    // Another admin picks Legal's Documents meanwhile; reading the places
    // again after the save is slow.
    fake.held.picks = ["b!contracts", "b!legal"];
    for (const choice of fake.held.choices) {
      choice.picked = fake.held.picks.includes(choice.place);
    }
    const reading = Promise.withResolvers<boolean>();
    fake.pending = reading.promise;
    await click(boxOf("Documents", longSite));
    await click(boxOf(everyoneReads));
    await click(button("Save the places"));
    const notice = "These are the ones picked now";
    // The save was refused, and the page is reading the places again.
    await until(
      () => asked.filter(([method]) => method === "syncPlaces").length === 2
    );
    await act(async () => {
      await Promise.resolve();
    });
    const whileReading = text().includes(notice);
    await act(async () => {
      reading.resolve(true);
      await Promise.resolve();
    });
    await until(() => text().includes(notice));
    expect({
      whileReading,
      checked: [
        ...document.querySelectorAll('[role="checkbox"][aria-checked="true"]'),
      ].map(nameOf),
    }).toStrictEqual({
      whileReading: false,
      checked: ["Documents Legal", `Contracts ${longSite}`],
    });
  });

  it("says the picks changed meanwhile only once it has read them, and offers to read them again when it couldn't", async () => {
    const fake: Core = { held: libraries() };
    await shown(fake);
    // Another admin picks Legal's Documents meanwhile, and the places then
    // can't be read.
    fake.held.picks = ["b!contracts", "b!legal"];
    for (const choice of fake.held.choices) {
      choice.picked = fake.held.picks.includes(choice.place);
    }
    fake.refuseListing = true;
    await click(boxOf("Documents", longSite));
    await click(boxOf(everyoneReads));
    await click(button("Save the places"));
    await until(() => button("Try again") !== undefined);
    const failed = {
      reason: text().includes(unreachable),
      claimed: text().includes("These are the ones picked now"),
      boxes: document.querySelectorAll('[role="checkbox"]').length,
    };
    fake.refuseListing = false;
    await click(button("Try again"));
    await until(() => text().includes("These are the ones picked now"));
    expect({
      failed,
      checked: [
        ...document.querySelectorAll('[role="checkbox"][aria-checked="true"]'),
      ].map(nameOf),
    }).toStrictEqual({
      failed: { reason: true, claimed: false, boxes: 0 },
      checked: ["Documents Legal", `Contracts ${longSite}`],
    });
  });

  it("keeps a refused save's reason and the ticks, even when reading the places again fails too", async () => {
    const fake: Core = { held: libraries(), refuseSave: true };
    const asked = await shown(fake);
    await click(boxOf("Documents", longSite));
    await click(boxOf(everyoneReads));
    fake.refuseListing = true;
    await click(button("Save the places"));
    await until(
      () => asked.filter(([method]) => method === "syncPlaces").length === 2
    );
    await until(() => document.querySelectorAll('[role="alert"]').length === 2);
    expect({
      reasons: [...document.querySelectorAll('[role="alert"]')].map(
        (alert) => alert.textContent
      ),
      stillTicked: boxOf("Documents", longSite)?.getAttribute("aria-checked"),
    }).toStrictEqual({
      reasons: [refusal, unreachable],
      stillTicked: "true",
    });
  });

  it("says it is reading while a large listing takes its reads, and lets a failed one be tried again", async () => {
    const listing = Promise.withResolvers<boolean>();
    const fake: Core = { held: libraries(), pending: listing.promise };
    const asked = await shown(fake);
    const reading = text().includes(`Reading the places ${label} can open…`);
    fake.refuseListing = true;
    await act(async () => {
      listing.resolve(true);
      await Promise.resolve();
    });
    await until(() => button("Try again") !== undefined);
    const failed = text().includes(unreachable);
    fake.refuseListing = false;
    await click(button("Try again"));
    await until(() => boxOf("Contracts", longSite) !== undefined);
    expect({
      reading,
      failed,
      reads: asked.filter(([method]) => method === "syncPlaces").length,
    }).toStrictEqual({ reading: true, failed: true, reads: 2 });
  });

  it("says what the account can't open, in its own provider's words, rather than showing an empty list", async () => {
    await shown(
      { held: { feed: "shared-drives", choices: [], picks: [] } },
      { ...microsoft, provider: "google" }
    );
    expect({
      empty: text().includes("Nothing to copy into the Brain yet"),
      google: text().includes(
        `The account connected as ${label} can't open any shared drives.`
      ),
      sharePoint: text().includes("SharePoint"),
      saves: button("Save the places") !== undefined,
    }).toStrictEqual({
      empty: true,
      google: true,
      sharePoint: false,
      saves: false,
    });
  });
});
