import { agentErrors } from "@grasp-os/shared/agent";
import { appErrors } from "@grasp-os/shared/apps";
import { actorOf } from "@grasp-os/shared/audit";
import {
  chatTitleSchema,
  projectDocumentMaxBytes,
  projectDocumentNameSchema,
  projectGoalSchema,
  projectNameSchema,
} from "@grasp-os/shared/chat";
import type {
  ChatConnectionRequest,
  ChatDraft,
  ChatProject,
  ChatQuestion,
  ChatsApi,
  ChatSummary,
  ChatUpdate,
  FixRunResult,
  PreviewBundle,
  ProjectDocument,
} from "@grasp-os/shared/chat";
import {
  authErrors,
  internalErrors,
  isExpectedError,
} from "@grasp-os/shared/errors";
import { chatIdSchema, workspaceIdSchema } from "@grasp-os/shared/ids";
import type { AppId, ChatId, WorkspaceId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import type { ModelEfforts } from "@grasp-os/shared/models";
import { functionRequestMaxBytes } from "@grasp-os/shared/operation-limits";
import { roleErrors } from "@grasp-os/shared/roles";
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
import { z } from "zod";

import type { FunctionAnswer } from "./app-functions.ts";
import { appFor, draftFiles, screensIn } from "./apps.ts";
import { organizationId } from "./auth/auth.ts";
import { chatRequests, decideInChat } from "./chat-connections.ts";
import { personOf } from "./connections.ts";
import { withReferencesText } from "./draft-references.ts";
import { appHost, workspace } from "./durable-objects.ts";
import { gatewaySettings, modelEffortsOf } from "./models.ts";
import { callbackFor, isStub } from "./page-callbacks.ts";
import type { StillOpen } from "./page-callbacks.ts";
import { relayPreviewStream } from "./preview-stream-relay.ts";
import { QuerySubscriptions } from "./query-subscriptions.ts";
import type { LiveReads } from "./query-subscriptions.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { fixQuestion, runToFix } from "./run-fixes.ts";
import { RunSubscription } from "./run-subscription.ts";
import { frameAccess, stageFrame } from "./screen-frame.ts";
import {
  admitPreviewCall,
  admitWindow,
  argumentsFor,
  stillHasRole,
  windowCharger,
  withinAnswer,
} from "./screens-rpc.ts";
import { screenCode } from "./screens.ts";
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
// (chat-connections.ts). A person's projects are theirs alike, and every
// change to one is audited, as is moving a chat into or out of one.

/**
 * The agent every chat's agent is: the organization workspace's, so
 * admins grant to it once, whoever's chat it answers in. Named as agents
 * must be (`workspaceAgentIdSchema` in agent-scope.ts).
 */
export const chatAgentId = organizationId;

/**
 * The Workspace object that holds `userId`'s chats: each person's own, so
 * one person's chats, watches and turns never load, cap or restart
 * another's. A chat's context names it (`workspaceId`), and its agent is
 * still {@link chatAgentId}.
 */
export const personalWorkspaceId = (userId: string): WorkspaceId =>
  workspaceIdSchema.parse(`person:${userId}`);

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
 * A document to add to a project, as the page sends it: a name with one
 * of the types a project takes, and text. Its size and how many the
 * project has are the object's to check (`addProjectDocument`).
 */
const projectDocumentSchema = z.strictObject({
  name: projectDocumentNameSchema,
  // A character is at least a byte: longer can't fit.
  content: z.string().max(projectDocumentMaxBytes),
});

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
const previewKey = (chatId: ChatId, revision: number): string =>
  `preview:${chatId}:${revision}`;

/** The chat and revision `previewKey` made `key` of. */
const previewOfKey = (
  key: string | undefined
): { chatId: ChatId; revision: number } => {
  const [kind, chat, revision] = (key ?? "").split(":");
  const parsed = chatIdSchema.safeParse(chat);
  const at = Number(revision);
  if (kind !== "preview" || !parsed.success || !Number.isInteger(at)) {
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
    await appFor(env, by, app, "builder");
    return true;
  } catch (error) {
    if (isExpectedError(error)) {
      return false;
    }
    throw error;
  }
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
  // The draft still at the subscription's revision, and the person still
  // building the App: a read under way as the draft moved on pushes
  // nothing, and its subscription ends.
  access: async (by, app, key) => {
    const { chatId, revision } = previewOfKey(key);
    const now = await workspace(env, personalWorkspaceId(by.userId)).draft(
      chatId,
      app
    );
    return now.revision === revision && (await buildsNow(env, by, app))
      ? "open"
      : "role";
  },
  roles: async (by, app) =>
    (await buildsNow(env, by, app))
      ? canonicalJson({ appMember: true, appBuilder: true })
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
    return await withPerson(
      this.#check,
      () => gatewaySettings(this.#env).models
    );
  }

  async efforts(): Promise<Record<string, ModelEfforts>> {
    return await withPerson(this.#check, () =>
      Object.fromEntries(
        gatewaySettings(this.#env).models.map((model) => [
          model,
          modelEffortsOf(model),
        ])
      )
    );
  }

  async list(): Promise<ChatSummary[]> {
    return await withPerson(
      this.#check,
      async ({ userId }) => await this.#chatsOf(userId).chats(userId)
    );
  }

  async create(title: string, projectId?: string | null): Promise<ChatSummary> {
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
        actorOf(person),
        undefined,
        projectId ?? undefined
      );
      return {
        id: chat.id,
        title: chat.title,
        createdAt: chat.createdAt.toISOString(),
        running: false,
        projectId: chat.projectId,
      };
    });
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

  async moveChat(chatId: string, projectId: string | null): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await this.#chatsOf(person.userId).moveChat(
        chatIdOf(chatId),
        person.userId,
        projectId,
        actorOf(person)
      );
    });
  }

  async projects(): Promise<ChatProject[]> {
    return await withPerson(
      this.#check,
      async ({ userId }) => await this.#chatsOf(userId).projects(userId)
    );
  }

  async createProject(name: string): Promise<ChatProject> {
    return await withPerson(this.#check, async (person) => {
      const parsed = projectNameSchema.safeParse(name);
      if (!parsed.success) {
        throw agentErrors.create("agent.invalid_project");
      }
      return await this.#chatsOf(person.userId).createProject(
        person.userId,
        parsed.data,
        actorOf(person)
      );
    });
  }

  async renameProject(projectId: string, name: string): Promise<void> {
    await withPerson(this.#check, async (person) => {
      const parsed = projectNameSchema.safeParse(name);
      if (!parsed.success) {
        throw agentErrors.create("agent.invalid_project");
      }
      await this.#chatsOf(person.userId).renameProject(
        projectId,
        person.userId,
        parsed.data,
        actorOf(person)
      );
    });
  }

  async setProjectGoal(projectId: string, goal: string): Promise<void> {
    await withPerson(this.#check, async (person) => {
      const parsed = projectGoalSchema.safeParse(goal);
      if (!parsed.success) {
        throw agentErrors.create("agent.invalid_project");
      }
      await this.#chatsOf(person.userId).setProjectGoal(
        projectId,
        person.userId,
        parsed.data,
        actorOf(person)
      );
    });
  }

  async addProjectDocument(
    projectId: string,
    document: unknown
  ): Promise<ProjectDocument> {
    return await withPerson(this.#check, async (person) => {
      // A name and text only: whatever else the page passed goes no further.
      const parsed = projectDocumentSchema.safeParse(document);
      if (!parsed.success) {
        throw agentErrors.create("agent.invalid_project_document");
      }
      return await this.#chatsOf(person.userId).addProjectDocument(
        projectId,
        person.userId,
        parsed.data,
        actorOf(person)
      );
    });
  }

  async removeProjectDocument(
    projectId: string,
    documentId: string
  ): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await this.#chatsOf(person.userId).removeProjectDocument(
        projectId,
        person.userId,
        documentId,
        actorOf(person)
      );
    });
  }

  async removeProject(projectId: string): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await this.#chatsOf(person.userId).deleteProject(
        projectId,
        person.userId,
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
        projectId: chat.projectId,
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

  /**
   * A screen of the chat's draft of `app`, to preview (preview.ts): only
   * while the person builds the App, as the agent must to write it.
   */
  async preview(
    chatId: string,
    app: string,
    screen?: string
  ): Promise<PreviewBundle> {
    return await withPerson(this.#check, async (by) => {
      const { id, name } = await appFor(this.#env, by, app, "builder");
      // One update of the preview loads at a time, and one waits, the
      // newest (preview-updates.ts).
      const chats = this.#chatsOf(by.userId);
      const token = await chats.takePreviewUpdate(
        chatIdOf(chatId),
        by.userId,
        id
      );
      if (token === null) {
        throw appErrors.create("app.preview_superseded");
      }
      try {
        return await this.#loadPreview(by, chatId, id, name, screen);
      } finally {
        // Housekeeping: a place never settled frees itself once its lease
        // ends, so a failure here never replaces how the load ended.
        try {
          await chats.settlePreviewUpdate(
            chatIdOf(chatId),
            by.userId,
            id,
            token
          );
        } catch (error) {
          log.warn("app.preview_settle_failed", {
            app: id,
            ...errorFields(error),
          });
        }
      }
    });
  }

  /** The bundle of `chatId`'s preview of App `id`, built from its draft now. */
  async #loadPreview(
    by: Identity,
    chatId: string,
    id: AppId,
    name: string,
    screen: string | undefined
  ): Promise<PreviewBundle> {
    const draft = await this.#chatsOf(by.userId).previewDraft(
      chatIdOf(chatId),
      by.userId,
      id
    );
    const files = await draftFiles(this.#env, id, draft);
    const screens = screensIn(files);
    if (screens.length === 0) {
      throw screenErrors.create("screen.not_found");
    }
    // A draft of spec 8's layout: its screens import the references its
    // draft release generates, the very release their calls run on.
    const withReferences = await withReferencesText(
      Object.fromEntries(files),
      async () =>
        (await this.#chatsOf(by.userId).previewReferences(
          chatIdOf(chatId),
          by.userId,
          id,
          draft.revision
        )) ?? undefined
    );
    const built = await screenCode(
      this.#env,
      withReferences,
      screen ?? screens[0],
      null,
      id
    );
    // A preview reads no real data, so no approval decides it; its
    // frame still runs exactly this build and nothing else.
    await stageFrame(this.#env, built.artifact, built.code);
    return {
      app: id,
      name,
      revision: draft.revision,
      screens,
      screen: built.screen,
      artifact: built.artifact,
      frameToken: await frameAccess(this.#env, built.artifact),
    };
  }

  /**
   * Calls a method of the draft's server code in its preview, with plain
   * data and the screen's callbacks, as a screen's call does
   * (screens-rpc.ts); each push through a callback checks again, with each
   * reading of the session, what the call itself needs: the session and
   * a builder's role in the App. Once either is gone, the callback is
   * released and forwards nothing more.
   */
  async previewCall(
    chatId: string,
    app: string,
    revision: number,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    return await withPerson(this.#check, async (by) => {
      const { id } = await appFor(this.#env, by, app, "builder");
      await admitPreviewCall(this.#env, by, id);
      if (typeof method !== "string" || !Array.isArray(args)) {
        throw screenErrors.create("screen.invalid");
      }
      const { passed, callbacks } = argumentsFor(
        args,
        stillHasRole(this.#env, this.#check, id, "builder")
      );
      try {
        return withinAnswer(
          await this.#chatsOf(by.userId).previewCall(
            chatIdOf(chatId),
            by.userId,
            id,
            revision,
            method,
            passed
          )
        );
      } catch (error) {
        // A failed call keeps no callback.
        for (const callback of callbacks) {
          callback[Symbol.dispose]();
        }
        throw error;
      }
    });
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
      const { id } = await appFor(this.#env, by, app, "builder");
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
      const { id } = await appFor(this.#env, by, app, "builder");
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
      // The chat is theirs, with a draft of the App at `revision`.
      const draft = await this.#chatsOf(by.userId).previewDraft(
        chat,
        by.userId,
        id
      );
      if (draft.revision !== revision) {
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
        // draft still at the stream's revision.
        stillOpen: async () => {
          const now = await this.#check();
          if (now.userId !== by.userId) {
            throw authErrors.create("auth.unauthenticated");
          }
          if ((await chats.draftRevision(chat, id)) !== revision) {
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
