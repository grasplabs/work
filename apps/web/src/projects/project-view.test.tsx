// @vitest-environment happy-dom
import { SidebarProvider } from "@grasp-os/app-kit/components/sidebar";
import type { ChatSummary } from "@grasp-os/shared/chat";
import type {
  FileItem,
  NewProjectMember,
  Project,
  ProjectCursor,
  ProjectItemCandidate,
  ProjectItemsPage,
  ProjectItemRef,
  ProjectMemberRef,
  ProjectShareCandidates,
} from "@grasp-os/shared/projects";
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

import { ProjectView } from "./project-view.tsx";

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

/** Core's projects API, keeping each call it was asked. */
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

/** The page of `shownProject`, on what `session` holds. */
const shown = async (
  session: ReturnType<typeof fakeProjects>["session"],
  shownProject: Project,
  chatsInIt: ChatSummary[] = []
) => {
  const core = {
    withSession: async <T,>(
      run: (reached: typeof session) => Promise<T>
    ): Promise<T> => await run(session),
  };
  const rootRoute = createRootRoute({
    // The page's bar (frame/site-header.tsx) stands in the frame's sidebar.
    component: () => (
      <SidebarProvider>
        <ProjectView
          chats={chatsInIt}
          identity={{ role: "builder" }}
          project={shownProject}
        />
      </SidebarProvider>
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
        <RouterProvider router={router} />
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

/** The faces in the header, which open the project's people. */
const peopleButton = () =>
  [...document.querySelectorAll("button")].find(
    (each) =>
      each.getAttribute("aria-label")?.startsWith("People in it") === true
  );

/** A button inside the open dialog, by its words. */
const inDialog = (name: string) =>
  [...document.querySelectorAll('[role="dialog"] button')].find(
    (each) => each.textContent?.trim() === name || words(each) === name
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

/**
 * Waits until the button named `name` in the open dialog is at rest again:
 * a Button holds how its press went for a moment, and takes no press
 * meanwhile.
 */
const rested = async (name: string): Promise<void> => {
  for (let tries = 0; tries < 40; tries += 1) {
    const found = inDialog(name);
    if (found instanceof HTMLElement && found.dataset.status === undefined) {
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- one look after the other
    await act(async () => {
      const { promise, resolve } = Promise.withResolvers<boolean>();
      setTimeout(() => {
        resolve(true);
      }, 100);
      await promise;
    });
  }
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

/** The options of the list `control` opens: the picker's, or a Select's. */
const optionsOf = (control: Element | null | undefined): Element[] => {
  const list = control?.getAttribute("aria-controls");
  const box =
    list === null || list === undefined
      ? null
      : document.querySelector(`#${list}`);
  return [...(box?.querySelectorAll("[role=option]") ?? [])];
};

/** The options the open picker shows, each as its lines read. */
const optionLines = (): string[] => optionsOf(field()).map(words);

/** Picks the option whose first line is `name`. */
const pickOption = async (name: string): Promise<void> => {
  await press(optionsOf(field()).find((each) => words(each).startsWith(name)));
};

/** Opens the Select named `name` and chooses `choice` in its list. */
const choose = async (name: string, choice: string): Promise<void> => {
  const trigger = button(name);
  await press(trigger);
  await press(optionsOf(trigger).find((each) => words(each) === choice));
};

describe("A project's page", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("makes something in the project from Make something, making nothing until asked, with the project carried along", async () => {
    const { session, asked } = fakeProjects();
    const router = await shown(session, project("builder"));

    await press(link("Make something"));

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
    await shown(session, project("builder"));

    await press(button("Add"));
    // Found by name in the list, as a person picks it.
    await press(
      document.querySelector('[role="dialog"] [aria-label="Show the choices"]')
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

  it("says Adding while core files it, then Not added and core's reason where core refused, the dialog still open", async () => {
    const { session } = fakeProjects();
    const { promise: answer, reject } = Promise.withResolvers<undefined>();
    session.projects.file = async (): Promise<void> => {
      await answer;
    };
    await shown(session, project("builder"));

    await press(button("Add"));
    await press(
      document.querySelector('[role="dialog"] [aria-label="Show the choices"]')
    );
    await press(
      [...document.querySelectorAll('[role="option"]')].find(
        (each) => each.textContent?.trim() === "Quotes"
      )
    );
    await press(inDialog("Add"));
    const working = inDialog("Adding") !== undefined;
    await act(async () => {
      reject(new Error("Quotes is not yours to add."));
      await Promise.resolve();
    });
    await settled();

    expect({
      working,
      failed: inDialog("Not added") !== undefined,
      reason: document
        .querySelector('[role="dialog"]')
        ?.textContent?.includes("Quotes is not yours to add."),
    }).toStrictEqual({ working: true, failed: true, reason: true });
  });

  it("adds people and teams in a role, from who core offers when the people open, and says why an add was refused", async () => {
    const { session, asked } = fakeProjects();
    await shown(session, project("builder"));

    const before = [...asked];
    await press(peopleButton());
    await openPicker();
    const names = optionLines();
    // Every ID holds an "s" ("user-…", "team-…"): only names are searched.
    await type(field(), "s");
    const found = optionLines();
    await type(field(), "");
    await openPicker();
    await pickOption("Bo");
    await choose("Role in the project", "Builder");
    await press(inDialog("Add"));
    await rested("Add");
    await openPicker();
    await pickOption("Sales (team)");
    await press(inDialog("Add"));
    await rested("Add");
    await openPicker();
    await pickOption("Cy");
    await press(inDialog("Add"));

    expect({
      before,
      names,
      found,
      asked,
      refused: document.body.textContent?.includes("Cy can't be added."),
    }).toStrictEqual({
      before: [],
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
        // A refused add reads the page again too, as any change does.
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
    await shown(session, project("builder"));
    await press(peopleButton());

    await openPicker();
    const options = optionLines();

    // The Ada in it is the only one it lists, so it names her as before.
    expect({
      options,
      inIt: button("Role of Ada") !== undefined,
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
    await shown(session, {
      ...project("builder"),
      members: [ada, { ...ada, id: "user-ada-222222" }],
    });
    await press(peopleButton());
    const faces = [
      ...document.querySelectorAll(
        "[aria-label='People in the project'] [data-slot=item]"
      ),
    ].map((row) => row.querySelector("[data-slot=item-media]")?.textContent);

    expect({
      named: [
        button("Role of Ada (ID …er-ada)") !== undefined,
        button("Role of Ada (ID …222222)") !== undefined,
      ],
      // Each face from the plain name, not the words that tell them apart.
      faces,
    }).toStrictEqual({ named: [true, true], faces: ["O", "A", "A"] });
  });

  it("changes someone's role, and takes them out only once they confirm, naming what they lose", async () => {
    const { session, asked } = fakeProjects();
    await shown(session, project("builder"));
    await press(peopleButton());

    await choose("Role of Ada", "Builder");
    const takeOut = async (): Promise<void> => {
      await choose("Role of Ada", "Remove");
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

  it("says why someone wasn't taken out in the dialog that asked, which stays open", async () => {
    const { session } = fakeProjects();
    session.projects.removeMember = async (): Promise<void> => {
      await Promise.resolve();
      throw new Error("Ada owns an App in it.");
    };
    await shown(session, project("builder"));
    await press(peopleButton());

    await choose("Role of Ada", "Remove");
    await press(
      [...document.querySelectorAll('[role="alertdialog"] button')].find(
        (each) => words(each) === "Take out"
      )
    );
    const asking = document.querySelector('[role="alertdialog"]');
    const reasons = [...document.querySelectorAll('[role="alert"]')].filter(
      (each) => each.textContent === "Ada owns an App in it."
    );

    expect({
      open: asking !== null,
      // Once, and in the dialog, not under the list behind it.
      reasons: reasons.map((each) => asking?.contains(each) === true),
    }).toStrictEqual({ open: true, reasons: [true] });
  });

  it("puts a long name in a box of its own beside the icon, so it can break", async () => {
    const { session } = fakeProjects();
    const name = "customer_onboarding_pipeline_review_2026";
    await shown(session, { ...project("builder"), name });
    const heading = document.querySelector("h1");
    const named = heading?.firstElementChild;

    expect({
      heading: heading?.textContent,
      // The icon tile, then the name alone in its own element.
      parts: [...(named?.children ?? [])].map((each) => each.textContent),
    }).toStrictEqual({ heading: name, parts: ["", name] });
  });

  it("names who loses access before taking a shared workflow out", async () => {
    const { session, asked } = fakeProjects();
    await shown(session, project("builder"));

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
    await shown(session, project("user"));
    await press(peopleButton());
    const people = {
      picker: field(),
      roles: button("Role of Ada"),
      listed: [
        ...document.querySelectorAll(
          "[aria-label='People in the project'] [data-slot=item]"
        ),
      ].map(words),
      asked: [...asked],
    };
    await press(button("Close"));

    expect({
      people,
      add: button("Add"),
      remove: button("Take Invoices out of the project"),
      change: button("Change"),
      delete: button("Delete"),
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
    await shown(session, {
      ...project("user"),
      moreItems: true,
      counts: { apps: 1, workflows: 1, connections: 0 },
    });

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
    await shown(session, {
      ...project("user"),
      moreItems: true,
      counts: { apps: 1, workflows: 1, connections: 0 },
    });

    await press(button("Show more"));
    await press(button("Show more"));
    const deskShown = document.body.textContent?.includes("Desk");

    expect({
      desk: deskShown,
      invoicesShown: [...document.querySelectorAll("li")].filter((row) =>
        row.textContent?.includes("Invoices")
      ).length,
      asked,
    }).toStrictEqual({
      desk: true,
      invoicesShown: 1,
      asked: [
        ["items", "workflow", "wf-invoices", "2026-11-01T10:00:00.000Z"],
        ["items", "workflow", "wf-invoices", "2026-11-01T12:00:00.000Z"],
      ],
    });
  });

  it("lists only the person's own chats in it, adds one of theirs not in it yet, and takes one out", async () => {
    const { session, asked } = fakeProjects();
    await shown(session, project("user"), [accruals]);

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
});
