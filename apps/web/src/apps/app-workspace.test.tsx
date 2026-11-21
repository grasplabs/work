// @vitest-environment happy-dom
import type { AppReview } from "@grasp-os/shared/app-review";
import type { App, ViewedApp } from "@grasp-os/shared/apps";
import type {
  ChatQuestion,
  ChatUpdate,
  PreviewBundle,
} from "@grasp-os/shared/chat";
import type {
  Draft,
  DraftCheck,
  DraftCheckpoint,
  LiveVersion,
} from "@grasp-os/shared/drafts";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { Identity } from "@grasp-os/shared/rpc";
import type { Subject } from "@grasp-os/shared/subject";
import type {
  ShareCandidates,
  SubjectMember,
  SubjectMemberRef,
} from "@grasp-os/shared/subject-members";
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
import { ChatBar } from "../chat/chat-bar.tsx";
import { ChatPanel } from "../chat/chat-panel.tsx";
import { chatPresence } from "../chat/chat-presence.ts";
import { slotOf } from "../chat/chat-subject.ts";
import { GlobalChatProvider } from "../chat/global-chat.tsx";
import { toast, Toaster } from "../grasp/toast/index.ts";
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
// in its place; Share's dialog shares it as its Sharing settings do;
// Publish's dialog says where it stands, what applies and whether its
// changes pass their checks, and publishes them as the person over the
// revision shown, the page reads it again afterwards, and what core
// refuses is said in the page's words; once shared and live, a line under
// the bar says what changes only its builders see; an archived App is
// restored from it.
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
const memberOf = (
  type: SubjectMemberRef["type"],
  id: string
): SubjectMember => ({
  type,
  id,
  name: memberNames[id] ?? id,
  role: "user",
  addedBy: "user-1",
  addedAt: "2026-10-20T08:00:00.000Z",
});

/** What a publish or roll back made live, as core answers it. */
const liveOf = (made: App): LiveVersion => ({
  subject: { kind: "app", id: made.id },
  version: made.currentVersion ?? 0,
  label: made.liveLabel ?? "",
});

/** Core's `apps` for one App, as someone with `role` in it reads it. */
const fakeApps = ({
  role = "builder",
  archived = false,
  currentVersion = 1,
  sharedWith = [],
  points = [],
  restoreConflicts = 0,
}: {
  role?: ViewedApp["role"];
  archived?: boolean;
  currentVersion?: number | null;
  /** Whom it is shared with now. */
  sharedWith?: SubjectMember[];
  /** The draft's checkpoints, newest first. */
  points?: DraftCheckpoint[];
  /** How many restores someone else's write refuses first (`draft.conflict`). */
  restoreConflicts?: number;
} = {}) => {
  const calls: string[] = [];
  let conflicts = restoreConflicts;
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
    sharedMeanwhile: (member: SubjectMember): void => {
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
          _subject: Subject,
          version: number
        ): Promise<{ label: string | null }> =>
          await Promise.resolve({
            label:
              version <= (app.currentVersion ?? 0) ? `26.11.${version}` : null,
          }),
        // Rolling back to a version: `version` live, over the draft at
        // `revision`, only over `expected`, the version the person saw live.
        rollback: async (
          { id }: Subject,
          version: number,
          revision?: number,
          expected?: number | null
        ): Promise<LiveVersion> => {
          calls.push(
            `rollback ${id} ${version} over ${revision} from ${expected}`
          );
          await Promise.resolve();
          app = {
            ...app,
            currentVersion: version,
            liveLabel: `26.11.${version}`,
          };
          return liveOf(app);
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
        list: async (): Promise<SubjectMember[]> =>
          await Promise.resolve(members),
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
          { type, id, role: as }: SubjectMemberRef & { role: string }
        ): Promise<void> => {
          calls.push(`share ${type}:${id} as ${as}`);
          await Promise.resolve();
          members = [...members, memberOf(type, id)];
        },
        remove: async (_app: string, { type, id }: SubjectMemberRef) => {
          calls.push(`unshare ${type}:${id}`);
          await Promise.resolve();
          members = members.filter(
            (member) => !(member.type === type && member.id === id)
          );
        },
      },
      drafts: {
        /** The draft's checkpoints, newest first. */
        checkpoints: async (): Promise<DraftCheckpoint[]> =>
          await Promise.resolve(points),
        /** Makes checkpoint `point` the draft again, over `revision`. */
        restore: async (
          _subject: Subject,
          point: number,
          revision: number
        ): Promise<void> => {
          calls.push(`restore point ${point} over ${revision}`);
          await Promise.resolve();
          if (conflicts > 0) {
            conflicts -= 1;
            throw Object.assign(
              new Error(
                "Someone else changed the draft at the same time. Read it again and retry."
              ),
              { code: "draft.conflict" }
            );
          }
        },
        /** Discards the draft's changes, over the revision the person saw. */
        discard: async (_subject: Subject, revision: number): Promise<void> => {
          calls.push(`discard over ${revision}`);
          await Promise.resolve();
        },
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
  /** What publishing the draft changes and its check, as core reads them; by default not yet. */
  changes: () => Promise<Reviewed> = async () =>
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
    packageRequests: async () => await Promise.resolve([]),
    heldCalls: async () => await Promise.resolve([]),
    models: async () => await Promise.resolve(["openai/gpt-5"]),
    send: async (chatId: string, question: ChatQuestion) => {
      sent.push({ chatId, question });
      await Promise.resolve();
    },
    efforts: async () => await Promise.resolve({}),
    summary: async () => await Promise.withResolvers<never>().promise,
  };
  const pendingActions = { list: async () => await Promise.resolve([]) };
  const { drafts: kept, versions, ...rest } = apps;
  const withReview = { ...rest, review: changes };
  const drafts = {
    ...kept,
    get: draft,
    check: async (): Promise<DraftCheck> => {
      const { revision, check } = await changes();
      return { revision, ...check };
    },
    publish: async ({ id }: Subject, revision: number) =>
      liveOf(await publish(id, revision)),
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
      <>
        <GlobalChatProvider>
          <Outlet />
          <ChatPanel />
          <ChatBar />
        </GlobalChatProvider>
        <Toaster aria-label="Notifications" />
      </>
    ),
  });
  const page = createRoute({
    getParentRoute: () => shell,
    path: "/",
    loader: async () => await apps.get(),
    // As the App's own route says: no chat but the App's own, docked.
    staticData: { chat: chatPresence.hidden },
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
  // Its words as a screen reader hears them: a button's hidden result
  // words (done, failed) left out.
  const copy = element.cloneNode(true);
  if (copy instanceof HTMLElement) {
    for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) {
      hidden.remove();
    }
  }
  const text = copy.textContent?.trim() ?? "";
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

/** An App's review, and its draft's check (`drafts.check`) at its revision. */
type Reviewed = AppReview & { check: Omit<DraftCheck, "revision"> };

/**
 * What publishing the draft of `draftOf` changes, as core reads it at
 * revision 1: its page changed, checks passing, unless `overrides` says
 * otherwise.
 */
const changesOf = (overrides: Partial<Reviewed> = {}): Reviewed => ({
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
  ...overrides,
});

/** The dialog titled `title`, once open. */
const dialogTitled = (title: string): HTMLElement | null =>
  [
    ...document.querySelectorAll<HTMLElement>('[data-slot="dialog-content"]'),
  ].find(
    (each) => each.querySelector("h2")?.textContent.startsWith(title) === true
  ) ?? null;

/** The dialog Share opens, once open. */
const sheet = (): HTMLElement | null => dialogTitled("Share");

/** Picks `name` in Share's dialog and adds them, as its list does. */
const shareWith = async (name: string): Promise<void> => {
  const box = sheet()?.querySelector<HTMLInputElement>(
    "input[aria-label='Add people, teams or projects']"
  );
  if (box === undefined || box === null) {
    throw new TypeError("No picker in Share's dialog");
  }
  await act(async () => {
    box.focus();
    box.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })
    );
    await Promise.resolve();
  });
  await settled();
  const option = [
    ...document.querySelectorAll<HTMLElement>("[role=option]"),
  ].find((each) => each.textContent.includes(name));
  if (option === undefined) {
    throw new Error(`No ${name} to pick`);
  }
  await press(option);
  const add = [...(sheet()?.querySelectorAll("button") ?? [])].find(
    (each) => nameOf(each) === "Add"
  );
  if (add === undefined) {
    throw new Error("No Add in Share's dialog");
  }
  await press(add);
  await settled();
};

/** The asking dialog's confirming action: its last, after Cancel. */
const confirmation = (): HTMLElement => {
  const found = [
    ...document.querySelectorAll<HTMLElement>('[role="alertdialog"] button'),
  ].at(-1);
  if (found === undefined) {
    throw new Error("No dialog asking");
  }
  return found;
};

/** Whether `element` is the page's main action. */
const lime = (element: HTMLElement): boolean =>
  element.dataset.variant === "ink";

/** Share, in the bar. */
const shareButton = (): HTMLButtonElement => button("Share");

/** Publish, in the bar. */
const publishButton = (): HTMLButtonElement => button("Publish");

/** The dialog Publish opens, once open. */
const panel = (): HTMLElement | null => dialogTitled("Publish");

/** The button in Publish's dialog called `name`. */
const panelButton = (name: string): HTMLButtonElement => {
  const found = [...(panel()?.querySelectorAll("button") ?? [])].find(
    (each) => nameOf(each) === name
  );
  if (found === undefined) {
    throw new Error(`No button ${name} in Publish's dialog`);
  }
  return found;
};

/** Each fact Publish's dialog shows: its value's words, without its own button. */
const factValues = (): string[] =>
  [...(panel()?.querySelectorAll('[data-slot="key-value"] dd') ?? [])].map(
    (value) => {
      const copy = value.cloneNode(true);
      if (!(copy instanceof HTMLElement)) {
        return "";
      }
      for (const each of copy.querySelectorAll("button")) {
        each.remove();
      }
      return copy.textContent.trim();
    }
  );

/** Where Publish's dialog says the App stands: its first fact. */
const stands = (): string | undefined => factValues()[0];

/** What Publish's dialog says of the App past where it stands, fact by fact. */
const facts = (): string[] => factValues().slice(1);

/** Whether the workspace is gone from the page: no Publish in it. */
const publishGone = (): boolean =>
  ![...document.querySelectorAll("button")].some(
    (each) => nameOf(each) === "Publish"
  );

/** Whether `element` is off, as a button kept focusable while off is. */
const off = (element: HTMLElement): boolean =>
  element.getAttribute("aria-disabled") === "true" ||
  element.hasAttribute("disabled");

/** What the box to ask in says while it is empty. */
const placeholder = (): string | undefined =>
  document.querySelector("textarea")?.placeholder;

/** Types `text` into the box `box`, as typing does: its own setter, then the input React hears. */
const typeInPrompt = (box: Element, text: string): void => {
  if (!(box instanceof HTMLTextAreaElement)) {
    throw new Error("The box is no text field");
  }
  Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value"
  )?.set?.call(box, text);
  box.dispatchEvent(new Event("input", { bubbles: true }));
};

/** Where pressing the open menu's item `name` takes the person. */
const goesTo = async (
  router: { state: { location: { href: string } } },
  name: string
): Promise<string | undefined> => {
  const item = [
    ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ].find((each) => each.textContent?.trim() === name);
  if (item === undefined) {
    return undefined;
  }
  await press(item);
  await settled();
  return router.state.location.href;
};

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
  [...document.querySelectorAll('[aria-label="Notifications"] li')].map(
    (each) => (each instanceof HTMLElement ? nameOf(each) : "")
  );

/** The App's status badge, in the bar. */
const status = (): string | null | undefined =>
  document.querySelector('[data-slot="badge"]')?.textContent;

/** Whether the App's chat takes a question: its box, in a chat not closed. */
const askable = (): boolean =>
  document.querySelector(
    'textarea[aria-label="Ask for a change"]:not([inert] *)'
  ) !== null;

/**
 * The window `width` pixels wide, as its media queries answer: the widths
 * the page asks about (`(width < 40rem)`, `(max-width: 767px)`,
 * `(min-width: 64rem)`), at 16px a rem; any other query, no.
 */
const windowOf = (width: number): void => {
  const widthQuery =
    /^\((?<side>max-|min-)?width\s*(?<sign><|:)\s*(?<at>[\d.]+)(?<unit>px|rem)\)$/u;
  vi.stubGlobal("matchMedia", (query: string) => {
    const found = widthQuery.exec(query)?.groups;
    const at = Number(found?.at) * (found?.unit === "rem" ? 16 : 1);
    let matches = false;
    if (found?.sign === "<") {
      matches = width < at;
    } else if (found?.side === "max-") {
      matches = width <= at;
    } else if (found?.side === "min-") {
      matches = width >= at;
    }
    return Object.assign(new EventTarget(), { matches, media: query });
  });
};

/** The idle bar's button that opens the chat, while the chat is closed. */
const chatBar = (): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find((each) =>
    (each.getAttribute("aria-label") ?? "").startsWith("Open the chat")
  );

/** Types `text` in the App's chat and sends it. */
const typeAndSend = async (text: string): Promise<void> => {
  const box = document.querySelector('textarea[aria-label="Ask for a change"]');
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
    // The page's toasts are one queue for the tab: none outlives its test.
    toast.dismiss();
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
        controls: document.querySelector('[aria-label="Reload"]') !== null,
        share: [...document.querySelectorAll("button")].some(
          (each) => nameOf(each) === "Publish"
        ),
        chat: askable(),
        app: document.querySelector('iframe[title="App"]') !== null,
      };
      takenDown();
    }

    expect(seen).toStrictEqual({
      builder: {
        name: "Invoices",
        controls: true,
        share: true,
        chat: true,
        app: false,
      },
      user: {
        name: "Invoices",
        controls: false,
        share: false,
        chat: false,
        app: true,
      },
      staff: {
        name: "Invoices",
        controls: false,
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
      loading: [...document.querySelectorAll('[role="status"]')].some(
        (each) => each.textContent === "Loading…"
      ),
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
      'textarea[aria-label="Describe the App"]'
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
    const { router } = await opened(fakeApps().apps);
    const offered = await moreMenu();
    const link = await goesTo(router, "See what your team sees");
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
        (each) => nameOf(each) === "Publish"
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

  it("on a phone shows the App first, its chat a bar that opens it when asked", async () => {
    windowOf(639);
    await opened(fakeApps().apps, identityOf(false), "chat-kept-open");
    await settled();
    const bar = chatBar();
    if (bar === undefined) {
      throw new Error("No bar to open the chat by");
    }
    await press(bar);

    expect({ bar: chatBar(), opened: askable() }).toStrictEqual({
      bar: undefined,
      opened: true,
    });
  });

  it("from App shell's narrow width up keeps the App's chat open beside it, with no bar", async () => {
    windowOf(640);
    await opened(fakeApps().apps, identityOf(false), "chat-kept-open");
    await settled();

    expect({ bar: chatBar(), opened: askable() }).toStrictEqual({
      bar: undefined,
      opened: true,
    });
  });

  it("asks about the App: each question carries it, named in the bar on the box", async () => {
    const { sent } = await opened(
      fakeApps().apps,
      identityOf(false),
      "chat-about-app"
    );
    await settled();
    // The band over the box, which says what each question is about.
    const bar = document.querySelector(
      '[data-slot="composer-surface"]'
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
    const { askedForApp, router } = await opened(
      fakeApps().apps,
      identityOf(false),
      "chat-built-in"
    );
    await settled();
    await press(button("More"));

    expect({
      askedForApp,
      kept: activeChat(deskSlot),
      openInChat: await goesTo(router, "Open the chat in Chat"),
    }).toStrictEqual({
      askedForApp: [],
      kept: "chat-built-in",
      openInChat: "/chats/chat-built-in",
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
      // The plan's card, by its heading.
      plan: [...document.querySelectorAll("section h2")].some(
        (heading) => heading.textContent === "Here's what Grasp will make"
      ),
    }).toStrictEqual({
      before: "Say what should change",
      after: "Change something about the plan",
      plan: true,
    });
  });

  it.each([
    {
      from: "handed over by the route",
      handed: "chat-deleted",
      kept: undefined,
    },
    { from: "this tab kept", handed: undefined, kept: "chat-kept-gone" },
  ])(
    "asks core for the App's own chat when the chat $from can't be followed",
    async ({ handed, kept }) => {
      if (kept !== undefined) {
        setActiveChat(kept, deskSlot);
      }
      const { askedForApp } = await opened(
        fakeApps().apps,
        identityOf(false),
        handed,
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
    }
  );

  it("keeps the chat handed over when core won't follow it for now, saying why, rather than opening another", async () => {
    const { askedForApp, router } = await opened(
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
      openInChat: await goesTo(router, "Open the chat in Chat"),
    }).toStrictEqual({
      askedForApp: [],
      says: true,
      openInChat: "/chats/chat-handed-over",
    });
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

  it("publishes the changes over the revision read from Publish, which says where the App stands, and says it is live", async () => {
    const fake = fakeApps({ currentVersion: null });
    let drafted = true;
    const published: unknown[][] = [];
    await opened(
      fake.apps,
      identityOf(false),
      "chat-publishing",
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
    const before = { status: status(), lime: lime(publishButton()) };

    await press(publishButton());
    const shown = {
      stands: stands(),
      facts: facts(),
    };
    await press(panelButton("Publish"));

    expect({
      before,
      shown,
      published,
      calls: fake.calls,
      after: { panel: panel() !== null, toasts: toasts() },
    }).toStrictEqual({
      before: { status: "Only you see this", lime: true },
      shown: {
        stands: "Not live",
        facts: ["None yet", "Only its builders", "Checks pass"],
      },
      published: [["invoice-desk", 1]],
      // Publishing shares it with nobody.
      calls: [],
      // A first version has none before it to go back to: no Undo.
      after: { panel: false, toasts: ["Invoices is live"] },
    });
  });

  it("shares the App from Share's dialog with whom the builder adds, publishing nothing, as its Sharing settings do", async () => {
    const fake = fakeApps({ currentVersion: 1 });
    const published: unknown[][] = [];
    await opened(
      fake.apps,
      identityOf(false),
      "chat-sharing",
      async () => await Promise.resolve(watching()),
      undefined,
      async () => await Promise.resolve(draftOf("invoice-desk")),
      async (app, revision) => {
        published.push([app, revision]);
        return await Promise.resolve(fake.published(2));
      },
      async () =>
        await Promise.resolve(
          changesOf({ live: 1, liveLabel: "26.11.1", next: "26.11.2" })
        )
    );
    await settled();
    const before = { status: status(), lime: lime(shareButton()) };

    await press(shareButton());
    const shown = {
      title: sheet()?.querySelector("h2")?.textContent,
      sees: says("They'll find it under Apps, and see it as it is now."),
    };
    await shareWith("Finance team");

    expect({
      before,
      shown,
      published,
      calls: fake.calls,
      status: status(),
    }).toStrictEqual({
      // Publish is the page's main action, never Share.
      before: { status: "Only you see this", lime: false },
      shown: { title: "Share Invoices", sees: true },
      published: [],
      calls: ["share team:t-fin as user"],
      status: "Finance team uses it",
    });
  });

  it("says in Share that an App not live yet is found once it is published", async () => {
    await opened(
      fakeApps({ currentVersion: null }).apps,
      identityOf(false),
      "chat-sharing-early",
      async () => await Promise.resolve(watching()),
      undefined,
      async () => await Promise.resolve(draftOf("invoice-desk")),
      undefined,
      async () => await Promise.resolve(changesOf())
    );
    await settled();

    await press(shareButton());

    expect(
      says("They'll find it under Apps once it is published.")
    ).toBeTruthy();
  });

  it("publishes the App's version as it is, with nothing live yet and changes that change nothing, as an App made from a blueprint has", async () => {
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

    await press(publishButton());
    await press(panelButton("Publish"));

    expect(fake.calls).toStrictEqual([
      "rollback invoice-desk 1 over 0 from null",
    ]);
  });

  it("undoes publishing from its toast: the team has the version it had before again, and the changes published are the draft again", async () => {
    // The draft as published, at revision 1, over version 1.
    const publishedPoint: DraftCheckpoint = {
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
    const fake = fakeApps({
      currentVersion: 1,
      points: [publishedPoint],
      sharedWith: [memberOf("person", "p-bo")],
    });
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

    // Live, with changes only its builders see.
    await press(publishButton());
    const standing = stands();
    await press(panelButton("Publish"));
    const said = toasts();
    await press(button("Undo"));
    await settled();

    expect({ stands: standing, said, calls: fake.calls }).toStrictEqual({
      stands: "Live, 26.11.1; changes not live yet",
      said: ["Invoices is liveUndo"],
      calls: [
        // Its changes emptied over version 2, at revision 0, and version 2
        // still the team's: a colleague's since would stay.
        "rollback invoice-desk 1 over 0 from 2",
        // The changes published are the draft again, as before.
        "restore point 3 over 0",
      ],
    });
  });

  it.each([
    {
      conflicts: 1,
      restores: 2,
      said: "Publishing undone",
    },
    {
      conflicts: 2,
      restores: 2,
      said: "Your team has the version they had beforeThe changes you published couldn't be put back as the draft. They're in its History, to restore from there.",
    },
  ])(
    "puts the published changes back after Undo, tried again once over someone's write, or says they're in History ($conflicts refused)",
    async ({ conflicts, restores, said }) => {
      const publishedPoint: DraftCheckpoint = {
        number: 3,
        revision: 1,
        base: 1,
        contentHash: "published",
        personId: "user-1",
        chatId: null,
        callId: null,
        restoredFrom: null,
        createdAt: "2026-10-20T08:00:00.000Z",
        touched: ["src/routes/index.tsx"],
        changes: 1,
      };
      const fake = fakeApps({
        currentVersion: 1,
        points: [publishedPoint],
        sharedWith: [memberOf("person", "p-bo")],
        restoreConflicts: conflicts,
      });
      let drafted = true;
      await opened(
        fake.apps,
        identityOf(false),
        "chat-undo-retries",
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
      await press(publishButton());
      await press(panelButton("Publish"));
      await press(button("Undo"));
      await settled();

      expect({
        // The team has the version before either way.
        rolledBack: fake.calls.includes(
          "rollback invoice-desk 1 over 0 from 2"
        ),
        restores: fake.calls.filter((call) => call.startsWith("restore"))
          .length,
        said: toasts().includes(said),
      }).toStrictEqual({ rolledBack: true, restores, said: true });
    }
  );

  it("asks before Undo drops changes taken since publishing, even once the workspace was left", async () => {
    const fake = fakeApps({ currentVersion: 1 });
    let stage: "drafted" | "published" | "changed again" = "drafted";
    const { router } = await opened(
      fake.apps,
      identityOf(false),
      "chat-undo-asks",
      async () => await Promise.resolve(watching()),
      undefined,
      async () =>
        await Promise.resolve(
          stage === "published"
            ? draftOf("invoice-desk", [])
            : draftOf("invoice-desk")
        ),
      async () => {
        await Promise.resolve();
        stage = "published";
        return fake.published(2);
      },
      async () =>
        await Promise.resolve(
          changesOf({ live: 1, liveLabel: "26.11.1", next: "26.11.2" })
        )
    );
    await settled();
    await press(publishButton());
    await press(panelButton("Publish"));
    // Someone changes it again before Undo, and the person left.
    stage = "changed again";
    await act(async () => {
      router.history.push("/elsewhere");
      await Promise.resolve();
    });
    const left = publishGone();

    await press(button("Undo"));
    await settled();
    const asked = says("Give your team the version they had before?");
    const before = [...fake.calls];
    await press(button("Drop them and go back"));

    expect({ left, asked, before, calls: fake.calls }).toStrictEqual({
      left: true,
      asked: true,
      before: [],
      calls: ["rollback invoice-desk 1 over 1 from 2"],
    });
  });

  it("keeps Publish off while the changes fail their check, and sends what fails to the App's chat with Fix with Grasp", async () => {
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

    await press(publishButton());
    const publishOff = off(panelButton("Publish"));
    const problem = says("Use the Button's own variant.");
    await press(panelButton("Fix with Grasp"));

    expect({
      publishOff,
      problem,
      published,
      sent: sent.map(({ chatId, question }) => ({
        chatId,
        names: question.text.includes(
          "- src/routes/index.tsx:4: Use the Button's own variant."
        ),
      })),
    }).toStrictEqual({
      publishOff: true,
      problem: true,
      published: [],
      sent: [{ chatId: "chat-fixing", names: true }],
    });
  });

  /**
   * What Publish's popover says of the draft's access, once its changes
   * are shown, as core reads the draft's changes as `changes` says.
   */
  const accessShown = async (changes: Partial<Reviewed>): Promise<string> => {
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
    await press(publishButton());
    await press(panelButton("What changes"));
    const access = [...(panel()?.querySelectorAll("section") ?? [])].find(
      (section) => section.querySelector("h3")?.textContent === "Access"
    );
    return access?.textContent ?? "";
  };

  it("says in Publish who sees and changes which rows of the App's tables", async () => {
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

  it("says in Publish what the App may do when its code can't be read, never that nothing is new", async () => {
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

  it("keeps Publish off while the App's changes are read", async () => {
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

    expect(off(publishButton())).toBeTruthy();
  });

  it("keeps Publish off while Grasp still works on the App, saying so", async () => {
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
    await press(publishButton());

    expect({
      working: says("Grasp is still working on it…"),
      off: off(panelButton("Publish")),
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

    await press(publishButton());
    await press(panelButton("Publish"));

    expect({
      said: says(
        "Someone changed it since you opened this. Look at the changes again, then share."
      ),
      reads,
      calls: fake.calls,
      status: status(),
    }).toStrictEqual({
      said: true,
      // Its review and its check, as the workspace opened and again after
      // the refusal.
      reads: 4,
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

  it("says under the bar how many changes only you see and of what, and publishes them with the bar's Publish", async () => {
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
    const main = lime(publishButton());

    await press(publishButton());
    await press(panelButton("Publish"));

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
      main: true,
      published: [["invoice-desk", 1]],
      // Nobody new: publishing shares it with nobody.
      calls: [],
      gone: null,
      toasts: ["Invoices is liveUndo"],
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
    await press(confirmation());

    expect({ asked, before, calls: fake.calls }).toStrictEqual({
      asked: true,
      before: [],
      calls: ["discard over 1"],
    });
  });

  it("sets a new App up calmly while Grasp builds it: its name, Grasp building it in the preview's place, Share off, nothing of the App or its tip until it works", async () => {
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
      building:
        document.querySelector('[aria-label="Grasp is building"]') !== null,
      calm: says("It shows here as soon as there is something to see."),
      state: says("Setting up"),
      shareOff: off(share),
      controls: document.querySelector('[aria-label="Reload"]'),
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
      building: true,
      calm: true,
      state: true,
      shareOff: true,
      controls: null,
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
        controls: document.querySelector('[aria-label="Reload"]') !== null,
        asked: sent.map(({ question }) => question.text),
      };
      takenDown();
    }

    expect(seen).toStrictEqual({
      runs: { settingUp: false, notReady: false, controls: true, asked: [] },
      fails: {
        settingUp: false,
        notReady: true,
        controls: false,
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

  it("says what to do next over a newly made App as soon as it shows, while Grasp still works on it, so Grasp finishing moves nothing under the person", async () => {
    markMade("invoice-desk");
    const tip = "This is your new App, with example data.";
    const core = new PreviewingCore();
    socketsTo(core);
    let send: ((update: ChatUpdate) => void) | undefined;
    const turn = { messages: [], partial: null, stopped: null, held: 0 };
    await opened(
      fakeApps().apps,
      identityOf(false),
      "chat-finishing",
      // The preview shows while Grasp's turn still runs: the person can
      // use it then.
      async (_chat, _after, received) => {
        send = received;
        received({ ...turn, running: true, worked: 1 });
        return await Promise.resolve(watching());
      }
    );
    await act(async () => {
      await core.reached;
    });
    await settled();
    const frame = document.querySelector("iframe");
    // What is drawn over the preview, in the order it stands: something
    // put there later pushes the page down under the person's pointer.
    const over = (): string[] =>
      [...document.querySelectorAll("body *")]
        .filter(
          (each) =>
            frame !== null &&
            each.childElementCount === 0 &&
            each.closest('[aria-label="Chat"]') === null &&
            // oxlint-disable-next-line no-bitwise -- a DOM position mask
            (each.compareDocumentPosition(frame) &
              Node.DOCUMENT_POSITION_FOLLOWING) !==
              0
        )
        .map((each) => each.textContent)
        .filter((text) => text !== "");
    const whileWorking = { tip: says(tip), over: over() };
    await act(async () => {
      send?.({ ...turn, running: false, worked: 2 });
      await Promise.resolve();
    });
    await settled();

    expect({
      whileWorking: whileWorking.tip,
      sameFrame: document.querySelector("iframe") === frame,
      overWhenDone: over(),
    }).toStrictEqual({
      whileWorking: true,
      sameFrame: true,
      overWhenDone: whileWorking.over,
    });
  });

  it("says what changes only you see over the preview before the preview shows, however late who uses the App is read, so the line never comes in over a preview in use", async () => {
    const core = new PreviewingCore(undefined, deskOfVersion1);
    socketsTo(core);
    const fake = fakeApps({ sharedWith: [memberOf("team", "t-fin")] });
    // Who uses it is read apart from the draft, and answers last.
    const membersRead = Promise.withResolvers<boolean>();
    const { list } = fake.apps.members;
    fake.apps.members.list = async () => {
      await membersRead.promise;
      return await list();
    };
    await opened(
      fake.apps,
      identityOf(false),
      "chat-members-late",
      async () => await Promise.resolve(watching())
    );
    await settled();
    const whileRead = {
      preview: document.querySelector("iframe") !== null,
      line: changesLine() !== null,
    };
    await act(async () => {
      membersRead.resolve(true);
      await Promise.resolve();
    });
    await act(async () => {
      await core.reached;
    });
    await settled();
    const frame = document.querySelector("iframe");
    const line = changesLine();

    expect({
      whileRead,
      // Both at once, the line over the preview from the start.
      shown: {
        preview: frame !== null,
        lineOver:
          frame !== null &&
          line !== null &&
          // oxlint-disable-next-line no-bitwise -- a DOM position mask
          (line.compareDocumentPosition(frame) &
            Node.DOCUMENT_POSITION_FOLLOWING) !==
            0,
      },
    }).toStrictEqual({
      whileRead: { preview: false, line: false },
      shown: { preview: true, lineOver: true },
    });
  });

  it("shows the preview without the line under the bar when who uses the App can't be read", async () => {
    const core = new PreviewingCore(undefined, deskOfVersion1);
    socketsTo(core);
    const fake = fakeApps({ sharedWith: [memberOf("team", "t-fin")] });
    // Who uses it is lost on the way, as a dropped connection loses it.
    fake.apps.members.list = async () => {
      await Promise.resolve();
      throw new Error("Peer closed WebSocket: 1006");
    };
    await opened(
      fake.apps,
      identityOf(false),
      "chat-members-lost",
      async () => await Promise.resolve(watching())
    );
    await act(async () => {
      await core.reached;
    });
    await settled();
    expect({
      preview: document.querySelector("iframe") !== null,
      line: changesLine() !== null,
    }).toStrictEqual({ preview: true, line: false });
  });
});
