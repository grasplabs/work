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

const chatAgent = ({ id, name, face, job }: Agent): ChatAgent => ({
  id,
  name,
  face,
  job,
  model: null,
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
  const core = {
    withSession: async <T,>(
      action: (session: { connections: typeof connections }) => Promise<T>
    ): Promise<T> => await action({ connections }),
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

/** The agents' names, as the rows start with them. */
const names = ["Stephen", "Claire", "Milan"];

/** Each row as its name, where its name leads, and whether it offers a chat. */
const cards = () =>
  [...document.querySelectorAll("ul[aria-label='Agents'] > li")].map((row) => {
    const text = row.textContent ?? "";
    const links = [...row.querySelectorAll("a")].map((link) =>
      link.getAttribute("href")
    );
    return {
      name: names.find((name) => text.startsWith(name)),
      to: links.find((href) => href?.startsWith("/agents/") === true),
      chat: links.filter((href) => href?.startsWith("/?agent=") === true),
      text,
    };
  });

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

/** The fact row named `name` that opens to say more. */
const factNamed = (name: string) =>
  [...document.querySelectorAll("button[aria-labelledby]")].find(
    (each) =>
      document.querySelector(
        `#${CSS.escape(each.getAttribute("aria-labelledby") ?? "")}`
      )?.textContent === name
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
          models={[]}
          makes={false}
          managed={undefined}
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
        newAgent: buttonNamed("New agent") !== undefined,
        says: document.body.textContent?.includes("Paused"),
      }).toStrictEqual({ newAgent: false, says: false });
    });

    it("shows an admin every agent, and offers a chat only with one that is on and answers them", async () => {
      await mounted(
        <AgentsOverview
          models={[]}
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
        ].map((words) => clairesCard?.text.includes(words)),
        // Never asked this month: nothing about what it cost.
        milanCost: milansCard?.text.includes("this month"),
        milan: ["Nobody yet", "May do nothing yet"].map((words) =>
          milansCard?.text.includes(words)
        ),
        milanPaused: milansCard?.text.includes("Paused"),
        newAgent: buttonNamed("New agent") !== undefined,
      }).toStrictEqual({
        claire: [true, true, true, true],
        milanCost: false,
        milan: [true, true],
        milanPaused: true,
        newAgent: true,
      });
    });

    it("narrows an admin's list to the paused ones", async () => {
      await mounted(
        <AgentsOverview
          models={[]}
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
      ).toBe("Chat");
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
      const panel = document.body;
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

    it("saves a picked picture with the rest of the agent as it was", async () => {
      const asked = await mounted(page(claire, "overview"));
      await press(buttonNamed("Edit"));
      await press(document.querySelector("[aria-label='Pen']"));
      await press(
        [...document.querySelectorAll("[role='dialog'] button")].find(
          (each) => each.textContent?.trim() === "Save"
        )
      );
      const whole = {
        name: "Claire",
        job: "Chases invoices.",
        instructions: "Claire's instructions.",
        modelRole: null,
      };
      expect(asked).toStrictEqual([
        ["change", "agent-claire", { ...whole, face: "pen", model: null }],
      ]);
    });

    it("deletes an agent only once the admin says so again, and offers no delete for the first agent", async () => {
      const asked = await mounted(page(claire, "overview"));
      await press(buttonNamed("Delete"));
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
        firstOffers: buttonNamed("Delete") !== undefined,
      }).toStrictEqual({
        before: [],
        asked: [["deleted", "agent-claire"]],
        firstOffers: false,
      });
    });

    it("says what an agent used this month: how much and how often, never what", async () => {
      await mounted(page(claire, "overview"));
      await press(factNamed("November 2026"));
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

    it("says an agent's access isn't shown where core didn't say it, never that it answers everyone", async () => {
      // As for an admin among Grasp's staff, whom core refuses the read.
      const unread: ManagedAgents = { ...managed, settings: {} };
      await mounted(
        <AgentsOverview
          models={[]}
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
        claire: true,
        claireEveryone: false,
        access: true,
        everyone: false,
      });
    });
  });
});
