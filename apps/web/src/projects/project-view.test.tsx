// @vitest-environment happy-dom
import type { AppOverview } from "@grasp-os/shared/apps";
import type { ChatSummary } from "@grasp-os/shared/chat";
import { appIdSchema } from "@grasp-os/shared/ids";
import type {
  FileItem,
  NewProjectMember,
  Project,
  ProjectConnections,
  ProjectCursor,
  ProjectItemCandidate,
  ProjectItemsPage,
  ProjectItemRef,
  ProjectMemberRef,
  ProjectShareCandidates,
} from "@grasp-os/shared/projects";
import { SidebarProvider } from "@grasp-os/ui/components/sidebar";
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

import type { OverviewRow } from "../workflows/overview.ts";
import { ProjectView } from "./project-view.tsx";
import type { ProjectTab } from "./project-view.tsx";

// A project's page against core's projects API as the page reaches it
// over RPC (the boundary from the web app), faked: it keeps what is filed
// in the project and whether it is shared with it. From the ways it can
// fail: filing sharing what nobody chose to share; access going without
// saying whose; someone who only uses the project changing it.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const candidates: ProjectItemCandidate[] = [
  { type: "workflow", id: "wf-quotes", name: "Quotes", builds: true },
];

const project = (role: Project["role"]): Project => ({
  id: "project-1",
  name: "Sell & get paid",
  description: "Quotes to cash",
  icon: "coins",
  role,
  counts: { apps: 0, workflows: 1, connections: 0 },
  owner: { id: "user-olga", name: "Olga" },
  members: [
    {
      type: "person",
      id: "user-ada",
      name: "Ada",
      role: "user",
      addedBy: "user-olga",
      addedAt: "2026-11-01T09:00:00.000Z",
    },
  ],
  moreMembers: false,
  people: 2,
  items: [
    {
      type: "workflow",
      id: "wf-invoices",
      name: "Invoices",
      sharedAs: "user",
      builds: true,
      addedAt: "2026-11-01T10:00:00.000Z",
    },
  ],
  moreItems: false,
  shared: 1,
});

/** Desk, an App filed after Invoices. */
const desk: ProjectItemsPage["items"][number] = {
  type: "app",
  id: "app-desk",
  name: "Desk",
  sharedAs: null,
  builds: true,
  addedAt: "2026-11-02T10:00:00.000Z",
};

/** Invoices again, moved later by a share changed since it was shown. */
const invoicesMoved: ProjectItemsPage["items"][number] = {
  type: "workflow",
  id: "wf-invoices",
  name: "Invoices",
  sharedAs: "builder",
  builds: true,
  addedAt: "2026-11-01T12:00:00.000Z",
};

/** A chat of the person's, as their list gives it. */
const chatOf = (id: string, title: string): ChatSummary => ({
  id,
  title,
  agentId: "grasp",
  createdAt: "2026-11-01T10:00:00.000Z",
  lastAt: "2026-11-01T10:00:00.000Z",
  running: false,
  make: null,
  archived: false,
});

const accruals = chatOf("chat-accruals", "Accruals");

/** Core's projects API, keeping each call it was asked. */
const fakeProjects = (
  pages: ProjectItemsPage[] = [{ items: [desk], more: false }],
  /** The people core offers to add. */
  people: ProjectShareCandidates["people"] = [
    { id: "user-bo", name: "Bo" },
    { id: "user-cy", name: "Cy" },
  ]
) => {
  const left = [...pages];
  const asked: unknown[][] = [];
  const workflowResources = {
    create: async (
      name: string,
      inProject?: string
    ): Promise<{ id: string }> => {
      await Promise.resolve();
      asked.push(["create", name.slice(0, -9), inProject]);
      return { id: "wf-made" };
    },
  };
  const projects = {
    shareCandidates: async (): Promise<ProjectShareCandidates> => {
      await Promise.resolve();
      asked.push(["shareCandidates"]);
      return { people, teams: [{ id: "team-sales", name: "Sales" }] };
    },
    addMember: async (_id: string, member: NewProjectMember): Promise<void> => {
      await Promise.resolve();
      if (member.id === "user-cy") {
        throw new Error("Cy can't be added.");
      }
      asked.push(["addMember", member.type, member.id, member.role]);
    },
    removeMember: async (
      _id: string,
      member: ProjectMemberRef
    ): Promise<void> => {
      await Promise.resolve();
      asked.push(["removeMember", member.type, member.id]);
    },
    itemCandidates: async (): Promise<ProjectItemCandidate[]> => {
      await Promise.resolve();
      return candidates;
    },
    file: async (_id: string, file: FileItem): Promise<void> => {
      await Promise.resolve();
      asked.push(["file", file.item.id, file.share]);
    },
    unfile: async (_id: string, item: ProjectItemRef): Promise<void> => {
      await Promise.resolve();
      asked.push(["unfile", item.id]);
    },
    // The pages after Invoices, one each time it is asked.
    items: async (
      _id: string,
      after: ProjectCursor
    ): Promise<ProjectItemsPage> => {
      await Promise.resolve();
      asked.push(["items", after.type, after.id, after.at]);
      return left.shift() ?? { items: [], more: false };
    },
  };
  const chats = {
    // The person's chats: Lunch, and Accruals, which is in the project.
    list: async (): Promise<ChatSummary[]> => {
      await Promise.resolve();
      return [chatOf("chat-lunch", "Lunch"), accruals];
    },
    setProject: async (chatId: string, inProject: string | null) => {
      await Promise.resolve();
      asked.push(["setProject", chatId, inProject]);
    },
  };
  return { session: { projects, workflowResources, chats }, asked };
};

/** A workflow as the Workflows page reads it, live and quiet. */
const workflowRow = (id: string, name: string): OverviewRow => ({
  id,
  name,
  phase: "running",
  paused: false,
  blocked: null,
  role: "builder",
  process: null,
  owner: "Olga",
  runs: null,
  version: 1,
  waiting: 0,
  failed: 0,
  lastRun: null,
});

let root: Root | undefined;

const settled = async (): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 0);
    await promise;
  });
};

/** The page of `shownProject`, on what `session` holds, on `tab`. */
const shown = async (
  session: ReturnType<typeof fakeProjects>["session"],
  shownProject: Project,
  {
    chatsInIt = [],
    tab = "overview",
    connections = { connections: [], unseen: 0 },
    workflows = [],
    apps = [],
  }: {
    chatsInIt?: ChatSummary[];
    tab?: ProjectTab;
    connections?: ProjectConnections;
    workflows?: OverviewRow[];
    apps?: AppOverview[];
  } = {}
) => {
  const core = {
    withSession: async <T,>(
      run: (reached: typeof session) => Promise<T>
    ): Promise<T> => await run(session),
  };
  const rootRoute = createRootRoute({
    component: () => (
      <ProjectView
        chats={chatsInIt}
        connections={connections}
        apps={apps}
        identity={{ role: "builder", staff: false, userId: "user-ada" }}
        project={shownProject}
        tab={tab}
        workflows={workflows}
      />
    ),
  });
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
        <SidebarProvider>
          <RouterProvider router={router} />
        </SidebarProvider>
      </I18nProvider>
    );
    await router.load();
  });
  await settled();
  return router;
};

const press = async (element: Element | undefined | null) => {
  if (!(element instanceof HTMLElement)) {
    throw new TypeError("Nothing to press");
  }
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await settled();
};

const button = (name: string) =>
  [...document.querySelectorAll("button")].find(
    (each) =>
      each.textContent?.trim() === name ||
      each.getAttribute("aria-label") === name
  );

/** A button inside the open dialog, by its words. */
const inDialog = (name: string) =>
  [...document.querySelectorAll('[role="dialog"] button')].find(
    (each) => each.textContent?.trim() === name
  );

const link = (name: string) =>
  [...document.querySelectorAll("a")].find(
    (each) => each.textContent?.trim() === name
  );

const type = async (input: Element | null, value: string) => {
  if (!(input instanceof HTMLInputElement)) {
    throw new TypeError("Nothing to type in");
  }
  await act(async () => {
    // Through the element's own setter, as typing reaches React.
    Reflect.set(HTMLInputElement.prototype, "value", value, input);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
};

/** What an element says, without the words it keeps hidden for working or failed. */
const words = (element: Element): string => {
  const copy = element.cloneNode(true);
  if (!(copy instanceof Element)) {
    return "";
  }
  for (const hidden of copy.querySelectorAll("[aria-hidden='true']")) {
    hidden.remove();
  }
  return copy.textContent?.trim() ?? "";
};

/** The field of the picker of people and teams to add. */
const field = (): HTMLInputElement | null =>
  document.querySelector<HTMLInputElement>(
    "input[aria-label='Search people and teams']"
  );

/** Opens the picker's list, as the person does from its field. */
const openPicker = async (): Promise<void> => {
  const box = field();
  if (box === null) {
    throw new TypeError("No picker");
  }
  await act(async () => {
    box.focus();
    box.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })
    );
    await Promise.resolve();
  });
  await settled();
};

/** The options the open picker shows, each as its lines read. */
const optionLines = (): string[] =>
  [...document.querySelectorAll("[role=option]")].map(words);

/** Picks the option whose name is `name`. */
const pickOption = async (name: string): Promise<void> => {
  await press(
    [...document.querySelectorAll("[role=option]")].find(
      (each) => (each.getAttribute("aria-label") ?? words(each)) === name
    )
  );
};

/** Chooses `choice` in the open list of a Select. */
const choose = async (choice: string): Promise<void> => {
  await press(
    [...document.querySelectorAll("[role=option]")].find(
      (each) => words(each) === choice
    )
  );
};

/** Takes the page away, as leaving it does. */
const cleared = (): void => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  document.body.replaceChildren();
};

describe("A project's page", () => {
  afterEach(cleared);

  it("makes an App in the project from its empty line, making nothing until asked, with the project carried along", async () => {
    const { session, asked } = fakeProjects();
    const router = await shown(session, project("builder"));

    await press(link("Make an App"));

    expect({
      asked,
      at: router.state.location.pathname,
      search: { ...router.state.location.search },
    }).toStrictEqual({
      asked: [],
      at: "/",
      search: { make: "app", project: "project-1" },
    });
  });

  it("adds a workflow without sharing it unless asked, and names who would gain access", async () => {
    const { session, asked } = fakeProjects();
    await shown(session, project("builder"), { tab: "workflows" });

    await press(button("Add"));
    // Found by name in the list, as a person picks it.
    await press(
      document.querySelector(
        '[role="dialog"] [aria-label="Show the apps and workflows"]'
      )
    );
    await press(
      [...document.querySelectorAll('[role="option"]')].find(
        (each) => each.textContent?.trim() === "Quotes"
      )
    );
    const share = document.querySelector('[role="dialog"] [role="checkbox"]');
    const offer = document.body.textContent ?? "";
    await press(
      [...document.querySelectorAll('[role="dialog"] button')].find((each) =>
        each.textContent?.trim().startsWith("Add")
      )
    );

    expect({
      checked: share?.getAttribute("aria-checked"),
      // The question, and who that is under it.
      offer: [
        offer.includes("Also give the 2 people in Sell & get paid access?"),
        offer.includes("That is Olga and Ada."),
      ],
      asked,
    }).toStrictEqual({
      checked: "false",
      offer: [true, true],
      asked: [["file", "wf-quotes", false]],
    });
  });

  it("adds people and teams in a role, from who core offers when the people open, and says why an add was refused", async () => {
    const { session, asked } = fakeProjects();
    await shown(session, project("builder"), { tab: "people" });

    const before = [...asked];
    await openPicker();
    const names = optionLines();
    // Every ID holds an "s" ("user-…", "team-…"): only names are searched.
    await type(field(), "s");
    const found = optionLines();
    await type(field(), "");
    // One at a time, each in the role last chosen.
    await pickOption("Bo");
    await press(button("Access for who you add"));
    await choose("Builder");
    await press(button("Add"));
    await openPicker();
    await pickOption("Sales (team)");
    await press(button("Add"));
    await openPicker();
    await pickOption("Cy");
    await press(button("Add"));

    expect({
      before,
      names,
      found,
      asked,
      refused: document.body.textContent?.includes("Cy can't be added."),
    }).toStrictEqual({
      // Opening the People tab is opening the people.
      before: [["shareCandidates"]],
      names: ["Bo", "Cy", "Sales (team)"],
      found: ["Sales (team)"],
      asked: [
        ["shareCandidates"],
        ["addMember", "person", "user-bo", "builder"],
        // Whom to offer is read again after each change, so who was just
        // added isn't offered again.
        ["shareCandidates"],
        ["addMember", "team", "team-sales", "builder"],
        ["shareCandidates"],
        // And after Cy's refused add, as the project is read again.
        ["shareCandidates"],
      ],
      refused: true,
    });
  });

  it("tells apart someone offered from someone of the same name in it already, by the end of their ID", async () => {
    const { session } = fakeProjects(undefined, [
      { id: "user-ada-222222", name: "Ada" },
      { id: "user-bo", name: "Bo" },
    ]);
    await shown(session, project("builder"), { tab: "people" });

    await openPicker();
    const options = optionLines();

    // The Ada in it is the only one it lists, so it names her as before.
    expect({
      options,
      inIt: button("Access for Ada") !== undefined,
    }).toStrictEqual({
      options: ["AdaID …222222", "Bo", "Sales (team)"],
      inIt: true,
    });
  });

  it("names members of the same name apart, to change or take out", async () => {
    const { session } = fakeProjects();
    const [ada] = project("builder").members;
    if (ada === undefined) {
      throw new TypeError("No member to copy");
    }
    await shown(
      session,
      {
        ...project("builder"),
        members: [ada, { ...ada, id: "user-ada-222222" }],
      },
      { tab: "people" }
    );

    expect([
      button("Access for Ada (ID …er-ada)") !== undefined,
      button("Access for Ada (ID …222222)") !== undefined,
    ]).toStrictEqual([true, true]);
  });

  it("changes someone's role, and takes them out only once they confirm, naming what they lose", async () => {
    const { session, asked } = fakeProjects();
    await shown(session, project("builder"), { tab: "people" });

    await press(button("Access for Ada"));
    await choose("Builder");
    const takeOut = async (): Promise<void> => {
      await press(button("Access for Ada"));
      await choose("Remove");
    };
    await takeOut();
    const warning =
      document.querySelector('[role="alertdialog"]')?.textContent ?? "";
    await press(button("Cancel"));
    const changes = () => asked.filter(([call]) => call !== "shareCandidates");
    const afterCancel = changes();
    await takeOut();
    await press(
      [...document.querySelectorAll('[role="alertdialog"] button')].find(
        (each) => words(each) === "Take out"
      )
    );

    expect({
      warned: warning.includes("Take Ada out of Sell & get paid?"),
      afterCancel,
      asked: changes(),
    }).toStrictEqual({
      warned: true,
      afterCancel: [["addMember", "person", "user-ada", "builder"]],
      asked: [
        ["addMember", "person", "user-ada", "builder"],
        ["removeMember", "person", "user-ada"],
      ],
    });
  });

  it("names who loses access before taking a shared workflow out", async () => {
    const { session, asked } = fakeProjects();
    await shown(session, project("builder"), { tab: "workflows" });

    await press(button("Take Invoices out of the project"));
    const warning =
      document.querySelector('[role="alertdialog"]')?.textContent ?? "";
    await press(
      [...document.querySelectorAll('[role="alertdialog"] button')].find(
        (each) => each.textContent?.trim().startsWith("Take out")
      )
    );

    expect({
      named: warning.includes("Olga and Ada lose access"),
      asked,
    }).toStrictEqual({ named: true, asked: [["unfile", "wf-invoices"]] });
  });

  it("lets someone who only uses the project change nothing", async () => {
    const { session, asked } = fakeProjects();
    await shown(session, project("user"), { tab: "people" });
    const people = {
      picker: field(),
      roles: button("Access for Ada"),
      listed: [
        ...document.querySelectorAll("[aria-label='People'] [data-slot=item]"),
      ].map(words),
      asked: [...asked],
    };
    cleared();
    await shown(session, project("user"), { tab: "workflows" });

    expect({
      people,
      add: button("Add"),
      remove: button("Take Invoices out of the project"),
      change: button("Settings"),
      delete: button("More for Sell & get paid"),
      listed: document.body.textContent?.includes("Invoices"),
    }).toStrictEqual({
      people: {
        picker: null,
        roles: undefined,
        listed: ["OlgaOwner", "AdaUser"],
        asked: [],
      },
      add: undefined,
      remove: undefined,
      change: undefined,
      delete: undefined,
      listed: true,
    });
  });

  it("shows a project bigger than one page a page at a time, reading the next after the last shown", async () => {
    const { session, asked } = fakeProjects();
    await shown(
      session,
      {
        ...project("user"),
        moreItems: true,
        counts: { apps: 1, workflows: 1, connections: 0 },
      },
      { tab: "apps" }
    );

    const before = document.body.textContent?.includes("Desk");
    await press(button("Show more"));

    expect({
      before,
      after: document.body.textContent?.includes("Desk"),
      showMore: button("Show more"),
      asked,
    }).toStrictEqual({
      before: false,
      after: true,
      showMore: undefined,
      asked: [["items", "workflow", "wf-invoices", "2026-11-01T10:00:00.000Z"]],
    });
  });

  it("moves on past a page made only of items shown already", async () => {
    const { session, asked } = fakeProjects([
      { items: [invoicesMoved], more: true },
      { items: [desk], more: false },
    ]);
    await shown(
      session,
      {
        ...project("user"),
        moreItems: true,
        counts: { apps: 1, workflows: 1, connections: 0 },
      },
      { tab: "workflows" }
    );

    await press(button("Show more"));
    await press(button("Show more"));

    expect({
      showMore: button("Show more"),
      invoicesShown: [...document.querySelectorAll("li")].filter((row) =>
        row.textContent?.includes("Invoices")
      ).length,
      asked,
    }).toStrictEqual({
      showMore: undefined,
      invoicesShown: 1,
      asked: [
        ["items", "workflow", "wf-invoices", "2026-11-01T10:00:00.000Z"],
        ["items", "workflow", "wf-invoices", "2026-11-01T12:00:00.000Z"],
      ],
    });
  });

  it("lists only the person's own chats in it, adds one of theirs not in it yet, and takes one out", async () => {
    const { session, asked } = fakeProjects();
    await shown(session, project("user"), {
      chatsInIt: [accruals],
      tab: "chats",
    });

    const listed = document.body.textContent?.includes("Accruals");
    await press(button("Add a chat"));
    const choices = [...document.querySelectorAll('[role="dialog"] li')].map(
      (row) => row.textContent?.trim()
    );
    await press(inDialog("Add"));
    await press(button("Take out"));

    expect({ listed, choices, asked }).toStrictEqual({
      listed: true,
      choices: ["LunchAdd"],
      asked: [
        ["setProject", "chat-lunch", "project-1"],
        ["setProject", "chat-accruals", null],
      ],
    });
  });

  it("shows three of each part on the overview, each workflow as it stands, with View all opening its tab", async () => {
    const { session } = fakeProjects();
    const items = ["one", "two", "three", "four"].map((id, at) => ({
      type: "workflow" as const,
      id: `wf-${id}`,
      name: id,
      sharedAs: null,
      builds: true,
      addedAt: `2026-11-0${at + 1}T10:00:00.000Z`,
    }));
    await shown(
      session,
      {
        ...project("builder"),
        items,
        counts: { apps: 0, workflows: 4, connections: 0 },
      },
      {
        workflows: [
          { ...workflowRow("wf-one", "One"), paused: true },
          { ...workflowRow("wf-two", "Two"), failed: 2 },
          workflowRow("wf-three", "Three"),
        ],
      }
    );

    const rows = [
      ...document.querySelectorAll(
        "[aria-labelledby='project-workflows'] [data-slot=item]"
      ),
    ].map(words);

    expect({
      rows,
      viewAll: link("View all")?.getAttribute("href"),
    }).toStrictEqual({
      rows: ["OnePaused", "Two2 failed", "ThreeNo runs yet"],
      viewAll: "/projects/project-1?tab=workflows",
    });
  });

  it("says which connection stopped letting Grasp in: its builders reconnect it, anyone else asks the owner", async () => {
    const { session } = fakeProjects();
    const connections: ProjectConnections = {
      connections: [
        {
          id: "conn-1",
          // The product names and marks only its own connectors (connections/brands.ts).
          provider: "microsoft",
          accountName: null,
          status: "needs_reauth",
        },
      ],
      unseen: 1,
    };
    await shown(session, project("builder"), { connections });
    const builder = {
      said: document.body.textContent?.includes(
        "Microsoft stopped letting Grasp in"
      ),
      reconnect: link("Reconnect")?.getAttribute("href"),
      more: document.body.textContent?.includes("1 more"),
    };
    cleared();
    await shown(session, project("user"), { connections });

    expect({
      builder,
      user: {
        asks: document.body.textContent?.includes("Ask Olga to reconnect it."),
        reconnect: link("Reconnect"),
      },
    }).toStrictEqual({
      builder: { said: true, reconnect: "/integrations", more: true },
      user: { asks: true, reconnect: undefined },
    });
  });

  it("asks someone who only uses an empty project to ask its owner to set it up", async () => {
    const { session } = fakeProjects();
    const empty = {
      items: [],
      counts: { apps: 0, workflows: 0, connections: 0 },
    };
    await shown(session, { ...project("user"), ...empty });
    const user = {
      asks: document.body.textContent?.includes(
        "Ask Olga to set this project up."
      ),
      make: link("Make an App"),
      // One line for the project, not one per empty part: only their own
      // chats are theirs to add.
      emptyParts: ["No workflows yet", "No Apps yet"].map((said) =>
        document.body.textContent?.includes(said)
      ),
      addChat: button("Add a chat") !== undefined,
    };
    cleared();
    await shown(session, { ...project("builder"), ...empty });

    expect({
      user,
      builder: document.body.textContent?.includes("to set this project up"),
    }).toStrictEqual({
      user: {
        asks: true,
        make: undefined,
        emptyParts: [false, false],
        addChat: true,
      },
      builder: false,
    });
  });

  it("shows the project's Apps as the Apps page does, on their own cards that open them", async () => {
    const { session } = fakeProjects();
    const deskApp: AppOverview = {
      app: {
        id: appIdSchema.parse("app-desk"),
        name: "Desk",
        description: "Where the front desk works",
        owner: "user-olga",
        responsible: "user-olga",
        audience: null,
        blueprint: null,
        currentVersion: 1,
        liveLabel: null,
        archived: false,
        link: null,
        process: null,
        createdAt: "2026-11-01T10:00:00.000Z",
        role: "user",
      },
      contents: { version: 1, pages: true },
    };
    await shown(
      session,
      {
        ...project("user"),
        items: [desk],
        counts: { apps: 1, workflows: 0, connections: 0 },
      },
      { apps: [deskApp] }
    );

    expect({
      opens: link("Desk")?.getAttribute("href"),
      said: [
        "Where the front desk works",
        "Your team uses it",
        "No preview yet",
      ].map((said) => document.body.textContent?.includes(said)),
    }).toStrictEqual({
      opens: "/apps/app-desk",
      said: [true, true, true],
    });
  });
});
