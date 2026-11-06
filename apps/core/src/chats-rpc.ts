import { isAppLayout } from "@grasp-os/compiler";
import { agentErrors } from "@grasp-os/shared/agent";
import { appErrors } from "@grasp-os/shared/apps";
import type { AppFiles } from "@grasp-os/shared/apps";
import { actorOf } from "@grasp-os/shared/audit";
import {
  chatTitleSchema,
  previewAtSchema,
  previewShownSchema,
  readOnlyRevision,
} from "@grasp-os/shared/chat";
import type {
  ChatConnectionRequest,
  ChatCitedDocument,
  ChatDraft,
  ChatDraftVersion,
  ChatFile,
  ChatFileInput,
  ChatQuestion,
  ChatSearchHit,
  ChatsApi,
  ChatSummary,
  ChatUpdate,
  PreviewAt,
  PreviewBundle,
  PreviewRefresh,
  PreviewShown,
  PreviewUpdate,
} from "@grasp-os/shared/chat";
import { authErrors, isExpectedError } from "@grasp-os/shared/errors";
import { chatIdSchema } from "@grasp-os/shared/ids";
import type { AppId, ChatId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import type { ModelEfforts } from "@grasp-os/shared/models";
import { functionRequestMaxBytes } from "@grasp-os/shared/operation-limits";
import { draftSealFailures } from "@grasp-os/shared/operations";
import {
  pageErrors,
  pageHrefSchema,
  pageProblemSchema,
} from "@grasp-os/shared/pages";
import type { QuerySnapshotPush, PageProblem } from "@grasp-os/shared/pages";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { requireBuilder, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";

import { draftOf, proposeChatDraft } from "./agent-builds.ts";
import { chatAuthority, chatContext } from "./agent-scope.ts";
import type { FunctionAnswer } from "./app-functions.ts";
import {
  appFor,
  createApp,
  draftFiles,
  editableApp,
  hasPages,
} from "./apps.ts";
import { organizationId } from "./auth/auth.ts";
import { teamsOf } from "./auth/identity.ts";
import { chatRequests, decideInChat } from "./chat-connections.ts";
import { readChatFile } from "./chat-files.ts";
import { personOf } from "./connections.ts";
import { withReferencesText } from "./draft-references.ts";
import { appHost, workspace } from "./durable-objects.ts";
import { modelSettings, modelEffortsOf } from "./models.ts";
import { callbackFor, isStub } from "./page-callbacks.ts";
import type { StillOpen } from "./page-callbacks.ts";
import type { LeasedBuild } from "./page-delivery.ts";
import {
  appModules,
  frameAccess,
  previewFrame,
  stageFrame,
  stageModules,
  updatingFrameAccess,
} from "./page-frame.ts";
import {
  admitPreviewCall,
  admitWindow,
  windowCharger,
  withinAnswer,
} from "./pages-rpc.ts";
import { versionPages } from "./pages.ts";
import type { BuiltPage } from "./pages.ts";
import { personalWorkspaceId } from "./personal-workspace.ts";
import { relayPreviewStream } from "./preview-stream-relay.ts";
import { QuerySubscriptions } from "./query-subscriptions.ts";
import type { LiveReads } from "./query-subscriptions.ts";
import { isRestricted } from "./restricted.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { draftVersionReferences } from "./sealed-previews.ts";
import type { PreviewAnswer } from "./sealed-previews.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";
import { Subscription } from "./subscription.ts";
import { questionSchema } from "./workspace.ts";

// A signed-in person's chats (workspace.ts), over `/rpc`. Each person's
// chats are in a Workspace object of their own, reached only with the
// signed-in person as the session check hands them over here, and that
// object checks every call against the chat's stored person too: nobody
// else lists, renames, deletes, asks in, stops or follows a chat, and a
// chat of someone else's is refused as if there were none. Making,
// renaming and deleting one is audited, and so is deciding a connection
// its agent asked for (chat-connections.ts).

/**
 * The agent every chat's agent is: the organization workspace's, so
 * admins grant to it once, whoever's chat it answers in. Named as agents
 * must be (`workspaceAgentIdSchema` in agent-scope.ts).
 */
// Where it is: the leaf module, which what this module imports can import.
export { personalWorkspaceId } from "./personal-workspace.ts";

export const chatAgentId = organizationId;

/**
 * Most chats one connection follows at once: a page shows one, and a page
 * that watches over and over holds no more than this in the object.
 */
const maxWatches = 10;

/** A chat's ID from the page: a string, or no chat at all. */
const chatIdOf = (chatId: unknown): ChatId => {
  const parsed = chatIdSchema.safeParse(chatId);
  if (!parsed.success) {
    throw agentErrors.create("agent.chat_not_found");
  }
  return parsed.data;
};

/** How a push to a chat page is refused. */
const refusals = {
  invalid: () => agentErrors.create("agent.invalid_request"),
  closed: () => agentErrors.create("agent.chat_not_found"),
};

/** The signed-in person's chats with the organization's agent. */
/** A preview call's answer, as the chat's Workspace object sent it as text. */
const previewAnswerOf = (text: string): PreviewAnswer =>
  // SAFETY: core's own object made the text of a `PreviewAnswer`.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  JSON.parse(text) as PreviewAnswer;

/**
 * What a preview's live queries are keyed by: its chat and the build the
 * frame shows (`PreviewAt`), the draft's revision or a version of the App.
 */
const previewKey = (chatId: ChatId, at: PreviewAt): LeasedBuild =>
  typeof at === "number"
    ? { artifact: `preview:${chatId}`, version: at }
    : { artifact: `preview-version:${chatId}`, version: at.appVersion };

/** The chat and build `previewKey` made `key` of. */
const previewOfKey = (
  key: LeasedBuild | undefined
): { chatId: ChatId; at: PreviewAt } => {
  const [kind, chat] = (key?.artifact ?? "").split(":");
  const parsed = chatIdSchema.safeParse(chat);
  const named = previewAtSchema.safeParse(
    kind === "preview-version" ? { appVersion: key?.version } : key?.version
  );
  if (
    (kind !== "preview" && kind !== "preview-version") ||
    !parsed.success ||
    !named.success
  ) {
    throw appErrors.create("app.preview_outdated");
  }
  return { chatId: parsed.data, at: named.data };
};

/** Whether `by` builds App `app` now. */
const buildsNow = async (
  env: Env,
  by: Identity,
  app: AppId
): Promise<boolean> => {
  try {
    await editableApp(env, by, app);
    return true;
  } catch (error) {
    if (isExpectedError(error)) {
      return false;
    }
    throw error;
  }
};

/** A builder's roles in an App, with the teams they are in now, as a key. */
const builderRolesKey = async (env: Env, userId: string): Promise<string> => {
  const teams = await teamsOf(env.DB, userId);
  return canonicalJson({
    appMember: true,
    appBuilder: true,
    teams: teams.map(({ id }) => id).toSorted(),
  });
};

/**
 * A page's live reads of its previews (query-subscriptions.ts): as the
 * person behind the connection's session, pushed only while they build
 * the App, read in the preview of the chat's draft at the revision the
 * subscription named, on the preview's store; charged to the person's
 * live reads of the App as a page's are.
 */
const previewReads = (env: Env, check: SessionCheck): LiveReads<Identity> => ({
  check,
  // The person still building the App, and the build the subscription
  // names still served (`SealedPreviews.served`): a read under way as the
  // preview moved on to other server code pushes nothing, and its
  // subscription ends as out of date, never as the App gone, so the frame
  // follows it again at the build it shows next (the page's
  // page-host.ts).
  access: async (by, app, key) => {
    if (!(await buildsNow(env, by, app))) {
      return "role";
    }
    const { chatId, at } = previewOfKey(key);
    const served = await workspace(
      env,
      personalWorkspaceId(by.userId)
    ).previewServes(chatId, app, at);
    return served ? "open" : "outdated";
  },
  // The teams they are in now with them, which a table's row rules read
  // (store-rules.ts): a preview read under one set is never pushed under
  // another, as for an App's own pages (query-subscriptions.ts).
  roles: async (by, app) =>
    (await buildsNow(env, by, app))
      ? await builderRolesKey(env, by.userId)
      : undefined,
  admit: async (by, app, cost) =>
    await appHost(env, app).admitLiveRead(by.userId, cost),
  revocable: true,
  forget: () => {
    check.forget?.();
  },
  evaluate: async (by, app, key, request, deadline, chargePages) => {
    const { chatId, at } = previewOfKey(key);
    const answered = previewAnswerOf(
      await workspace(env, personalWorkspaceId(by.userId)).previewFunction(
        chatId,
        by.userId,
        app,
        at,
        request,
        {
          kind: "query",
          deadline,
          // A window's pages past what its read paid, charged as a
          // version's live list charges them.
          chargeWindow: async (pages) => {
            await chargePages(pages);
          },
        }
      )
    );
    return { result: answered.answer.result, reads: answered.reads };
  },
});

const encoder = new TextEncoder();

/**
 * What the open frame of a preview imports of `built`, a build of its
 * draft at `revision` (@grasp-os/sdk's preview-runtime.ts): its route
 * tree's module, by address, and the App's and the kit's modules it
 * loads, and the App's version it is of, when it shows one
 * (`PreviewRefresh.appVersion`), and whether it runs in place of server
 * code that doesn't build (`PreviewRefresh.serverUnbuilt`).
 */
const refreshOf = (
  revision: number,
  { code, serverUnbuilt }: Pick<PreviewPage, "code" | "serverUnbuilt">,
  appVersion: number | undefined
): PreviewRefresh => ({
  ...(serverUnbuilt ? { serverUnbuilt: true } : {}),
  revision,
  entry: code.addresses[code.entry] ?? "",
  modules: Object.fromEntries(
    Object.entries(code.modules).map(([name, text]) => [
      code.addresses[name] ?? "",
      encoder.encode(text).byteLength,
    ])
  ),
  css: code.css,
  kit: Object.keys(code.kit),
  ...(appVersion === undefined ? {} : { appVersion }),
});

/**
 * What a preview builds (`ChatsRpc.#previewed`): its files, the
 * references their pages import, the draft's revision it is at
 * (`readOnlyRevision` for a version of the draft), and the App's version
 * it `shows`, when it shows one rather than the draft's changes: what its
 * frame's calls then name (`PreviewAt`).
 */
interface Previewed {
  files: Map<string, string>;
  references: () => Promise<PreviewReferences>;
  revision: number;
  shows?: number;
}

/**
 * The references a preview's pages import, and whether they are of
 * other server code than the draft's, which doesn't build
 * (`Workspace.previewReferences`).
 */
interface PreviewReferences {
  references: string | null;
  serverUnbuilt: boolean;
}

/** A preview's pages, built (`ChatsRpc.#previewBuild`). */
type PreviewPage = BuiltPage & { serverUnbuilt: boolean };

/**
 * Whether `error` says code didn't build: its pages
 * (`page.build_failed`), or its server code (`draftSealFailures`).
 */
const buildFailed = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string" &&
  (error.code === "page.build_failed" || draftSealFailures.has(error.code));

export class ChatsRpc extends CoreRpcTarget implements ChatsApi {
  readonly #env: Env;
  readonly #check: SessionCheck;
  /** This connection's watches, each until it's released. */
  readonly #watches = new Set<Disposable>();
  /**
   * Whether this connection may still follow chats, before each push: its
   * session holds, as the connection's own check last read it, the same
   * reading its calls share (at most `sessionRecheckMs` old,
   * session-check.ts).
   */
  readonly #stillOpen: StillOpen;
  /** This connection's live queries of its previews (sealed-previews.ts). */
  readonly #previewQueries: QuerySubscriptions;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
    this.#previewQueries = new QuerySubscriptions(
      env,
      previewReads(env, check)
    );
    this.#stillOpen = async () => {
      try {
        await check();
        return true;
      } catch {
        return false;
      }
    };
  }

  /** The object that holds `userId`'s chats. */
  #chatsOf(userId: string) {
    return workspace(this.#env, personalWorkspaceId(userId));
  }

  async models(): Promise<string[]> {
    return await withPerson(this.#check, async () => {
      const { models: allowed } = await modelSettings(this.#env);
      return allowed;
    });
  }

  async efforts(): Promise<Record<string, ModelEfforts>> {
    return await withPerson(this.#check, async () => {
      const { models: allowed } = await modelSettings(this.#env);
      return Object.fromEntries(
        allowed.map((model) => [model, modelEffortsOf(model)])
      );
    });
  }

  async list(): Promise<ChatSummary[]> {
    return await withPerson(
      this.#check,
      async ({ userId }) => await this.#chatsOf(userId).chats(userId)
    );
  }

  async search(query: string): Promise<ChatSearchHit[]> {
    return await withPerson(this.#check, async ({ userId }) => {
      if (typeof query !== "string") {
        throw agentErrors.create("agent.invalid_request");
      }
      // Only the signed-in person's own object, and only their chats in it:
      // nobody searches another person's, an admin no more than anyone.
      return await this.#chatsOf(userId).searchChats(userId, query);
    });
  }

  async summary(chatId: string): Promise<ChatSummary> {
    return await withPerson(
      this.#check,
      async ({ userId }) =>
        await this.#chatsOf(userId).chatSummary(chatIdOf(chatId), userId)
    );
  }

  async create(title: string): Promise<ChatSummary> {
    return await withPerson(this.#check, async (person) => {
      const { userId } = person;
      const parsed = chatTitleSchema.safeParse(title);
      if (!parsed.success) {
        throw agentErrors.create("agent.invalid_title");
      }
      const chat = await this.#chatsOf(userId).createChat(
        parsed.data,
        userId,
        chatAgentId,
        actorOf(person)
      );
      return {
        id: chat.id,
        title: chat.title,
        createdAt: chat.createdAt.toISOString(),
        lastAt: chat.lastAt.toISOString(),
        running: false,
        appId: chat.appId,
        via: chat.via,
      };
    });
  }

  async forApp(app: string): Promise<ChatSummary> {
    return await withPerson(this.#check, async (person) => {
      // A builder's, of an App that isn't archived: the chat changes it.
      const { id, name } = await editableApp(this.#env, person, app);
      const kept = await this.#chatsOf(person.userId).appChat(
        person.userId,
        id
      );
      return kept ?? (await this.#appChat(person, id, name));
    });
  }

  async newApp(input: {
    name: string;
    description: string;
  }): Promise<ChatSummary & { appId: string }> {
    return await withPerson(this.#check, async (person) => {
      requireBuilder(person);
      // No room for its chat: refused before an App is made, so asking
      // again doesn't leave one behind each time. A chat that fails after
      // all leaves its App, which stays as every App does (`forApp` gives
      // it a chat).
      await this.#chatsOf(person.userId).requireRoomForChat(person.userId);
      const made = await createApp(this.#env, person, input);
      const chat = await this.#appChat(person, made.id, made.name);
      return { ...chat, appId: made.id };
    });
  }

  /** A new chat of `person`'s for App `id`, named after it (`forApp`). */
  async #appChat(
    person: Identity,
    id: AppId,
    name: string
  ): Promise<ChatSummary> {
    // An App's name always fits a chat's title.
    const title = chatTitleSchema.parse(name);
    const chat = await this.#chatsOf(person.userId).createChat(
      title,
      person.userId,
      chatAgentId,
      actorOf(person),
      "web",
      undefined,
      id
    );
    return {
      id: chat.id,
      title: chat.title,
      createdAt: chat.createdAt.toISOString(),
      lastAt: chat.lastAt.toISOString(),
      running: false,
      appId: chat.appId,
      via: chat.via,
    };
  }

  async rename(chatId: string, title: string): Promise<void> {
    await withPerson(this.#check, async (person) => {
      const id = chatIdOf(chatId);
      const parsed = chatTitleSchema.safeParse(title);
      if (!parsed.success) {
        throw agentErrors.create("agent.invalid_title");
      }
      await this.#chatsOf(person.userId).renameChat(
        id,
        person.userId,
        parsed.data,
        actorOf(person)
      );
    });
  }

  /**
   * Deletes the chat once its agent isn't working on it, rejecting first
   * every write it holds, so none is left that nobody can decide: a
   * failure there leaves the chat as it was, to delete again. The object
   * does it all (`deleteChat`), taking no question meanwhile.
   */
  async remove(chatId: string): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await this.#chatsOf(person.userId).deleteChat(
        chatIdOf(chatId),
        person.userId,
        await personOf(this.#env, person),
        actorOf(person)
      );
    });
  }

  /**
   * Reads the file's text (chat-files.ts), outside the person's Workspace
   * object, then attaches it to their chat there, audited.
   */
  async attachFile(chatId: string, file: ChatFileInput): Promise<ChatFile> {
    return await withPerson(this.#check, async (person) => {
      const id = chatIdOf(chatId);
      const read = await readChatFile(this.#env, file);
      return await this.#chatsOf(person.userId).attachFile(
        id,
        person.userId,
        read,
        actorOf(person)
      );
    });
  }

  async removeFile(chatId: string, fileId: string): Promise<void> {
    await withPerson(this.#check, async (person) => {
      if (typeof fileId !== "string") {
        throw agentErrors.create("agent.file_not_found");
      }
      await this.#chatsOf(person.userId).removeFile(
        chatIdOf(chatId),
        person.userId,
        fileId,
        actorOf(person)
      );
    });
  }

  async send(chatId: string, question: ChatQuestion): Promise<void> {
    await withPerson(this.#check, async ({ userId }) => {
      const id = chatIdOf(chatId);
      // Its strings and effort only: whatever else the page passed goes no
      // further.
      const parsed = questionSchema.safeParse(question);
      if (!parsed.success) {
        throw agentErrors.create("agent.invalid_question");
      }
      await this.#chatsOf(userId).send(id, userId, parsed.data);
    });
  }

  async drafts(chatId: string): Promise<ChatDraft[]> {
    return await withPerson(
      this.#check,
      async ({ userId }) =>
        await this.#chatsOf(userId).drafts(chatIdOf(chatId), userId)
    );
  }

  async cited(chatId: string, messageId: number): Promise<ChatCitedDocument[]> {
    return await withPerson(
      this.#check,
      async ({ userId }) =>
        await this.#chatsOf(userId).cited(chatIdOf(chatId), userId, messageId)
    );
  }

  /**
   * Every version of the chat's draft of `app`, newest first: only while
   * the person builds the App, as for its preview.
   */
  async draftVersions(
    chatId: string,
    app: string
  ): Promise<ChatDraftVersion[]> {
    return await withPerson(this.#check, async (by) => {
      const { id } = await appFor(this.#env, by, app, "builder");
      return await this.#chatsOf(by.userId).draftVersions(
        chatIdOf(chatId),
        by.userId,
        id
      );
    });
  }

  /**
   * Every file of the chat's draft of `app`, read as its agent reads them
   * (`draftOf`, agent-builds.ts), so the code view shows what the preview
   * builds: only from the person's own chat, while they build the App.
   */
  async draftFiles(chatId: string, app: string): Promise<AppFiles> {
    return await withPerson(this.#check, async (by) => {
      const { id } = await appFor(this.#env, by, app, "builder");
      const scope = {
        workspaceId: personalWorkspaceId(by.userId),
        chatId: await this.#ownChat(by.userId, chatId),
      };
      const draft = await draftOf(this.#env, scope, id);
      return Object.fromEntries(await draftFiles(this.#env, id, draft));
    });
  }

  /**
   * Makes version `version` of the chat's draft of `app` the draft again,
   * as a new version: only while the person builds the App.
   */
  async restoreDraftVersion(
    chatId: string,
    app: string,
    version: number
  ): Promise<ChatDraftVersion> {
    return await withPerson(this.#check, async (by) => {
      const { id } = await appFor(this.#env, by, app, "builder");
      return await this.#chatsOf(by.userId).restoreDraftVersion(
        chatIdOf(chatId),
        by.userId,
        id,
        version,
        actorOf(by)
      );
    });
  }

  /**
   * Discards the chat's draft of `app`: its changes go, its versions stay
   * to restore one. Only while the person builds the App, as for
   * restoring one.
   */
  async discardDraft(chatId: string, app: string): Promise<void> {
    await withPerson(this.#check, async (by) => {
      const { id } = await appFor(this.#env, by, app, "builder");
      await this.#chatsOf(by.userId).discardDraft(
        chatIdOf(chatId),
        by.userId,
        id,
        actorOf(by)
      );
    });
  }

  /**
   * Proposes the chat's draft of `app` as the App's next version, by the
   * person themselves (`proposeChatDraft`, as the chat's agent proposes
   * it): only while they build the App and it isn't archived, and never
   * from a chat that read restricted data, which its agent couldn't
   * propose from either: what it wrote there may carry that data.
   */
  async proposeDraft(
    chatId: string,
    app: string,
    message: string
  ): Promise<number> {
    return await withPerson(this.#check, async (by) => {
      const { id } = await editableApp(this.#env, by, app);
      const scope = {
        workspaceId: personalWorkspaceId(by.userId),
        chatId: await this.#ownChat(by.userId, chatId),
      };
      const authority = chatAuthority({
        agentId: chatAgentId,
        personId: by.userId,
      });
      const unrestricted = async (): Promise<void> => {
        if (await isRestricted(this.#env, authority, chatContext(scope))) {
          throw permissionErrors.create("permission.restricted");
        }
      };
      // Refused early, and again right before the commit: a chat stays
      // restricted once it is, so a draft its agent wrote after reading
      // restricted data, while this checked it, is never committed.
      await unrestricted();
      const { version } = await proposeChatDraft(
        this.#env,
        by,
        scope,
        id,
        message,
        { admit: unrestricted }
      );
      if (version === null) {
        throw appErrors.create("app.draft_failed");
      }
      return version;
    });
  }

  /**
   * The pages of the chat's draft of `app`, to preview (preview.ts): only
   * while the person builds the App, as the agent must to write it. With
   * `version`, of that version of the draft, read-only: built the same
   * way, but at `readOnlyRevision`, so its calls are all refused
   * (`app.preview_outdated`).
   */
  async preview(
    chatId: string,
    app: string,
    version?: number
  ): Promise<PreviewBundle> {
    return await withPerson(this.#check, async (by) => {
      // As its recheck (`buildsNow`): an archived App has no preview.
      const { id, name } = await editableApp(this.#env, by, app);
      const load = async (): Promise<PreviewBundle> =>
        await this.#loadPreview(by, chatId, id, name, version);
      // A version opened read-only is one person's click, never asked
      // for again by a write: it builds as it is asked.
      if (version !== undefined) {
        return await load();
      }
      // The draft as it is now: one open per revision, shared by every
      // preview that opens it at once.
      const opened = await this.#chatsOf(by.userId).previewBuild(
        chatIdOf(chatId),
        by.userId,
        id,
        "open",
        undefined,
        load
      );
      // What `load` answered, shared under a key only it builds (`open`):
      // a bundle, which only a frame's open has.
      if (!("frameToken" in opened)) {
        throw new Error("A preview's open was answered with an update.");
      }
      return opened;
    });
  }

  /**
   * The pages of the chat's draft of `app` at `revision`, the newest
   * the asker knows of, their modules staged for its open preview to
   * import and swap in (`PreviewRefresh`): only while the person builds
   * the App, as for `preview`. One build per revision, shared
   * by every preview that asks for it (preview-builds.ts);
   * `app.preview_outdated` once the draft moved past `revision`, as the
   * asker then hears of a newer one. No frame is staged, nothing is
   * sealed when the draft's
   * server code is as it was (sealed-previews.ts), and its build skips the
   * type check and lint, so a write reaches the page at once; the
   * agent's check of the draft has them. `shown` is what the frame shows:
   * it is handed only a build it can swap in, and otherwise told whether
   * what it shows is still what to show (`PreviewUpdate`).
   */
  async previewUpdate(
    chatId: string,
    app: string,
    revision: number,
    shown: PreviewShown
  ): Promise<PreviewUpdate> {
    return await withPerson(this.#check, async (by) => {
      const { id } = await editableApp(this.#env, by, app);
      if (!Number.isSafeInteger(revision)) {
        throw pageErrors.create("page.invalid");
      }
      const frame = pageErrors.parse("page.invalid", previewShownSchema, shown);
      const update = async (): Promise<PreviewUpdate> =>
        await this.#updateFor(by, chatId, id, frame);
      const updated = await this.#chatsOf(by.userId).previewBuild(
        chatIdOf(chatId),
        by.userId,
        id,
        // The answer depends on all the frame shows.
        `update:${canonicalJson(frame)}`,
        revision,
        update
      );
      // What `update` answered, shared under a key only it builds
      // (`update:` and what the frame shows): an update, never a frame's
      // bundle.
      if ("frameToken" in updated) {
        throw new Error("A preview's update was answered with a bundle.");
      }
      return updated;
    });
  }

  /**
   * What an open frame of `chatId`'s preview of App `id` takes now
   * (`PreviewUpdate`), the frame showing `shown`. The build to show is the
   * draft's changes, or the App's latest version while the draft changes
   * nothing:
   *
   * - The App's latest version: `unchanged` for a frame showing it; a
   *   build to swap in for a frame on the draft's changes; `restart` for
   *   one showing another version.
   * - The draft's changes: their build, swapped in. One that doesn't build
   *   fails as the build does, so the frame keeps what it shows and says
   *   it is being fixed, unless the frame shows the App's version in place
   *   of the draft and a newer one came since: it opens afresh on that
   *   one, as `#loadPreview` would.
   */
  async #updateFor(
    by: Identity,
    chatId: string,
    id: AppId,
    shown: PreviewShown
  ): Promise<PreviewUpdate> {
    const now = await this.#previewed(by, chatId, id, {});
    if (now.shows !== undefined) {
      if (shown.appVersion === now.shows) {
        return { app: id, unchanged: true };
      }
      if (shown.appVersion !== undefined) {
        return { app: id, restart: true };
      }
      return { app: id, refresh: await this.#staged(chatId, id, now) };
    }
    // Whether a newer version of the App came than the one a frame shows
    // in place of the draft: what `#loadPreview` would open it on now.
    const newerShown = async (): Promise<boolean> => {
      try {
        const { shows } = await this.#previewed(by, chatId, id, {
          fallback: true,
        });
        return shows !== undefined && shows !== shown.appVersion;
      } catch {
        return false;
      }
    };
    // No page left in the draft: a frame on its changes opens afresh, on
    // the App's latest version in its place, as `#loadPreview` opens it;
    // one on the App's version already moves on only to a newer one.
    if (!hasPages(now.files)) {
      return shown.appVersion === undefined || (await newerShown())
        ? { app: id, restart: true }
        : { app: id, unchanged: true };
    }
    try {
      return { app: id, refresh: await this.#staged(chatId, id, now) };
    } catch (error) {
      if (
        shown.appVersion === undefined ||
        !buildFailed(error) ||
        !(await newerShown())
      ) {
        throw error;
      }
      return { app: id, restart: true };
    }
  }

  /**
   * The pages of `previewed`, built and their modules staged under the
   * preview's own scope, where its open frame loads them
   * (page-frame.ts): the kit's are those it loaded already.
   */
  async #staged(
    chatId: string,
    id: AppId,
    previewed: Previewed
  ): Promise<PreviewRefresh> {
    const built = await this.#previewBuild(
      previewed.files,
      previewed.references,
      id
    );
    const { scope } = await previewFrame(chatId, id, built.artifact, {
      updates: true,
    });
    await stageModules(this.#env, appModules(built.code, scope));
    return refreshOf(previewed.revision, built, previewed.shows);
  }

  /**
   * What `chatId`'s preview of App `id` builds: the files of its draft
   * now, of its draft's `version`, or (`fallback`) of the App's latest
   * version in place of the draft, and the references their pages
   * import, read over the same build. A version of the draft is read-only
   * (`readOnlyRevision`). The draft now that changes nothing, and the
   * fallback, `shows` the App's latest version, read anew: what their
   * frame's calls name.
   */
  async #previewed(
    by: Identity,
    chatId: string,
    id: AppId,
    { version, fallback = false }: { version?: number; fallback?: boolean }
  ): Promise<Previewed> {
    const chats = this.#chatsOf(by.userId);
    const chat = chatIdOf(chatId);
    if (version !== undefined) {
      const draft = await chats.draftVersion(chat, by.userId, id, version);
      return {
        files: await draftFiles(this.#env, id, draft),
        references: async () => ({
          references: await draftVersionReferences(this.#env, id, draft),
          serverUnbuilt: false,
        }),
        // A version opened read-only names no revision a draft is at, so
        // nothing it calls runs, even when it is the draft as it is now.
        revision: readOnlyRevision,
      };
    }
    const draft = await chats.previewDraft(chat, by.userId, id, { fallback });
    const shows =
      draft.base !== null && Object.keys(draft.changes).length === 0
        ? draft.base
        : undefined;
    // Its references, of the very build its files are of.
    const at: PreviewAt =
      shows === undefined ? draft.revision : { appVersion: shows };
    return {
      files: await draftFiles(this.#env, id, draft),
      references: async () =>
        await chats.previewReferences(chat, by.userId, id, at),
      revision: draft.revision,
      ...(shows === undefined ? {} : { shows }),
    };
  }

  /**
   * The bundle of `chatId`'s preview of App `id`, built from its draft
   * now, or from its draft's `version` (`#previewed`). The draft now with
   * changes that leave it no page that builds opens on the App's latest
   * version instead, as a draft that changes nothing would show it, its
   * calls on that version's own server code, said to be a `fallback`: its
   * frame takes the draft's next write that builds, as any frame does. So
   * nothing is shown in place of the App while a version of it builds.
   */
  async #loadPreview(
    by: Identity,
    chatId: string,
    id: AppId,
    name: string,
    version: number | undefined
  ): Promise<PreviewBundle> {
    const now = await this.#previewed(by, chatId, id, { version });
    let shown = now;
    let built: PreviewPage;
    try {
      built = await this.#previewBuild(now.files, now.references, id);
    } catch (error) {
      // Only the draft as it is now, with changes of its own, falls back.
      const fallsBack =
        now.revision !== readOnlyRevision &&
        now.shows === undefined &&
        (buildFailed(error) || !hasPages(now.files));
      if (!fallsBack) {
        throw error;
      }
      try {
        shown = await this.#previewed(by, chatId, id, { fallback: true });
        built = await this.#previewBuild(shown.files, shown.references, id);
      } catch {
        // No version of the App that builds: the draft's own failure.
        throw error;
      }
    }
    // Only the draft as it is now takes updates, and only its frame's
    // policy allows them (page-frame.ts): a version opened read-only
    // stays as it was, staged apart from the draft's writes.
    const updates = now.revision !== readOnlyRevision;
    // A preview reads no real data; its frame still runs exactly this
    // build and nothing else, until the page hands it an update.
    const { scope, artifact } = await previewFrame(chatId, id, built.artifact, {
      updates,
    });
    await stageFrame(this.#env, artifact, built.code, {
      preview: true,
      scope,
    });
    return {
      app: id,
      name,
      revision: now.revision,
      artifact,
      frameToken: updates
        ? await updatingFrameAccess(this.#env, artifact)
        : await frameAccess(this.#env, artifact),
      // Its updates follow the draft's revisions, from the one it opened at.
      ...(updates
        ? { refresh: refreshOf(now.revision, built, shown.shows) }
        : {}),
      ...(shown === now ? {} : { fallback: true }),
    };
  }

  /**
   * The pages of a preview's `files`, built for its frame: with the
   * references its draft release generates when it is of spec 8's layout,
   * the very release its calls run on, and without the type check and
   * lint, which the agent's check of the draft has (pages.ts).
   * `page.not_found` for files with no pages.
   */
  async #previewBuild(
    files: Map<string, string>,
    references: () => Promise<PreviewReferences>,
    id: AppId
  ): Promise<PreviewPage> {
    const source = Object.fromEntries(files);
    // Its server code read whatever its pages import: whether it builds
    // is said even of pages that call none of it.
    const reading = isAppLayout(source) ? references() : undefined;
    let read:
      | { references: PreviewReferences }
      | { failed: unknown }
      | undefined;
    if (reading !== undefined) {
      try {
        read = { references: await reading };
      } catch (error) {
        read = { failed: error };
      }
    }
    let needed = false;
    const withReferences = await withReferencesText(source, async () => {
      needed = true;
      const got = await reading;
      return got?.references ?? undefined;
    });
    // Its pages import references that couldn't be had: why (its server
    // code doesn't build, say) is what to tell, never that the App has no
    // server code, which a build without them would say.
    if (needed && read !== undefined && "failed" in read) {
      throw read.failed;
    }
    const serverUnbuilt =
      read !== undefined &&
      ("failed" in read
        ? buildFailed(read.failed)
        : read.references.serverUnbuilt);
    const built = await versionPages(
      this.#env,
      withReferences,
      null,
      id,
      "preview",
      { checks: false }
    );
    return { ...built, serverUnbuilt };
  }

  /**
   * Calls a function of the draft of spec 8's layout in its preview, as a
   * page's `callFunction` does (sealed-previews.ts): `request` is the
   * call's text, as the page's client sends it. Answers as a page's
   * call is answered (app-functions.ts), a refusal of the call included;
   * throws only for a preview the person may not use or that is out of
   * date.
   */
  async previewFunction(
    chatId: string,
    app: string,
    at: PreviewAt,
    request: string
  ): Promise<FunctionAnswer> {
    return await withPerson(this.#check, async (by) => {
      const { id } = await editableApp(this.#env, by, app);
      await admitPreviewCall(this.#env, by, id);
      if (
        typeof request !== "string" ||
        request.length > functionRequestMaxBytes
      ) {
        throw pageErrors.create("page.invalid");
      }
      // A paginated list's window counts its pages, as a page's does.
      await admitWindow(this.#env, by, id, request);
      const answered = previewAnswerOf(
        await this.#chatsOf(by.userId).previewFunction(
          chatIdOf(chatId),
          by.userId,
          id,
          at,
          request,
          { chargeWindow: windowCharger(this.#env, by, id) }
        )
      );
      return withinAnswer(answered.answer);
    });
  }

  /**
   * Follows a public query of the draft of spec 8's layout in its
   * preview, as a page's `watchQuery` does (query-subscriptions.ts),
   * read on the preview's store as the person, while they build the App
   * and the build `at` names still serves.
   */
  async previewWatchQuery(
    chatId: string,
    app: string,
    at: PreviewAt,
    request: string,
    onSnapshot: (snapshot: QuerySnapshotPush) => void
  ): Promise<Subscription> {
    return await withPerson(this.#check, async (by) => {
      const { id } = await editableApp(this.#env, by, app);
      await admitPreviewCall(this.#env, by, id);
      if (
        typeof request !== "string" ||
        request.length > functionRequestMaxBytes ||
        !previewAtSchema.safeParse(at).success ||
        !isStub(onSnapshot)
      ) {
        throw pageErrors.create("page.invalid");
      }
      // A window counts as the pages it reads (query-windows.ts).
      await admitWindow(this.#env, by, id, request);
      const chat = chatIdOf(chatId);
      // The chat is theirs, with a preview of the App that the build `at`
      // names still reaches.
      const chats = this.#chatsOf(by.userId);
      await chats.previewDraft(chat, by.userId, id);
      if (!(await chats.previewServes(chat, id, at))) {
        throw appErrors.create("app.preview_outdated");
      }
      return this.#previewQueries.subscribe(
        by,
        id,
        previewKey(chat, at),
        request,
        onSnapshot
      );
    });
  }

  /**
   * Starts (`stream`) or follows again (`attach`) a streaming action of the
   * draft of spec 8's layout in its preview, as a page's `streamFunction`
   * does (sealed-previews.ts), relayed to `onFrame` only while the person
   * still builds the App and the build `at` names still serves
   * (preview-stream-relay.ts). Each start and attach counts as one of the
   * person's preview requests.
   */
  async previewStream(
    chatId: string,
    app: string,
    at: PreviewAt,
    what: "stream" | "attach",
    request: string,
    onFrame: (frame: unknown) => Promise<unknown>
  ): Promise<Subscription> {
    return await withPerson(this.#check, async (by) => {
      const { id } = await appFor(this.#env, by, app, "builder");
      await admitPreviewCall(this.#env, by, id);
      if (
        (what !== "stream" && what !== "attach") ||
        typeof request !== "string" ||
        request.length > functionRequestMaxBytes ||
        !previewAtSchema.safeParse(at).success ||
        !isStub(onFrame)
      ) {
        throw pageErrors.create("page.invalid");
      }
      if (this.#watches.size >= maxWatches) {
        throw agentErrors.create("agent.too_many_watches");
      }
      const chat = chatIdOf(chatId);
      const chats = this.#chatsOf(by.userId);
      // Its slot taken before anything is awaited, as `watch` takes one:
      // starts made at once can't each find room.
      const relayed: { stop?: () => void } = {};
      const toPage = callbackFor(onFrame, this.#stillOpen, refusals, () => {
        this.#watches.delete(toPage);
        relayed.stop?.();
      });
      this.#watches.add(toPage);
      let frames: ReadableStream<Uint8Array>;
      try {
        frames = await chats.previewStream(
          chat,
          by.userId,
          id,
          at,
          request,
          what === "attach"
        );
      } catch (error) {
        toPage[Symbol.dispose]();
        throw error;
      }
      relayed.stop = relayPreviewStream(frames, {
        deliver: toPage,
        // The session still theirs, the App still theirs to build, and the
        // build the stream runs on still served.
        stillOpen: async () => {
          const now = await this.#check();
          if (now.userId !== by.userId) {
            throw authErrors.create("auth.unauthenticated");
          }
          if (!(await chats.previewServes(chat, id, at))) {
            throw appErrors.create("app.preview_outdated");
          }
          if (!(await buildsNow(this.#env, now, id))) {
            throw roleErrors.create("role.forbidden");
          }
        },
        cancel: async () =>
          await chats.previewCancelStream(chat, by.userId, id, at, request),
        requestId: crypto.randomUUID(),
      }).stop;
      return new Subscription(async () => {
        await Promise.resolve();
        toPage[Symbol.dispose]();
      });
    });
  }

  /**
   * Asks the preview's invocation of the streaming action `request` names
   * to stop, as a page's `cancelStream` does: `{ requested }`.
   */
  async previewCancelStream(
    chatId: string,
    app: string,
    at: PreviewAt,
    request: string
  ): Promise<{ requested: boolean }> {
    return await withPerson(this.#check, async (by) => {
      const { id } = await appFor(this.#env, by, app, "builder");
      await admitPreviewCall(this.#env, by, id);
      if (
        typeof request !== "string" ||
        request.length > functionRequestMaxBytes
      ) {
        throw pageErrors.create("page.invalid");
      }
      return {
        requested: await this.#chatsOf(by.userId).previewCancelStream(
          chatIdOf(chatId),
          by.userId,
          id,
          at,
          request
        ),
      };
    });
  }

  /**
   * Keeps what the preview's page reported, for the agent's next check
   * of the draft: text its code wrote, held to size (`pageProblemSchema`).
   */
  async previewReport(
    chatId: string,
    app: string,
    at: PreviewAt,
    path: string,
    problem: PageProblem
  ): Promise<void> {
    await withPerson(this.#check, async (by) => {
      const { id } = await appFor(this.#env, by, app, "builder");
      const shownOn = pageErrors.parse("page.invalid", pageHrefSchema, path);
      const reported = pageErrors.parse(
        "page.invalid",
        pageProblemSchema,
        problem
      );
      await this.#chatsOf(by.userId).previewReport(
        chatIdOf(chatId),
        by.userId,
        id,
        at,
        shownOn,
        reported
      );
    });
  }

  /** The person's own chat `chatId`, or refused as if there were none. */
  async #ownChat(userId: string, chatId: unknown): Promise<ChatId> {
    return await this.#chatsOf(userId).requireChat(chatIdOf(chatId), userId);
  }

  async connectionRequests(chatId: string): Promise<ChatConnectionRequest[]> {
    return await withPerson(
      this.#check,
      async (person) =>
        await chatRequests(
          this.#env,
          person,
          await this.#ownChat(person.userId, chatId)
        )
    );
  }

  async grantConnection(chatId: string, id: string): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await decideInChat(
        this.#env,
        person,
        await this.#ownChat(person.userId, chatId),
        id,
        "granted"
      );
    });
  }

  async denyConnection(chatId: string, id: string): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await decideInChat(
        this.#env,
        person,
        await this.#ownChat(person.userId, chatId),
        id,
        "denied"
      );
    });
  }

  async cancel(chatId: string): Promise<boolean> {
    return await withPerson(
      this.#check,
      async ({ userId }) =>
        await this.#chatsOf(userId).cancel(chatIdOf(chatId), userId)
    );
  }

  async watch(
    chatId: string,
    after: number | null,
    onUpdate: (update: ChatUpdate) => void
  ): Promise<Subscription> {
    return await withPerson(this.#check, async ({ userId }) => {
      const id = chatIdOf(chatId);
      if (!isStub(onUpdate)) {
        throw agentErrors.create("agent.invalid_request");
      }
      if (this.#watches.size >= maxWatches) {
        throw agentErrors.create("agent.too_many_watches");
      }
      const listener = callbackFor(onUpdate, this.#stillOpen, refusals, () => {
        this.#watches.delete(listener);
      });
      this.#watches.add(listener);
      const chats = this.#chatsOf(userId);
      let watchId: string;
      try {
        watchId = await chats.watch(id, userId, after, listener);
      } catch (error) {
        listener[Symbol.dispose]();
        throw error;
      }
      return new Subscription(async () => {
        // The slot is free at once, and the listener forwards nothing
        // more; the object drops it now, or at its next update if it
        // can't be reached.
        listener[Symbol.dispose]();
        try {
          await chats.unwatch(id, watchId);
        } catch (error) {
          log.warn("chat.unwatch_failed", {
            chatId: id,
            ...errorFields(error),
          });
        }
      });
    });
  }
}
