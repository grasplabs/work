// @vitest-environment happy-dom
import type {
  App,
  AppStatus,
  VersionReview,
  ViewedApp,
} from "@grasp-os/shared/apps";
import type {
  ChatDraft,
  ChatUpdate,
  PreviewBundle,
} from "@grasp-os/shared/chat";
import { appIdSchema } from "@grasp-os/shared/ids";
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
  useRouterState,
} from "@tanstack/react-router";
import type { AnyRouter } from "@tanstack/react-router";
import { RpcTarget } from "capnweb";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { activeChat, appSlot, setActiveChat } from "../chat/active-chat.ts";
import { socketsTo } from "../pages/test-socket.ts";
import { AppWorkspace } from "./app-workspace.tsx";

// An App's workspace against core's `apps` as the page reaches it over
// RPC (the boundary from the web app), faked: only its builders get it;
// it never shows the live App, only where the App stands (a version ready
// to publish, previewed read-only once the App's chat is known, nothing
// unpublished, nothing built yet); Publish moves the
// App only along what core allows, the page reads it again afterwards,
// and what core refuses is said; a draft the agent didn't propose is
// proposed by the person and reviewed; an archived App is restored from it. The
// App's chat stays unanswered here: these are the workspace's own parts.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

type Transition = "publish" | "unpublish" | "restore";

/** Where each transition goes, from where core lets it start. */
const moves: Record<Transition, { from: AppStatus[]; to: AppStatus }> = {
  publish: { from: ["draft"], to: "published" },
  unpublish: { from: ["published"], to: "draft" },
  restore: { from: ["archived"], to: "draft" },
};

/** What core says `version` changes: nothing a reviewer must read on. */
const reviewOf = (version: number): VersionReview => ({
  version: {
    app: appIdSchema.parse("invoice-desk"),
    version,
    parent: 1,
    tree: "tree",
    files: 1,
    author: "user-1",
    message: `Version ${version}`,
    createdAt: "2026-10-20T08:00:00.000Z",
    proposedBy: null,
  },
  proposedBy: null,
  current: 1,
  files: [{ path: "src/routes/index.tsx", change: "modified" }],
  server: null,
  serverFiles: [],
  migrations: [],
  permissions: [],
  grants: [],
  handsFilesToWorkflows: false,
  readsPeople: false,
  rowRules: [],
});

/** Core's `apps` for one App, as someone with `role` in it reads it. */
const fakeApps = (
  status: AppStatus,
  {
    role = "builder",
    currentVersion = 1,
    pendingVersion = null,
    refusing,
  }: {
    role?: ViewedApp["role"];
    currentVersion?: number | null;
    pendingVersion?: number | null;
    refusing?: Transition;
  } = {}
) => {
  const calls: string[] = [];
  let app: ViewedApp = {
    id: appIdSchema.parse("invoice-desk"),
    name: "Invoices",
    description: "",
    owner: "user-1",
    responsible: "user-1",
    audience: null,
    process: null,
    blueprint: null,
    currentVersion,
    pendingVersion,
    status,
    link: null,
    createdAt: "2026-10-20T08:00:00.000Z",
    role,
  };
  const move = async (transition: Transition): Promise<App> => {
    calls.push(transition);
    await Promise.resolve();
    if (transition === refusing) {
      throw new Error("Only the App's builders can do that.");
    }
    if (!moves[transition].from.includes(app.status)) {
      throw new Error("The App moved on meanwhile.");
    }
    app = { ...app, status: moves[transition].to };
    return app;
  };
  return {
    calls,
    /** The chat's draft was proposed as version `version`: it waits for review. */
    proposed: (version: number) => {
      app = { ...app, pendingVersion: version };
    },
    apps: {
      get: async (): Promise<ViewedApp> => await Promise.resolve(app),
      list: async (): Promise<ViewedApp[]> => await Promise.resolve([app]),
      publish: async () => await move("publish"),
      unpublish: async () => await move("unpublish"),
      restore: async () => await move("restore"),
      versions: {
        // What core says a version changes: version 2's at once, any later
        // one only once the test lets it.
        review: async (_app: string, version: number) =>
          version === 2
            ? await Promise.resolve(reviewOf(version))
            : await Promise.withResolvers<VersionReview>().promise,
        setCurrent: async (_app: string, version: number) => {
          calls.push(`setCurrent ${version}`);
          await Promise.resolve();
          app = { ...app, currentVersion: version, pendingVersion: null };
          return app;
        },
      },
      members: { list: async () => await Promise.resolve([]) },
    },
  };
};

const identityOf = (staff: boolean): Identity => ({
  userId: "user-1",
  email: "user-1@acme.test",
  name: "user-1",
  role: "builder",
  teams: [],
  staff,
  expiresAt: "2026-11-01T09:00:00.000Z",
});

let root: Root | undefined;

/** Takes the page down. */
const takenDown = (): void => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  document.body.replaceChildren();
};

/** Whether the loader's data is the App, as `fakeApps` answers it. */
const isApp = (data: unknown): data is ViewedApp =>
  typeof data === "object" && data !== null && "status" in data;

/** The workspace of the App `apps` holds, as `identity` sees it. */
/** Core's `chats.watch`: the chat, the last message seen, and where updates go. */
type Watch = (
  chatId: string,
  after: number | null,
  received: (update: ChatUpdate) => void
) => Promise<unknown>;

/** A watch that is answered: release it, and it is gone. */
const watching = () => ({
  release: async () => {
    await Promise.resolve();
  },
  [Symbol.dispose]: () => {},
});

const opened = async (
  apps: ReturnType<typeof fakeApps>["apps"],
  identity: Identity = identityOf(false),
  handedOver?: string,
  /** How core answers watching a chat; by default it sends nothing yet. */
  watch: Watch = async () => await Promise.withResolvers<never>().promise,
  /** How core answers asking for the App's chat; by default not yet. */
  forApp: () => Promise<never> = async () =>
    await Promise.withResolvers<never>().promise,
  /** The drafts each chat holds; by default none. */
  drafts: (chatId: string) => Promise<ChatDraft[]> = async () =>
    await Promise.resolve([]),
  /** How core answers the person proposing a chat's draft; by default not yet. */
  proposeDraft: (
    chatId: string,
    app: string,
    message: string
  ) => Promise<number> = async () =>
    await Promise.withResolvers<never>().promise
) => {
  // The App's chat: core never answers `forApp` here. A chat that is
  // followed sends nothing yet and has no drafts.
  const askedForApp: string[] = [];
  const chats = {
    forApp: async (app: string) => {
      askedForApp.push(app);
      return await forApp();
    },
    watch,
    drafts,
    proposeDraft,
    connectionRequests: async () => await Promise.resolve([]),
  };
  const pendingActions = { list: async () => await Promise.resolve([]) };
  const core = {
    withSession: async <T,>(
      action: (session: {
        apps: typeof apps;
        chats: typeof chats;
        pendingActions: typeof pendingActions;
      }) => Promise<T>
    ): Promise<T> => await action({ apps, chats, pendingActions }),
  };
  const rootRoute = createRootRoute({ component: Outlet });
  // The shell, whose context names who is signed in, as the app's has it.
  const shell = createRoute({
    getParentRoute: () => rootRoute,
    id: "_shell",
    beforeLoad: () => ({ identity }),
    component: Outlet,
  });
  const page = createRoute({
    getParentRoute: () => shell,
    path: "/",
    loader: async () => await apps.get(),
  });
  const Page = () => {
    // This test's own router, never the app's registered route tree.
    const loaded: unknown = useRouterState<AnyRouter>({
      select: ({ matches }) => matches.at(-1)?.loaderData,
    });
    if (!isApp(loaded)) {
      return null;
    }
    return (
      <AppWorkspace
        app={loaded}
        builds={loaded.role === "builder" && !identity.staff}
        efforts={{}}
        handedOver={handedOver}
        identity={identity}
        models={[]}
        section={undefined}
        storeChanges={undefined}
        view="preview"
      />
    );
  };
  page.update({ component: Page });
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
  return { askedForApp, router };
};

/** Lets every pending promise and render settle, the page's reload too. */
const settled = async (): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 10);
    await promise;
  });
};

/** What a button or menu item is called: its text, or its label without one. */
const nameOf = (element: HTMLElement): string => {
  const text = element.textContent?.trim() ?? "";
  return text === "" ? (element.getAttribute("aria-label") ?? "") : text;
};

const button = (name: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll("button")].find(
    (each) => nameOf(each) === name
  );
  if (found === undefined) {
    throw new Error(`No button ${name}`);
  }
  return found;
};

const press = async (element: HTMLElement): Promise<void> => {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await settled();
};

/** Chooses `item` from the menu its button `name` opens. */
const choose = async (name: string, item: string): Promise<void> => {
  await press(button(name));
  const found = [
    ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ].find((each) => nameOf(each).startsWith(item));
  if (found === undefined) {
    throw new Error(`No menu item ${item}`);
  }
  await press(found);
};

/** Picks the choice labelled `label` among the agent's questions. */
const pick = async (label: string): Promise<void> => {
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
  await press(radio);
};

/** The App's status badge, in the bar. */
const status = (): string | null | undefined =>
  document.querySelector('[data-slot="badge"]')?.textContent;

/** The chat's box to ask in, while the chat shows. */
const box = (): HTMLTextAreaElement | null =>
  document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Ask for a change"]'
  );

const says = (text: string): boolean =>
  document.body.textContent.includes(text);

/** A chat's draft of `app`, written by its agent and not proposed. */
const draftOf = (app: string): ChatDraft => ({
  app,
  base: 1,
  changed: ["src/routes/index.tsx"],
  deleted: [],
  revision: 1,
  updatedAt: "2026-10-20T08:00:00.000Z",
  callId: null,
});

/**
 * Core, over the page's own connection (a WebSocket) and a real Cap'n Web
 * session, as far as a preview's load reaches it: who is signed in, and
 * each preview asked for, kept and never answered, refused with `refusal`
 * when one is given, or answered with `bundle`. `reached` resolves at the
 * first.
 */
class PreviewingCore extends RpcTarget {
  readonly asked: unknown[][] = [];
  readonly #reached = Promise.withResolvers<boolean>();
  readonly reached = this.#reached.promise;
  readonly #refusal: string | undefined;
  readonly #bundle: PreviewBundle | undefined;

  constructor(refusal?: string, bundle?: PreviewBundle) {
    super();
    this.#refusal = refusal;
    this.#bundle = bundle;
  }

  authenticate(): this {
    return this;
  }

  readonly userId = "user-1";

  whoami(): { userId: string } {
    return { userId: this.userId };
  }

  get chats(): this {
    return this;
  }

  async preview(...args: unknown[]): Promise<PreviewBundle> {
    this.asked.push(args);
    this.#reached.resolve(true);
    if (this.#refusal !== undefined) {
      throw Object.assign(new Error("Refused."), { code: this.#refusal });
    }
    if (this.#bundle !== undefined) {
      return await Promise.resolve(this.#bundle);
    }
    return await Promise.withResolvers<never>().promise;
  }
}

/**
 * Core's preview of the App's `desk` page, of its version 1, as it
 * answers a chat that hasn't changed the App: at the draft's revision 0.
 */
const deskOfVersion1: PreviewBundle = {
  app: appIdSchema.parse("invoice-desk"),
  name: "Invoices",
  revision: 0,
  artifact: "a".repeat(64),
  frameToken: "token",
  refresh: {
    revision: 0,
    entry: "b".repeat(64),
    modules: {},
    css: "",
    kit: [],
    appVersion: 1,
  },
};

describe(AppWorkspace, () => {
  // The chat's thread loads on its own (chat-dock.tsx, `lazy`), the first
  // time with its Markdown and highlighting: loaded once here, so what a
  // test waits for in it never races that first load on a busy machine.
  beforeAll(async () => {
    await import("../chat/thread.tsx");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
    setActiveChat(undefined, appSlot("invoice-desk"));
  });

  it("is for the App's builders alone, never a user of it or Grasp staff", async () => {
    const seen: Record<string, boolean> = {};
    const viewers = {
      builder: { role: "builder", staff: false },
      user: { role: "user", staff: false },
      staff: { role: "builder", staff: true },
    } as const;
    for (const [who, { role, staff }] of Object.entries(viewers)) {
      // oxlint-disable-next-line no-await-in-loop -- one page at a time
      await opened(fakeApps("draft", { role }).apps, identityOf(staff));
      seen[who] = !says("Only its builders change Invoices");
      takenDown();
    }

    expect(seen).toStrictEqual({ builder: true, user: false, staff: false });
  });

  it("never shows the live App: with no chat to preview from, it says where the App stands instead", async () => {
    const said: Record<string, boolean> = {};
    const states = {
      ready: [
        fakeApps("published", { pendingVersion: 2 }),
        "Version 2 is ready to publish",
      ],
      unchanged: [fakeApps("published"), "No unpublished changes"],
      empty: [fakeApps("draft", { currentVersion: null }), "Nothing built yet"],
    } as const;
    for (const [state, [fake, text]] of Object.entries(states)) {
      // oxlint-disable-next-line no-await-in-loop -- one page at a time
      await opened(
        fake.apps,
        identityOf(false),
        undefined,
        undefined,
        async () => await Promise.reject(new Error("No chat."))
      );
      // oxlint-disable-next-line no-await-in-loop -- one page at a time
      await settled();
      said[state] = says(text);
      takenDown();
    }
    // While core finds the App's chat, the preview is on its way.
    await opened(fakeApps("published").apps);
    const finding = {
      loading: document.querySelector('[aria-label="Loading…"]') !== null,
      unchanged: says("No unpublished changes"),
    };

    expect({ said, finding }).toStrictEqual({
      said: { ready: true, unchanged: true, empty: true },
      finding: { loading: true, unchanged: false },
    });
  });

  it("switches the main area between Preview, Code, Data and Settings, the one shown marked", async () => {
    await opened(fakeApps("draft").apps);

    const views = document.querySelector('nav[aria-label="Workspace views"]');
    expect(
      [...(views?.querySelectorAll("a") ?? [])].map((link) => ({
        name: link.textContent,
        to: link.getAttribute("href"),
        shown: link.getAttribute("aria-current") === "page",
      }))
    ).toStrictEqual([
      { name: "Preview", to: "/apps/invoice-desk/edit", shown: true },
      { name: "Code", to: "/apps/invoice-desk/edit?view=code", shown: false },
      { name: "Data", to: "/apps/invoice-desk/edit?view=data", shown: false },
      {
        name: "Settings",
        to: "/apps/invoice-desk/edit?view=settings",
        shown: false,
      },
    ]);
  });

  it("publishes a draft from the bar, and takes it back to a draft from there", async () => {
    const { calls, apps } = fakeApps("draft");
    await opened(apps);
    const draft = status();

    await choose("Publish", "Publish");
    const published = status();
    await choose("Published", "Unpublish");

    expect({ draft, published, unpublished: status(), calls }).toStrictEqual({
      draft: "Draft",
      published: "Published",
      unpublished: "Draft",
      calls: ["publish", "unpublish"],
    });
  });

  it("says why core refused, leaving the App as it was", async () => {
    const { apps } = fakeApps("draft", { refusing: "publish" });
    await opened(apps);

    await choose("Publish", "Publish");

    expect({
      status: status(),
      refused: says("Only the App's builders can do that."),
    }).toStrictEqual({ status: "Draft", refused: true });
  });

  it("doesn't offer to publish an App with no version to run", async () => {
    await opened(fakeApps("draft", { currentVersion: null }).apps);

    expect(button("Publish").disabled).toBeTruthy();
  });

  it("restores an archived App, with no chat or Publish until then", async () => {
    const { calls, apps } = fakeApps("archived");
    await opened(apps);
    const archived = {
      status: status(),
      chat: [...document.querySelectorAll("button")].some(
        (each) => nameOf(each) === "Chat"
      ),
      publish: [...document.querySelectorAll("button")].some((each) =>
        nameOf(each).startsWith("Publish")
      ),
    };

    await press(button("Restore"));

    expect({ archived, restored: status(), calls }).toStrictEqual({
      archived: { status: "Archived", chat: false, publish: false },
      restored: "Draft",
      calls: ["restore"],
    });
  });

  it("carries on the chat the person came from, building the App, rather than the App's own", async () => {
    const { askedForApp } = await opened(
      fakeApps("draft").apps,
      identityOf(false),
      "chat-studio"
    );
    await settled();
    await press(button("More"));

    expect({
      askedForApp,
      // The App's own chat stays the tab's, for when no chat is handed over.
      kept: activeChat(appSlot("invoice-desk")),
      openInChat: document
        .querySelector('[role="menuitem"][href^="/?chat="]')
        ?.getAttribute("href"),
    }).toStrictEqual({
      askedForApp: [],
      kept: undefined,
      openInChat: "/?chat=chat-studio&panel=true",
    });
  });

  it("keeps what was typed in the chat while the chat is hidden and shown again", async () => {
    await opened(fakeApps("draft").apps, identityOf(false), "chat-studio");
    await settled();
    if (box() === null) {
      await press(button("Chat"));
    }
    const typed = box();
    if (typed === null) {
      throw new Error("No box to ask in");
    }
    await act(async () => {
      const prototype = Reflect.getPrototypeOf(typed) ?? {};
      Reflect.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
        typed,
        "Add a due date column"
      );
      typed.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });

    await press(button("Chat"));
    const hidden = box();
    await press(button("Chat"));

    expect({ hidden, kept: box()?.value }).toStrictEqual({
      hidden: null,
      kept: "Add a due date column",
    });
  });

  it("keeps how far the person got with the agent's questions while the chat is hidden and shown again", async () => {
    let send: ((update: ChatUpdate) => void) | undefined;
    // A chat of this test's own: the tab keeps one watch per chat.
    await opened(
      fakeApps("draft").apps,
      identityOf(false),
      "chat-asking",
      async (_chat, _after, received) => {
        send = received;
        return await Promise.resolve(watching());
      }
    );
    await settled();
    if (box() === null && !says("Grasp asks")) {
      await press(button("Chat"));
    }
    await act(async () => {
      send?.({
        messages: [
          {
            id: 1,
            role: "assistant",
            text: "A few questions first.",
            citations: [],
            code: [],
            tools: [],
            asked: {
              callId: "call-1",
              questions: [
                { question: "How often?", choices: ["Daily", "Weekly"] },
                { question: "To whom?", choices: ["Me", "My team"] },
              ],
            },
            end: "done",
            at: "2026-10-20T08:00:05.000Z",
          },
        ],
        partial: null,
        running: false,
        stopped: null,
        held: 0,
        drafts: 0,
      });
      await Promise.resolve();
    });
    await settled();
    await pick("Weekly");
    await press(button("Next"));

    await press(button("Chat"));
    const hidden = says("Grasp asks");
    await press(button("Chat"));
    const step = says("Grasp asks, 2 of 2");
    await press(button("Back"));

    expect({
      hidden,
      step,
      // The first question's answer is still picked: Next goes on.
      answered: button("Next").disabled,
    }).toStrictEqual({ hidden: false, step: true, answered: false });
  });

  it("offers a version proposed outside a turn, once the chat's drafts change", async () => {
    const fake = fakeApps("published");
    let send: ((update: ChatUpdate) => void) | undefined;
    // A chat of this test's own: the tab keeps one watch per chat.
    await opened(
      fake.apps,
      identityOf(false),
      "chat-drafting",
      async (_chat, _after, received) => {
        send = received;
        return await Promise.resolve(watching());
      }
    );
    await settled();
    const before = says("Publish version 2");

    // Its person proposed the draft as version 2: core drops the draft.
    fake.proposed(2);
    await act(async () => {
      send?.({
        messages: [],
        partial: null,
        running: false,
        stopped: null,
        held: 0,
        drafts: 1,
      });
      await Promise.resolve();
    });
    await settled();

    expect({
      before,
      ready: says("Publish version 2"),
      publish: button("Publish version 2").disabled,
    }).toStrictEqual({ before: false, ready: true, publish: false });
  });

  it("previews the App as the App's chat has it, with the way to publish the version proposed, once the chat is known", async () => {
    const fake = fakeApps("published", { pendingVersion: 2 });
    // No chat yet: no frame.
    await opened(fake.apps);
    const withoutChat = { frame: document.querySelector("iframe") };
    takenDown();

    const core = new PreviewingCore();
    socketsTo(core);
    await opened(
      fake.apps,
      identityOf(false),
      "chat-proposed",
      async () => await Promise.resolve(watching())
    );
    await act(async () => {
      await core.reached;
    });
    const frame = document.querySelector("iframe");

    await press(button("Publish version 2"));

    expect({
      withoutChat,
      label: says("Preview: changes nothing, reads no real data"),
      // The bar names the version once the frame says which it shows.
      said: says("Version 2 is ready to publish"),
      frame: {
        title: frame?.getAttribute("title"),
        sandbox: frame?.getAttribute("sandbox"),
      },
      review: document.querySelector('[role="dialog"] h2')?.textContent,
      // What the frame asked core to build: the chat's preview, which core
      // builds from the App's latest version, version 2, while the chat's
      // draft changes nothing (proposing it emptied it); never read-only,
      // so the chat's next write comes into it.
      asked: core.asked.map((args) => args.filter((arg) => arg !== undefined)),
    }).toStrictEqual({
      withoutChat: { frame: null },
      label: true,
      said: false,
      frame: {
        title: "Preview of the draft",
        sandbox: "allow-scripts",
      },
      review: "Publish version 2",
      asked: [["chat-proposed", "invoice-desk"]],
    });
  });

  it("keeps the frame open on the page it shows when the chat's first write changes that page, rather than starting it afresh", async () => {
    const fake = fakeApps("published");
    const core = new PreviewingCore(undefined, deskOfVersion1);
    socketsTo(core);
    let send: ((update: ChatUpdate) => void) | undefined;
    let drafts: ChatDraft[] = [];
    await opened(
      fake.apps,
      identityOf(false),
      "chat-drafting",
      async (_chat, _after, received) => {
        send = received;
        return await Promise.resolve(watching());
      },
      undefined,
      async () => await Promise.resolve(drafts)
    );
    await act(async () => {
      await core.reached;
    });
    await settled();
    const frame = document.querySelector("iframe");

    // The agent's first write changes `desk`, the page the frame shows.
    drafts = [{ ...draftOf("invoice-desk"), changed: ["src/routes/desk.tsx"] }];
    await act(async () => {
      send?.({
        messages: [],
        partial: null,
        running: false,
        stopped: null,
        held: 0,
        drafts: 1,
      });
      await Promise.resolve();
    });
    await settled();

    expect({
      // The very frame, with what its page holds: the write comes in as
      // an update, never by opening the preview again.
      sameFrame: document.querySelector("iframe") === frame,
      opens: core.asked.length,
    }).toStrictEqual({ sameFrame: true, opens: 1 });
  });

  it("says a proposed version with no page to show is ready to publish, rather than failing its preview", async () => {
    // An App with no pages: core has no page of it to build.
    const core = new PreviewingCore("page.not_found");
    socketsTo(core);
    await opened(
      fakeApps("published", { pendingVersion: 2 }).apps,
      identityOf(false),
      "chat-workflows",
      async () => await Promise.resolve(watching())
    );
    await act(async () => {
      await core.reached;
    });
    // Its refusal crosses the session back, then the area changes: each
    // look lets what came render first.
    await vi.waitFor(async () => {
      await act(async () => {
        await Promise.resolve();
      });
      expect(says("Grasp finished these changes")).toBeTruthy();
    });

    expect({
      ready: says("Grasp finished these changes"),
      frame: document.querySelector("iframe"),
      review: button("Review and publish").disabled,
    }).toStrictEqual({ ready: true, frame: null, review: false });
  });

  it("opens the App's own chat when the chat handed over can't be followed", async () => {
    const { askedForApp } = await opened(
      fakeApps("draft").apps,
      identityOf(false),
      "chat-deleted",
      async () => {
        await Promise.resolve();
        // Core's answer for a chat that is gone, or not the person's.
        throw Object.assign(new Error("There's no such chat."), {
          code: "agent.chat_not_found",
        });
      }
    );
    await settled();

    expect(askedForApp).toStrictEqual(["invoice-desk"]);
  });

  it("keeps the chat handed over when core won't follow it for now, saying why, rather than opening another", async () => {
    const { askedForApp } = await opened(
      fakeApps("draft").apps,
      identityOf(false),
      "chat-handed-over",
      async () => {
        await Promise.resolve();
        // The chat is the person's, but too many of their pages follow
        // chats at once.
        throw Object.assign(
          new Error(
            "Too many of your pages follow chats at once. Close some, then try again."
          ),
          { code: "agent.too_many_watches" }
        );
      }
    );
    // The reason shows in the chat's thread, which loads on its own (lazy):
    // each look lets what came render first.
    await vi.waitFor(async () => {
      await act(async () => {
        await Promise.resolve();
      });
      expect(
        says(
          "Too many of your pages follow chats at once. Close some, then try again."
        )
      ).toBeTruthy();
    });

    expect({
      askedForApp,
      says: says(
        "Too many of your pages follow chats at once. Close some, then try again."
      ),
      openInChat: document
        .querySelector('a[aria-label="Open in Chat"]')
        ?.getAttribute("href"),
    }).toStrictEqual({
      askedForApp: [],
      says: true,
      openInChat: "/?chat=chat-handed-over&panel=true",
    });
  });

  it("asks core for the App's chat again when the one this tab kept is gone", async () => {
    setActiveChat("chat-kept-gone", appSlot("invoice-desk"));
    const { askedForApp } = await opened(
      fakeApps("draft").apps,
      identityOf(false),
      undefined,
      async () => {
        await Promise.resolve();
        throw Object.assign(new Error("There's no such chat."), {
          code: "agent.chat_not_found",
        });
      }
    );
    await settled();

    expect(askedForApp).toStrictEqual(["invoice-desk"]);
  });

  it("reviews a newer proposal afresh: what was read for the last one never publishes it", async () => {
    const fake = fakeApps("published", { pendingVersion: 2 });
    const { router } = await opened(fake.apps);
    await press(button("Publish version 2"));
    const first = button("Make version 2 current").disabled;

    // Version 3 is proposed while the review of 2 is open.
    fake.proposed(3);
    await act(async () => {
      await router.invalidate();
    });
    await settled();

    expect({
      first,
      title: document.querySelector('[role="dialog"] h2')?.textContent,
      offered: [...document.querySelectorAll("button")]
        .map((each) => each.textContent.trim())
        .filter((name) => name.startsWith("Make version")),
      calls: fake.calls,
    }).toStrictEqual({
      first: false,
      title: "Publish version 3",
      offered: [],
      calls: [],
    });
  });

  it("asks core for the App's chat again on Try again, after it gave none", async () => {
    let refusals = 1;
    const { askedForApp } = await opened(
      fakeApps("draft").apps,
      identityOf(false),
      undefined,
      undefined,
      async () => {
        await Promise.resolve();
        if (refusals > 0) {
          refusals -= 1;
          throw Object.assign(new Error("Grasp couldn't open the chat."), {
            code: "app.not_found",
          });
        }
        return await Promise.withResolvers<never>().promise;
      }
    );
    await settled();
    const said = says("Try again");

    await press(button("Try again"));

    expect({ said, askedForApp }).toStrictEqual({
      said: true,
      askedForApp: ["invoice-desk", "invoice-desk"],
    });
  });

  it("doesn't open the review again on its own for a later version once it went away", async () => {
    const fake = fakeApps("published", { pendingVersion: 2 });
    const { router } = await opened(fake.apps);
    await press(button("Publish version 2"));
    const open = document.querySelector('[role="dialog"]') !== null;

    // Version 2 was made current elsewhere: nothing waits for review.
    await fake.apps.versions.setCurrent("invoice-desk", 2);
    await act(async () => {
      await router.invalidate();
    });
    await settled();
    // Then the agent proposes version 3.
    fake.proposed(3);
    await act(async () => {
      await router.invalidate();
    });
    await settled();

    expect({
      open,
      reopened: document.querySelector('[role="dialog"]') !== null,
      // Offered on the bar: the preview waits for the App's chat.
      offered: says("Publish version 3"),
    }).toStrictEqual({ open: true, reopened: false, offered: true });
  });

  it("shows nothing of a chat it no longer follows: its draft goes with it", async () => {
    // The App's own chat, kept by the tab: its drafts never come here.
    setActiveChat("chat-own", appSlot("invoice-desk"));
    const refuse = Promise.withResolvers<boolean>();
    await opened(
      fakeApps("published").apps,
      identityOf(false),
      "chat-handed",
      async (chatId) => {
        if (chatId === "chat-handed") {
          await refuse.promise;
          throw Object.assign(new Error("There's no such chat."), {
            code: "agent.chat_not_found",
          });
        }
        return await Promise.withResolvers<never>().promise;
      },
      undefined,
      async (chatId) =>
        chatId === "chat-handed"
          ? await Promise.resolve([
              {
                app: "invoice-desk",
                base: 1,
                changed: ["src/routes/index.tsx"],
                deleted: [],
                revision: 1,
                updatedAt: "2026-10-20T08:00:00.000Z",
                callId: null,
              },
            ])
          : await Promise.withResolvers<ChatDraft[]>().promise
    );
    await settled();
    const handed = says("Unpublished changes");

    refuse.resolve(true);
    await settled();

    expect({ handed, own: says("Unpublished changes") }).toStrictEqual({
      handed: true,
      own: false,
    });
  });

  it("publishes the chat's draft the agent didn't propose: proposed by the person, then reviewed", async () => {
    const fake = fakeApps("published");
    let drafted = true;
    const proposals: string[] = [];
    await opened(
      fake.apps,
      identityOf(false),
      "chat-unproposed",
      async () => await Promise.resolve(watching()),
      undefined,
      async () =>
        await Promise.resolve(drafted ? [draftOf("invoice-desk")] : []),
      async (chatId, app) => {
        proposals.push(`${chatId} ${app}`);
        await Promise.resolve();
        // Core commits it as version 2, up for review, and drops the draft.
        fake.proposed(2);
        drafted = false;
        return 2;
      }
    );
    await settled();
    const before = says("Unpublished changes");

    await choose("Published", "Publish changes");

    expect({
      before,
      proposals,
      review: document.querySelector('[role="dialog"] h2')?.textContent,
      makeCurrent: button("Make version 2 current").disabled,
    }).toStrictEqual({
      before: true,
      proposals: ["chat-unproposed invoice-desk"],
      review: "Publish version 2",
      makeCurrent: false,
    });
  });

  it("still publishes a draft App as it is, beside publishing its unproposed changes", async () => {
    const { calls, apps } = fakeApps("draft");
    await opened(
      apps,
      identityOf(false),
      "chat-both",
      async () => await Promise.resolve(watching()),
      undefined,
      async () => await Promise.resolve([draftOf("invoice-desk")])
    );
    await settled();
    await press(button("Publish"));
    const offered = [
      ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ].map(nameOf);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      await Promise.resolve();
    });
    await settled();

    await choose("Publish", "PublishFor the people");

    expect({ offered, status: status(), calls }).toStrictEqual({
      offered: [
        "Publish changesCheck what the chat built, then review it",
        "PublishFor the people it is shared with",
        "LinkNone yet",
      ],
      status: "Published",
      calls: ["publish"],
    });
  });

  it("doesn't propose the draft while the chat's agent still writes it", async () => {
    const proposals: string[] = [];
    let send: ((update: ChatUpdate) => void) | undefined;
    await opened(
      fakeApps("published").apps,
      identityOf(false),
      "chat-writing",
      async (_chat, _after, received) => {
        send = received;
        return await Promise.resolve(watching());
      },
      undefined,
      async () => await Promise.resolve([draftOf("invoice-desk")]),
      async (chatId) => {
        proposals.push(chatId);
        return await Promise.resolve(2);
      }
    );
    await settled();
    await act(async () => {
      send?.({
        messages: [],
        partial: null,
        running: true,
        stopped: null,
        held: 0,
        drafts: 1,
      });
      await Promise.resolve();
    });
    await settled();

    await choose("Published", "Publish changes");

    expect({
      proposals,
      review: document.querySelector('[role="dialog"]'),
    }).toStrictEqual({ proposals: [], review: null });
  });

  it("says why core didn't propose the draft, opening no review", async () => {
    await opened(
      fakeApps("draft", { currentVersion: null }).apps,
      identityOf(false),
      "chat-failing",
      async () => await Promise.resolve(watching()),
      undefined,
      async () => await Promise.resolve([draftOf("invoice-desk")]),
      async () => {
        await Promise.resolve();
        throw Object.assign(
          new Error("The changes don't pass their checks yet."),
          { code: "app.draft_failed" }
        );
      }
    );
    await settled();

    await choose("Publish", "Publish changes");

    expect({
      said: says("The changes don't pass their checks yet."),
      review: document.querySelector('[role="dialog"]'),
    }).toStrictEqual({ said: true, review: null });
  });
});
