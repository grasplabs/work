// @vitest-environment happy-dom

import { SidebarProvider } from "@grasp-os/app-kit/components/sidebar";
import type { Blueprint } from "@grasp-os/shared/apps";
import type { ChatAgent, ChatMake, ChatQuestion } from "@grasp-os/shared/chat";
import { blueprintIdSchema } from "@grasp-os/shared/ids";
import type { Opportunity } from "@grasp-os/shared/opportunities";
import type { Identity } from "@grasp-os/shared/rpc";
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

import type { Loaded } from "../load-from-core.tsx";
import { examplesFor } from "../make/examples.ts";
import { activeChat } from "./active-chat.ts";
import { ChatStart } from "./chat-start.tsx";
import type { MakeIdeas } from "./chat-start.tsx";
import { GlobalChatProvider } from "./global-chat.tsx";
import { typeInPrompt } from "./test-typing.ts";

// Chat's own page from Make something: ideas to start from in place of the
// questions (an App's blueprints, a workflow's starting sentences), each
// only filling the box, nothing made; from an opportunity an admin drafts,
// the box starts with its brief, nothing asked until it is sent; the
// first question makes the chat with what to make, which the chat keeps.
// Core is faked at its session.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const identity: Identity = {
  userId: "user-1",
  email: "user-1@acme.test",
  name: "user-1",
  role: "builder",
  teams: [],
  staff: false,
  expiresAt: "2026-11-01T09:00:00.000Z",
};

const blueprint: Blueprint = {
  id: blueprintIdSchema.parse("blueprint-1"),
  name: "Service desk",
  description: "Every client question, until it's solved.",
  app: null,
  version: null,
  markedBy: null,
  markedAt: "2026-10-01T08:00:00.000Z",
  permissions: [],
};

const settled = async (): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 10);
    await promise;
  });
};

const agent = (id: string, name: string): ChatAgent => ({
  id,
  name,
  face: "",
  job: "",
  model: null,
  own: false,
});

/** A team's routine as an admin reads it on Opportunities. */
const opportunity: Opportunity = {
  routine: "work-1",
  evidence: "drawing-1",
  name: "handling client requests",
  local: "klantverzoeken afhandelen",
  team: "team-1",
  steps: ["Read the request", "Look it up in Exact", "Send the quote"],
  casesPerWeek: 50,
  hoursPerWeek: 20.8,
  basis: "described",
  seen: null,
  differs: null,
  form: "workflow",
  covers: null,
  setup: ["Exact"],
  personApproves: [3],
  dismissed: false,
};

/**
 * Chat's page, from Make something `make` with `ideas`, against a fake
 * core whose person may talk to `agents`; the address naming `named`, and
 * the opportunity `from` whose brief the box starts with.
 */
const shown = async (
  make?: ChatMake,
  ideas?: MakeIdeas,
  {
    agents = [],
    named,
    from,
    models = Promise.resolve(["openai/gpt-5"]),
  }: {
    agents?: ChatAgent[];
    named?: string;
    from?: Opportunity;
    /** What core says the models are, once it does. */
    models?: Promise<string[]>;
  } = {}
) => {
  const asked: string[] = [];
  const chats = {
    models: async () => await models,
    efforts: async () => await Promise.resolve({}),
    list: async () => await Promise.resolve([]),
    agents: async () => await Promise.resolve(agents),
    create: async (title: string, agentId?: string, made?: ChatMake) => {
      const by = agentId === undefined ? "" : ` with ${agentId}`;
      asked.push(`create ${title} ${JSON.stringify(made ?? null)}${by}`);
      return await Promise.resolve({ id: "chat-1", title });
    },
    send: async (chatId: string, question: ChatQuestion) => {
      asked.push(
        `send ${chatId} ${question.text}${question.mentions === undefined ? "" : ` ${JSON.stringify(question.mentions)}`}`
      );
      await Promise.resolve();
    },
    watch: async () => await Promise.withResolvers<never>().promise,
    summary: async () => await Promise.withResolvers<never>().promise,
  };
  const core = {
    withSession: async <T,>(
      action: (session: { chats: typeof chats }) => Promise<T>
    ): Promise<T> => await action({ chats }),
  };
  const rootRoute = createRootRoute({ component: Outlet });
  const shell = createRoute({
    getParentRoute: () => rootRoute,
    id: "_shell",
    beforeLoad: () => ({ identity }),
    component: () => (
      <SidebarProvider>
        <GlobalChatProvider>
          <Outlet />
        </GlobalChatProvider>
      </SidebarProvider>
    ),
  });
  const read: Promise<Loaded<MakeIdeas>> | undefined =
    ideas === undefined
      ? undefined
      : Promise.resolve({ state: "ready", data: ideas });
  const page = createRoute({
    getParentRoute: () => shell,
    path: "/",
    component: () => (
      <ChatStart
        agent={named}
        ideas={read}
        make={make}
        opportunity={
          from === undefined
            ? undefined
            : Promise.resolve({ state: "ready", data: from })
        }
      />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([shell.addChildren([page])]),
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
  await settled();
  return { asked };
};

const box = (): HTMLElement => {
  const found = document.querySelector<HTMLElement>('[role="textbox"]');
  if (found === null) {
    throw new Error("No box to ask in");
  }
  return found;
};

/** The box's Send, or Stop. */
const submit = (): HTMLElement => {
  const found = document.querySelector<HTMLElement>(
    '[data-slot="prompt-input-end"] button'
  );
  if (found === null) {
    throw new Error("No Send");
  }
  return found;
};

/** A button by its name. */
const buttonNamed = (name: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find(
    (each) =>
      each.getAttribute("aria-label") === name || each.textContent === name
  );

/** What the lines under the box say. */
const notes = (): string[] =>
  [...document.querySelectorAll('[data-slot="prompt-input-note"]')].map(
    (each) => each.textContent
  );

/** Each idea's press: its title, stretched over the tile. */
const tiles = (): HTMLButtonElement[] => [
  ...document.querySelectorAll<HTMLButtonElement>(
    '[aria-label="Ideas to start from"] button'
  ),
];

/** The ideas offered: each tile's title, and the line under it. */
const ideas = (): string[][] =>
  tiles().map((each) => [
    each.textContent,
    document.querySelector(`[id="${each.getAttribute("aria-describedby")}"]`)
      ?.textContent ?? "",
  ]);

const pick = async (title: string): Promise<void> => {
  const tile = tiles().find((each) => each.textContent === title);
  await act(async () => {
    tile?.click();
    await Promise.resolve();
  });
  await settled();
};

describe("Chat's page from Make something", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
    localStorage.clear();
  });

  it("offers an App's blueprints, each filling the box with a sentence naming it, and makes nothing", async () => {
    const { asked } = await shown(
      { kind: "app", project: "project-1" },
      { kind: "app", blueprints: [blueprint] }
    );
    const offered = ideas();

    await pick("Service desk");

    expect({ offered, box: box().textContent, asked }).toStrictEqual({
      offered: [["Service desk", "Every client question, until it's solved."]],
      box: "Make an App from the Service desk blueprint: Every client question, until it's solved.",
      asked: [],
    });
  });

  it("offers a workflow a few starting sentences from the business processes, filling the box", async () => {
    const { asked } = await shown(
      { kind: "workflow" },
      { kind: "workflow", examples: examplesFor(["r2r"]) }
    );
    const offered = ideas();

    await pick("Track the month-end close");

    expect({ offered, box: box().textContent, asked }).toStrictEqual({
      offered: [
        ["Track the month-end close", "Record-to-Report"],
        ["Approve big invoices", "Purchase-to-Pay"],
        ["Onboard a new hire", "Hire-to-Retire"],
      ],
      box: "Keep track of the month-end close: who does what, and remind people when they're late.",
      asked: [],
    });
  });

  it("starts the box with the brief of an opportunity an admin drafts, and asks nothing until it is sent", async () => {
    const { asked } = await shown({ kind: "workflow" }, undefined, {
      from: opportunity,
    });
    const before = [...asked];
    const brief = [
      "Draft a workflow for the opportunity “Handling client requests (klantverzoeken afhandelen)”.",
      "How the team does it today:",
      "1. Read the request",
      "2. Look it up in Exact",
      "3. Send the quote (a person approves this step)",
      "Cases a week: 50.",
      "Hours a week by hand: 20.8.",
      "Connect first: Exact.",
    ];

    await act(async () => {
      box().closest("form")?.requestSubmit();
      await Promise.resolve();
    });
    await settled();

    expect({ before, asked }).toStrictEqual({
      before: [],
      // Make something's own chat, made to make a workflow and named
      // after the brief's first words, its first question the brief, a
      // paragraph a line.
      asked: [
        'create Draft a workflow for the opportunity “Handling client requests (klantverzoeken … {"kind":"workflow"}',
        `send chat-1 ${brief.join("\n")}`,
      ],
    });
  });

  it("starts the brief of an opportunity only seen in activity with the steps seen, the ones that copy data marked", async () => {
    const { asked } = await shown({ kind: "workflow" }, undefined, {
      from: {
        ...opportunity,
        name: "Exact invoices.read → Google Sheets rows.add",
        local: undefined,
        steps: [],
        casesPerWeek: null,
        hoursPerWeek: null,
        basis: "observed",
        seen: {
          steps: [
            {
              system: "Exact",
              step: "invoices.read",
              hoursAfter: null,
              copied: false,
            },
            {
              system: "Google Sheets",
              step: "rows.add",
              hoursAfter: 1,
              copied: true,
            },
          ],
          variants: [],
        },
        setup: [],
        personApproves: [],
      },
    });

    await act(async () => {
      box().closest("form")?.requestSubmit();
      await Promise.resolve();
    });
    await settled();

    expect(asked.at(-1)).toBe(
      `send chat-1 ${[
        "Draft a workflow for the opportunity “Exact invoices.read → Google Sheets rows.add”.",
        "What five or more of the team were seen doing:",
        "1. Exact: invoices.read",
        "2. Google Sheets: rows.add (copied from another system)",
      ].join("\n")}`
    );
  });

  it("makes the chat with what to make, which it keeps, on the first question", async () => {
    const { asked } = await shown({
      kind: "app",
      project: "project-1",
    });

    await act(async () => {
      typeInPrompt(box(), "Track the month-end close");
      await Promise.resolve();
    });
    await act(async () => {
      box().closest("form")?.requestSubmit();
      await Promise.resolve();
    });
    await settled();

    expect({ asked, open: activeChat() }).toStrictEqual({
      asked: [
        'create Track the month-end close {"kind":"app","project":"project-1"}',
        "send chat-1 Track the month-end close",
      ],
      // The chat it made opens, over the page.
      open: "chat-1",
    });
  });

  it("without Make something, asks as ever: no ideas, a chat with nothing to make", async () => {
    const { asked } = await shown();

    await act(async () => {
      typeInPrompt(box(), "What waits on me today?");
      await Promise.resolve();
    });
    await act(async () => {
      box().closest("form")?.requestSubmit();
      await Promise.resolve();
    });
    await settled();

    expect({ ideas: ideas(), asked }).toStrictEqual({
      ideas: [],
      asked: [
        "create What waits on me today? null",
        "send chat-1 What waits on me today?",
      ],
    });
  });

  it("sends a question asked before core has said which models there are once it has, with no second press", async () => {
    const models = Promise.withResolvers<string[]>();
    const { asked } = await shown(undefined, undefined, {
      models: models.promise,
    });

    await act(async () => {
      typeInPrompt(box(), "What waits on me today?");
      await Promise.resolve();
    });
    await act(async () => {
      box().closest("form")?.requestSubmit();
      await Promise.resolve();
    });
    await settled();
    const before = [...asked];
    await act(async () => {
      models.resolve(["openai/gpt-5"]);
      await models.promise;
    });
    await settled();

    expect({ before, asked }).toStrictEqual({
      before: [],
      asked: [
        "create What waits on me today? null",
        "send chat-1 What waits on me today?",
      ],
    });
  });

  it("lets a question held for the models go unsent once core can't say which there are, says why, and keeps its words", async () => {
    const models = Promise.withResolvers<string[]>();
    const { asked } = await shown(undefined, undefined, {
      models: models.promise,
    });

    await act(async () => {
      typeInPrompt(box(), "What waits on me today?");
      await Promise.resolve();
    });
    await act(async () => {
      box().closest("form")?.requestSubmit();
      await Promise.resolve();
    });
    await settled();
    const working = submit().getAttribute("aria-busy");
    // Core out of reach, as the chat says it.
    const reason = "Grasp can't be reached right now. Try again in a moment.";
    await act(async () => {
      models.reject(new Error("The models can't be read"));
      await models.promise.catch(() => {});
    });
    await settled();

    expect({
      working,
      asked,
      box: box().textContent,
      busy: submit().getAttribute("aria-busy"),
      // Under the box, and on the page with the way to read them again.
      notes: notes(),
      page: document.body.textContent.split(reason).length - 1,
      retry: buttonNamed("Try again") !== undefined,
    }).toStrictEqual({
      working: "true",
      asked: [],
      box: "What waits on me today?",
      busy: null,
      notes: ["Could not send. Your message is kept.", reason],
      page: 2,
      retry: true,
    });
  });

  it("lets a question held for the models go unsent on Stop, its words kept", async () => {
    const models = Promise.withResolvers<string[]>();
    const { asked } = await shown(undefined, undefined, {
      models: models.promise,
    });

    await act(async () => {
      typeInPrompt(box(), "What waits on me today?");
      await Promise.resolve();
    });
    await act(async () => {
      box().closest("form")?.requestSubmit();
      await Promise.resolve();
    });
    await settled();
    await act(async () => {
      buttonNamed("Stop")?.click();
      await Promise.resolve();
    });
    await settled();
    await act(async () => {
      models.resolve(["openai/gpt-5"]);
      await models.promise;
    });
    await settled();

    expect({ asked, box: box().textContent }).toStrictEqual({
      asked: [],
      box: "What waits on me today?",
    });
  });

  it("mentions the agent the address names in the box, so the question goes to it, among those the person may talk to", async () => {
    const { asked } = await shown(undefined, undefined, {
      agents: [agent("organization", "Grasp"), agent("agent-2", "Claire")],
      named: "agent-2",
    });
    const prefilled = [
      ...box().querySelectorAll('[data-slot="token-input-token"]'),
    ].map((chip) => chip.textContent);

    await act(async () => {
      typeInPrompt(box(), "Which invoices are late?");
      await Promise.resolve();
    });
    await act(async () => {
      box().closest("form")?.requestSubmit();
      await Promise.resolve();
    });
    await settled();

    expect({ prefilled, asked }).toStrictEqual({
      // A chip, which shows the agent's name.
      prefilled: ["Claire"],
      asked: [
        "create @Claire Which invoices are late? null with agent-2",
        'send chat-1 @Claire Which invoices are late? [{"kind":"agent","id":"agent-2"}]',
      ],
    });
  });

  it("mentions nobody for an agent the person may not talk to", async () => {
    await shown(undefined, undefined, {
      agents: [agent("organization", "Grasp")],
      named: "agent-hidden",
    });
    expect(box().textContent).toBe("");
  });
});
