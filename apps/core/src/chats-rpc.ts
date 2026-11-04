import { agentErrors } from "@grasp-os/shared/agent";
import { appErrors } from "@grasp-os/shared/apps";
import { actorOf } from "@grasp-os/shared/audit";
import { chatTitleSchema, readOnlyRevision } from "@grasp-os/shared/chat";
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
  FixRunResult,
  PreviewBundle,
  PreviewRefresh,
  PreviewUpdate,
} from "@grasp-os/shared/chat";
import {
  authErrors,
  internalErrors,
  isExpectedError,
} from "@grasp-os/shared/errors";
import { chatIdSchema } from "@grasp-os/shared/ids";
import type { AppId, ChatId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import type { ModelEfforts } from "@grasp-os/shared/models";
import { functionRequestMaxBytes } from "@grasp-os/shared/operation-limits";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { requireBuilder, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import {
  screenErrors,
  screenNameSchema,
  screenProblemSchema,
} from "@grasp-os/shared/screens";
import type {
  QuerySnapshotPush,
  ScreenProblem,
} from "@grasp-os/shared/screens";

import { proposeChatDraft } from "./agent-builds.ts";
import { chatAuthority, chatContext } from "./agent-scope.ts";
import type { FunctionAnswer } from "./app-functions.ts";
import {
  appFor,
  createApp,
  draftFiles,
  editableApp,
  findVersion,
  readTree,
  screensIn,
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
import { personalWorkspaceId } from "./personal-workspace.ts";
import { relayPreviewStream } from "./preview-stream-relay.ts";
import { QuerySubscriptions } from "./query-subscriptions.ts";
import type { LiveReads } from "./query-subscriptions.ts";
import { isRestricted } from "./restricted.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { fixQuestion, runToFix } from "./run-fixes.ts";
import { RunSubscription } from "./run-subscription.ts";
import type { LeasedBuild } from "./screen-delivery.ts";
import {
  appModules,
  frameAccess,
  previewFrame,
  stageFrame,
  stageModules,
  updatingFrameAccess,
} from "./screen-frame.ts";
import {
  admitPreviewCall,
  admitWindow,
  windowCharger,
  withinAnswer,
} from "./screens-rpc.ts";
import { screenCode } from "./screens.ts";
import type { BuiltScreen } from "./screens.ts";
import {
  draftVersionReferences,
  readOnlyReferences,
} from "./sealed-previews.ts";
import type { PreviewAnswer } from "./sealed-previews.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";
import { questionSchema } from "./workspace.ts";

// A signed-in person's chats (workspace.ts), over `/rpc`. Each person's
// chats are in a Workspace object of their own, reached only with the
// signed-in person as the session check hands them over here, and that
// object checks every call against the chat's stored person too: nobody
// else lists, renames, deletes, asks in, stops or follows a chat, and a
// chat of someone else's is refused as if there were none. Making,
// renaming and deleting one is audited, and so is starting one to fix a
// failed run (`fixRun`), and deciding a connection its agent asked for
// (chat-connections.ts).

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

/**
 * Why a question wasn't taken, as its person reads it: an unplanned error
 * is logged, and shown as one.
 */
const refusedBecause = (chatId: ChatId, error: unknown): string => {
  if (isExpectedError(error)) {
    return error.message;
  }
  log.error("chat.fix_not_asked", { chatId, ...errorFields(error) });
  return internalErrors.create("internal.unexpected").message;
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

/** What a preview's live queries are keyed by: its chat and revision. */
const previewKey = (chatId: ChatId, revision: number): LeasedBuild => ({
  artifact: `preview:${chatId}`,
  version: revision,
});

/** The chat and revision `previewKey` made `key` of. */
const previewOfKey = (
  key: LeasedBuild | undefined
): { chatId: ChatId; revision: number } => {
  const [kind, chat] = (key?.artifact ?? "").split(":");
  const parsed = chatIdSchema.safeParse(chat);
  const at = key?.version;
  if (
    kind !== "preview" ||
    !parsed.success ||
    at === undefined ||
    !Number.isInteger(at)
  ) {
    throw appErrors.create("app.preview_outdated");
  }
  return { chatId: parsed.data, revision: at };
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
 * live reads of the App as a screen's are.
 */
const previewReads = (env: Env, check: SessionCheck): LiveReads<Identity> => ({
  check,
  // The draft still served at the subscription's revision (its own, or
  // one since which only its screens changed), and the person still
  // building the App: a read under way as the draft's server code moved
  // on pushes nothing, and its subscription ends.
  access: async (by, app, key) => {
    const { chatId, revision } = previewOfKey(key);
    const served = await workspace(
      env,
      personalWorkspaceId(by.userId)
    ).previewServes(chatId, app, revision);
    return served && (await buildsNow(env, by, app)) ? "open" : "role";
  },
  // The teams they are in now with them, which a table's row rules read
  // (store-rules.ts): a preview read under one set is never pushed under
  // another, as for an App's own screens (query-subscriptions.ts).
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
    const { chatId, revision } = previewOfKey(key);
    const answered = previewAnswerOf(
      await workspace(env, personalWorkspaceId(by.userId)).previewFunction(
        chatId,
        by.userId,
        app,
        revision,
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
 * draft at `revision` (@grasp-os/sdk's preview-runtime.ts): its screen's
 * module, by address, and the App's and the kit's modules it loads.
 */
const refreshOf = (
  revision: number,
  { screen, code }: Pick<BuiltScreen, "screen" | "code">
): PreviewRefresh => ({
  revision,
  screen,
  entry: code.addresses[code.entry] ?? "",
  modules: Object.fromEntries(
    Object.entries(code.modules).map(([name, text]) => [
      code.addresses[name] ?? "",
      encoder.encode(text).byteLength,
    ])
  ),
  css: code.css,
  kit: Object.keys(code.kit),
});

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
      undefined,
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

  /**
   * Starts a chat to fix a failed run (run-fixes.ts), and asks its agent
   * with `model`. A model the deployment doesn't allow is refused before any chat is
   * made. A question refused past that (the client's model rules, say)
   * leaves the chat, with its report, in the person's list, to ask again:
   * it resolves with the chat and why, so the page opens that chat rather
   * than make another.
   */
  async fixRun(run: string, model: string): Promise<FixRunResult> {
    return await withPerson(this.#check, async (person) => {
      const { userId } = person;
      const fix = await runToFix(this.#env, person, run);
      const chats = this.#chatsOf(userId);
      const chat = await chats.createFixChat(
        `Fix ${fix.report.workflow}`,
        userId,
        chatAgentId,
        actorOf(person),
        fix,
        model
      );
      const summary = {
        id: chat.id,
        title: chat.title,
        createdAt: chat.createdAt.toISOString(),
        lastAt: chat.lastAt.toISOString(),
        appId: chat.appId,
        via: chat.via,
      };
      try {
        await chats.send(chat.id, userId, {
          text: fixQuestion(fix.report),
          model,
        });
      } catch (error) {
        return {
          chat: { ...summary, running: false },
          sent: false,
          reason: refusedBecause(chat.id, error),
        };
      }
      return { chat: { ...summary, running: true }, sent: true };
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
   * A screen of the chat's draft of `app`, to preview (preview.ts): only
   * while the person builds the App, as the agent must to write it. With
   * `version`, of that version of the draft, read-only: built the same
   * way, but at `readOnlyRevision`, so its calls are all refused
   * (`app.preview_outdated`). With `appVersion` instead, of that version
   * of the App (the one proposed, before it is published), read-only the
   * same way: from the person's own chat, as its draft's would be.
   */
  async preview(
    chatId: string,
    app: string,
    screen?: string,
    version?: number,
    appVersion?: number
  ): Promise<PreviewBundle> {
    return await withPerson(this.#check, async (by) => {
      if (version !== undefined && appVersion !== undefined) {
        throw screenErrors.create("screen.invalid");
      }
      // As its recheck (`buildsNow`): an archived App has no preview.
      const { id, name } = await editableApp(this.#env, by, app);
      const load = async (): Promise<PreviewBundle> =>
        await this.#loadPreview(by, chatId, id, name, {
          screen,
          version,
          appVersion,
        });
      // A version opened read-only is one person's click, never asked
      // for again by a write: it builds as it is asked.
      if (version !== undefined || appVersion !== undefined) {
        return await load();
      }
      // The draft as it is now: one open per revision and screen, shared
      // by every preview that opens it at once.
      const opened = await this.#chatsOf(by.userId).previewBuild(
        chatIdOf(chatId),
        by.userId,
        id,
        `open:${screen ?? ""}`,
        undefined,
        load
      );
      // What `load` answered, shared under a key only it builds (`open:`
      // and its screen): a bundle, which only a frame's open has.
      if (!("frameToken" in opened)) {
        throw new Error("A preview's open was answered with an update.");
      }
      return opened;
    });
  }

  /**
   * Screen `screen` of the chat's draft of `app` at `revision`, the
   * newest the asker knows of, its modules staged for its open preview to
   * import and swap in (`PreviewRefresh`): only while the person builds
   * the App, as for `preview`. One build per revision and screen, shared
   * by every preview that asks for it (preview-builds.ts);
   * `app.preview_outdated` once the draft moved past `revision`, as the
   * asker then hears of a newer one. No frame is staged, nothing is
   * sealed when the draft's
   * server code is as it was (sealed-previews.ts), and its build skips the
   * type check and lint, so a write reaches the screen at once; the
   * agent's check of the draft has them.
   */
  async previewUpdate(
    chatId: string,
    app: string,
    screen: string,
    revision: number
  ): Promise<PreviewUpdate> {
    return await withPerson(this.#check, async (by) => {
      const { id } = await editableApp(this.#env, by, app);
      if (!Number.isSafeInteger(revision)) {
        throw screenErrors.create("screen.invalid");
      }
      const update = async (): Promise<PreviewUpdate> => {
        const {
          files,
          references,
          revision: built,
        } = await this.#previewed(by, chatId, id, {});
        const screenBuild = await this.#previewBuild(
          files,
          references,
          id,
          screen
        );
        // Under the preview's own scope, where its open frame loads them
        // (screen-frame.ts): the kit's are those it loaded already.
        const { scope } = await previewFrame(chatId, id, screenBuild.artifact);
        await stageModules(this.#env, appModules(screenBuild.code, scope));
        return { app: id, refresh: refreshOf(built, screenBuild) };
      };
      const updated = await this.#chatsOf(by.userId).previewBuild(
        chatIdOf(chatId),
        by.userId,
        id,
        `update:${screen}`,
        revision,
        update
      );
      // What `update` answered, shared under a key only it builds
      // (`update:` and its screen): an update, never a frame's bundle.
      if ("frameToken" in updated) {
        throw new Error("A preview's update was answered with a bundle.");
      }
      return updated;
    });
  }

  /**
   * What `chatId`'s preview of App `id` builds: the files of its draft
   * now, of its draft's `version`, or of the App's `appVersion`, the
   * references their screens import, and the revision its calls name.
   * Every one but the draft now is read-only (`readOnlyRevision`).
   */
  async #previewed(
    by: Identity,
    chatId: string,
    id: AppId,
    { version, appVersion }: { version?: number; appVersion?: number }
  ): Promise<{
    files: Map<string, string>;
    references: () => Promise<string | null>;
    revision: number;
  }> {
    const chats = this.#chatsOf(by.userId);
    if (appVersion !== undefined) {
      // From the person's own chat, as each kind of preview is
      // (`agent.chat_not_found` for anyone else's, or none), of a version
      // they may read.
      await chats.chatSummary(chatIdOf(chatId), by.userId);
      const row = await findVersion(this.#env, id, appVersion);
      const files = await readTree(this.#env, id, row.tree);
      return {
        files,
        references: async () =>
          await readOnlyReferences(this.#env, id, row.version, files),
        revision: readOnlyRevision,
      };
    }
    const draft =
      version === undefined
        ? await chats.previewDraft(chatIdOf(chatId), by.userId, id)
        : await chats.draftVersion(chatIdOf(chatId), by.userId, id, version);
    return {
      files: await draftFiles(this.#env, id, draft),
      references: async () =>
        version === undefined
          ? await chats.previewReferences(
              chatIdOf(chatId),
              by.userId,
              id,
              draft.revision
            )
          : await draftVersionReferences(this.#env, id, draft),
      // A version opened read-only names no revision a draft is at, so
      // nothing it calls runs, even when it is the draft as it is now.
      revision: version === undefined ? draft.revision : readOnlyRevision,
    };
  }

  /**
   * The bundle of `chatId`'s preview of App `id`, built from its draft
   * now, from its draft's `version`, or from the App's `appVersion`
   * (`#previewed`).
   */
  async #loadPreview(
    by: Identity,
    chatId: string,
    id: AppId,
    name: string,
    {
      screen,
      version,
      appVersion,
    }: { screen?: string; version?: number; appVersion?: number }
  ): Promise<PreviewBundle> {
    const { files, references, revision } = await this.#previewed(
      by,
      chatId,
      id,
      { version, appVersion }
    );
    const screens = screensIn(files);
    if (screens.length === 0) {
      throw screenErrors.create("screen.not_found");
    }
    const built = await this.#previewBuild(
      files,
      references,
      id,
      screen ?? screens[0]
    );
    // A preview reads no real data; its frame still runs exactly this
    // build and nothing else, until the page hands it an update.
    const { scope, artifact } = await previewFrame(chatId, id, built.artifact);
    await stageFrame(this.#env, artifact, built.code, {
      preview: true,
      scope,
    });
    // Only the draft as it is now takes updates, and only its frame's
    // policy allows them (screen-frame.ts): a version opened read-only
    // stays as it was.
    const updates = revision !== readOnlyRevision;
    return {
      app: id,
      name,
      revision,
      screens,
      screen: built.screen,
      artifact,
      frameToken: updates
        ? await updatingFrameAccess(this.#env, artifact)
        : await frameAccess(this.#env, artifact),
      ...(updates ? { refresh: refreshOf(revision, built) } : {}),
    };
  }

  /**
   * Screen `screen` of a preview's `files`, built for its frame: with the
   * references its draft release generates when it is of spec 8's layout,
   * the very release its calls run on, and without the type check and
   * lint, which the agent's check of the draft has (screens.ts).
   */
  async #previewBuild(
    files: Map<string, string>,
    references: () => Promise<string | null>,
    id: AppId,
    screen: string | undefined
  ): Promise<BuiltScreen> {
    const withReferences = await withReferencesText(
      Object.fromEntries(files),
      async () => (await references()) ?? undefined
    );
    return await screenCode(
      this.#env,
      withReferences,
      screen,
      null,
      id,
      "preview",
      { checks: false }
    );
  }

  /**
   * Calls a function of the draft of spec 8's layout in its preview, as a
   * screen's `callFunction` does (sealed-previews.ts): `request` is the
   * call's text, as the screen's client sends it. Answers as a screen's
   * call is answered (app-functions.ts), a refusal of the call included;
   * throws only for a preview the person may not use or that is out of
   * date.
   */
  async previewFunction(
    chatId: string,
    app: string,
    revision: number,
    request: string
  ): Promise<FunctionAnswer> {
    return await withPerson(this.#check, async (by) => {
      const { id } = await editableApp(this.#env, by, app);
      await admitPreviewCall(this.#env, by, id);
      if (
        typeof request !== "string" ||
        request.length > functionRequestMaxBytes
      ) {
        throw screenErrors.create("screen.invalid");
      }
      // A paginated list's window counts its pages, as a screen's does.
      await admitWindow(this.#env, by, id, request);
      const answered = previewAnswerOf(
        await this.#chatsOf(by.userId).previewFunction(
          chatIdOf(chatId),
          by.userId,
          id,
          revision,
          request,
          { chargeWindow: windowCharger(this.#env, by, id) }
        )
      );
      return withinAnswer(answered.answer);
    });
  }

  /**
   * Follows a public query of the draft of spec 8's layout in its
   * preview, as a screen's `watchQuery` does (query-subscriptions.ts),
   * read on the preview's store as the person, while they build the App
   * and the draft is at `revision`.
   */
  async previewWatchQuery(
    chatId: string,
    app: string,
    revision: number,
    request: string,
    onSnapshot: (snapshot: QuerySnapshotPush) => void
  ): Promise<RunSubscription> {
    return await withPerson(this.#check, async (by) => {
      const { id } = await editableApp(this.#env, by, app);
      await admitPreviewCall(this.#env, by, id);
      if (
        typeof request !== "string" ||
        request.length > functionRequestMaxBytes ||
        typeof revision !== "number" ||
        !isStub(onSnapshot)
      ) {
        throw screenErrors.create("screen.invalid");
      }
      // A window counts as the pages it reads (query-windows.ts).
      await admitWindow(this.#env, by, id, request);
      const chat = chatIdOf(chatId);
      // The chat is theirs, with a draft of the App that a screen at
      // `revision` still reaches.
      const chats = this.#chatsOf(by.userId);
      await chats.previewDraft(chat, by.userId, id);
      if (!(await chats.previewServes(chat, id, revision))) {
        throw appErrors.create("app.preview_outdated");
      }
      return this.#previewQueries.subscribe(
        by,
        id,
        previewKey(chat, revision),
        request,
        onSnapshot
      );
    });
  }

  /**
   * Starts (`stream`) or follows again (`attach`) a streaming action of the
   * draft of spec 8's layout in its preview, as a screen's `streamFunction`
   * does (sealed-previews.ts), relayed to `onFrame` only while the person
   * still builds the App and the draft is still at `revision`
   * (preview-stream-relay.ts). Each start and attach counts as one of the
   * person's preview requests.
   */
  async previewStream(
    chatId: string,
    app: string,
    revision: number,
    what: "stream" | "attach",
    request: string,
    onFrame: (frame: unknown) => Promise<unknown>
  ): Promise<RunSubscription> {
    return await withPerson(this.#check, async (by) => {
      const { id } = await appFor(this.#env, by, app, "builder");
      await admitPreviewCall(this.#env, by, id);
      if (
        (what !== "stream" && what !== "attach") ||
        typeof request !== "string" ||
        request.length > functionRequestMaxBytes ||
        typeof revision !== "number" ||
        !isStub(onFrame)
      ) {
        throw screenErrors.create("screen.invalid");
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
          revision,
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
        // draft still served at the stream's revision.
        stillOpen: async () => {
          const now = await this.#check();
          if (now.userId !== by.userId) {
            throw authErrors.create("auth.unauthenticated");
          }
          if (!(await chats.previewServes(chat, id, revision))) {
            throw appErrors.create("app.preview_outdated");
          }
          if (!(await buildsNow(this.#env, now, id))) {
            throw roleErrors.create("role.forbidden");
          }
        },
        cancel: async () =>
          await chats.previewCancelStream(
            chat,
            by.userId,
            id,
            revision,
            request
          ),
        requestId: crypto.randomUUID(),
      }).stop;
      return new RunSubscription(async () => {
        await Promise.resolve();
        toPage[Symbol.dispose]();
      });
    });
  }

  /**
   * Asks the preview's invocation of the streaming action `request` names
   * to stop, as a screen's `cancelStream` does: `{ requested }`.
   */
  async previewCancelStream(
    chatId: string,
    app: string,
    revision: number,
    request: string
  ): Promise<{ requested: boolean }> {
    return await withPerson(this.#check, async (by) => {
      const { id } = await appFor(this.#env, by, app, "builder");
      await admitPreviewCall(this.#env, by, id);
      if (
        typeof request !== "string" ||
        request.length > functionRequestMaxBytes
      ) {
        throw screenErrors.create("screen.invalid");
      }
      return {
        requested: await this.#chatsOf(by.userId).previewCancelStream(
          chatIdOf(chatId),
          by.userId,
          id,
          revision,
          request
        ),
      };
    });
  }

  /**
   * Keeps what the preview's screen reported, for the agent's next check
   * of the draft: text its code wrote, held to size (`screenProblemSchema`).
   */
  async previewReport(
    chatId: string,
    app: string,
    revision: number,
    screen: string,
    problem: ScreenProblem
  ): Promise<void> {
    await withPerson(this.#check, async (by) => {
      const { id } = await appFor(this.#env, by, app, "builder");
      const at = screenErrors.parse("screen.invalid", screenNameSchema, screen);
      const reported = screenErrors.parse(
        "screen.invalid",
        screenProblemSchema,
        problem
      );
      await this.#chatsOf(by.userId).previewReport(
        chatIdOf(chatId),
        by.userId,
        id,
        revision,
        at,
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
  ): Promise<RunSubscription> {
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
      return new RunSubscription(async () => {
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
