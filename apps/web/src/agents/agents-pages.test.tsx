// @vitest-environment happy-dom
import type {
  Agent,
  AgentInput,
  AgentSettings,
  AgentWake,
} from "@grasp-os/shared/agents";
import type { ChatAgent } from "@grasp-os/shared/chat";
import { companyToolClasses } from "@grasp-os/shared/connect";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { AgentPage } from "./agent-page.tsx";
import type { AgentTab, FirstAgentAccess } from "./agent-page.tsx";
import { AgentsOverview } from "./agents-overview.tsx";
import type { ManagedAgents } from "./agents-overview.tsx";

// The Agents page and one agent's page, on what their routes read from
// core. These start from the ways the pages can fail: someone who isn't an
// admin shown agents that aren't theirs, or a way to change one; a chat
// offered with an agent that won't answer the person; a paused agent
// passed off as on; a change that sends core less than the whole agent
// and so wipes what wasn't on the card.

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
  instructions: `${name}'s instructions.`,
  ownerId: null,
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
        orgSettings: typeof orgSettings;
      }) => Promise<T>
    ): Promise<T> => await action({ connections, orgSettings }),
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

/** Each card as its name, where its name leads, and whether it offers a chat. */
const cards = () =>
  [
    ...document.querySelectorAll(
      "ul[aria-label='Your agents'] > li, ul[aria-label='Agents'] > li"
    ),
  ].map((card) => {
    const [name, ...others] = [...card.querySelectorAll("a")];
    return {
      name: name?.textContent,
      to: name?.getAttribute("href"),
      chat: others.map((link) => link.getAttribute("href")),
      text: card.textContent ?? "",
    };
  });

/** The button named `name` on the open tab, or outside the tabs. */
const buttonNamed = (name: string) =>
  [...document.querySelectorAll("button")].find(
    (each) =>
      each.textContent?.trim() === name &&
      each.closest("[role='tabpanel'][hidden]") === null
  );

/** One agent's page, as its route shows it. */
const page = (agent: Agent, tab: AgentTab, usable = true) => (
  <AgentPage
    agent={agent}
    documents={[]}
    editable
    first={agent.id === stephen.id}
    firstAccess={agent.id === stephen.id ? firstAccess : undefined}
    models={["anthropic/claude-sonnet-4-5", "anthropic/claude-opus-4-6"]}
    onTab={() => {}}
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
        <AgentsOverview
          makesOwn={false}
          own={[]}
          makes={false}
          managed={undefined}
          usable={[chatAgent(stephen), chatAgent(claire)]}
        />
      );
      expect(
        cards().map(({ name, to, chat }) => ({ name, to, chat }))
      ).toStrictEqual([
        {
          name: "Stephen",
          to: "/?agent=organization",
          chat: ["/?agent=organization"],
        },
        {
          name: "Claire",
          to: "/?agent=agent-claire",
          chat: ["/?agent=agent-claire"],
        },
      ]);
      expect({
        newAgent: document.querySelector("a[href='/agents/new']") !== null,
        says: document.body.textContent?.includes("Paused"),
      }).toStrictEqual({ newAgent: false, says: false });
    });

    it("shows a person their own agents apart from the company's, each opening its page, and offers to make one", async () => {
      const scribe = agentOf("agent-scribe", "Scribe", { ownerId: "user-me" });
      const idle = agentOf("agent-idle", "Idle", {
        ownerId: "user-me",
        state: "paused",
      });
      await mounted(
        <AgentsOverview
          makes={false}
          makesOwn
          managed={undefined}
          own={[scribe, idle]}
          // Core lists their own that are on among the ones they may ask.
          usable={[chatAgent(stephen), chatAgent(scribe)]}
        />
      );
      expect({
        cards: cards().map(({ name, to, chat }) => ({ name, to, chat })),
        groups: [...document.querySelectorAll("h2")].map(
          (each) => each.textContent
        ),
        newAgent: document.querySelector("a[href='/agents/new']") !== null,
        alone: document.body.textContent?.includes("Only you"),
      }).toStrictEqual({
        cards: [
          // Theirs first, each opening its page; a chat only with one on.
          {
            name: "Scribe",
            to: "/agents/agent-scribe",
            chat: ["/?agent=agent-scribe"],
          },
          { name: "Idle", to: "/agents/agent-idle", chat: [] },
          // Then the company's, once: never their own again.
          {
            name: "Stephen",
            to: "/?agent=organization",
            chat: ["/?agent=organization"],
          },
        ],
        groups: ["Yours", "Your company's"],
        newAgent: true,
        alone: true,
      });
    });

    it("shows an admin how many agents of their own each person has and what they cost, never their names, and turns them off", async () => {
      const people = [
        {
          userId: "user-anna",
          name: "Anna de Vries",
          email: "anna@acme.test",
          role: "user" as const,
          joinedAt: "2026-01-05T09:00:00.000Z",
        },
      ];
      const asked = await mounted(
        <AgentsOverview
          makes
          makesOwn
          managed={managed}
          own={[]}
          ownAdmin={{
            on: true,
            people,
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
          usable={[chatAgent(stephen)]}
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

    it("gives an admin among Grasp's staff no way to turn people's own agents off", async () => {
      const asked = await mounted(
        <AgentsOverview
          makes={false}
          makesOwn={false}
          managed={managed}
          own={[]}
          ownAdmin={{ on: true, people: [], usage: [] }}
          usable={[]}
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
            toggle.getAttribute("aria-disabled") === "true"),
        asked,
      }).toStrictEqual({ disabled: true, asked: [] });
    });

    it("shows an admin every agent, and offers a chat only with one that is on and answers them", async () => {
      await mounted(
        <AgentsOverview
          makesOwn={false}
          own={[]}
          makes
          managed={managed}
          // The admin isn't in Claire's teams; Milan is paused.
          usable={[chatAgent(stephen)]}
        />
      );
      expect(
        cards().map(({ name, to, chat }) => ({ name, to, chat }))
      ).toStrictEqual([
        {
          name: "Stephen",
          to: "/agents/organization",
          chat: ["/?agent=organization"],
        },
        { name: "Claire", to: "/agents/agent-claire", chat: [] },
        { name: "Milan", to: "/agents/agent-milan", chat: [] },
      ]);
      const [, clairesCard, milansCard] = cards();
      expect({
        claire: [
          "Finance",
          "3 of 6 kinds of work",
          "1 schedule",
          "$12.50 this month",
          "On",
        ].map((words) => clairesCard?.text.includes(words)),
        // Never asked this month: nothing about what it cost.
        milanCost: milansCard?.text.includes("this month"),
        milan: ["Nobody yet", "May do nothing yet", "Only when asked"].map(
          (words) => milansCard?.text.includes(words)
        ),
        milanPaused: milansCard?.text.endsWith("Paused"),
        newAgent: document.querySelector("a[href='/agents/new']") !== null,
      }).toStrictEqual({
        claire: [true, true, true, true, true],
        milanCost: false,
        milan: [true, true, true],
        milanPaused: true,
        newAgent: true,
      });
    });

    it("narrows an admin's list to the paused ones", async () => {
      await mounted(
        <AgentsOverview
          makesOwn={false}
          own={[]}
          makes
          managed={managed}
          usable={[chatAgent(stephen)]}
        />
      );
      await press(buttonNamed("Paused"));
      expect(cards().map(({ name }) => name)).toStrictEqual(["Milan"]);
    });
  });

  describe("one agent's page", () => {
    it("pauses the agent in core from its heading, and offers a chat only while it is on and answers the person", async () => {
      const asked = await mounted(page(claire, "overview"));
      expect(
        document.querySelector("a[href='/?agent=agent-claire']")?.textContent
      ).toBe("Chat with Claire");
      await press(document.querySelector("[role='switch']"));
      expect(asked).toStrictEqual([["paused", "agent-claire", true]]);
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

    it("has the first agent's access on its own page: where people reach it, with no way out to Settings", async () => {
      await mounted(page(stephen, "access"));
      const panel = document.querySelector("[role='tabpanel']:not([hidden])");
      expect({
        places: panel?.textContent?.includes("Where people reach him"),
        grasp: panel?.textContent?.includes("Grasp's chat"),
        link: document.querySelector("a[href='/settings/stephen']") !== null,
      }).toStrictEqual({ places: true, grasp: true, link: false });
    });

    it("saves new instructions with the agent's name and job as they were", async () => {
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
          "change",
          "agent-claire",
          {
            name: "Claire",
            job: "Chases invoices.",
            instructions: "Chase after 30 days.",
            face: "stephen",
            model: null,
            modelRole: null,
          },
        ],
      ]);
    });

    it("saves a picked picture and a model of its own, each with the rest as it was", async () => {
      const asked = await mounted(page(claire, "overview"));
      await press(document.querySelector("input[aria-label='Pen']"));
      const [saveProfile, saveModel] = [
        ...document.querySelectorAll("button"),
      ].filter((each) => each.textContent?.trim() === "Save");
      await press(saveProfile);
      const select = document.querySelector("select");
      if (select === null) {
        throw new TypeError("No model select");
      }
      await act(async () => {
        select.value = "anthropic/claude-opus-4-6";
        select.dispatchEvent(new Event("change", { bubbles: true }));
        await Promise.resolve();
      });
      await press(saveModel);
      const whole = {
        name: "Claire",
        job: "Chases invoices.",
        instructions: "Claire's instructions.",
        modelRole: null,
      };
      expect(asked).toStrictEqual([
        ["change", "agent-claire", { ...whole, face: "pen", model: null }],
        [
          "change",
          "agent-claire",
          { ...whole, face: "stephen", model: "anthropic/claude-opus-4-6" },
        ],
      ]);
    });

    it("deletes an agent only once the admin says so again, and offers no delete for the first agent", async () => {
      const asked = await mounted(page(claire, "overview"));
      await press(buttonNamed("Delete"));
      const before = [...asked];
      await press(buttonNamed("Delete for good"));
      act(() => {
        root?.unmount();
      });
      document.body.replaceChildren();
      await mounted(page(stephen, "overview"));
      expect({
        before,
        asked,
        firstOffers: buttonNamed("Delete") !== undefined,
      }).toStrictEqual({
        before: [],
        asked: [["deleted", "agent-claire"]],
        firstOffers: false,
      });
    });

    it("says what an agent used this month: how much and how often, never what", async () => {
      await mounted(page(claire, "overview"));
      const said = [...document.querySelectorAll("dl")]
        .at(1)
        ?.textContent?.replaceAll(/\s+/gu, " ");
      expect(
        [
          "November 2026",
          "Cost$12.50$3.00 the month before",
          "Requests to a model40",
          "People it worked for4",
          "Last asked",
        ].map(
          (words) =>
            (words === "November 2026"
              ? document.body.textContent
              : said
            )?.includes(words) ?? false
        )
      ).toStrictEqual([true, true, true, true, true]);
    });

    it("says an agent's access isn't shown where core didn't say it, never that it answers everyone", async () => {
      // As for an admin among Grasp's staff, whom core refuses the read.
      const unread: ManagedAgents = { ...managed, settings: {} };
      await mounted(
        <AgentsOverview
          makesOwn={false}
          own={[]}
          makes={false}
          managed={unread}
          usable={[chatAgent(stephen)]}
        />
      );
      const [firstCard, clairesCard] = cards();
      const onCards = {
        first: firstCard?.text.includes("Everyone with Grasp"),
        claire: clairesCard?.text.includes("Access not shown"),
        claireEveryone: clairesCard?.text.includes("Everyone"),
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
          models={[]}
          onTab={() => {}}
          people={[]}
          settings={undefined}
          tab="access"
          teams={teams}
          usable={false}
          usage={undefined}
          wakes={[]}
        />
      );
      const panel = document.querySelector("[role='tabpanel']:not([hidden])");
      expect({
        ...onCards,
        access: panel?.textContent?.includes("Access isn't shown"),
        everyone: document.body.textContent?.includes("Everyone"),
      }).toStrictEqual({
        first: true,
        claire: true,
        claireEveryone: false,
        access: true,
        everyone: false,
      });
    });
  });
});
