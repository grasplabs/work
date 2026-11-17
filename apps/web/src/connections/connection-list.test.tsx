// @vitest-environment happy-dom
import { connectionErrors } from "@grasp-os/shared/connect";
import type { Identity } from "@grasp-os/shared/rpc";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { ConnectionList } from "./connection-list.tsx";
import type { CatalogConnection, Integration } from "./integrations.ts";

// The disconnect dialog of a person's connection: it says what the Brain
// kept from it is erased whenever core says the connection may hold some
// (`keepsReads`), and says nothing of the Brain for one that never can.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const person: Identity = {
  userId: "u1",
  email: "ada@example.com",
  name: "Ada",
  role: "user",
  teams: [],
  staff: false,
  expiresAt: "2026-12-31T00:00:00.000Z",
};

const connection = (change: Partial<CatalogConnection>): CatalogConnection => ({
  id: "c1",
  source: "composio",
  provider: "notes",
  scope: "personal",
  status: "active",
  ownerUserId: "u1",
  connectedBy: "u1",
  connectedByName: "Ada",
  accountName: null,
  createdAt: "2026-10-22T08:00:00.000Z",
  ...change,
});

const integrationOf = (connections: CatalogConnection[]): Integration => ({
  key: "composio:notes",
  source: "composio",
  id: "notes",
  name: "Notes",
  categories: [],
  group: "Other",
  description: null,
  auth: undefined,
  logo: null,
  toolCount: undefined,
  offered: true,
  listed: true,
  connections,
});

let root: Root | undefined;

/** The text of the disconnect dialog of the one connection `shown`. */
const disconnectDialog = async (shown: CatalogConnection): Promise<string> => {
  const core = {
    withSession: async <T,>(action: (session: unknown) => Promise<T>) =>
      await action({}),
  };
  const rootRoute = createRootRoute({
    component: () => (
      <ConnectionList
        held={undefined}
        identity={person}
        integration={integrationOf([shown])}
      />
    ),
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
  const trigger = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "Disconnect"
  );
  await act(async () => {
    trigger?.click();
    await Promise.resolve();
  });
  return document.querySelector('[role="dialog"]')?.textContent ?? "";
};

const erased = "Everything the Brain kept from it is erased for good.";

describe("disconnecting a connection", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("says what the Brain kept from it is erased when it may hold some, and nothing of the Brain when it can't", async () => {
    const mayHold = await disconnectDialog(connection({ keepsReads: true }));
    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    const never = await disconnectDialog(connection({}));

    expect({
      mayHold: mayHold.includes(erased),
      never: never.includes(erased),
      opened: never.includes("Disconnect Notes?"),
    }).toStrictEqual({ mayHold: true, never: false, opened: true });
  });
});

/** An admin of the company. */
const admin: Identity = { ...person, role: "admin" };

/** A shared connection to Notes, connected by an admin. */
const shared = connection({ scope: "shared", ownerUserId: null });

/** What the page asked of core, by method, and its arguments. */
type Asked = [string, ...unknown[]][];

/**
 * Shows the shared connection `shown` to an admin, with core answering
 * its audience (`audience`) and the company's teams, and records what
 * the page asks it to change.
 */
/** What the fake core holds of the connection: its audience, and whether it is being erased. */
interface Held {
  audience: { kind: string; teamId?: string };
  erasing: boolean;
}

/** How often the page read the audiences and the teams of core. */
interface Reads {
  audiences: number;
  teams: number;
}

/** What core refuses, as when the Brain is out of reach. */
type Refusing = "erase" | "change" | undefined;

/** The refusal's words, as core gives them. */
const refusal = "The Brain is out of reach.";

const asAdmin = async (
  shown: CatalogConnection,
  audience?: { kind: string; teamId?: string },
  /** What core holds, which a test changes as the clock would. */
  holding?: Held,
  {
    others = [],
    refusing,
    reads = { audiences: 0, teams: 0 },
  }: {
    /** More shared connections of the same integration, each with no audience. */
    others?: CatalogConnection[];
    refusing?: Refusing;
    /** Counted as the page reads. */
    reads?: Reads;
  } = {}
): Promise<Asked> => {
  const held = holding ?? {
    audience: audience ?? { kind: "nobody" },
    erasing: false,
  };
  const asked: Asked = [];
  const session = {
    connections: {
      // As core lists them: one with an audience or being erased.
      brainAudiences: async () => {
        reads.audiences += 1;
        return await Promise.resolve(
          held.audience.kind === "nobody" && !held.erasing
            ? []
            : [
                {
                  connectionId: shown.id,
                  audience: held.audience,
                  erasing: held.erasing,
                  changedBy: held.audience.kind === "nobody" ? null : "u2",
                  changedAt:
                    held.audience.kind === "nobody"
                      ? null
                      : "2026-11-17T08:00:00.000Z",
                },
              ]
        );
      },
      setBrainAudience: async (...given: unknown[]) => {
        asked.push(["setBrainAudience", ...given]);
        if (refusing === "change") {
          await Promise.resolve();
          throw new Error(refusal);
        }
        const [, next, from] = given;
        // As core: only from the audience held now.
        if (JSON.stringify(from) !== JSON.stringify(held.audience)) {
          await Promise.resolve();
          throw connectionErrors.create("connection.brain_audience_changed");
        }
        if (typeof next === "object" && next !== null && "kind" in next) {
          held.audience = {
            kind: String(next.kind),
            ...("teamId" in next ? { teamId: String(next.teamId) } : {}),
          };
        }
        await Promise.resolve();
      },
      // An erase takes the audience away and is under way until the
      // clock ends it.
      eraseBrainReads: async (...given: unknown[]) => {
        asked.push(["eraseBrainReads", ...given]);
        if (refusing === "erase") {
          await Promise.resolve();
          throw new Error(refusal);
        }
        held.audience = { kind: "nobody" };
        held.erasing = true;
        await Promise.resolve();
      },
    },
    organization: {
      teams: async () => {
        reads.teams += 1;
        return await Promise.resolve([{ id: "t1", name: "Sales" }]);
      },
    },
  };
  const core = {
    withSession: async <T,>(action: (given: unknown) => Promise<T>) =>
      await action(session),
  };
  const rootRoute = createRootRoute({
    component: () => (
      <ConnectionList
        held={undefined}
        identity={admin}
        integration={integrationOf([shown, ...others])}
      />
    ),
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
  // Its audience and the teams, read as the card opens.
  await act(async () => {
    await Promise.resolve();
  });
  return asked;
};

/** Chooses `value` in the card's Brain audience. */
const choose = async (value: string): Promise<void> => {
  const select = document.querySelector("select");
  await act(async () => {
    if (select !== null) {
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    await Promise.resolve();
  });
};

/** Presses the button whose text is `text`, in the dialog when there is one. */
const press = async (text: string): Promise<void> => {
  const button = [...document.querySelectorAll("button")].findLast(
    (each) => each.textContent === text
  );
  await act(async () => {
    button?.click();
    await Promise.resolve();
  });
};

/** The open dialog's text, or nothing. */
const dialogText = (): string =>
  document.querySelector('[role="dialog"]')?.textContent ?? "";

describe("a shared connection's Brain audience, for an admin", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("asks before it opens to everyone, saying what was kept before is shown too, and changes nothing when cancelled", async () => {
    const asked = await asAdmin(shared);
    await choose("everyone");
    const asking = dialogText();
    await press("Cancel");
    const afterCancel = [...asked];
    await choose("everyone");
    await press("Keep it for them");

    expect({
      asking: asking.includes(
        "Everyone in the company will be able to find what agents read through Notes, including what was kept before. Choose a team if not everyone should see it."
      ),
      afterCancel,
      asked,
    }).toStrictEqual({
      asking: true,
      afterCancel: [],
      asked: [
        ["setBrainAudience", "c1", { kind: "everyone" }, { kind: "nobody" }],
      ],
    });
  });

  it("names the team when it opens to one, closes to nobody without asking, and erases only once confirmed", async () => {
    // Core says the Brain holds some of it (`keepsReads`), so it may be
    // erased whatever its audience is now.
    const asked = await asAdmin(
      connection({ scope: "shared", ownerUserId: null, keepsReads: true }),
      { kind: "everyone" }
    );
    // Narrowing from everyone to a team shows it to fewer: no question.
    await choose("t1");
    await choose("nobody");
    await press("Erase what the Brain kept");
    const erasing = dialogText();
    await press("Erase for good");
    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    const fromNobody = await asAdmin(shared);
    await choose("t1");
    const toTeam = dialogText();

    expect({
      asked,
      erasing: erasing.includes("This can't be undone."),
      toTeam: toTeam.includes(
        "Everyone in Sales will be able to find what agents read through Notes, including what was kept before."
      ),
      fromNobody,
    }).toStrictEqual({
      asked: [
        [
          "setBrainAudience",
          "c1",
          { kind: "team", teamId: "t1" },
          { kind: "everyone" },
        ],
        [
          "setBrainAudience",
          "c1",
          { kind: "nobody" },
          { kind: "team", teamId: "t1" },
        ],
        ["eraseBrainReads", "c1"],
      ],
      erasing: true,
      toTeam: true,
      fromNobody: [],
    });
  });

  it("shows nobody, refuses a choice and says so while an erasure is under way, and asks before opening it once it has ended", async () => {
    const held: Held = { audience: { kind: "everyone" }, erasing: false };
    const kept = connection({
      scope: "shared",
      ownerUserId: null,
      keepsReads: true,
    });
    await asAdmin(kept, undefined, held);
    await press("Erase what the Brain kept");
    await press("Erase for good");
    // Read again from core.
    await act(async () => {
      await Promise.resolve();
    });
    const select = document.querySelector("select");
    const whileErasing = {
      shown: select?.value,
      disabled: select?.disabled,
      says: document.body.textContent.includes(
        "What the Brain kept from Notes is being erased. You can choose who may read it again once that is done."
      ),
    };
    // The clock ends the erasure; the admin comes back to the card.
    held.erasing = false;
    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    const asked = await asAdmin(kept, undefined, held);
    await choose("t1");

    expect({
      whileErasing,
      asking: dialogText().includes(
        "Everyone in Sales will be able to find what agents read through Notes, including what was kept before."
      ),
      asked,
    }).toStrictEqual({
      whileErasing: { shown: "nobody", disabled: true, says: true },
      asking: true,
      // Not chosen until confirmed.
      asked: [],
    });
  });

  it("keeps a refused erase's reason on the page after the audience is read again, and a refused change's too", async () => {
    const kept = connection({
      scope: "shared",
      ownerUserId: null,
      keepsReads: true,
    });
    await asAdmin(kept, { kind: "everyone" }, undefined, {
      refusing: "erase",
    });
    await press("Erase what the Brain kept");
    await press("Erase for good");
    await act(async () => {
      await Promise.resolve();
    });
    const afterErase = document.body.textContent.includes(refusal);
    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    await asAdmin(kept, { kind: "everyone" }, undefined, {
      refusing: "change",
    });
    await choose("nobody");
    await act(async () => {
      await Promise.resolve();
    });

    expect({
      afterErase,
      afterChange: document.body.textContent.includes(refusal),
    }).toStrictEqual({ afterErase: true, afterChange: true });
  });

  it("reads the audiences and the teams once for all the shared connections shown, and once again after a change", async () => {
    const reads: Reads = { audiences: 0, teams: 0 };
    await asAdmin(shared, { kind: "everyone" }, undefined, {
      others: [
        connection({ id: "c2", scope: "shared", ownerUserId: null }),
        connection({ id: "c3", scope: "shared", ownerUserId: null }),
      ],
      reads,
    });
    const opened = { ...reads };
    // The first card's choice: narrowing, so no question.
    await choose("nobody");
    await act(async () => {
      await Promise.resolve();
    });

    expect({ opened, changed: reads }).toStrictEqual({
      opened: { audiences: 1, teams: 1 },
      changed: { audiences: 2, teams: 1 },
    });
  });

  it("says the audience changed meanwhile when a choice was made from an old one, shows the one held now, and asks before opening it from there", async () => {
    const held: Held = { audience: { kind: "everyone" }, erasing: false };
    await asAdmin(shared, undefined, held);
    // Another admin closes it to nobody; this card still shows everyone.
    held.audience = { kind: "nobody" };
    // From everyone, a team narrows: no question, and core refuses it.
    await choose("t1");
    await act(async () => {
      await Promise.resolve();
    });
    const after = {
      says: document.body.textContent.includes(
        "Who may read what agents read through Notes was changed in the meantime. This is who may read it now: choose again if you still want to change it."
      ),
      shown: document.querySelector("select")?.value,
      held: held.audience,
    };
    await choose("t1");

    expect({
      after,
      asking: dialogText().includes(
        "Everyone in Sales will be able to find what agents read through Notes, including what was kept before."
      ),
    }).toStrictEqual({
      after: { says: true, shown: "nobody", held: { kind: "nobody" } },
      asking: true,
    });
  });

  it("reads the audience again when the window comes back, so an erasure that ended frees the choice", async () => {
    const held: Held = { audience: { kind: "nobody" }, erasing: true };
    await asAdmin(shared, undefined, held);
    const whileErasing = document.querySelector("select")?.disabled;
    held.erasing = false;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });

    expect({
      whileErasing,
      back: document.querySelector("select")?.disabled,
    }).toStrictEqual({ whileErasing: true, back: false });
  });

  it("is never shown to someone who isn't an admin, nor on a person's own connection", async () => {
    await asAdmin(connection({}));
    const own = document.querySelector("select");
    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    // The person, not an admin, on a shared connection.
    await disconnectDialog(shared);
    const member = document.querySelector("select");

    expect({ own, member }).toStrictEqual({ own: null, member: null });
  });
});
