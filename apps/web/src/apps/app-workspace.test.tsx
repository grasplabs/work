// @vitest-environment happy-dom
import type { AppReview } from "@grasp-os/shared/app-review";
import type {
  App,
  AppMember,
  AppMemberRef,
  ShareCandidates,
  ViewedApp,
} from "@grasp-os/shared/apps";
import type {
  ChatQuestion,
  ChatUpdate,
  PreviewBundle,
} from "@grasp-os/shared/chat";
import type {
  Draft,
  DraftCheckpoint,
  LiveVersion,
} from "@grasp-os/shared/drafts";
import {
  appIdSchema,
  permissionIdSchema,
  workflowResourceIdSchema,
} from "@grasp-os/shared/ids";
import type { Permission } from "@grasp-os/shared/permissions";
import type { Identity } from "@grasp-os/shared/rpc";
import type { Subject } from "@grasp-os/shared/subject";
import { SidebarProvider } from "@grasp-os/ui/components/sidebar";
import { Toaster } from "@grasp-os/ui/components/toast";
import { typeInPrompt } from "@grasp-os/ui/testing";
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

import { activeChat, setActiveChat } from "../chat/active-chat.ts";
import { ChatPanel } from "../chat/chat-panel.tsx";
import { slotOf } from "../chat/chat-subject.ts";
import { GlobalChatProvider } from "../chat/global-chat.tsx";
import { socketsTo } from "../pages/test-socket.ts";
import { OpenedApp } from "./app-page.tsx";
import { AppWorkspace } from "./app-workspace.tsx";
import type { ReadOnlyShown, WorkspaceEnv } from "./app-workspace.tsx";
import { markMade } from "./made-tip.ts";

// An App's workspace against core's `apps` as the page reaches it over
// RPC (the boundary from the web app), faked: only its builders get it,
// at the App's own address, where anyone else gets the live App with
// nothing that builds it; its main area always shows the App, its draft
// previewed, or, where the App has no page yet, what it should do, asked
// in its place; Share with your team asks who gets it, says what applies
// and whether its changes pass their checks, publishes them as the person
// over the revision shown and shares it with whoever was ticked, the page
// reads it again afterwards, and what core refuses is said in the page's
// words; once shared, a line under the bar says what changes only its
// builders see; an archived App is restored from it.
// The draft is the App's own, shared by its builders: read from core, and
// again as the chat beside it says its agent wrote.
// Grasp's chat stands beside it, as in the shell, about the App: its chat
// found from core, or the one handed over.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** The tab's slot for the App's chat, which Grasp's chat shows here. */
const deskSlot = slotOf({ kind: "app", id: "invoice-desk" });

/** Whom the fake shares with, by name. */
const memberNames: Record<string, string> = {
  "t-fin": "Finance team",
  "p-bo": "Bo",
};

/** Someone the App is shared with, as core lists them. */
const memberOf = (type: AppMemberRef["type"], id: string): AppMember => ({
  type,
  id,
  name: memberNames[id] ?? id,
  role: "user",
  addedBy: "user-1",
  addedAt: "2026-10-20T08:00:00.000Z",
});

/** Core's `apps` for one App, as someone with `role` in it reads it. */
const fakeApps = ({
  role = "builder",
  archived = false,
  currentVersion = 1,
  sharedWith = [],
  points = [],
}: {
  role?: ViewedApp["role"];
  archived?: boolean;
  currentVersion?: number | null;
  /** Whom it is shared with now. */
  sharedWith?: AppMember[];
  /** The draft's checkpoints, newest first. */
  points?: DraftCheckpoint[];
} = {}) => {
  const calls: string[] = [];
  let members = sharedWith;
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
    liveLabel: currentVersion === null ? null : `26.11.${currentVersion}`,
    archived,
    link: null,
    createdAt: "2026-10-20T08:00:00.000Z",
    role,
  };
  return {
    calls,
    /** Someone shares the App meanwhile, as `member`, the page unaware. */
    sharedMeanwhile: (member: AppMember): void => {
      members = [...members, member];
    },
    /** The App's draft was published as version `version`: it is live. */
    published: (version: number): App => {
      app = { ...app, currentVersion: version, liveLabel: `26.11.${version}` };
      return app;
    },
    apps: {
      get: async (): Promise<ViewedApp> => await Promise.resolve(app),
      versions: {
        // A version as core answers it: labelled once it was live.
        get: async (
          _id: string,
          version: number
        ): Promise<{ label: string | null }> =>
          await Promise.resolve({
            label:
              version <= (app.currentVersion ?? 0) ? `26.11.${version}` : null,
          }),
        // Rolling back to a version: `version` live, over the draft at
        // `revision`, only over `expected`, the version the person saw live.
        rollback: async (
          id: string,
          version: number,
          revision?: number,
          expected?: number | null
        ): Promise<App> => {
          calls.push(
            `rollback ${id} ${version} over ${revision} from ${expected}`
          );
          await Promise.resolve();
          app = {
            ...app,
            currentVersion: version,
            liveLabel: `26.11.${version}`,
          };
          return app;
        },
      },
      list: async (): Promise<ViewedApp[]> => await Promise.resolve([app]),
      restore: async (): Promise<App> => {
        calls.push("restore");
        await Promise.resolve();
        app = { ...app, archived: false };
        return app;
      },
      members: {
        list: async (): Promise<AppMember[]> => await Promise.resolve(members),
        candidates: async (): Promise<ShareCandidates> =>
          await Promise.resolve({
            teams: [{ id: "t-fin", name: "Finance team" }],
            people: [
              { id: "user-1", name: "Ann" },
              { id: "p-bo", name: "Bo" },
            ],
            projects: [],
          }),
        add: async (
          _app: string,
          { type, id, role: as }: AppMemberRef & { role: string }
        ): Promise<void> => {
          calls.push(`share ${type}:${id} as ${as}`);
          await Promise.resolve();
          members = [...members, memberOf(type, id)];
        },
        remove: async (_app: string, { type, id }: AppMemberRef) => {
          calls.push(`unshare ${type}:${id}`);
          await Promise.resolve();
          members = members.filter(
            (member) => !(member.type === type && member.id === id)
          );
        },
      },
      /** The draft's checkpoints, newest first. */
      draftPoints: async (): Promise<DraftCheckpoint[]> =>
        await Promise.resolve(points),
      /** Makes checkpoint `point` the draft again, over `revision`. */
      restoreDraftPoint: async (
        _app: string,
        point: number,
        revision: number
      ): Promise<void> => {
        calls.push(`restore point ${point} over ${revision}`);
        await Promise.resolve();
      },
      /** Discards the draft's changes, over the revision the person saw. */
      discardDraft: async (_app: string, revision: number): Promise<void> => {
        calls.push(`discard over ${revision}`);
        await Promise.resolve();
      },
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
  typeof data === "object" && data !== null && "archived" in data;

/**
 * The draft of `app` changing `changed`, written by a chat's agent and not
 * published; changing nothing, at revision 0.
 */
const draftOf = (
  app: string,
  changed: string[] = ["src/routes/index.tsx"]
): Draft => ({
  subject: { kind: "app", id: appIdSchema.parse(app) },
  base: 1,
  changed,
  deleted: [],
  definitionChanged: false,
  revision: changed.length === 0 ? 0 : 1,
  updatedAt: changed.length === 0 ? null : "2026-10-20T08:00:00.000Z",
  updatedBy: changed.length === 0 ? null : "user-1",
});

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

/** What a publish or roll back made live, as core answers it. */
const liveOf = (made: App): LiveVersion => ({
  subject: { kind: "app", id: made.id },
  version: made.currentVersion ?? 0,
  label: made.liveLabel ?? "",
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
  /**
   * The App's draft, as core reads it; by default one with a change only
   * its builders see, so the workspace shows their working version.
   */
  draft: () => Promise<Draft> = async () =>
    await Promise.resolve(draftOf("invoice-desk")),
  /** How core answers the person publishing the App's draft; by default not yet. */
  publish: (app: string, revision: number) => Promise<App> = async () =>
    await Promise.withResolvers<never>().promise,
  /** What publishing the draft changes, as core reads it; by default not yet. */
  changes: () => Promise<AppReview> = async () =>
    await Promise.withResolvers<never>().promise,
  /** Draft or Live, as the address says. */
  env: WorkspaceEnv = "draft",
  /** A checkpoint or a version History opened read-only, if any. */
  shown?: ReadOnlyShown
) => {
  // The App's chat: core never answers `forSubject` here. A chat that is
  // followed sends nothing yet and worked on nothing.
  const askedForApp: string[] = [];
  const sent: { chatId: string; question: ChatQuestion }[] = [];
  const chats = {
    forSubject: async ({ id }: { kind: string; id: string }) => {
      askedForApp.push(id);
      return await forApp();
    },
    watch,
    worked: async () => await Promise.resolve([]),
    connectionRequests: async () => await Promise.resolve([]),
    models: async () => await Promise.resolve(["openai/gpt-5"]),
    send: async (chatId: string, question: ChatQuestion) => {
      sent.push({ chatId, question });
      await Promise.resolve();
    },
    efforts: async () => await Promise.resolve({}),
    summary: async () => await Promise.withResolvers<never>().promise,
  };
  const pendingActions = { list: async () => await Promise.resolve([]) };
  const withReview = { ...apps, review: changes };
  const drafts = {
    get: draft,
    publish: async ({ id }: Subject, revision: number) =>
      liveOf(await publish(id, revision)),
    checkpoints: apps.draftPoints,
    restore: async ({ id }: Subject, point: number, revision: number) => {
      await apps.restoreDraftPoint(id, point, revision);
    },
    discard: async ({ id }: Subject, revision: number) => {
      await apps.discardDraft(id, revision);
    },
  };
  const versions = {
    get: async ({ id }: Subject, version: number) =>
      await apps.versions.get(id, version),
    rollback: async (
      { id }: Subject,
      version: number,
      revision?: number,
      expected?: number | null
    ) => liveOf(await apps.versions.rollback(id, version, revision, expected)),
  };
  const core = {
    withSession: async <T,>(
      action: (session: {
        apps: typeof withReview;
        drafts: typeof drafts;
        versions: typeof versions;
        chats: typeof chats;
        pendingActions: typeof pendingActions;
      }) => Promise<T>
    ): Promise<T> =>
      await action({
        apps: withReview,
        drafts,
        versions,
        chats,
        pendingActions,
      }),
    // The live App's page joins the tab's connection, which never
    // answers here: it stays on its way.
    onEnded: () => () => {},
    session: async () => await Promise.withResolvers<never>().promise,
    person: async () => await Promise.withResolvers<never>().promise,
  };
  const rootRoute = createRootRoute({ component: Outlet });
  // The shell, whose context names who is signed in, with Grasp's chat
  // beside the page and its toasts, as the app's has it.
  const shell = createRoute({
    getParentRoute: () => rootRoute,
    id: "_shell",
    beforeLoad: () => ({ identity }),
    component: () => (
      <SidebarProvider>
        <Toaster>
          <GlobalChatProvider>
            <Outlet />
            <ChatPanel />
          </GlobalChatProvider>
        </Toaster>
      </SidebarProvider>
    ),
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
      <OpenedApp
        app={loaded}
        back={{ label: "Apps", to: "/apps" }}
        env={env}
        handedOver={handedOver}
        identity={identity}
        pages
        section={undefined}
        shown={shown}
        view="preview"
      />
    );
  };
  page.update({ component: Page });
  // Somewhere else in the shell, to leave the workspace for.
  const elsewhere = createRoute({
    getParentRoute: () => shell,
    path: "/elsewhere",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([shell.addChildren([page, elsewhere])]),
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
  return { askedForApp, router, sent };
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

/**
 * What publishing the draft of `draftOf` changes, as core reads it at
 * revision 1: its page changed, checks passing, unless `overrides` says
 * otherwise.
 */
const changesOf = (overrides: Partial<AppReview> = {}): AppReview => ({
  revision: 1,
  live: null,
  liveLabel: null,
  next: "26.11.1",
  files: [
    {
      path: "src/routes/index.tsx",
      change: "modified",
      before: "export {};\n",
      after: "export const page = 1;\n",
    },
  ],
  plan: null,
  check: { passed: true, problems: [] },
  server: null,
  serverFiles: [],
  migrations: [],
  handsFilesToWorkflows: false,
  readsPeople: false,
  rowRules: [],
  permissions: [],
  grants: [],
  callers: [],
  ...overrides,
});

/**
 * A workflow's grant to call the App's function `path`, as core lists it
 * among the draft's callers.
 */
const callerGrant = (workflow: string, path: string): Permission => {
  const workflowId = workflowResourceIdSchema.parse(crypto.randomUUID());
  return {
    id: permissionIdSchema.parse(crypto.randomUUID()),
    subject: { type: "workflow", workflowId },
    object: {
      type: "app",
      appId: appIdSchema.parse("invoice-desk"),
      function: "f1",
    },
    actions: ["call"],
    binding: "INVOICES",
    status: "active",
    requestedBy: "user-1",
    requestedAt: "2026-10-20T08:00:00.000Z",
    grantedBy: "admin-1",
    grantedAt: "2026-10-20T09:00:00.000Z",
    revokedBy: null,
    revokedAt: null,
    requestedVia: null,
    chat: null,
    workflowNames: { [workflowId]: workflow },
    functionName: path,
  };
};

/** The sheet Share with your team opens, once open. */
const sheet = (): HTMLElement | null =>
  document.querySelector('[data-slot="sheet-content"]');

/** The button in the sheet called `name`. */
const sheetButton = (name: string): HTMLButtonElement => {
  const found = [...(sheet()?.querySelectorAll("button") ?? [])].find(
    (each) => nameOf(each) === name
  );
  if (found === undefined) {
    throw new Error(`No button ${name} in the sheet`);
  }
  return found;
};

/** Ticks `name` among who gets it, in the sheet. */
const tick = async (name: string): Promise<void> => {
  const row = [...(sheet()?.querySelectorAll("li") ?? [])].find(
    (each) => each.textContent?.trim() === name
  );
  const box = row?.querySelector<HTMLElement>('[role="checkbox"]');
  if (box === undefined || box === null) {
    throw new Error(`No ${name} to tick`);
  }
  await press(box);
};

/** Whether `element` is the page's lime action. */
const lime = (element: HTMLElement): boolean =>
  element.className.includes("bg-highlight");

/** Share with your team, in the bar. */
const shareButton = (): HTMLButtonElement => button("Share with your team");

/** Whether the workspace is gone from the page: no Share with your team in it. */
const shareButtonGone = (): boolean =>
  ![...document.querySelectorAll("button")].some(
    (each) => nameOf(each) === "Share with your team"
  );

/** Whether `element` is off, as a button kept focusable while off is. */
const off = (element: HTMLElement): boolean =>
  element.getAttribute("aria-disabled") === "true" ||
  element.hasAttribute("disabled");

/** What the box to ask in says while it is empty. */
const placeholder = (): string | undefined =>
  document.querySelector<HTMLElement>('[role="textbox"] p')?.dataset
    .placeholder;

/** The line under the bar of changes only the builders see, if shown. */
const changesLine = (): HTMLElement | null =>
  document.querySelector('section[aria-label="Changes only you see"]');

/** What "…" offers, once open. */
const moreMenu = async (): Promise<string[]> => {
  await press(button("More"));
  return [...document.querySelectorAll('[role="menuitem"]')].map(
    (item) => item.textContent?.trim() ?? ""
  );
};

/** The button named `name` the person can reach: none under what covers it (`inert`). */
const reachable = (name: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find(
    (each) => nameOf(each) === name && each.closest("[inert]") === null
  );

/** What the toasts say. */
const toasts = (): string[] =>
  [...document.querySelectorAll('[data-slot="toast"]')].map(
    (each) => each.textContent?.trim() ?? ""
  );

/** The App's status badge, in the bar. */
const status = (): string | null | undefined =>
  document.querySelector('[data-slot="badge"]')?.textContent;

/** Whether the App's chat takes a question: its box, in a chat not closed. */
const askable = (): boolean =>
  document.querySelector(
    '[role="textbox"][aria-label="Ask for a change"]:not([inert] *)'
  ) !== null;

/** Types `text` in the App's chat and sends it. */
const typeAndSend = async (text: string): Promise<void> => {
  const box = document.querySelector(
    '[role="textbox"][aria-label="Ask for a change"]'
  );
  if (box === null) {
    throw new Error("No box to ask in");
  }
  await act(async () => {
    typeInPrompt(box, text);
    await Promise.resolve();
  });
  await press(button("Send"));
};

const says = (text: string): boolean =>
  document.body.textContent.includes(text);

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

  get apps(): this {
    return this;
  }

  get preview(): this {
    return this;
  }

  async open(...args: unknown[]): Promise<PreviewBundle> {
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
 * answers while the draft changes nothing: at the draft's revision 0.
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
  // The chat's thread loads on its own (`lazy`), the first
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
    setActiveChat(undefined, deskSlot);
  });

  it("is for the App's builders alone: a user of it, or Grasp staff, gets the App itself, with nothing that builds it", async () => {
    const seen: Record<string, unknown> = {};
    const viewers = {
      builder: { role: "builder", staff: false },
      user: { role: "user", staff: false },
      staff: { role: "builder", staff: true },
    } as const;
    for (const [who, { role, staff }] of Object.entries(viewers)) {
      // oxlint-disable-next-line no-await-in-loop -- one page at a time
      await opened(fakeApps({ role }).apps, identityOf(staff));
      // oxlint-disable-next-line no-await-in-loop -- one page at a time
      await settled();
      seen[who] = {
        name: document.querySelector("h1")?.textContent,
        views:
          document.querySelector('nav[aria-label="Workspace views"]') !== null,
        share: [...document.querySelectorAll("button")].some(
          (each) => nameOf(each) === "Share with your team"
        ),
        chat: askable(),
        app: document.querySelector('iframe[title="App"]') !== null,
      };
      takenDown();
    }

    expect(seen).toStrictEqual({
      builder: {
        name: "Invoices",
        views: true,
        share: true,
        chat: true,
        app: false,
      },
      user: {
        name: "Invoices",
        views: false,
        share: false,
        chat: false,
        app: true,
      },
      staff: {
        name: "Invoices",
        views: false,
        share: false,
        chat: false,
        app: true,
      },
    });
  });

  it("asks what the App should do where it has no page yet, never a card in its place", async () => {
    const said: Record<string, unknown> = {};
    // Nothing written to it and no version: asked at once, with no
    // preview to try.
    const untouched = new PreviewingCore();
    socketsTo(untouched);
    await opened(
      fakeApps({ currentVersion: null }).apps,
      identityOf(false),
      "chat-empty",
      async () => await Promise.resolve(watching()),
      undefined,
      async () => await Promise.resolve(draftOf("invoice-desk", []))
    );
    await settled();
    said.empty = {
      asks: says("What should this App do?"),
      previews: untouched.asked.length,
    };
    takenDown();
    // While core reads the App's draft, the preview is on its way.
    await opened(
      fakeApps().apps,
      identityOf(false),
      undefined,
      undefined,
      undefined,
      async () => await Promise.withResolvers<never>().promise
    );
    const reading = {
      loading: document.querySelector('[aria-label="Loading…"]') !== null,
      frame: document.querySelector("iframe"),
    };

    expect({ said, reading }).toStrictEqual({
      said: { empty: { asks: true, previews: 0 } },
      reading: { loading: true, frame: null },
    });
  });

  it("asks what an App with no page yet should do in the App's own chat, beside it", async () => {
    const { sent } = await opened(
      fakeApps({ currentVersion: null }).apps,
      identityOf(false),
      "chat-first",
      async () => await Promise.resolve(watching()),
      undefined,
      async () => await Promise.resolve(draftOf("invoice-desk", []))
    );
    await settled();
    const box = document.querySelector(
      '[role="textbox"][aria-label="Describe the App"]'
    );
    if (box === null) {
      throw new Error("No box to say what the App should do");
    }
    await act(async () => {
      typeInPrompt(box, "A board of open invoices");
      await Promise.resolve();
    });
    await act(async () => {
      box.closest("form")?.requestSubmit();
      await Promise.resolve();
    });
    await settled();

    expect(
      sent.map(({ chatId, question }) => ({
        chatId,
        text: question.text,
        subject: question.subject,
      }))
    ).toStrictEqual([
      {
        chatId: "chat-first",
        text: "A board of open invoices",
        subject: { kind: "app", id: "invoice-desk" },
      },
    ]);
  });

  it("switches the main area between Preview, Code, Data and Settings, the one shown marked", async () => {
    await opened(fakeApps().apps);

    const views = document.querySelector('nav[aria-label="Workspace views"]');
    expect(
      [...(views?.querySelectorAll("a") ?? [])].map((link) => ({
        name: link.textContent,
        to: link.getAttribute("href"),
        shown: link.getAttribute("aria-current") === "page",
      }))
    ).toStrictEqual([
      { name: "App", to: "/apps/invoice-desk", shown: true },
      { name: "Code", to: "/apps/invoice-desk?view=code", shown: false },
      { name: "Data", to: "/apps/invoice-desk?view=data", shown: false },
      {
        name: "Settings",
        to: "/apps/invoice-desk?view=settings",
        shown: false,
      },
    ]);
  });

  it("shows the builders' own version, and what the team sees from …, once the team has a version, with the way back", async () => {
    // Set up, as its draft passes its check: nothing shared yet.
    await opened(
      fakeApps({ currentVersion: null }).apps,
      identityOf(false),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      async () => await Promise.resolve(changesOf())
    );
    await settled();
    const nothingShared = await moreMenu();
    takenDown();
    await opened(fakeApps().apps);
    const offered = await moreMenu();
    const link = [...document.querySelectorAll('[role="menuitem"]')]
      .find((item) => item.textContent?.trim() === "See what your team sees")
      ?.getAttribute("href");
    takenDown();
    await opened(
      fakeApps().apps,
      identityOf(false),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "live"
    );
    const back = [...document.querySelectorAll("a")]
      .find((each) => each.textContent?.trim() === "Back to your version")
      ?.getAttribute("href");

    expect({
      switch: document.querySelector('nav[aria-label="Draft or live"]'),
      nothingShared: nothingShared.includes("See what your team sees"),
      offered: offered.includes("See what your team sees"),
      link,
      back,
    }).toStrictEqual({
      switch: null,
      nothingShared: false,
      offered: true,
      link: "/apps/invoice-desk?env=live",
      back: "/apps/invoice-desk",
    });
  });

  it("shows its builder what the team sees while nothing is only theirs, and their own version once there are changes", async () => {
    const seen: Record<string, unknown> = {};
    for (const [state, changed, definitionChanged] of [
      ["nothingOnlyTheirs", [], false],
      ["changes", ["src/routes/index.tsx"], false],
      // Its data model changed, and no file: changes all the same.
      ["definitionOnly", [], true],
    ] as const) {
      const core = new PreviewingCore();
      socketsTo(core);
      // oxlint-disable-next-line no-await-in-loop -- one page at a time
      await opened(
        fakeApps().apps,
        identityOf(false),
        undefined,
        undefined,
        undefined,
        async () =>
          await Promise.resolve({
            ...draftOf("invoice-desk", [...changed]),
            definitionChanged,
          })
      );
      // oxlint-disable-next-line no-await-in-loop -- one page at a time
      await settled();
      // oxlint-disable-next-line no-await-in-loop -- one page at a time
      const menu = await moreMenu();
      seen[state] = {
        teams:
          document.querySelector(
            '[aria-label="Invoices, as your team sees it"]'
          ) !== null,
        previews: core.asked.length,
        offered: menu.includes("See what your team sees"),
      };
      takenDown();
    }

    expect(seen).toStrictEqual({
      nothingOnlyTheirs: { teams: true, previews: 0, offered: false },
      changes: { teams: false, previews: 1, offered: true },
      definitionOnly: { teams: false, previews: 1, offered: true },
    });
  });

  it("showing what the team sees, runs the App's page as the person, never the builders' preview", async () => {
    const core = new PreviewingCore();
    socketsTo(core);
    await opened(
      fakeApps().apps,
      identityOf(false),
      "chat-live",
      async () => await Promise.resolve(watching()),
      undefined,
      undefined,
      undefined,
      undefined,
      "live"
    );
    await settled();

    expect({
      frame: document.querySelector("iframe")?.getAttribute("title"),
      previews: core.asked,
    }).toStrictEqual({
      frame: "App",
      previews: [],
    });
  });

  it("says in the preview's place why it didn't start, with Try again, and Fix with Grasp, which asks the App's chat", async () => {
    const core = new PreviewingCore("page.build_failed");
    socketsTo(core);
    const { sent } = await opened(
      fakeApps().apps,
      identityOf(false),
      "chat-broken",
      async () => await Promise.resolve(watching()),
      undefined,
      async () => await Promise.resolve(draftOf("invoice-desk"))
    );
    await act(async () => {
      await core.reached;
    });
    await vi.waitFor(async () => {
      await act(async () => {
        await Promise.resolve();
      });
      expect(says("The preview didn't start")).toBeTruthy();
    });
    const said = {
      why: says("The draft's code doesn't build."),
      details: button("Technical details") instanceof HTMLButtonElement,
    };
    await press(button("Fix with Grasp"));
    await press(button("Try again"));

    expect({
      said,
      sent: sent.map(({ chatId, question }) => ({
        chatId,
        asks: question.text.startsWith("My version of the App didn't start."),
        at: question.text.includes("- /: page.build_failed"),
      })),
      opens: core.asked.length,
    }).toStrictEqual({
      said: { why: true, details: true },
      sent: [{ chatId: "chat-broken", asks: true, at: true }],
      opens: 2,
    });
  });

  it("restores an archived App, with no chat or Share until then", async () => {
    const { calls, apps } = fakeApps({ archived: true });
    await opened(apps);
    const archived = {
      status: status(),
      chat: [...document.querySelectorAll("button")].some(
        (each) => nameOf(each) === "Chat"
      ),
      share: [...document.querySelectorAll("button")].some(
        (each) => nameOf(each) === "Share with your team"
      ),
    };

    await press(button("Restore"));

    expect({ archived, restored: status(), calls }).toStrictEqual({
      archived: { status: "Archived", chat: false, share: false },
      // Shared with nobody yet.
      restored: "Only you see this",
      calls: ["restore"],
    });
  });

  it("keeps Grasp's chat open beside it, about the App, with no way to close it", async () => {
    await opened(fakeApps().apps, identityOf(false), "chat-kept-open");
    await settled();
    const shown = askable();
    // Its shortcut, which closes it elsewhere.
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "j", ctrlKey: true, metaKey: true })
      );
      await Promise.resolve();
    });
    await settled();

    expect({
      shown,
      after: askable(),
      close: [...document.querySelectorAll("button")].some(
        (each) => nameOf(each) === "Close"
      ),
    }).toStrictEqual({ shown: true, after: true, close: false });
  });

  it("asks about the App: each question carries it, named in the bar on the box", async () => {
    const { sent } = await opened(
      fakeApps().apps,
      identityOf(false),
      "chat-about-app"
    );
    await settled();
    const bar = document.querySelector(
      '[data-slot="prompt-input-subject-bar"]'
    )?.textContent;
    await typeAndSend("Add a due date column");
    await typeAndSend("What's a good name for it?");

    expect({
      bar,
      sent: sent.map(({ chatId, question }) => ({
        chatId,
        text: question.text,
        subject: question.subject,
      })),
    }).toStrictEqual({
      bar: "Invoices",
      sent: ["Add a due date column", "What's a good name for it?"].map(
        (text) => ({
          chatId: "chat-about-app",
          text,
          subject: { kind: "app", id: "invoice-desk" },
        })
      ),
    });
  });

  it("makes the chat the person came from, building the App, the App's chat, rather than asking core for one", async () => {
    const { askedForApp } = await opened(
      fakeApps().apps,
      identityOf(false),
      "chat-built-in"
    );
    await settled();
    await press(button("More"));

    expect({
      askedForApp,
      kept: activeChat(deskSlot),
      openInChat: document
        .querySelector('[role="menuitem"][href^="/?chat="]')
        ?.getAttribute("href"),
    }).toStrictEqual({
      askedForApp: [],
      kept: "chat-built-in",
      openInChat: "/?chat=chat-built-in",
    });
  });

  it("previews a version read-only, named without a label it lacks, with no tab of its own to open", async () => {
    const core = new PreviewingCore();
    socketsTo(core);
    const fake = fakeApps({ currentVersion: null });
    await opened(
      fake.apps,
      identityOf(false),
      "chat-reading",
      async () => await Promise.resolve(watching()),
      undefined,
      undefined,
      undefined,
      undefined,
      "draft",
      { version: 1 }
    );
    await act(async () => {
      await core.reached;
    });
    await settled();

    expect({
      badge: says("This version, read-only"),
      asked: core.asked.map((args) => args.filter((arg) => arg !== undefined)),
    }).toStrictEqual({
      badge: true,
      asked: [["invoice-desk", 1]],
    });
  });

  it("previews the App's draft in a sandboxed frame", async () => {
    const core = new PreviewingCore();
    socketsTo(core);
    await opened(
      fakeApps().apps,
      identityOf(false),
      "chat-previewing",
      async () => await Promise.resolve(watching())
    );
    await act(async () => {
      await core.reached;
    });
    const frame = document.querySelector("iframe");

    expect({
      frame: {
        title: frame?.getAttribute("title"),
        sandbox: frame?.getAttribute("sandbox"),
      },
      // What the frame asked core to build: the draft's preview, which core
      // builds from the App's latest version while the draft changes
      // nothing; never read-only, so the next write comes into it.
      asked: core.asked.map((args) => args.filter((arg) => arg !== undefined)),
    }).toStrictEqual({
      frame: {
        title: "Your version of the App",
        sandbox: "allow-scripts",
      },
      asked: [["invoice-desk"]],
    });
  });

  it("keeps the frame open on the page it shows when the chat's next write changes that page, rather than starting it afresh", async () => {
    const fake = fakeApps();
    const core = new PreviewingCore(undefined, deskOfVersion1);
    socketsTo(core);
    let send: ((update: ChatUpdate) => void) | undefined;
    let draft = draftOf("invoice-desk", ["src/routes/index.tsx"]);
    await opened(
      fake.apps,
      identityOf(false),
      "chat-drafting",
      async (_chat, _after, received) => {
        send = received;
        return await Promise.resolve(watching());
      },
      undefined,
      async () => await Promise.resolve(draft)
    );
    await act(async () => {
      await core.reached;
    });
    await settled();
    const frame = document.querySelector("iframe");

    // The agent's next write changes `desk`, the page the frame shows.
    draft = draftOf("invoice-desk", [
      "src/routes/index.tsx",
      "src/routes/desk.tsx",
    ]);
    await act(async () => {
      send?.({
        messages: [],
        partial: null,
        running: false,
        stopped: null,
        held: 0,
        worked: 1,
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

  it("asks to change something about the plan under a plan that waits, and builds it from the chat's thread", async () => {
    let send: ((update: ChatUpdate) => void) | undefined;
    await opened(
      fakeApps().apps,
      identityOf(false),
      "chat-plan",
      async (_chat, _after, received) => {
        send = received;
        return await Promise.resolve(watching());
      },
      undefined,
      async () => await Promise.resolve(draftOf("invoice-desk"))
    );
    await settled();
    const before = placeholder();
    await act(async () => {
      send?.({
        messages: [
          {
            id: 1,
            role: "user",
            text: "Add a board of late tasks.",
            at: "2026-11-11T09:00:00.000Z",
          },
          {
            id: 2,
            role: "assistant",
            text: "",
            citations: [],
            code: [],
            tools: [],
            planned: {
              callId: "call-plan",
              parts: [{ kind: "app", name: "Late board", does: "Late tasks." }],
              who: "Finance team",
            },
            end: "done",
            at: "2026-11-11T09:01:00.000Z",
          },
        ],
        partial: null,
        running: false,
        stopped: null,
        held: 0,
        worked: 0,
      });
      await Promise.resolve();
    });
    await settled();

    expect({
      before,
      after: placeholder(),
      plan:
        document.querySelector(
          'section[aria-label="Here\'s what Grasp will make"]'
        ) !== null,
    }).toStrictEqual({
      before: "Say what should change",
      after: "Change something about the plan",
      plan: true,
    });
  });

  it("opens the App's own chat when the chat handed over can't be followed", async () => {
    const { askedForApp } = await opened(
      fakeApps().apps,
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
      fakeApps().apps,
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

    const said = says(
      "Too many of your pages follow chats at once. Close some, then try again."
    );
    await press(button("More"));

    expect({
      askedForApp,
      says: said,
      openInChat: document
        .querySelector('[role="menuitem"][href^="/?chat="]')
        ?.getAttribute("href"),
    }).toStrictEqual({
      askedForApp: [],
      says: true,
      openInChat: "/?chat=chat-handed-over",
    });
  });

  it("asks core for the App's chat again when the one this tab kept is gone", async () => {
    setActiveChat("chat-kept-gone", deskSlot);
    const { askedForApp } = await opened(
      fakeApps().apps,
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

  it("asks core for the App's chat again on Try again, after it gave none", async () => {
    let refusals = 1;
    const { askedForApp } = await opened(
      fakeApps().apps,
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

  it("shares with whoever is ticked in one step: publishes the changes over the revision read, then shares the App with them, and says so", async () => {
    const fake = fakeApps({ currentVersion: null });
    let drafted = true;
    const published: unknown[][] = [];
    await opened(
      fake.apps,
      identityOf(false),
      "chat-sharing",
      async () => await Promise.resolve(watching()),
      undefined,
      async () =>
        await Promise.resolve(
          drafted ? draftOf("invoice-desk") : draftOf("invoice-desk", [])
        ),
      async (app, revision) => {
        published.push([app, revision]);
        await Promise.resolve();
        // Core makes it version 1: its changes are the team's now.
        drafted = false;
        return fake.published(1);
      },
      async () => await Promise.resolve(changesOf())
    );
    await settled();
    const before = { status: status(), lime: lime(shareButton()) };

    await press(shareButton());
    const shown = {
      title: sheet()?.querySelector('[data-slot="sheet-title"]')?.textContent,
      who: [...(sheet()?.querySelectorAll("li") ?? [])].map((each) =>
        each.textContent?.trim()
      ),
      sees: says("They'll find it under Apps, and see it as it is now."),
      // Nobody ticked yet: nothing to share with.
      off: off(sheetButton("Share")),
    };
    await tick("Finance team");
    await press(sheetButton("Share"));

    expect({
      before,
      shown,
      published,
      calls: fake.calls,
      after: {
        status: status(),
        sheet: sheet() !== null,
        toasts: toasts(),
      },
    }).toStrictEqual({
      before: { status: "Only you see this", lime: true },
      shown: {
        title: "Share Invoices",
        // Its owner isn't offered: it is theirs.
        who: ["Finance team", "Bo"],
        sees: true,
        off: true,
      },
      published: [["invoice-desk", 1]],
      calls: ["share team:t-fin as user"],
      after: {
        status: "Finance team uses it",
        sheet: false,
        toasts: ["Shared with Finance teamUndo"],
      },
    });
  });

  it("shares the App's version as it is, with nothing shared yet and changes that change nothing, as an App made from a blueprint has", async () => {
    const fake = fakeApps({ currentVersion: null });
    await opened(
      fake.apps,
      identityOf(false),
      "chat-first-version",
      async () => await Promise.resolve(watching()),
      undefined,
      async () => await Promise.resolve(draftOf("invoice-desk", [])),
      undefined,
      async () => await Promise.resolve(changesOf({ revision: 0 }))
    );
    await settled();

    await press(shareButton());
    await tick("Bo");
    await press(sheetButton("Share"));

    expect({ calls: fake.calls, status: status() }).toStrictEqual({
      calls: [
        "rollback invoice-desk 1 over 0 from null",
        "share person:p-bo as user",
      ],
      status: "Bo uses it",
    });
  });

  it("undoes a share from its toast: whoever was added is taken off, and the team has the version it had before again", async () => {
    const fake = fakeApps({
      currentVersion: 1,
      sharedWith: [memberOf("person", "p-bo")],
    });
    let drafted = true;
    await opened(
      fake.apps,
      identityOf(false),
      "chat-undoing",
      async () => await Promise.resolve(watching()),
      undefined,
      async () =>
        await Promise.resolve(
          drafted ? draftOf("invoice-desk") : draftOf("invoice-desk", [])
        ),
      async () => {
        await Promise.resolve();
        drafted = false;
        return fake.published(2);
      },
      async () =>
        await Promise.resolve(
          changesOf({ live: 1, liveLabel: "26.11.1", next: "26.11.2" })
        )
    );
    await settled();

    // Shared, with changes only its builders see: the bar's lime action
    // shares the changes, and whom else to give it to.
    const main = lime(button("Share changes"));
    await press(button("Share changes"));
    const hasIt = sheet()?.textContent.includes("Bohas it");
    await tick("Finance team");
    await press(sheetButton("Share"));
    const shared = { toasts: toasts(), status: status() };
    await press(button("Undo"));

    expect({
      main,
      hasIt,
      shared,
      calls: fake.calls,
      status: status(),
    }).toStrictEqual({
      main: true,
      hasIt: true,
      shared: {
        toasts: ["Shared with Finance teamUndo"],
        status: "Bo and Finance team use it",
      },
      // Its changes emptied over version 2, at revision 0, and version 2
      // still the team's: a colleague's share since would stay.
      calls: [
        "share team:t-fin as user",
        "unshare team:t-fin",
        "rollback invoice-desk 1 over 0 from 2",
      ],
      status: "Bo uses it",
    });
  });

  it("shares only with whom it has no share yet, and Undo puts the shared changes back as the draft over the version before", async () => {
    // The draft as shared, at revision 1, over version 1.
    const sharedPoint: DraftCheckpoint = {
      number: 3,
      revision: 1,
      base: 1,
      contentHash: "shared",
      personId: "user-1",
      chatId: null,
      callId: null,
      restoredFrom: null,
      createdAt: "2026-10-20T08:00:00.000Z",
      touched: ["src/routes/index.tsx"],
      changes: 1,
    };
    const fake = fakeApps({ currentVersion: 1, points: [sharedPoint] });
    let drafted = true;
    await opened(
      fake.apps,
      identityOf(false),
      "chat-undo-restores",
      async () => await Promise.resolve(watching()),
      undefined,
      async () =>
        await Promise.resolve(
          drafted ? draftOf("invoice-desk") : draftOf("invoice-desk", [])
        ),
      async () => {
        await Promise.resolve();
        drafted = false;
        return fake.published(2);
      },
      async () =>
        await Promise.resolve(
          changesOf({ live: 1, liveLabel: "26.11.1", next: "26.11.2" })
        )
    );
    await settled();
    await press(shareButton());
    await tick("Finance team");
    await tick("Bo");
    // A colleague makes Bo a builder of it while the sheet is open.
    fake.sharedMeanwhile({ ...memberOf("person", "p-bo"), role: "builder" });
    await press(sheetButton("Share"));
    await press(button("Undo"));
    await settled();

    expect(fake.calls).toStrictEqual([
      // Bo stays a builder: only the team, which had no share, is added.
      "share team:t-fin as user",
      "unshare team:t-fin",
      "rollback invoice-desk 1 over 0 from 2",
      // The changes shared are the draft again, as before the share.
      "restore point 3 over 0",
    ]);
  });

  it("asks before Undo drops changes taken since the share, even once the workspace was left", async () => {
    const fake = fakeApps({ currentVersion: 1 });
    let stage: "drafted" | "shared" | "changed again" = "drafted";
    const { router } = await opened(
      fake.apps,
      identityOf(false),
      "chat-undo-asks",
      async () => await Promise.resolve(watching()),
      undefined,
      async () =>
        await Promise.resolve(
          stage === "shared"
            ? draftOf("invoice-desk", [])
            : draftOf("invoice-desk")
        ),
      async () => {
        await Promise.resolve();
        stage = "shared";
        return fake.published(2);
      },
      async () =>
        await Promise.resolve(
          changesOf({ live: 1, liveLabel: "26.11.1", next: "26.11.2" })
        )
    );
    await settled();
    await press(shareButton());
    await tick("Finance team");
    await press(sheetButton("Share"));
    // Someone changes it again before Undo, and the person left.
    stage = "changed again";
    await act(async () => {
      router.history.push("/elsewhere");
      await Promise.resolve();
    });
    const left = shareButtonGone();

    await press(button("Undo"));
    await settled();
    const asked = says("Give your team the version they had before?");
    const before = [...fake.calls];
    await press(button("Drop them and go back"));

    expect({ left, asked, before, calls: fake.calls }).toStrictEqual({
      left: true,
      asked: true,
      before: ["share team:t-fin as user", "unshare team:t-fin"],
      calls: [
        "share team:t-fin as user",
        "unshare team:t-fin",
        "rollback invoice-desk 1 over 1 from 2",
      ],
    });
  });

  it("keeps Share off while the changes fail their check, and sends what fails to the App's chat with Fix with Grasp", async () => {
    const published: string[] = [];
    const { sent } = await opened(
      fakeApps().apps,
      identityOf(false),
      "chat-fixing",
      async () => await Promise.resolve(watching()),
      undefined,
      async () => await Promise.resolve(draftOf("invoice-desk")),
      async (app) => {
        published.push(app);
        return await Promise.withResolvers<never>().promise;
      },
      async () =>
        await Promise.resolve(
          changesOf({
            live: 1,
            liveLabel: "26.11.1",
            next: "26.11.2",
            check: {
              passed: false,
              problems: [
                {
                  at: "src/routes/index.tsx",
                  line: 4,
                  message: "Use the Button's own variant.",
                },
              ],
            },
          })
        )
    );
    await settled();

    await press(shareButton());
    await tick("Finance team");
    const sheetOff = off(sheetButton("Share"));
    const problem = says("Use the Button's own variant.");
    await press(sheetButton("Fix with Grasp"));

    expect({
      sheetOff,
      problem,
      published,
      sent: sent.map(({ chatId, question }) => ({
        chatId,
        names: question.text.includes(
          "- src/routes/index.tsx:4: Use the Button's own variant."
        ),
      })),
    }).toStrictEqual({
      sheetOff: true,
      problem: true,
      published: [],
      sent: [{ chatId: "chat-fixing", names: true }],
    });
  });

  /**
   * What the open sheet says of the draft's access, once its changes are
   * shown, as core reads the draft's changes as `changes` says.
   */
  const accessShown = async (changes: Partial<AppReview>): Promise<string> => {
    await opened(
      fakeApps().apps,
      identityOf(false),
      "chat-access",
      async () => await Promise.resolve(watching()),
      undefined,
      async () => await Promise.resolve(draftOf("invoice-desk")),
      undefined,
      async () =>
        await Promise.resolve(
          changesOf({
            live: 1,
            liveLabel: "26.11.1",
            next: "26.11.2",
            ...changes,
          })
        )
    );
    await settled();
    await press(shareButton());
    await press(sheetButton("What changes"));
    const access = [...(sheet()?.querySelectorAll("section") ?? [])].find(
      (section) => section.querySelector("h3")?.textContent === "Access"
    );
    return access?.textContent ?? "";
  };

  it("names in the sheet only the workflows that call the App again once an admin grants it again", async () => {
    const access = await accessShown({
      callers: [
        {
          permission: callerGrant("Approve", "invoices.approve"),
          askedAgain: true,
        },
        {
          permission: callerGrant("Remind", "invoices.remind"),
          askedAgain: false,
        },
      ],
    });

    expect({
      heading: access.includes(
        "Workflows that call it again once an admin grants it again for the new version"
      ),
      askedAgain: access.includes("Approve calls invoices.approve"),
      notAskedAgain: access.includes("Remind"),
      nothingNew: access.includes("Nothing new"),
    }).toStrictEqual({
      heading: true,
      askedAgain: true,
      notAskedAgain: false,
      nothingNew: false,
    });
  });

  it("says in the sheet who sees and changes which rows of the App's tables", async () => {
    const access = await accessShown({
      rowRules: [
        {
          table: "invoices",
          read: [{ kind: "owner" }, { kind: "team", field: "team" }],
          write: [{ kind: "role", role: "builder" }],
        },
        {
          table: "rates",
          read: null,
          write: [{ kind: "person", field: "editor" }],
        },
        { table: "audit", read: [{ kind: "role", role: "user" }], write: null },
      ],
    });

    expect({
      heading: access.includes("Who sees which rows"),
      invoices: access.includes(
        "invoicesRead by whoever added the row and members of the team in teamChanged by the App's builders, of the rows they can read"
      ),
      rates: access.includes("ratesChanged by the person in editor"),
      audit: access.includes(
        "auditRead by everyone who uses the AppChanged by nobody"
      ),
      // Row rules need no admin.
      nothingNew: access.includes("Nothing new: it needs no admin."),
    }).toStrictEqual({
      heading: true,
      invoices: true,
      rates: true,
      audit: true,
      nothingNew: true,
    });
  });

  it("says in the sheet what the App may do when its code can't be read, never that nothing is new", async () => {
    const access = await accessShown({
      readsPeople: null,
      handsFilesToWorkflows: null,
      rowRules: null,
    });

    expect({
      unread: access.split("Its code can't be read").length - 1,
      people: access.includes(
        "It may read the name, email and teams of everyone in the organization."
      ),
      files: access.includes(
        "Its pages and server code may hand files people can read to the workflows it binds."
      ),
      rows: access.includes(
        "Its tables may say who sees and changes which rows."
      ),
      nothingNew: access.includes("Nothing new"),
    }).toStrictEqual({
      unread: 3,
      people: true,
      files: true,
      rows: true,
      nothingNew: false,
    });
  });

  it("keeps Share with your team off while the App's changes are read", async () => {
    await opened(
      fakeApps().apps,
      identityOf(false),
      "chat-reading-draft",
      async () => await Promise.resolve(watching()),
      undefined,
      // The draft's read is on its way.
      async () => await Promise.withResolvers<never>().promise
    );
    await settled();

    expect(off(shareButton())).toBeTruthy();
  });

  it("keeps Share off while Grasp still works on the App, saying so", async () => {
    const published: string[] = [];
    let send: ((update: ChatUpdate) => void) | undefined;
    await opened(
      fakeApps().apps,
      identityOf(false),
      "chat-writing",
      async (_chat, _after, received) => {
        send = received;
        return await Promise.resolve(watching());
      },
      undefined,
      async () => await Promise.resolve(draftOf("invoice-desk")),
      async (app) => {
        published.push(app);
        return await Promise.withResolvers<never>().promise;
      },
      async () =>
        await Promise.resolve(
          changesOf({ live: 1, liveLabel: "26.11.1", next: "26.11.2" })
        )
    );
    await settled();
    await act(async () => {
      send?.({
        messages: [],
        partial: null,
        running: true,
        stopped: null,
        held: 0,
        worked: 1,
      });
      await Promise.resolve();
    });
    await settled();
    await press(shareButton());
    await tick("Finance team");

    expect({
      working: says("Grasp is still working on it…"),
      off: off(sheetButton("Share")),
      published,
    }).toStrictEqual({ working: true, off: true, published: [] });
  });

  it("says in the page's words that someone changed the App meanwhile, reads its changes again, and leaves it as it was", async () => {
    let reads = 0;
    const fake = fakeApps({ currentVersion: null });
    await opened(
      fake.apps,
      identityOf(false),
      "chat-moved",
      async () => await Promise.resolve(watching()),
      undefined,
      async () => await Promise.resolve(draftOf("invoice-desk")),
      async () => {
        await Promise.resolve();
        throw Object.assign(
          new Error(
            "Someone else changed the draft at the same time. Read it again and retry."
          ),
          { code: "draft.conflict" }
        );
      },
      async () => {
        reads += 1;
        return await Promise.resolve(changesOf());
      }
    );
    await settled();

    await press(shareButton());
    await tick("Finance team");
    await press(sheetButton("Share"));

    expect({
      said: says(
        "Someone changed it since you opened this. Look at the changes again, then share."
      ),
      reads,
      calls: fake.calls,
      status: status(),
    }).toStrictEqual({
      said: true,
      // Once as the sheet opened, and again after the refusal.
      reads: 2,
      calls: [],
      status: "Only you see this",
    });
  });

  it("says where it stands in plain words: only you until it is shared, then who uses it, whatever changes only you see", async () => {
    const seen: Record<string, unknown> = {};
    const cases = {
      notShared: fakeApps({ currentVersion: null }),
      sharedWithNobody: fakeApps(),
      sharedWithTeam: fakeApps({ sharedWith: [memberOf("team", "t-fin")] }),
      changedSinceShared: fakeApps({
        sharedWith: [memberOf("team", "t-fin"), memberOf("person", "p-bo")],
      }),
    };
    for (const [name, fake] of Object.entries(cases)) {
      // oxlint-disable-next-line no-await-in-loop -- one page at a time
      await opened(
        fake.apps,
        identityOf(false),
        `chat-${name}`,
        async () => await Promise.resolve(watching()),
        undefined,
        async () =>
          await Promise.resolve(
            draftOf(
              "invoice-desk",
              name === "changedSinceShared" ? ["src/routes/index.tsx"] : []
            )
          )
      );
      // oxlint-disable-next-line no-await-in-loop -- one page at a time
      await settled();
      seen[name] = { status: status(), line: changesLine() !== null };
      takenDown();
    }

    expect(seen).toStrictEqual({
      notShared: { status: "Only you see this", line: false },
      sharedWithNobody: { status: "Only you see this", line: false },
      sharedWithTeam: { status: "Finance team uses it", line: false },
      changedSinceShared: {
        status: "Finance team and Bo use it",
        line: true,
      },
    });
  });

  it("says under the bar how many changes only you see and of what, and shares them with the bar's Share changes", async () => {
    const fake = fakeApps({ sharedWith: [memberOf("team", "t-fin")] });
    let drafted = true;
    const published: unknown[][] = [];
    await opened(
      fake.apps,
      identityOf(false),
      "chat-changes-line",
      async () => await Promise.resolve(watching()),
      undefined,
      async () =>
        await Promise.resolve(
          drafted
            ? draftOf("invoice-desk", [
                "src/routes/index.tsx",
                "src/routes/tasks.tsx",
              ])
            : draftOf("invoice-desk", [])
        ),
      async (app, revision) => {
        published.push([app, revision]);
        await Promise.resolve();
        drafted = false;
        return fake.published(2);
      },
      async () =>
        await Promise.resolve(
          changesOf({
            live: 1,
            liveLabel: "26.11.1",
            next: "26.11.2",
            files: [
              {
                path: "src/routes/index.tsx",
                change: "modified",
                before: "",
                after: "1",
              },
              {
                path: "src/routes/tasks.tsx",
                change: "added",
                after: "2",
              },
            ],
          })
        )
    );
    await settled();
    const line = changesLine()?.textContent ?? "";
    const main = {
      lime: lime(button("Share changes")),
      with: shareButtonGone(),
    };

    await press(button("Share changes"));
    await press(sheetButton("Share"));

    expect({
      count: line.includes("2 changes only you see"),
      what: line.includes("2 pages"),
      showing: line.includes("You’re seeing your version."),
      main,
      published,
      calls: fake.calls,
      gone: changesLine(),
      toasts: toasts(),
    }).toStrictEqual({
      count: true,
      what: true,
      showing: true,
      // The bar's one lime action says what it shares now.
      main: { lime: true, with: true },
      published: [["invoice-desk", 1]],
      // Nobody new: it is shared with the team already.
      calls: [],
      gone: null,
      toasts: ["Your changes are sharedUndo"],
    });
  });

  it("says under the bar there is a change only you see when only the App's data model changed", async () => {
    await opened(
      fakeApps({ sharedWith: [memberOf("team", "t-fin")] }).apps,
      identityOf(false),
      "chat-definition-only",
      async () => await Promise.resolve(watching()),
      undefined,
      async () =>
        await Promise.resolve({
          ...draftOf("invoice-desk", []),
          definitionChanged: true,
        })
    );
    await settled();

    const line =
      document.querySelector('[aria-label="Changes only you see"]')
        ?.textContent ?? "";
    expect(line).toContain("1 change only you see");
  });

  it("undoes the changes only you see from the line under the bar, once the person confirms", async () => {
    const fake = fakeApps({ sharedWith: [memberOf("team", "t-fin")] });
    await opened(
      fake.apps,
      identityOf(false),
      "chat-undo-changes",
      async () => await Promise.resolve(watching()),
      undefined,
      async () => await Promise.resolve(draftOf("invoice-desk")),
      undefined,
      async () =>
        await Promise.resolve(
          changesOf({ live: 1, liveLabel: "26.11.1", next: "26.11.2" })
        )
    );
    await settled();

    await press(button("Undo"));
    const asked = says("Undo the changes only you see?");
    const before = [...fake.calls];
    await press(button("Undo changes"));

    expect({ asked, before, calls: fake.calls }).toStrictEqual({
      asked: true,
      before: [],
      calls: ["discard over 1"],
    });
  });

  it("sets a new App up calmly while Grasp builds it: its name, Share off, nothing of the App or its tip until it works", async () => {
    markMade("invoice-desk");
    const core = new PreviewingCore("page.build_failed");
    socketsTo(core);
    await opened(
      fakeApps({ currentVersion: null }).apps,
      identityOf(false),
      "chat-setting-up",
      async (_chat, _after, received) => {
        received({
          messages: [],
          partial: null,
          running: true,
          stopped: null,
          held: 0,
          worked: 0,
        });
        return await Promise.resolve(watching());
      },
      undefined,
      async () => await Promise.resolve(draftOf("invoice-desk")),
      undefined,
      async () => await Promise.resolve(changesOf())
    );
    await act(async () => {
      await core.reached;
    });
    await settled();
    const share = button("Share with your team");

    expect({
      setting: says("Setting up Invoices…"),
      calm: says("Grasp is building it. This takes a minute or two."),
      state: says("Setting up"),
      shareOff: off(share),
      views: document.querySelector('nav[aria-label="Workspace views"]'),
      // The preview that failed under it never shows, nor the tip.
      failure: [...document.querySelectorAll("body *")].some(
        (each) =>
          each.childElementCount === 0 &&
          each.textContent === "The preview didn't start" &&
          each.closest("[inert]") === null
      ),
      fix: reachable("Fix with Grasp") !== undefined,
      tip: says("This is your new App, with example data."),
    }).toStrictEqual({
      setting: true,
      calm: true,
      state: true,
      shareOff: true,
      views: null,
      failure: false,
      fix: false,
      tip: false,
    });
  });

  it("shows a new App once Grasp's turn is over, however it is opened, and asks again in the chat when its preview failed", async () => {
    const seen: Record<string, unknown> = {};
    for (const [state, refusal] of [
      ["runs", undefined],
      ["fails", "page.build_failed"],
    ] as const) {
      const core = new PreviewingCore(refusal);
      socketsTo(core);
      // oxlint-disable-next-line no-await-in-loop -- one page at a time
      const { sent } = await opened(
        fakeApps({ currentVersion: null }).apps,
        identityOf(false),
        `chat-${state}`,
        // Grasp's turn after the Build it that made the App, over.
        async (_chat, _after, received) => {
          received({
            messages: [
              {
                id: 1,
                role: "user",
                text: "Build it",
                built: {
                  app: { id: "invoice-desk", name: "Invoices" },
                  plan: "plan-1",
                },
                at: "2026-10-20T08:00:00.000Z",
              },
              {
                id: 2,
                role: "assistant",
                text: "Invoices is set up.",
                citations: [],
                code: [],
                tools: [],
                end: "done",
                at: "2026-10-20T08:01:00.000Z",
              },
            ],
            partial: null,
            running: false,
            stopped: null,
            held: 0,
            worked: 1,
          });
          return await Promise.resolve(watching());
        },
        undefined,
        async () => await Promise.resolve(draftOf("invoice-desk")),
        undefined,
        async () => await Promise.resolve(changesOf())
      );
      // oxlint-disable-next-line no-await-in-loop -- one page at a time
      await act(async () => {
        await core.reached;
      });
      // oxlint-disable-next-line no-await-in-loop -- one page at a time
      await settled();
      const notReady = says("Invoices isn't ready yet");
      if (notReady) {
        const again = reachable("Try again");
        if (again !== undefined) {
          // oxlint-disable-next-line no-await-in-loop -- one page at a time
          await press(again);
        }
      }
      seen[state] = {
        settingUp: says("Setting up Invoices…"),
        notReady,
        views:
          document.querySelector('nav[aria-label="Workspace views"]') !== null,
        asked: sent.map(({ question }) => question.text),
      };
      takenDown();
    }

    expect(seen).toStrictEqual({
      runs: { settingUp: false, notReady: false, views: true, asked: [] },
      fails: {
        settingUp: false,
        notReady: true,
        views: false,
        asked: ["Try again to set up Invoices."],
      },
    });
  });

  it("says what to do next over a newly made App, once, until it is dismissed", async () => {
    markMade("invoice-desk");
    const tip = "This is your new App, with example data.";
    await opened(fakeApps().apps);
    await settled();
    const first = says(tip);
    await press(button("Dismiss the tip"));
    const dismissed = says(tip);
    takenDown();
    await opened(fakeApps().apps);
    await settled();

    expect({ first, dismissed, again: says(tip) }).toStrictEqual({
      first: true,
      dismissed: false,
      again: false,
    });
  });
});
