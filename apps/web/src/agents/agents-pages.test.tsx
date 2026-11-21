// @vitest-environment happy-dom
import type {
  Agent,
  AgentInput,
  AgentSettings,
  AgentWake,
} from "@grasp-os/shared/agents";
import type { ChatAgent } from "@grasp-os/shared/chat";
import { companyToolClasses } from "@grasp-os/shared/connect";
import type { InstructionFileRef } from "@grasp-os/shared/instruction-files";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, useState } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { AgentPage } from "./agent-page.tsx";
import type { FirstAgentAccess } from "./agent-page.tsx";
import { AgentsOverview } from "./agents-overview.tsx";
import type { ManagedAgents } from "./agents-overview.tsx";
import { OwnAgentsCard } from "./own-agents-admin.tsx";
import type { AgentsTab, AgentTab } from "./tabs.tsx";

// The Agents page and one agent's page, on what their routes read from
// core. These start from the ways the pages can fail: someone who isn't an
// admin shown agents that aren't theirs, or a way to change one; a chat
// offered with an agent that won't answer the person; a paused agent
// passed off as on; an agent that answers nobody else listed among the
// organization's, or the other way round; a change that sends core less
// than the whole agent and so wipes what wasn't on the card; a person's own agent shown to
// anyone else, or what it is told shown to an admin.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const teams = [
  { teamId: "team-finance", name: "Finance" },
  { teamId: "team-sales", name: "Sales" },
];

const agentOf = (id: string, name: string, change: Partial<Agent>): Agent => ({
  id,
  name,
  face: "stephen",
  job: `${name}'s job.`,
  ownerId: null,
  offeredAt: null,
  modelRole: null,
  model: null,
  state: "on",
  changedBy: null,
  changedAt: null,
  ...change,
});

const stephen = agentOf("organization", "Stephen", {});
const claire = agentOf("agent-claire", "Claire", { job: "Chases invoices." });
const milan = agentOf("agent-milan", "Milan", { state: "paused" });

const settingsOf = (
  audience: AgentSettings["audience"],
  on: number
): AgentSettings => ({
  on: true,
  audience,
  classes: companyToolClasses.map((toolClass, index) => ({
    toolClass,
    audience: index < on ? { who: "asClass" } : { who: "nobody" },
  })),
});

const wake: AgentWake = {
  id: "wake-1",
  agentId: claire.id,
  cron: "30 7 * * 1-5",
  timeZone: "Europe/Amsterdam",
  personId: "user-anna",
  opening: "Look for overdue invoices.",
  state: "on",
  nextAt: "2026-11-13T06:30:00.000Z",
  lastAt: null,
  lastOutcome: null,
};

/** A wake-up whose last run didn't start: no AI provider was connected. */
const failedWake: AgentWake = {
  ...wake,
  id: "wake-2",
  agentId: stephen.id,
  nextAt: null,
  state: "paused",
  lastAt: "2026-11-12T06:30:00.000Z",
  lastOutcome: "model.no_provider",
};

const managed: ManagedAgents = {
  agents: [stephen, claire, milan],
  settings: {
    [claire.id]: settingsOf({ who: "teams", teams: ["team-finance"] }, 3),
    [milan.id]: settingsOf({ who: "nobody" }, 0),
  },
  wakes: { [claire.id]: [wake] },
  usage: {
    [claire.id]: {
      agentId: claire.id,
      month: "2026-11",
      spent: 12.5,
      spentBefore: 3,
      requests: 40,
      people: 4,
      lastAt: "2026-11-12T08:00:00.000Z",
    },
    [milan.id]: {
      agentId: milan.id,
      month: "2026-11",
      spent: 0,
      spentBefore: 0,
      requests: 0,
      people: 0,
      lastAt: null,
    },
  },
  teams,
};

/** Every agent answers someone: none is only the admin's. */
const allShared: ManagedAgents = {
  ...managed,
  settings: {
    ...managed.settings,
    [milan.id]: settingsOf({ who: "everyone" }, 0),
  },
};

/** The first agent's access, as core keeps it for a company that changed nothing. */
const firstAccess: FirstAgentAccess = {
  reach: {
    on: true,
    audience: { who: "everyone" },
    changedBy: null,
    changedAt: null,
    places: [],
    apps: [],
    teams,
  },
  classes: [],
  week: null,
  workflows: null,
};

const chatAgent = ({ id, name, face, job, ownerId }: Agent): ChatAgent => ({
  id,
  name,
  face,
  job,
  model: null,
  own: ownerId !== null,
});

/** Anna, one of the company's people. */
const anna = {
  userId: "user-anna",
  name: "Anna de Vries",
  email: "anna@acme.test",
  role: "user" as const,
  joinedAt: "2026-01-05T09:00:00.000Z",
  suspension: null,
};

let root: Root | undefined;

/** What core was asked to change, in order. */
type Asked = unknown[][];

/** `shown` on a page of its own, with core's connections faked to keep what is asked. */
const mounted = async (shown: ReactNode): Promise<Asked> => {
  const asked: Asked = [];
  const connections = {
    changeAgent: async (id: string, input: AgentInput) => {
      await Promise.resolve();
      asked.push(["change", id, input]);
    },
    setAgentPaused: async (id: string, paused: boolean) => {
      await Promise.resolve();
      asked.push(["paused", id, paused]);
    },
    deleteAgent: async (id: string) => {
      await Promise.resolve();
      asked.push(["deleted", id]);
    },
    adoptAgent: async (id: string) => {
      await Promise.resolve();
      asked.push(["adopted", id]);
    },
    declineAgent: async (id: string) => {
      await Promise.resolve();
      asked.push(["declined", id]);
    },
  };
  const instructions = {
    save: async (saved: {
      file: InstructionFileRef;
      change: string;
      text: string;
      after: number;
    }) => {
      await Promise.resolve();
      asked.push(["told", saved.file, saved.text, saved.after]);
      return { version: saved.after + 1 };
    },
  };
  const orgSettings = {
    updateOwnAgents: async (settings: { on: boolean }) => {
      await Promise.resolve();
      asked.push(["own agents", settings]);
      return settings;
    },
  };
  const core = {
    withSession: async <T,>(
      action: (session: {
        connections: typeof connections;
        instructions: typeof instructions;
        orgSettings: typeof orgSettings;
      }) => Promise<T>
    ): Promise<T> => await action({ connections, instructions, orgSettings }),
  };
  const rootRoute = createRootRoute({ component: () => <main>{shown}</main> });
  const router = createRouter({
    routeTree: rootRoute,
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
  return asked;
};

/** Lets every pending promise and render settle. */
const settled = async (): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 0);
    await promise;
  });
};

const press = async (element: Element | null | undefined) => {
  if (!(element instanceof HTMLElement)) {
    throw new TypeError("Nothing to press");
  }
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await settled();
};

/** The agent page's "…" button in its heading. */
const moreButton = (): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>("button")].find((each) =>
    (each.getAttribute("aria-label") ?? "").startsWith("More for")
  );

/** The open menu's item whose words start with `words`. */
const menuItem = (words: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find(
    (each) => each.textContent.trim().startsWith(words)
  );

/** The agents' names, as the rows start with them. */
const names = ["Stephen", "Claire", "Milan", "Scribe", "Idle"];

/** Each card, the person's own first, as its name, where it leads, and whether it opens a chat. */
const cards = () =>
  [
    ...document.querySelectorAll(
      "ul[aria-label='Your agents'] > li, ul[aria-label='Agents'] > li"
    ),
  ].map((row) => {
    const text = row.textContent ?? "";
    const links = [...row.querySelectorAll("a")].map((link) =>
      link.getAttribute("href")
    );
    return {
      name: names.find((name) => text.includes(name)),
      to: links.find((href) => href?.startsWith("/agents/") === true),
      chat: links.filter((href) => href?.startsWith("/?agent=") === true),
      text,
    };
  });

/** No agents of the person's own. */
const noneOwn: readonly Agent[] = [];

/**
 * The Agents page as its route shows it: the tab chosen is kept, as the
 * address keeps it, starting from the one the address names (`at`).
 */
const Overview = ({
  at,
  own = noneOwn,
  makesOwn = false,
  ...page
}: Omit<
  ComponentProps<typeof AgentsOverview>,
  "tab" | "onTab" | "own" | "makesOwn"
> &
  Partial<Pick<ComponentProps<typeof AgentsOverview>, "own" | "makesOwn">> & {
    at?: AgentsTab;
  }) => {
  const [tab, setTab] = useState(at);
  return (
    <AgentsOverview
      {...page}
      makesOwn={makesOwn}
      onTab={setTab}
      own={own}
      tab={tab}
    />
  );
};

/** The overview's tabs, by their words, and which is chosen. */
const tabs = () =>
  [...document.querySelectorAll("[role='tab']")].map((tab) => ({
    name: tab.textContent,
    chosen: tab.getAttribute("aria-selected") === "true",
  }));

/** The overview's tab named `name`. */
const tabNamed = (name: string) =>
  [...document.querySelectorAll("[role='tab']")].find(
    (tab) => tab.textContent === name
  );

/** The button named `name` on the open tab, or outside the tabs. */
const buttonNamed = (name: string) =>
  [...document.querySelectorAll("button")].find(
    (each) =>
      each.textContent?.trim() === name && each.closest("[hidden]") === null
  );

/**
 * The button whose words start with `words`: a dialog's action also
 * holds the words it shows while working or failed, unseen.
 */
const buttonStarting = (words: string) =>
  [...document.querySelectorAll("button")].find((each) =>
    each.textContent?.trim().startsWith(words)
  );

/** One agent's page, as its route shows it. */
const page = (agent: Agent, tab: AgentTab, usable = true) => (
  <AgentPage
    agent={agent}
    documents={[]}
    editable
    first={agent.id === stephen.id}
    firstAccess={agent.id === stephen.id ? firstAccess : undefined}
    instructions={{ version: 3, text: `${agent.name}'s instructions.` }}
    models={["anthropic/claude-sonnet-4-5", "anthropic/claude-opus-4-6"]}
    people={[]}
    settings={managed.settings[agent.id]}
    tab={tab}
    teams={teams}
    usable={usable}
    usage={managed.usage[agent.id]}
    wakes={managed.wakes[agent.id] ?? []}
  />
);

describe("the company's agents, on pages of their own", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  describe("the Agents page", () => {
    it("shows someone who isn't an admin only their agents, each opening a chat with it and nothing to change", async () => {
      await mounted(
        <Overview
          makes={false}
          makesOwn={false}
          managed={undefined}
          own={[]}
          usable={[chatAgent(stephen), chatAgent(claire)]}
        />
      );
      expect(
        cards().map(({ name, to, chat }) => ({ name, to, chat }))
      ).toStrictEqual([
        { name: "Stephen", to: undefined, chat: ["/?agent=organization"] },
        { name: "Claire", to: undefined, chat: ["/?agent=agent-claire"] },
      ]);
      expect({
        newAgent: document.querySelector("a[href='/agents/new']") !== null,
        says: document.body.textContent?.includes("Paused"),
        // Every agent they see is shared with them: nothing to tell apart.
        tabs: tabs(),
      }).toStrictEqual({ newAgent: false, says: false, tabs: [] });
    });

    it("shows a person their own agents apart from the company's, each opening its page, and offers to make one", async () => {
      const scribe = agentOf("agent-scribe", "Scribe", { ownerId: "user-me" });
      const idle = agentOf("agent-idle", "Idle", {
        ownerId: "user-me",
        state: "paused",
      });
      await mounted(
        <Overview
          makes={false}
          makesOwn
          managed={undefined}
          own={[scribe, idle]}
          // Core lists their own that are on among the ones they may ask.
          usable={[chatAgent(stephen), chatAgent(scribe)]}
        />
      );
      const [scribesCard, idlesCard] = cards();
      const text = document.body.textContent ?? "";
      expect({
        cards: cards().map(({ name, to, chat }) => ({ name, to, chat })),
        groups: ["Yours", "Only you see and ask these.", "Your company's"].map(
          (words) => text.includes(words)
        ),
        alone: scribesCard?.text.includes("Just for me"),
        paused: idlesCard?.text.includes("Paused"),
        newAgent: document.querySelector("a[href='/agents/new']") !== null,
      }).toStrictEqual({
        cards: [
          // Theirs first, each opening its page, where its Chat is.
          { name: "Scribe", to: "/agents/agent-scribe", chat: [] },
          { name: "Idle", to: "/agents/agent-idle", chat: [] },
          // Then the company's, once: never their own again.
          { name: "Stephen", to: undefined, chat: ["/?agent=organization"] },
        ],
        groups: [true, true, true],
        alone: true,
        paused: true,
        newAgent: true,
      });
    });

    it("offers no chat with one of a person's own the company turned off, and still opens its page", async () => {
      const scribe = agentOf("agent-scribe", "Scribe", { ownerId: "user-me" });
      await mounted(
        <Overview
          makes={false}
          makesOwn={false}
          managed={undefined}
          own={[scribe]}
          // Off: core lists none of their own as theirs to ask.
          usable={[chatAgent(stephen)]}
        />
      );
      expect(cards().find(({ name }) => name === "Scribe")).toMatchObject({
        to: "/agents/agent-scribe",
        chat: [],
      });
    });

    it("tells someone who may make an agent of their own that they can, where they have none", async () => {
      await mounted(
        <Overview
          makes={false}
          makesOwn
          managed={undefined}
          own={[]}
          usable={[]}
        />
      );
      expect({
        said: document.body.textContent?.includes(
          "You can also make one of your own."
        ),
        newAgent: document.querySelector("a[href='/agents/new']") !== null,
      }).toStrictEqual({ said: true, newAgent: true });
    });

    it("shows an admin how many agents of their own each person has and what they cost, never their names, and turns them off", async () => {
      const asked = await mounted(
        <OwnAgentsCard
          admin={{
            on: true,
            people: [anna],
            usage: [
              {
                personId: "user-anna",
                agents: 2,
                month: "2026-11",
                spent: 1.5,
                spentBefore: 0,
                requests: 4,
              },
              {
                personId: "user-gone",
                agents: 1,
                month: "2026-11",
                spent: 0,
                spentBefore: 0,
                requests: 0,
              },
            ],
          }}
          editable={true}
        />
      );
      const text = document.body.textContent ?? "";
      const toggle = document.querySelector(
        "[role='switch'][aria-label='Let people make agents of their own']"
      );
      await press(toggle);
      expect({
        anna: text.includes("Anna de Vries") && text.includes("2 agents"),
        spent: text.includes("$1.50 this month"),
        gone: text.includes("Someone no longer in the company"),
        asked,
      }).toStrictEqual({
        anna: true,
        spent: true,
        gone: true,
        asked: [["own agents", { on: false }]],
      });
    });

    it("names nobody as gone where the company's people couldn't be read", async () => {
      await mounted(
        <OwnAgentsCard
          admin={{
            on: true,
            people: undefined,
            usage: [
              {
                personId: "user-anna",
                agents: 1,
                month: "2026-11",
                spent: 0,
                spentBefore: 0,
                requests: 0,
              },
            ],
          }}
          editable={true}
        />
      );
      const text = document.body.textContent ?? "";
      expect({
        unnamed: text.includes("Name not shown"),
        gone: text.includes("Someone no longer in the company"),
      }).toStrictEqual({ unnamed: true, gone: false });
    });

    it("gives an admin among Grasp's staff no way to turn people's own agents off", async () => {
      const asked = await mounted(
        <OwnAgentsCard
          admin={{ on: true, people: [], usage: [] }}
          editable={false}
        />
      );
      const toggle = document.querySelector(
        "[role='switch'][aria-label='Let people make agents of their own']"
      );
      await press(toggle);
      expect({
        disabled:
          toggle instanceof HTMLElement &&
          (Object.hasOwn(toggle.dataset, "disabled") ||
            toggle.getAttribute("aria-disabled") === "true" ||
            toggle.hasAttribute("disabled")),
        asked,
      }).toStrictEqual({ disabled: true, asked: [] });
    });

    it("shows an admin the agents people offered the company and who from, and takes one on or declines it", async () => {
      const offered = [
        agentOf("agent-scribe", "Scribe", {
          ownerId: "user-anna",
          offeredAt: "2026-11-13T09:00:00.000Z",
        }),
        agentOf("agent-idle", "Idle", {
          ownerId: "user-gone",
          offeredAt: "2026-11-13T10:00:00.000Z",
        }),
      ];
      const asked = await mounted(
        <Overview
          at="organization"
          makes
          makesOwn
          managed={managed}
          offered={{ agents: offered, people: [anna] }}
          own={[]}
          usable={[chatAgent(stephen)]}
        />
      );
      const text = document.body.textContent ?? "";
      await press(
        document.querySelector("[aria-label='Take Scribe on for the company']")
      );
      const [, declineIdle] = [...document.querySelectorAll("button")].filter(
        (each) => each.textContent?.trim() === "Decline"
      );
      await press(declineIdle);
      expect({
        from: text.includes("From Anna de Vries"),
        gone: text.includes("From Someone no longer in the company"),
        asked,
      }).toStrictEqual({
        from: true,
        gone: true,
        asked: [
          ["adopted", "agent-scribe"],
          ["declined", "agent-idle"],
        ],
      });
    });

    it("gives an admin among Grasp's staff no way to take an offered agent on", async () => {
      await mounted(
        <Overview
          at="organization"
          makes={false}
          makesOwn={false}
          managed={managed}
          offered={{
            agents: [
              agentOf("agent-scribe", "Scribe", {
                ownerId: "user-anna",
                offeredAt: "2026-11-13T09:00:00.000Z",
              }),
            ],
            people: [],
          }}
          own={[]}
          usable={[]}
        />
      );
      expect({
        listed: document.body.textContent?.includes("Scribe"),
        takeOn: document.querySelector(
          "[aria-label='Take Scribe on for the company']"
        ),
      }).toStrictEqual({ listed: true, takeOn: null });
    });

    it("shows an admin every agent of the company under Organization, each card opening its page with whom it answers at its foot", async () => {
      await mounted(
        <Overview
          makes
          managed={{
            ...managed,
            wakes: { ...managed.wakes, [stephen.id]: [failedWake] },
          }}
          // The admin isn't in Claire's teams; Milan is paused.
          usable={[chatAgent(stephen)]}
        />
      );
      // With no tab in the address and none of their own, the company's:
      // Milan too, though he answers nobody yet.
      const organization = { tabs: tabs(), cards: cards() };
      await press(tabNamed("My agents"));
      expect({
        organization: {
          tabs: organization.tabs,
          cards: organization.cards.map(({ name, to, chat }) => ({
            name,
            to,
            chat,
          })),
        },
        mine: cards(),
      }).toStrictEqual({
        organization: {
          tabs: [
            { name: "My agents", chosen: false },
            { name: "Organization", chosen: true },
          ],
          cards: [
            { name: "Stephen", to: "/agents/organization", chat: [] },
            { name: "Claire", to: "/agents/agent-claire", chat: [] },
            { name: "Milan", to: "/agents/agent-milan", chat: [] },
          ],
        },
        mine: [],
      });
      const [stephensCard, clairesCard, milansCard] = organization.cards;
      expect({
        // Whom each answers, and how it stands.
        claire: clairesCard?.text.includes("Finance"),
        stephen: ["Everyone", "Last run failed"].map((words) =>
          stephensCard?.text.includes(words)
        ),
        milan: ["Nobody yet", "Paused"].map((words) =>
          milansCard?.text.includes(words)
        ),
        newAgent: document.querySelector("a[href='/agents/new']") !== null,
      }).toStrictEqual({
        claire: true,
        stephen: [true, true],
        milan: [true, true],
        newAgent: true,
      });
    });

    it("opens an admin with no agent of their own on the organization's, with no tab in the address", async () => {
      await mounted(
        <Overview makes managed={allShared} usable={[chatAgent(stephen)]} />
      );
      expect({
        tabs: tabs(),
        cards: cards().map(({ name }) => name),
      }).toStrictEqual({
        tabs: [
          { name: "My agents", chosen: false },
          { name: "Organization", chosen: true },
        ],
        cards: ["Stephen", "Claire", "Milan"],
      });
    });

    it("opens on the tab the address names, and says so where it has no agents", async () => {
      await mounted(
        <Overview
          at="mine"
          makes
          managed={allShared}
          usable={[chatAgent(stephen)]}
        />
      );
      expect({
        tabs: tabs(),
        cards: cards().map(({ name }) => name),
        says: document.body.textContent?.includes(
          "Agents only you can use stand here."
        ),
      }).toStrictEqual({
        tabs: [
          { name: "My agents", chosen: true },
          { name: "Organization", chosen: false },
        ],
        cards: [],
        says: true,
      });
    });

    it("puts an admin's own agents under My agents, and none of the company's", async () => {
      const scribe = agentOf("agent-scribe", "Scribe", { ownerId: "user-me" });
      await mounted(
        <Overview
          makes
          managed={managed}
          own={[scribe]}
          usable={[chatAgent(stephen), chatAgent(scribe)]}
        />
      );
      const [scribesCard] = cards();
      expect({
        tabs: tabs(),
        cards: cards().map(({ name, to, chat }) => ({ name, to, chat })),
        alone: scribesCard?.text.includes("Just for me"),
      }).toStrictEqual({
        tabs: [
          { name: "My agents", chosen: true },
          { name: "Organization", chosen: false },
        ],
        cards: [{ name: "Scribe", to: "/agents/agent-scribe", chat: [] }],
        alone: true,
      });
    });

    it("says with an admin's card what is worth knowing before opening it", async () => {
      await mounted(
        <Overview
          at="organization"
          makes
          makesOwn={false}
          managed={managed}
          own={[]}
          usable={[chatAgent(stephen)]}
        />
      );
      // What the card's link is described by: read out with its name, and
      // what grows inside the card for who rests on it.
      const card = document.querySelector("a[href='/agents/agent-claire']");
      const said = (card?.getAttribute("aria-describedby") ?? "")
        .split(" ")
        .map((id) => document.querySelector(`#${id}`)?.textContent ?? "")
        .join(" ");
      expect(
        ["Finance", "On its own", "Model", "This month", "$12.50"].map(
          (words) => said.includes(words)
        )
      ).toStrictEqual([true, true, true, true, true]);
    });
  });

  describe("one agent's page", () => {
    it("says in words how its last run went, never core's code for it", async () => {
      await mounted(
        <AgentPage
          agent={claire}
          documents={[]}
          editable
          first={false}
          firstAccess={undefined}
          instructions={undefined}
          models={[]}
          people={[]}
          settings={managed.settings[claire.id]}
          tab="overview"
          teams={teams}
          usable
          usage={undefined}
          wakes={[{ ...failedWake, agentId: claire.id }]}
        />
      );
      const said = document.body.textContent ?? "";
      expect({
        why: said.includes("no AI provider is connected"),
        code: said.includes("model.no_provider"),
      }).toStrictEqual({ why: true, code: false });
    });

    it("offers a chat with an agent that is on and answers the person", async () => {
      await mounted(page(claire, "overview"));
      expect(
        document.querySelector("a[href='/?agent=agent-claire']")?.textContent
      ).toBe("Chat");
    });

    it("offers no chat with an agent that is paused, or that doesn't answer the person", async () => {
      await mounted(page(milan, "overview"));
      const paused = document.querySelector("a[href^='/?agent=']");
      act(() => {
        root?.unmount();
      });
      document.body.replaceChildren();
      await mounted(page(claire, "overview", false));
      expect({
        paused: paused === null,
        notTheirs: document.querySelector("a[href^='/?agent=']") === null,
      }).toStrictEqual({ paused: true, notTheirs: true });
    });

    it("saves new instructions as the agent's instruction file, after the version it showed", async () => {
      const asked = await mounted(page(claire, "instructions"));
      const box = document.querySelector("textarea");
      if (box === null) {
        throw new TypeError("No instructions box");
      }
      await act(async () => {
        const prototype = Reflect.getPrototypeOf(box) ?? {};
        Reflect.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
          box,
          "Chase after 30 days."
        );
        box.dispatchEvent(new Event("input", { bubbles: true }));
        await Promise.resolve();
      });
      await press(buttonNamed("Save"));
      expect(asked).toStrictEqual([
        [
          "told",
          { scope: "agent", agentId: "agent-claire" },
          "Chase after 30 days.",
          3,
        ],
      ]);
    });

    it("deletes an agent only once the admin says so again, and offers no delete for the first agent", async () => {
      const asked = await mounted(page(claire, "overview"));
      await press(moreButton());
      await press(menuItem("Delete"));
      const before = [...asked];
      await press(buttonStarting("Delete for good"));
      act(() => {
        root?.unmount();
      });
      document.body.replaceChildren();
      await mounted(page(stephen, "overview"));
      expect({
        before,
        asked,
        firstOffers: await (async () => {
          await press(moreButton());
          return menuItem("Delete") !== undefined;
        })(),
      }).toStrictEqual({
        before: [],
        asked: [["deleted", "agent-claire"]],
        firstOffers: false,
      });
    });

    it("says what an agent used this month: how much and how often, never what", async () => {
      await mounted(page(claire, "overview"));
      const said = document.body.textContent ?? "";
      expect(
        [
          "$12.50",
          "40 requests to a model",
          "for 4 people",
          "$3.00 the month before",
          "Last asked in a chat",
        ].map((words) => said.includes(words))
      ).toStrictEqual([true, true, true, true, true]);
    });

    it("says nothing of whom an agent answers where core didn't say it, never that it answers everyone", async () => {
      // As for an admin among Grasp's staff, whom core refuses the read.
      const unread: ManagedAgents = { ...managed, settings: {} };
      await mounted(
        <Overview
          makes={false}
          makesOwn={false}
          managed={unread}
          own={[]}
          usable={[chatAgent(stephen)]}
        />
      );
      const [firstCard, clairesCard] = cards();
      const onCards = {
        first: firstCard?.text.includes("Everyone"),
        // No pill: neither everyone nor nobody.
        claireEveryone: clairesCard?.text.includes("Everyone"),
        claireNobody: clairesCard?.text.includes("Nobody yet"),
      };
      act(() => {
        root?.unmount();
      });
      document.body.replaceChildren();
      await mounted(
        <AgentPage
          agent={claire}
          documents={[]}
          editable={false}
          first={false}
          instructions={undefined}
          models={[]}
          people={[]}
          settings={undefined}
          tab="access"
          teams={teams}
          usable={false}
          usage={undefined}
          wakes={[]}
        />
      );
      const panel = document.body;
      expect({
        ...onCards,
        access: panel?.textContent?.includes("Access isn't shown"),
        everyone: document.body.textContent?.includes("Everyone"),
      }).toStrictEqual({
        first: true,
        claireEveryone: false,
        claireNobody: false,
        access: true,
        everyone: false,
      });
    });
  });
});
