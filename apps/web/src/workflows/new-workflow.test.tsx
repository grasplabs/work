// @vitest-environment happy-dom
import type { BusinessProcess } from "@grasp-os/shared/business-processes";
import type {
  ChatMessage,
  ChatQuestion,
  ChatSummary,
  ChatUpdate,
} from "@grasp-os/shared/chat";
import { workflowNameSchema } from "@grasp-os/shared/workflow-resources";
import type {
  WorkflowDraft,
  WorkflowResource,
} from "@grasp-os/shared/workflow-resources";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useLoaderData,
  useParams,
} from "@tanstack/react-router";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { activeChat, setActiveChat } from "../chat/active-chat.ts";
import { ChatDock } from "../chat/chat-dock.tsx";
import { setDockMode } from "../chat/dock-mode.ts";
import { useDraftFromChat } from "./draw-in-chat.ts";
import { NewWorkflow } from "./independent-workflows.tsx";
import { workflowNameOf } from "./new-workflow.ts";
import { WorkflowFlow } from "./workflow-flow.tsx";

// New workflow, against core's workflowResources and chats as the page
// reaches them over RPC, faked: it creates a workflow and opens it, its
// Flow empty and a new chat docked open beside it, saying how it works
// here and asking which business process the workflow is for. Choosing
// one sets it on the workflow and asks it, naming the workflow, in a new
// ordinary chat (`chats.create`), which stays the person's like any other;
// as the chat's agent edits the draft, the Flow draws the draft's latest
// revision that passes.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const builder = "builder-1";

/** The draft of a workflow nobody edited yet: nothing passed, nothing drawn. */
const untouched: WorkflowDraft = {
  revision: 0,
  source: "{}",
  modules: {},
  problems: [],
  checkpoint: null,
  editedBy: null,
  editedAt: null,
};

/** The draft once the chat's agent saved its first step, which passes. */
const drawn: WorkflowDraft = {
  revision: 1,
  source: JSON.stringify({ do: [{ "receive-invoice": { set: {} } }] }),
  modules: {},
  problems: [],
  checkpoint: {
    revision: 1,
    source: JSON.stringify({ do: [{ "receive-invoice": { set: {} } }] }),
    diagram: {
      tasks: [
        {
          id: "receive-invoice",
          pointer: "/do/0/receive-invoice",
          kind: "set",
          label: null,
          detail: null,
          guarded: false,
          next: { kind: "continue" },
          scopes: [],
        },
      ],
    },
  },
  editedBy: builder,
  editedAt: "2026-11-03T09:00:00.000Z",
};

/**
 * Core as the page reaches it: workflows a builder creates, each with a
 * draft and a process, and the person's chat for each, whose watch the
 * test drives (`chatSays`). What the page asked, in `asked`.
 */
const fakeCore = () => {
  const asked: unknown[][] = [];
  const workflows = new Map<string, WorkflowResource>();
  let draft = untouched;
  let watcher: ((update: ChatUpdate) => void) | undefined;
  const session = {
    workflowResources: {
      create: async (name: string): Promise<WorkflowResource> => {
        await Promise.resolve();
        asked.push(["create", name]);
        const made: WorkflowResource = {
          id: crypto.randomUUID(),
          namespace: "workspace",
          name,
          owner: builder,
          currentVersion: null,
          role: "builder",
          process: null,
          createdAt: "2026-11-03T09:00:00.000Z",
        };
        workflows.set(made.id, made);
        return made;
      },
      draft: async (id: string): Promise<WorkflowDraft> => {
        await Promise.resolve();
        asked.push(["draft", id]);
        return draft;
      },
      setProcess: async (
        id: string,
        process: BusinessProcess | null
      ): Promise<WorkflowResource> => {
        await Promise.resolve();
        asked.push(["setProcess", id, process]);
        const found = workflows.get(id);
        if (found === undefined) {
          throw new Error(`No workflow ${id}`);
        }
        const set = { ...found, process };
        workflows.set(id, set);
        return set;
      },
    },
    chats: {
      models: async (): Promise<string[]> => {
        await Promise.resolve();
        return ["openai/gpt-5-mini"];
      },
      efforts: async (): Promise<Record<string, never>> => {
        await Promise.resolve();
        return {};
      },
      create: async (title: string): Promise<ChatSummary> => {
        await Promise.resolve();
        asked.push(["chat", title]);
        return {
          id: "new-chat",
          title,
          createdAt: "2026-11-03T09:00:00.000Z",
          lastAt: "2026-11-03T09:00:00.000Z",
          running: false,
          appId: null,
          via: "web",
        };
      },
      send: async (chatId: string, question: ChatQuestion): Promise<void> => {
        await Promise.resolve();
        asked.push(["send", chatId, question.text]);
      },
      watch: async (
        _chatId: string,
        _after: number | null,
        received: (update: ChatUpdate) => void
      ) => {
        await Promise.resolve();
        watcher = received;
        return {
          release: async (): Promise<void> => {
            await Promise.resolve();
          },
          [Symbol.dispose]: (): void => {
            watcher = undefined;
          },
        };
      },
    },
  };
  return {
    asked,
    core: {
      withSession: async <T,>(
        action: (reached: typeof session) => Promise<T>
      ): Promise<T> => await action(session),
    },
    workflow: (id: string): WorkflowResource | undefined => workflows.get(id),
    /** Core's draft from now on, as the chat's agent saved it. */
    saves: (next: WorkflowDraft): void => {
      draft = next;
    },
    /** The chat's watch says `messages` so far, and whether its agent works. */
    chatSays: (messages: ChatMessage[], running: boolean): void => {
      watcher?.({
        messages,
        partial: null,
        running,
        stopped: null,
        held: 0,
        drafts: 0,
      });
    },
  };
};

type FakeCore = ReturnType<typeof fakeCore>;

/** The workflow page as far as it matters here: its Flow, following its chat. */
const WorkflowPage = ({
  workflow,
  first,
}: {
  workflow: string;
  first: WorkflowDraft;
}) => {
  const [draft, setDraft] = useState(first);
  useDraftFromChat(workflow, setDraft);
  return (
    <WorkflowFlow
      draft={draft}
      onDefinition={() => {
        // Not here.
      }}
      onDraft={setDraft}
      onTriggers={() => {
        // Not here.
      }}
      workflow={workflow}
    />
  );
};

/** The workflow page once its loader read it, as the page's own route reads it. */
const LoadedPage = () => {
  const from = "/_shell/workflows/$workflow";
  const { workflow } = useParams({ from });
  const { draft } = useLoaderData({ from });
  return draft?.state === "ready" ? (
    <WorkflowPage first={draft.data} workflow={workflow} />
  ) : null;
};

/** The Workflows page, in a frame with the chat dock, at its list. */
const shown = async (fake: FakeCore) => {
  const rootRoute = createRootRoute();
  const shell = createRoute({
    getParentRoute: () => rootRoute,
    id: "_shell",
    beforeLoad: () => ({
      identity: {
        userId: builder,
        email: "builder@example.test",
        name: "Builder",
        role: "builder",
        teams: [],
        staff: false,
        expiresAt: "2026-11-04T09:00:00.000Z",
      },
    }),
    component: () => (
      <>
        <Outlet />
        <ChatDock />
      </>
    ),
  });
  const list = createRoute({
    getParentRoute: () => shell,
    path: "workflows",
    component: NewWorkflow,
  });
  const page = createRoute({
    getParentRoute: () => shell,
    path: "workflows/$workflow",
    loader: async ({ params }) => {
      const found = fake.workflow(params.workflow);
      const draft = await fake.core.withSession(
        async (session) =>
          await session.workflowResources.draft(params.workflow)
      );
      // As the workflow page's own loader reads them.
      return {
        resource:
          found === undefined
            ? ({ state: "missing" } as const)
            : ({ state: "ready", data: found } as const),
        draft: { state: "ready", data: draft } as const,
      };
    },
    component: LoadedPage,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([shell.addChildren([list, page])]),
    history: createMemoryHistory({ initialEntries: ["/workflows"] }),
    context: { core: fake.core },
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
  return router;
};

/** Lets every reply already on its way arrive, timers included. */
const settled = async (): Promise<void> => {
  await act(async () => {
    for (let turn = 0; turn < 5; turn += 1) {
      const { promise, resolve } = Promise.withResolvers<boolean>();
      setTimeout(() => {
        resolve(true);
      }, 0);
      // oxlint-disable-next-line no-await-in-loop -- one turn after another
      await promise;
    }
  });
};

/** The button named `name`. */
const button = (name: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll("button")].find(
    (each) => each.textContent?.trim() === name
  );
  if (found === undefined) {
    throw new Error(`No button ${name}`);
  }
  return found;
};

/** Presses the button named `name`, and lets core answer. */
const press = async (name: string): Promise<void> => {
  const found = button(name);
  await act(async () => {
    found.click();
    await Promise.resolve();
  });
  await settled();
};

/** Picks the choice labelled `label`. */
const pick = (label: string): void => {
  const found = [...document.querySelectorAll("label")].find(
    (each) => each.textContent === label
  );
  const radio =
    found === undefined
      ? null
      : document.querySelector<HTMLElement>(`#${CSS.escape(found.htmlFor)}`);
  if (radio === null) {
    throw new Error(`No choice ${label}`);
  }
  act(() => {
    radio.click();
  });
};

/** The open dock, by its name. */
const dock = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('section[aria-label="Ask Grasp"]');

/** The names of the steps the Flow draws. */
const drawnSteps = (): string[] =>
  [...document.querySelectorAll("[data-ground] li[aria-label]")].map(
    (step) => step.getAttribute("aria-label") ?? ""
  );

describe("New workflow", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
    setDockMode("bar");
    setActiveChat(undefined);
  });

  it("opens a new workflow on its empty Flow, with a new chat docked open beside it asking which business process it is for", async () => {
    // The chat the person had open stays theirs, in Chat; the dock starts anew.
    setActiveChat("chat-about-holidays");
    const fake = fakeCore();
    const router = await shown(fake);

    await press("New workflow");
    const [[, name] = []] = fake.asked;
    const open = dock();

    expect({
      created: typeof name === "string" && name.startsWith("new-workflow-"),
      at: router.state.location.pathname.startsWith("/workflows/"),
      empty: document.body.textContent.includes(
        "Nothing is drawn yet. Tell Grasp in the chat how this work runs and its steps come here."
      ),
      drawn: drawnSteps(),
      docked: open?.textContent.includes(
        "Tell me how this work runs today, step by step: who does what, in which app, and how often. I draw it as you go."
      ),
      asks: open?.textContent.includes(
        "Which business process is this workflow for?"
      ),
      choices: [...(open?.querySelectorAll("label") ?? [])].map(
        (label) => label.textContent
      ),
      open: activeChat(),
      // No chat made before the person answers.
      chats: fake.asked.filter(([call]) => call === "chat"),
    }).toStrictEqual({
      created: true,
      at: true,
      empty: true,
      drawn: [],
      docked: true,
      asks: true,
      choices: [
        "Opportunity-to-Cash",
        "Issue-to-Resolution",
        "Purchase-to-Pay",
        "Risk-to-Compliance",
        "Record-to-Report",
        "Hire-to-Retire",
        "Something else",
      ],
      open: undefined,
      chats: [],
    });
  });

  it("sets the process chosen, asks it in a new ordinary chat that names the workflow, and draws the draft as the chat's agent edits it", async () => {
    const fake = fakeCore();
    const router = await shown(fake);
    await press("New workflow");
    const [[, name] = []] = fake.asked;
    const workflow = router.state.location.pathname.split("/").at(-1) ?? "";
    const asked = `Which business process is this workflow for? Purchase-to-Pay\n\nWorkflow ${String(name)} (ID ${workflow}) is open beside this chat.`;

    pick("Purchase-to-Pay");
    await press("Send");
    // The agent works: it saves a first step, which passes.
    const question: ChatMessage = {
      id: 1,
      role: "user",
      text: asked,
      at: "2026-11-03T09:00:00.000Z",
    };
    await act(async () => {
      fake.chatSays([question], true);
      await Promise.resolve();
    });
    await settled();
    fake.saves(drawn);
    const answer: ChatMessage = {
      id: 2,
      role: "assistant",
      text: "Drawn: an invoice comes in. Who checks it?",
      citations: [],
      code: [],
      tools: [],
      end: "done",
      at: "2026-11-03T09:00:01.000Z",
    };
    await act(async () => {
      fake.chatSays([question, answer], false);
      await Promise.resolve();
    });
    await settled();

    expect({
      process: fake.asked.find(([call]) => call === "setProcess"),
      // An ordinary chat, named after the question.
      chat: fake.asked.find(([call]) => call === "chat"),
      sent: fake.asked.find(([call]) => call === "send"),
      open: activeChat(),
      drawn: drawnSteps(),
    }).toStrictEqual({
      process: ["setProcess", workflow, "p2p"],
      chat: [
        "chat",
        "Which business process is this workflow for? Purchase-to-Pay",
      ],
      sent: ["send", "new-chat", asked],
      open: "new-chat",
      drawn: ["receive-invoice"],
    });
  });
});

// A workflow made from a project's New dialog takes its name from what
// was typed, in the form core accepts (`workflowNameSchema`), whatever was
// typed.
describe("a new workflow's name", () => {
  it("is one core accepts, from whatever was typed", () => {
    const typed = [
      "Invoice approvals",
      "Q1 cash — Ünïcödé!!",
      "",
      "   ",
      "-",
      "x".repeat(200),
    ];

    const names = typed.map(workflowNameOf);

    expect({
      valid: names.map((name) => workflowNameSchema.safeParse(name).success),
      words: names.map((name) => name.slice(0, -9)),
    }).toStrictEqual({
      valid: [true, true, true, true, true, true],
      words: [
        "invoice-approvals",
        "q1-cash-unicode",
        "new-workflow",
        "new-workflow",
        "new-workflow",
        "x".repeat(48),
      ],
    });
  });
});
