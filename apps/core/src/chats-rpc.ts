import { agentErrors } from "@grasp-os/shared/agent";
import { agentAppOf } from "@grasp-os/shared/agents";
import type {
  Agent,
  AgentChangeDraft,
  AgentDraft,
  AgentDraftMade,
  AgentDraftMake,
} from "@grasp-os/shared/agents";
import { actorOf } from "@grasp-os/shared/audit";
import {
  chatMentionsSchema,
  chatListOptionsSchema,
  chatRatingReasonMax,
  chatStartSchema,
  chatTitleSchema,
  unmetNeeds,
} from "@grasp-os/shared/chat";
import type {
  ChatBuild,
  ChatBuilt,
  ChatPlan,
  ChatConnectionRequest,
  ChatFile,
  ChatFileInput,
  ChatHistoryPage,
  ChatListOptions,
  ChatQuestion,
  ChatRating,
  ChatSearchHit,
  ChatStart,
  ChatsApi,
  ChatStopped,
  ChatAgent,
  ChatSummary,
  ChatListUpdate,
  ChatUpdate,
  ChatWork,
  HeldAppCall,
  MentionablePerson,
} from "@grasp-os/shared/chat";
import type { DependencyRequest } from "@grasp-os/shared/dependencies";
import { chatIdSchema } from "@grasp-os/shared/ids";
import type { ChatId, ChatRef } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import type { ModelEffort, ModelEfforts } from "@grasp-os/shared/models";
import { requireBuilder } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { subjectSchema } from "@grasp-os/shared/subject";
import type { Subject, SubjectKind } from "@grasp-os/shared/subject";
import { workflowTitleSchema } from "@grasp-os/shared/workflow-resources";
import { z } from "zod";

import { setAgentApp } from "./agent-app-access.ts";
import { offeredApps } from "./agent-apps-offered.ts";
import {
  agentChangedAt,
  changeAgent,
  listAgents,
  listOwnAgents,
  readAgentSettings,
  makeAgent,
  makeOwnAgent,
  setAgentPaused,
  setAgentReach,
  setAgentToolClass,
} from "./agent-builder.ts";
import { makeAgentWake, wakeScheduleOf } from "./agent-wakes.ts";
import type { QuestionBuilt } from "./agent.ts";
import { firstAgentId, turnAgent } from "./agents.ts";
import { createFromBlueprint } from "./app-blueprints.ts";
import { appKind, createApp, editableApp } from "./apps.ts";
import { chatAgentOf, chatAgentsFor } from "./chat-agents.ts";
import { chatRequests, decideInChat } from "./chat-connections.ts";
import { readChatFile, readChatPicture } from "./chat-files.ts";
import { mentionablePeople, mentionsOf } from "./chat-mentions.ts";
import { personOf } from "./connections.ts";
import { chatWork, chatsWorkedOn, keepMadeInChat } from "./drafts.ts";
import { workspace } from "./durable-objects.ts";
import {
  confirmHeldAppCall,
  declineHeldAppCall,
  heldAppCallsOf,
} from "./held-app-calls.ts";
import {
  instructionFileToEdit,
  saveInstructionFile,
} from "./instruction-files.ts";
import { parseModelRef } from "./model-catalog.ts";
import { modelSettings, modelEffortsOf } from "./models.ts";
import { chatPackageRequests } from "./packages/requests.ts";
import { callbackFor, isStub, stillOpenWhile } from "./page-callbacks.ts";
import type { StillOpen } from "./page-callbacks.ts";
import { personalWorkspaceId } from "./personal-workspace.ts";
import { requireProjectRole } from "./project-access.ts";
import { makeInProject } from "./projects.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";
import { requireNotStaff } from "./sharing.ts";
import { watchEnds } from "./socket-watchers.ts";
import { requireCompanyAdmin, requireKnownTeams } from "./stephen-reach.ts";
import { Subscription } from "./subscription.ts";
import { followObject } from "./upstream.ts";
import {
  workflowKind,
  createWorkflowResource,
  requireWorkflowRole,
} from "./workflow-resources.ts";
import { questionSchema, stopReason } from "./workspace.ts";

/** The page's key for a request it may repeat (`ChatQuestion.key`). */
const requestKeySchema = z.uuid();

/** A rating as the page sends it (`ChatsApi.rate`). */
const ratedSchema = z.strictObject({
  messageId: z.int().positive(),
  rating: z
    .strictObject({
      value: z.enum(["up", "down"]),
      reason: z.string().trim().min(1).max(chatRatingReasonMax).optional(),
    })
    .nullable(),
});

/**
 * A question as the page sends it: what it is about, and what it
 * mentions, named by ID alone. What Build it made is core's to say
 * (`build`), never the page's.
 */
const askedSchema = questionSchema.omit({ built: true }).extend({
  subject: subjectSchema.optional(),
  mentions: chatMentionsSchema.optional(),
  key: requestKeySchema.optional(),
  start: chatStartSchema.optional(),
});

/** Build it as the page sends it (`ChatBuild`). */
const buildSchema = questionSchema
  .pick({ text: true, model: true, effort: true })
  .extend({ plan: z.string().min(1).max(256) });

/** Instructions with `added` after them, as a change from the chat adds them. */
const instructionsWith = (now: string, added: string | undefined): string =>
  added === undefined ? now : `${now.trimEnd()}\n\n${added}`.trim();

/** Whether a change touches more than the agent itself: its apps, access or schedule. */
const settingsIn = ({
  addApps = [],
  removeApps = [],
  audience,
  turnOn = [],
  schedule,
}: AgentChangeDraft): boolean =>
  addApps.length > 0 ||
  removeApps.length > 0 ||
  audience !== undefined ||
  turnOn.length > 0 ||
  schedule !== undefined;

/**
 * After a card's press made something: the chat goes on in the person's
 * words, its agent told what was made (`built`), as after Build it. A
 * turn that can't start keeps their words with what was made and why it
 * stopped (`keepBuilt`), so the card waits no more and nothing is made
 * twice.
 */
const carryOn = async (
  chats: ReturnType<typeof workspace>,
  chatId: ChatId,
  personId: string,
  asked: { text: string; model: string; effort?: ModelEffort | undefined },
  built: QuestionBuilt
): Promise<void> => {
  try {
    await chats.send(chatId, personId, { ...asked, built });
  } catch (error) {
    await chats.keepBuilt(chatId, personId, {
      text: asked.text,
      built,
      stopped: stopReason(chatId, error),
    });
  }
};

const draftMakeSchema = questionSchema
  .pick({ text: true, model: true, effort: true })
  .extend({ draft: z.string().min(1).max(256) });

/** The longest part of a new workflow's name taken from its plan. */
const wordsAtMost = 40;

/** Accents, as letters decompose into them (NFKD). */
const marks = /\p{M}+/gu;

/** Anything in a name that isn't a lowercase letter or digit, as a run. */
const notNameChars = /[^a-z0-9]+/gu;

/** Dashes at either end. */
const endDashes = /^-+|-+$/gu;

/**
 * A workflow's name (`workflowNameSchema`: lowercase letters, digits and
 * dashes) from what its plan calls it, with a part nobody had, as a
 * workflow's name is its own for good: `late-reminder-1a2b3c`. People
 * see its title, which its agent gives it.
 */
const workflowNameOf = (planned: string): string => {
  const words = planned
    .normalize("NFKD")
    .replaceAll(marks, "")
    .toLowerCase()
    .replaceAll(notNameChars, "-")
    .slice(0, wordsAtMost)
    .replaceAll(endDashes, "");
  const own = crypto.randomUUID().slice(0, 6);
  return `${words === "" ? "workflow" : words}-${own}`;
};

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
 * must be (`workspaceAgentIdSchema` in agent-scope.ts). The first of the
 * company's agents (agents.ts), under the ID it always had.
 */
// Where it is: the leaf module, which what this module imports can import.
export { personalWorkspaceId } from "./personal-workspace.ts";

export { firstAgentId as chatAgentId } from "./agents.ts";

/**
 * Most chats one connection follows at once: a page shows one, and a page
 * that watches over and over holds no more than this in the object.
 */
const maxWatches = 10;

/**
 * The pauses before taking up again a watch the person's object let go
 * of (`#follow`): at once, then longer while it can't be (the object
 * still resetting), at most a few seconds apart.
 */
const rewatchMs = [0, 500, 1000, 2000, 5000] as const;

/** The last message an update carried, if it carried any. */
const lastMessageOf = (update: unknown): number | undefined => {
  const parsed = z
    .object({ messages: z.array(z.object({ id: z.number() })) })
    .safeParse(update);
  return parsed.success ? parsed.data.messages.at(-1)?.id : undefined;
};

/** A chat's ID from the page: a string, or no chat at all. */
const chatIdOf = (chatId: unknown): ChatId => {
  const parsed = chatIdSchema.safeParse(chatId);
  if (!parsed.success) {
    throw agentErrors.create("agent.chat_not_found");
  }
  return parsed.data;
};

/**
 * What the person's object sends a follower of their list (`ChatListUpdate`,
 * person-connections.ts): checked before anything reaches the page.
 */
const listUpdateSchema = z.object({
  chats: z.array(z.looseObject({ id: z.string(), lastAt: z.string() })),
  removed: z.array(z.string()),
  full: z.boolean(),
  archived: z.number(),
});

/**
 * The most a slow page's follow of the list holds for it, as JSON: a few
 * updates of a long list. Past it the follow catches up with the whole
 * list, so a page that keeps not answering holds at most this.
 */
const maxQueuedList = 512 * 1024;

/** How a push to a chat page is refused. */
const refusals = {
  invalid: () => agentErrors.create("agent.invalid_request"),
  closed: () => agentErrors.create("agent.chat_not_found"),
};

/** What Build it's question is about: the App it made, or else its workflow. */
const subjectOfBuilt = ({ app, workflow }: ChatBuilt) => {
  if (app !== undefined) {
    return { subject: { kind: "app" as const, ...app } };
  }
  return workflow === undefined
    ? {}
    : { subject: { kind: "workflow" as const, ...workflow } };
};

/**
 * Keeps what Build it made as the chat's work (drafts.ts,
 * `keepMadeInChat`): where it was made, so the chat lists it at once. A
 * failure is logged for Grasp and never fails the build, which made it
 * all the same; the chat's agent's first write keeps it as the chat's
 * work then.
 */
const keptInChat = async (
  ...kept: Parameters<typeof keepMadeInChat>
): Promise<void> => {
  try {
    await keepMadeInChat(...kept);
  } catch (error) {
    const [, kind, subject] = kept;
    log.error("chat.made_unkept", {
      kind: kind.kind,
      id: subject,
      ...errorFields(error),
    });
  }
};

export class ChatsRpc extends CoreRpcTarget implements ChatsApi {
  readonly #env: Env;
  readonly #check: SessionCheck;
  /** This connection's watches, each until it's released. */
  readonly #watches = new Set<Disposable>();
  /**
   * The chats a call on this connection is starting now (`ChatStart`),
   * each until that call is done, by ID: a call about one of them that
   * came after it waits for it (`#idOf`), so the page that named a new
   * chat follows and reads it at once, from its next call, as a
   * connection's reads see its own writes.
   */
  readonly #starts = new Map<string, Promise<true>>();
  /**
   * Whether this connection may still follow chats, before each push: its
   * session holds, as the connection's own check last read it, the same
   * reading its calls share (at most `sessionRecheckMs` old,
   * session-check.ts).
   */
  readonly #stillOpen: StillOpen;
  /** `closed`: aborted once the connection closes, which lets go of every watch of it. */
  constructor(env: Env, check: SessionCheck, closed: AbortSignal) {
    super();
    this.#env = env;
    this.#check = check;
    this.#stillOpen = stillOpenWhile(check);
    closed.addEventListener("abort", () => {
      for (const watch of this.#watches) {
        watch[Symbol.dispose]();
      }
    });
  }

  /** The object that holds `userId`'s chats. */
  #chatsOf(userId: string) {
    return workspace(this.#env, personalWorkspaceId(userId));
  }

  /**
   * `call`, which starts chat `chatId` when it carries a `start`: known to
   * this connection as starting it until it is done (`#starts`), from
   * before this call yields, so a call that came after it finds it.
   */
  async #starting<T>(
    chatId: unknown,
    start: unknown,
    call: Promise<T>
  ): Promise<T> {
    if (start === undefined || typeof chatId !== "string") {
      return await call;
    }
    const done = Promise.withResolvers<true>();
    this.#starts.set(chatId, done.promise);
    try {
      return await call;
    } finally {
      done.resolve(true);
      if (this.#starts.get(chatId) === done.promise) {
        this.#starts.delete(chatId);
      }
    }
  }

  /** Once no call on this connection is starting chat `chatId` (`#starts`). */
  async #started(chatId: unknown): Promise<void> {
    if (typeof chatId === "string") {
      await this.#starts.get(chatId);
    }
  }

  /** A chat's ID from the page, once no call here is starting it (`#started`). */
  async #idOf(chatId: unknown): Promise<ChatId> {
    await this.#started(chatId);
    return chatIdOf(chatId);
  }

  /**
   * The chat `start` names, as its object makes it (`startChat`): with an
   * agent the person may talk to (`chatAgentOf`), or the company's first;
   * from "Make something", what it came to make, for a builder, and the
   * project, for a builder of it, checked now: Build it makes things
   * there. One to set up an agent only for the company's own admins, who
   * alone make one; Grasp staff never set one up.
   */
  async #startOf(person: Identity, { key, title, agentId, make }: ChatStart) {
    if (make?.kind === "agent") {
      requireCompanyAdmin(person);
    } else if (make !== undefined) {
      requireBuilder(person);
      if (make.project !== undefined) {
        requireNotStaff(person);
        await requireProjectRole(this.#env, person, make.project, "builder");
      }
    }
    const agent = await chatAgentOf(this.#env, person.userId, agentId);
    return { key, title, agentId: agent, make, by: actorOf(person) };
  }

  /**
   * Makes chat `chatId`, which `start` names, unless that start made it
   * already: what it is checked for (`#startOf`) only for a new one, as
   * its agent or project may be gone since the first call made it.
   */
  async #start(
    person: Identity,
    chatId: ChatId,
    start: ChatStart
  ): Promise<void> {
    const chats = this.#chatsOf(person.userId);
    if (!(await chats.chatStartedWith(chatId, person.userId, start.key))) {
      await chats.startChat(
        chatId,
        person.userId,
        await this.#startOf(person, start)
      );
    }
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

  async names(): Promise<Record<string, string>> {
    return await withPerson(this.#check, async () => {
      const { models: allowed } = await modelSettings(this.#env);
      return Object.fromEntries(
        allowed.map((model) => [
          model,
          parseModelRef(model)?.catalog.name ?? model,
        ])
      );
    });
  }

  async list(options?: ChatListOptions): Promise<ChatSummary[]> {
    return await withPerson(this.#check, async (person) => {
      const parsed = chatListOptionsSchema.safeParse(options ?? {});
      if (!parsed.success) {
        throw agentErrors.create("agent.invalid_request");
      }
      const { archived = false, project } = parsed.data;
      // Only while they are in the project: once out, its chats are no
      // longer listed by it, though each stays theirs in their own list.
      if (project !== undefined) {
        await requireProjectRole(this.#env, person, project, "user");
      }
      return await this.#chatsOf(person.userId).chats(
        person.userId,
        archived,
        project
      );
    });
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
        await this.#chatsOf(userId).chatSummary(
          await this.#idOf(chatId),
          userId
        )
    );
  }

  async agents(): Promise<ChatAgent[]> {
    return await withPerson(
      this.#check,
      async ({ userId }) => await chatAgentsFor(this.#env, userId)
    );
  }

  /**
   * The person's chat for an App or a workflow they may change (`ChatsApi.forSubject`):
   * the one that last worked on it, or null while none did.
   */
  async forSubject(subject: Subject): Promise<ChatSummary | null> {
    return await withPerson(this.#check, async (person) => {
      const parsed = subjectSchema.safeParse(subject);
      if (!parsed.success) {
        throw agentErrors.create("agent.invalid_request");
      }
      const { kind, id } = await this.#subjectOf(person, parsed.data);
      return await this.#chatsOf(person.userId).subjectChat(
        person.userId,
        { kind, id },
        await chatsWorkedOn(
          this.#env,
          { kind, id },
          personalWorkspaceId(person.userId)
        )
      );
    });
  }

  async people(): Promise<MentionablePerson[]> {
    return await withPerson(
      this.#check,
      async (person) => await mentionablePeople(this.#env, person)
    );
  }

  async rename(chatId: string, title: string): Promise<void> {
    await withPerson(this.#check, async (person) => {
      const id = await this.#idOf(chatId);
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

  async markRead(chatId: string, upTo?: number): Promise<number | null> {
    // Only the signed-in person's own object, and only their chat in it:
    // nobody moves where another person has read to.
    return await withPerson(this.#check, async ({ userId }) => {
      if (upTo !== undefined && !(Number.isSafeInteger(upTo) && upTo >= 0)) {
        throw agentErrors.create("agent.invalid_request");
      }
      return await this.#chatsOf(userId).markChatRead(
        await this.#idOf(chatId),
        userId,
        upTo
      );
    });
  }

  async archive(chatId: string): Promise<void> {
    await this.#archive(chatId, true);
  }

  async unarchive(chatId: string): Promise<void> {
    await this.#archive(chatId, false);
  }

  async setProject(chatId: string, project: string | null): Promise<void> {
    await withPerson(this.#check, async (person) => {
      const id = await this.#idOf(chatId);
      if (project !== null && typeof project !== "string") {
        throw agentErrors.create("agent.invalid_request");
      }
      // Only in a project they are in now; out of one, wherever they are.
      const access =
        project === null
          ? undefined
          : await requireProjectRole(this.#env, person, project, "user");
      const filed = access?.project.id ?? null;
      await this.#chatsOf(person.userId).setChatProject(
        id,
        person.userId,
        filed,
        actorOf(person)
      );
    });
  }

  /** Archives the person's own chat, or brings it back (`archived` false). */
  async #archive(chatId: string, archived: boolean): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await this.#chatsOf(person.userId).archiveChat(
        await this.#idOf(chatId),
        person.userId,
        archived,
        actorOf(person)
      );
    });
  }

  async rate(
    chatId: string,
    messageId: number,
    rating: ChatRating | null
  ): Promise<void> {
    await withPerson(this.#check, async (person) => {
      const id = await this.#idOf(chatId);
      const parsed = ratedSchema.safeParse({ messageId, rating });
      if (!parsed.success) {
        throw agentErrors.create("agent.invalid_request");
      }
      await this.#chatsOf(person.userId).rateAnswer(
        id,
        person.userId,
        parsed.data.messageId,
        parsed.data.rating,
        actorOf(person)
      );
    });
  }

  /**
   * Deletes the chat once its agent isn't working on it: gone from the
   * person's surfaces at once, taking no question, while its object
   * finishes every step by itself (`deleteChat`), the writes it holds
   * rejected among them, so none is left that nobody can decide.
   */
  async remove(chatId: string): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await this.#chatsOf(person.userId).deleteChat(
        await this.#idOf(chatId),
        person.userId,
        await personOf(this.#env, person),
        actorOf(person)
      );
    });
  }

  /**
   * Reads the file's text (chat-files.ts), outside the person's Workspace
   * object, or takes it whole when its bytes are a picture, then attaches
   * it to their chat there, audited. With `key`, a repeat answers the file
   * the first call attached. With `start`, for the question that starts
   * the chat, the chat is made first (`#start`), as `send` makes it.
   */
  async attachFile(
    chatId: string,
    file: ChatFileInput,
    key?: string,
    start?: ChatStart
  ): Promise<ChatFile> {
    return await this.#starting(
      chatId,
      start,
      withPerson(this.#check, async (person) => {
        const id =
          start === undefined ? await this.#idOf(chatId) : chatIdOf(chatId);
        const keyed = requestKeySchema.optional().safeParse(key);
        const starts = chatStartSchema.optional().safeParse(start);
        if (!keyed.success || !starts.success) {
          throw agentErrors.create("agent.invalid_request");
        }
        if (starts.data !== undefined) {
          await this.#start(person, id, starts.data);
        }
        const chats = this.#chatsOf(person.userId);
        // A repeat is answered before its bytes are read again: a page
        // sends one when the connection broke before it heard the first.
        const repeated =
          keyed.data === undefined
            ? undefined
            : await chats.fileAttachedWith(id, person.userId, keyed.data);
        if (repeated !== undefined) {
          return repeated;
        }
        const read =
          readChatPicture(file) ?? (await readChatFile(this.#env, file));
        return await chats.attachFile(
          id,
          person.userId,
          read,
          actorOf(person),
          keyed.data
        );
      })
    );
  }

  async removeFile(chatId: string, fileId: string): Promise<void> {
    await withPerson(this.#check, async (person) => {
      if (typeof fileId !== "string") {
        throw agentErrors.create("agent.file_not_found");
      }
      await this.#chatsOf(person.userId).removeFile(
        await this.#idOf(chatId),
        person.userId,
        fileId,
        actorOf(person)
      );
    });
  }

  /**
   * Asks in the person's chat; one that starts its chat (`ChatQuestion.start`)
   * makes it first (`#start`), in the same call, so a new chat costs the
   * page no call of its own before its question goes.
   */
  async send(chatId: string, question: ChatQuestion): Promise<void> {
    await this.#starting(
      chatId,
      // Whether it starts a chat is read before anything is checked, so
      // a call that came after it waits for it whatever it turns out.
      typeof question === "object" && question !== null
        ? Reflect.get(question, "start")
        : undefined,
      withPerson(this.#check, async (person) => {
        // Its strings and effort only: whatever else the page passed goes
        // no further.
        const parsed = askedSchema.safeParse(question);
        if (!parsed.success) {
          throw agentErrors.create("agent.invalid_question");
        }
        const {
          subject: named,
          mentions: picked,
          key,
          start,
          ...asked
        } = parsed.data;
        const id =
          start === undefined ? await this.#idOf(chatId) : chatIdOf(chatId);
        const chats = this.#chatsOf(person.userId);
        if (start !== undefined) {
          await this.#start(person, id, start);
        }
        // A repeat is answered before anything it names is looked up: what
        // the first call found may be gone since, and that refuses only a
        // new question.
        if (
          key !== undefined &&
          (await chats.sentBefore(id, person.userId, key))
        ) {
          return;
        }
        const [subject, mentions] = await Promise.all([
          named === undefined ? undefined : this.#subjectOf(person, named),
          picked === undefined || picked.length === 0
            ? undefined
            : mentionsOf(this.#env, person, picked),
        ]);
        await chats.send(
          id,
          person.userId,
          {
            ...asked,
            ...(subject === undefined ? {} : { subject }),
            ...(mentions === undefined ? {} : { mentions }),
          },
          key
        );
      })
    );
  }

  /**
   * Build it (`ChatsApi.build`): takes the chat's plan once, makes what it
   * lists, each through the same paths as anywhere (`createApp`, or
   * `createFromBlueprint` for an App part that names one,
   * `createWorkflowResource`, in the project the chat was started with),
   * then asks the chat's agent to build them, in the person's words, about
   * the App (or the workflow, without one), told what was made. Each is
   * kept as the chat's work the moment it is made (`keepMadeInChat`), so
   * its page finds this chat (`forSubject`) whatever happens next. A plan
   * whose connections aren't all there yet makes nothing and stays to
   * build once they are: nothing is promised and then left out. What the
   * first make refuses (the person's role, the project's) leaves the plan
   * to build again. A later failure (the next make, filing one in the
   * project, or the turn not starting) leaves what was made, as any App
   * or workflow stays until a person removes it, and the plan taken: the
   * chat keeps Build it with what was made all the same, and why it
   * stopped (`Workspace.keepBuilt`), and what was made is answered.
   */
  async build(chatId: string, build: ChatBuild): Promise<ChatBuilt> {
    return await withPerson(this.#check, async (person) => {
      requireBuilder(person);
      const id = await this.#idOf(chatId);
      const chat = {
        workspaceId: personalWorkspaceId(person.userId),
        chatId: id,
      };
      const parsed = buildSchema.safeParse(build);
      if (!parsed.success) {
        throw agentErrors.create("agent.invalid_request");
      }
      const { plan: callId, ...asked } = parsed.data;
      const chats = this.#chatsOf(person.userId);
      const { plan, make } = await chats.takePlan(id, person.userId, callId);
      const project = make?.project;
      const appPart = plan.parts.find(({ kind }) => kind === "app");
      const workflowPart = plan.parts.find(({ kind }) => kind === "workflow");
      const made: ChatBuilt = {};
      let failure: unknown;
      try {
        // No App or workflow made for a chat whose paused agent couldn't
        // build them.
        const { agentId } = await chats.chatSummary(id, person.userId);
        await turnAgent(this.#env, agentId);
        await this.#requireNeeds(person, plan);
        if (appPart !== undefined) {
          const named = { name: appPart.name, description: appPart.does };
          const { blueprint } = appPart;
          await makeInProject(
            this.#env,
            person,
            project,
            "app",
            async () => {
              const started =
                blueprint === undefined
                  ? { app: await createApp(this.#env, person, named) }
                  : await createFromBlueprint(
                      this.#env,
                      person,
                      blueprint,
                      named
                    );
              const { app } = started;
              // Known as made at once: a filing that fails leaves it made.
              made.app = { id: app.id, name: app.name };
              await keptInChat(this.#env, appKind, app.id, person.userId, {
                ...chat,
                turnId: null,
                callId,
              });
              return app;
            },
            ({ id: appId }) => appId
          );
        }
        if (workflowPart !== undefined) {
          await makeInProject(
            this.#env,
            person,
            project,
            "workflow",
            async () => {
              // Called what the plan named it, where that is a title;
              // a name that isn't one leaves it by its own name.
              const title = workflowTitleSchema.safeParse(workflowPart.name);
              const workflow = await createWorkflowResource(
                this.#env,
                person,
                workflowNameOf(workflowPart.name),
                title.success ? title.data : undefined
              );
              made.workflow = { id: workflow.id, name: workflowPart.name };
              await keptInChat(
                this.#env,
                workflowKind,
                workflow.id,
                person.userId,
                { ...chat, turnId: null, callId }
              );
              return workflow;
            },
            ({ id: workflowId }) => workflowId
          );
        }
      } catch (error) {
        if (made.app === undefined && made.workflow === undefined) {
          await chats.releasePlan(id, callId);
          throw error;
        }
        failure = error;
      }
      const built = {
        plan: callId,
        ...made,
        ...(project === undefined ? {} : { project }),
      };
      if (failure === undefined) {
        try {
          await chats.send(id, person.userId, {
            ...asked,
            ...subjectOfBuilt(made),
            built,
          });
          return made;
        } catch (error) {
          failure = error;
        }
      }
      // What was made stays made and the plan taken, so no retry makes it
      // twice: the chat keeps Build it with what it made, and why it
      // stopped, to go on from there.
      await chats.keepBuilt(id, person.userId, {
        text: asked.text,
        built,
        stopped: stopReason(id, failure),
      });
      return made;
    });
  }

  /**
   * Make it: the agent the chat drafted, as its card showed it, by the
   * Agents page's own checks (`makeAgent` for an admin, `makeOwnAgent`
   * for anyone the company lets), recorded as made from a chat. A first
   * refusal leaves the draft to make again. Once the agent is made, what
   * the card said it is told is saved as its instruction file; a save
   * that fails gives the draft back naming that agent, so the next Make it
   * tells it and makes no second. Told, the draft stays taken, so no retry
   * makes it twice, and what the card said of whom it reaches, what it may
   * do and when it wakes is set by the same checks, each refused as on its
   * page. Then the chat's agent goes on, in the person's words.
   */
  async makeDraftedAgent(
    chatId: string,
    make: AgentDraftMake
  ): Promise<AgentDraftMade> {
    return await withPerson(this.#check, async (person) => {
      const id = await this.#idOf(chatId);
      const parsed = draftMakeSchema.safeParse(make);
      if (!parsed.success) {
        throw agentErrors.create("agent.invalid_request");
      }
      const { draft: callId, ...asked } = parsed.data;
      const chats = this.#chatsOf(person.userId);
      const { draft, made } = await chats.takeAgentDraft(
        id,
        person.userId,
        callId
      );
      // The agent an earlier Make it made of this draft, whose instructions
      // it couldn't save; otherwise one made now.
      let agentId = made;
      if (agentId === null) {
        try {
          // None made for a chat whose paused agent couldn't go on with it,
          // as Build it makes none.
          await this.#requireChatAgentOn(chats, id, person.userId);
          const madeNow = await this.#makeDrafted(person, draft);
          agentId = madeNow.id;
        } catch (error) {
          await chats.releaseAgentDraft(id, callId);
          throw error;
        }
      }
      // What it is told: its instruction file's first version, saved as on
      // its page, under a change named by the agent, so a second Make it
      // after an answer that never came saves it once. Not saved, the
      // draft is given back, its instructions on its card, naming the
      // agent made, which Make it then tells them and never makes again.
      try {
        await saveInstructionFile(this.#env, person, {
          file: { scope: "agent", agentId },
          change: `made-${agentId}`,
          text: draft.instructions,
          after: 0,
        });
      } catch (error) {
        await chats.keepAgentDraftMade(id, callId, agentId);
        throw error;
      }
      const agent = { id: agentId, name: draft.name };
      // Told: it stays made and the draft taken, whatever fails next, and
      // the person lands on its page to finish it there.
      let unfinished = false;
      try {
        await this.#setDrafted(person, agent.id, draft);
      } catch (error) {
        log.warn("agent.drafted_unfinished", errorFields(error));
        // Never left answering with less narrowed than its card: with no
        // app saved it would use any app. Paused, it answers nothing until
        // its page is finished.
        await this.#pauseQuietly(person, agent.id);
        unfinished = true;
      }
      await carryOn(chats, id, person.userId, asked, {
        plan: callId,
        agent,
        agentAction: "made",
        ...(unfinished ? { unfinished: true } : {}),
      });
      return { ...agent, ...(unfinished ? { unfinished: true } : {}) };
    });
  }

  /**
   * Makes the agent `draft` is of, by the Agents page's own checks, what
   * its card says beyond the agent checked first, so a schedule or teams
   * core won't take make nothing.
   */
  async #makeDrafted(person: Identity, draft: AgentDraft): Promise<Agent> {
    const said = {
      name: draft.name,
      face: "pen",
      job: draft.job,
      modelRole: null,
    };
    await this.#checkDrafted(draft);
    if (draft.whose !== "company") {
      return await makeOwnAgent(this.#env, person, said, { from: "chat" });
    }
    return await makeAgent(this.#env, person, said, { from: "chat" });
  }

  /** Refuses while the chat's own agent is paused: it couldn't go on with what a card made. */
  async #requireChatAgentOn(
    chats: ReturnType<typeof workspace>,
    chatId: ChatId,
    personId: string
  ): Promise<void> {
    const { agentId } = await chats.chatSummary(chatId, personId);
    await turnAgent(this.#env, agentId);
  }

  /** Pauses an agent whose card couldn't all be set; a failure is only logged. */
  async #pauseQuietly(person: Identity, agentId: string): Promise<void> {
    try {
      await setAgentPaused(this.#env, person, agentId, true);
    } catch (error) {
      log.warn("agent.drafted_unpaused", errorFields(error));
    }
  }

  /**
   * Change it: the change to one of the person's agents the chat drafted,
   * as its card showed it, by the agent page's own checks. The agent is
   * the one by the card's name among those the person may change: one of
   * the company's for an admin, else their own. Refused with nothing
   * changed for one they may not change (`agent.unknown`), one changed
   * since the chat drafted it (`agent.draft_stale`), and anything its page
   * would refuse; then the draft is theirs to press again. Once something
   * changed, the draft stays taken and a later failure says the change is
   * unfinished.
   */
  async changeDraftedAgent(
    chatId: string,
    make: AgentDraftMake
  ): Promise<AgentDraftMade> {
    return await withPerson(this.#check, async (person) => {
      const id = await this.#idOf(chatId);
      const parsed = draftMakeSchema.safeParse(make);
      if (!parsed.success) {
        throw agentErrors.create("agent.invalid_request");
      }
      const { draft: callId, ...asked } = parsed.data;
      const chats = this.#chatsOf(person.userId);
      const { change, at } = await chats.takeAgentChange(
        id,
        person.userId,
        callId
      );
      let agent: Agent;
      try {
        // Nothing changed for a chat whose paused agent couldn't go on with
        // it, as Build it makes nothing.
        await this.#requireChatAgentOn(chats, id, person.userId);
        agent = await this.#changedAgent(person, change, at);
        await this.#checkDrafted({
          ...(change.addApps === undefined ? {} : { apps: change.addApps }),
          ...(change.audience === undefined
            ? {}
            : { audience: change.audience }),
          ...(change.schedule === undefined
            ? {}
            : { schedule: change.schedule }),
        });
      } catch (error) {
        await chats.releaseAgentChange(id, callId);
        throw error;
      }
      let unfinished = false;
      try {
        await this.#setChanged(person, agent, change, callId);
      } catch (error) {
        log.warn("agent.change_unfinished", errorFields(error));
        // An app the card took off may still be on: paused, it answers
        // nothing until its page is finished.
        await this.#pauseQuietly(person, agent.id);
        unfinished = true;
      }
      const changed = { id: agent.id, name: agent.name };
      await carryOn(chats, id, person.userId, asked, {
        plan: callId,
        agent: changed,
        agentAction: "changed",
        ...(unfinished ? { unfinished: true } : {}),
      });
      return { ...changed, ...(unfinished ? { unfinished: true } : {}) };
    });
  }

  /**
   * The agent a change names, among those `person` may change, as it is
   * now: never one changed since `at`, when the chat drafted the change.
   */
  async #changedAgent(
    person: Identity,
    change: AgentChangeDraft,
    at: Date
  ): Promise<Agent> {
    const { agent: name, whose } = change;
    const among =
      whose === "company"
        ? await this.#companyAgentsFor(person)
        : await listOwnAgents(this.#env, person.userId);
    const key = name.trim().toLowerCase();
    const agent = among.find((each) => each.name.toLowerCase() === key);
    if (agent === undefined) {
      throw agentErrors.create("agent.unknown");
    }
    // The first agent's apps and access are set elsewhere: only its job and
    // instructions change here, refused before anything is written.
    if (agent.id === firstAgentId && settingsIn(change)) {
      throw agentErrors.create("agent.settings_elsewhere");
    }
    // Changed since: itself, or any setting a card could change.
    const changedAt = await agentChangedAt(this.#env, agent);
    if (changedAt !== null && changedAt > at) {
      throw agentErrors.create("agent.draft_stale");
    }
    return agent;
  }

  /** The company's agents, for its own admins alone. */
  async #companyAgentsFor(person: Identity): Promise<Agent[]> {
    requireCompanyAdmin(person);
    return await listAgents(this.#env);
  }

  /** What a change's card said, set as on the agent's page. */
  async #setChanged(
    person: Identity,
    agent: Agent,
    {
      job,
      addInstructions,
      addApps = [],
      removeApps = [],
      audience,
      turnOn = [],
      schedule,
    }: AgentChangeDraft,
    callId: string
  ): Promise<void> {
    if (job !== undefined) {
      await changeAgent(
        this.#env,
        person,
        agent.id,
        {
          name: agent.name,
          face: agent.face,
          job,
          modelRole: agent.modelRole,
          model: agent.model,
        },
        { from: "chat" }
      );
    }
    if (addInstructions !== undefined) {
      // Added after what its instruction file says now, saved as on its
      // page: from the version read, under a change this card names, so a
      // second press saves it once and one saved meanwhile refuses it.
      const file = { scope: "agent" as const, agentId: agent.id };
      const now = await instructionFileToEdit(this.#env, person, file);
      await saveInstructionFile(this.#env, person, {
        file,
        change: `chat-change-${callId}`,
        text: instructionsWith(now?.text ?? "", addInstructions),
        after: now?.version ?? 0,
      });
    }
    for (const [apps, on] of [
      [addApps, true],
      [removeApps, false],
    ] as const) {
      for (const { source, provider } of apps) {
        // oxlint-disable-next-line no-await-in-loop -- one at a time, each audited
        await setAgentApp(
          this.#env,
          person,
          agent.id,
          agentAppOf(source, provider),
          on,
          { from: "chat" }
        );
      }
    }
    if (audience !== undefined) {
      // Whom it reaches, and nothing else: whether it answers at all stays
      // as it is, which the card never showed.
      const { on } = await readAgentSettings(this.#env, agent.id);
      await setAgentReach(this.#env, person, agent.id, on, audience, {
        from: "chat",
      });
    }
    await this.#setDrafted(person, agent.id, {
      classes: turnOn,
      ...(schedule === undefined ? {} : { schedule }),
    });
  }

  /**
   * Refuses what a card said that the agent's page would refuse: an app
   * the company doesn't offer, and for a company agent teams it doesn't
   * have or a schedule no wake-up takes.
   */
  async #checkDrafted({
    apps = [],
    audience,
    schedule,
  }: Pick<AgentDraft, "apps" | "audience" | "schedule">): Promise<void> {
    if (apps.length > 0) {
      const offered = await offeredApps(this.#env);
      if (
        apps.some(
          ({ source, provider }) => !offered.has(agentAppOf(source, provider))
        )
      ) {
        throw agentErrors.create("agent.app_unknown");
      }
    }
    if (audience?.who === "teams") {
      await requireKnownTeams(this.#env, JSON.stringify(audience.teams));
    }
    if (schedule !== undefined) {
      await wakeScheduleOf(this.#env, schedule);
    }
  }

  /** What a card said beyond the agent itself, set as on its page. */
  async #setDrafted(
    person: Identity,
    agentId: string,
    {
      apps = [],
      audience,
      classes = [],
      schedule,
    }: Pick<AgentDraft, "apps" | "audience" | "classes" | "schedule">
  ): Promise<void> {
    // Exactly the apps the card showed, and no other.
    for (const { source, provider } of apps) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time, each audited
      await setAgentApp(
        this.#env,
        person,
        agentId,
        agentAppOf(source, provider),
        true,
        { from: "chat" }
      );
    }
    if (audience !== undefined) {
      await setAgentReach(this.#env, person, agentId, true, audience, {
        from: "chat",
      });
    }
    for (const toolClass of classes) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time, each audited
      await setAgentToolClass(
        this.#env,
        person,
        agentId,
        toolClass,
        {
          who: "asClass",
        },
        { from: "chat" }
      );
    }
    if (schedule !== undefined) {
      await makeAgentWake(
        this.#env,
        person,
        agentId,
        {
          ...schedule,
          personId: person.userId,
        },
        new Date(),
        { from: "chat" }
      );
    }
  }

  /**
   * Refuses `plan` while a connection a part of it needs isn't one of the
   * person's to use: active, and shared or their own, as connect lists
   * them.
   */
  async #requireNeeds(person: Identity, plan: ChatPlan): Promise<void> {
    const listed = await this.#env.CONNECT.listConnections(
      await personOf(this.#env, person)
    );
    const usable = listed.filter(
      ({ scope, ownerUserId }) =>
        scope === "shared" || ownerUserId === person.userId
    );
    if (unmetNeeds(plan, usable).length > 0) {
      throw agentErrors.create("agent.plan_needs_connection");
    }
  }

  /**
   * What a question is about, as core finds it: an App or a workflow the
   * person builds, by its name; refused, as anywhere, for one they don't,
   * or an archived App, which nothing changes.
   */
  async #subjectOf(
    person: Identity,
    { kind, id }: Subject
  ): Promise<{ kind: SubjectKind; id: string; name: string }> {
    const found =
      kind === "app"
        ? await editableApp(this.#env, person, id)
        : await requireWorkflowRole(this.#env, person, id, "builder");
    return { kind, id: found.id, name: found.name };
  }

  async worked(chatId: string): Promise<ChatWork[]> {
    return await withPerson(
      this.#check,
      async ({ userId }) =>
        await chatWork(this.#env, await this.#ownChat(userId, chatId))
    );
  }

  /** The person's own chat `chatId`, or refused as if there were none. */
  /** `userId`'s own chat `chatId`, by its ref: refused as none otherwise. */
  async #ownChat(userId: string, chatId: unknown): Promise<ChatRef> {
    return {
      workspaceId: personalWorkspaceId(userId),
      chatId: await this.#chatsOf(userId).requireChat(
        await this.#idOf(chatId),
        userId
      ),
    };
  }

  /**
   * The npm packages the chat's agent asked for that wait for a decision,
   * each on a card the person decides with `dependencies.decide`.
   */
  async packageRequests(chatId: string): Promise<DependencyRequest[]> {
    return await withPerson(
      this.#check,
      async (person) =>
        await chatPackageRequests(
          this.#env,
          await this.#ownChat(person.userId, chatId)
        )
    );
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

  // Grasp's own chats' held App calls alone: a chat app's are shown and
  // decided on its card there (channels/held.ts), and its conversation is
  // no chat here (GRA-1919).
  async heldCalls(chatId: string, after?: string): Promise<HeldAppCall[]> {
    return await withPerson(this.#check, async (person) => {
      await this.#started(chatId);
      return await heldAppCallsOf(this.#env, person, chatId, "web", after);
    });
  }

  async confirmHeldCall(
    chatId: string,
    id: string,
    requestHash: string
  ): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await this.#started(chatId);
      await confirmHeldAppCall(
        this.#env,
        person,
        { chatId, via: "web" },
        id,
        requestHash
      );
    });
  }

  async declineHeldCall(chatId: string, id: string): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await this.#started(chatId);
      await declineHeldAppCall(this.#env, person, { chatId, via: "web" }, id);
    });
  }

  async sendNow(chatId: string): Promise<void> {
    await withPerson(this.#check, async ({ userId }) => {
      await this.#chatsOf(userId).sendNow(await this.#idOf(chatId), userId);
    });
  }

  async cancel(chatId: string): Promise<ChatStopped | false> {
    return await withPerson(
      this.#check,
      async ({ userId }) =>
        await this.#chatsOf(userId).cancel(await this.#idOf(chatId), userId)
    );
  }

  async watch(
    chatId: string,
    after: number | null,
    onUpdate: (update: ChatUpdate) => void
  ): Promise<Subscription> {
    return await withPerson(this.#check, async ({ userId }) => {
      const id = await this.#idOf(chatId);
      // Where the page got to: watched again from there.
      let from = after;
      return await this.#follow(
        onUpdate,
        {
          start: async (listener) =>
            await this.#chatsOf(userId).watch(id, userId, from, listener),
          stop: async (watchId) => {
            await this.#chatsOf(userId).unwatch(id, watchId);
          },
          pushed: (update) => {
            from = lastMessageOf(update) ?? from;
          },
        },
        { chatId: id }
      );
    });
  }

  /**
   * A page of the person's own chat before message `before`
   * (`Workspace.history`), as its watch shows them: only theirs, in their
   * own object, as every read of a chat.
   */
  async history(chatId: string, before: number): Promise<ChatHistoryPage> {
    return await withPerson(
      this.#check,
      async ({ userId }) =>
        await this.#chatsOf(userId).history(
          await this.#idOf(chatId),
          userId,
          before
        )
    );
  }

  /**
   * Follows the person's list of chats for the page: the whole list, then
   * what changes in it, over a socket to their object that hibernates
   * with it (person-connections.ts, upstream.ts). Each push is checked
   * against the connection's session before it reaches the page; one of
   * the connection's few watches.
   */
  async watchList(
    onUpdate: (update: ChatListUpdate) => void
  ): Promise<Subscription> {
    return await withPerson(this.#check, async ({ userId }) => {
      if (!isStub(onUpdate)) {
        throw agentErrors.create("agent.invalid_request");
      }
      if (this.#watches.size >= maxWatches) {
        throw agentErrors.create("agent.too_many_watches");
      }
      let following: Disposable | undefined;
      const page = callbackFor(onUpdate, this.#stillOpen, refusals, () => {
        this.#watches.delete(page);
        following?.[Symbol.dispose]();
      });
      this.#watches.add(page);
      /** Why core let go of it by itself, once it did. */
      const ended: { by: "displaced" | null } = { by: null };
      try {
        // Only the signed-in person's own object, and only their list in it.
        following = await followObject({
          open: async () =>
            await this.#chatsOf(userId).fetch("https://person/list", {
              headers: { Upgrade: "websocket" },
            }),
          parse: (frame) => listUpdateSchema.parse(frame),
          deliver: page,
          maxQueued: maxQueuedList,
          ended: (code) => {
            // The page's callback ends with it, which the page hears, and
            // follows again (follow-chat.ts `follow`): only on its next
            // look when it was displaced.
            ended.by = code === watchEnds.displaced ? "displaced" : null;
            page[Symbol.dispose]();
          },
          logged: { purpose: "chat list" },
        });
      } catch (error) {
        log.warn("chat.list_socket_unopened", errorFields(error));
        page[Symbol.dispose]();
        // The person's object still runs the code of the release before,
        // which takes no socket: followed the old way, until the release
        // after removes it.
        return await this.#follow(
          onUpdate,
          {
            start: async (listener) =>
              await this.#chatsOf(userId).watchChats(userId, listener),
            stop: async (watchId) => {
              await this.#chatsOf(userId).unwatchChats(watchId);
            },
          },
          {}
        );
      }
      // Let go of while it opened: its socket goes with it.
      if (!this.#watches.has(page)) {
        following[Symbol.dispose]();
      }
      return new Subscription(
        async () => {
          page[Symbol.dispose]();
          await Promise.resolve();
        },
        () => ended.by
      );
    });
  }

  /**
   * Has the person's object push to the page's `onUpdate` what `start`
   * follows, until the page releases it: one of this connection's few
   * watches (`maxWatches`), each push checked against the session first.
   * A watch the object lets go of without the page asking (the object
   * reset, as each deploy resets it, or dropped it after a push failed)
   * is taken up again at once, from where the page got to (`pushed`):
   * the runtime tells the listener so (its `Symbol.dispose`) once the
   * object holds it no more. The page never stops hearing for it.
   */
  async #follow(
    onUpdate: unknown,
    {
      start,
      stop,
      pushed,
    }: {
      start: (
        listener: Disposable & ((value: unknown) => Promise<void>)
      ) => Promise<string>;
      stop: (watchId: string) => Promise<void>;
      /** Told of each update the page took. */
      pushed?: (value: unknown) => void;
    },
    logged: Record<string, string>
  ): Promise<Subscription> {
    if (!isStub(onUpdate)) {
      throw agentErrors.create("agent.invalid_request");
    }
    if (this.#watches.size >= maxWatches) {
      throw agentErrors.create("agent.too_many_watches");
    }
    const page = callbackFor(onUpdate, this.#stillOpen, refusals, () => {
      this.#watches.delete(page);
    });
    this.#watches.add(page);
    let released = false;
    let watchId = "";
    let rewatching = false;
    /** Whether the page still follows it: not released, and still heard. */
    const following = (): boolean => !released && this.#watches.has(page);
    // Takes the watch up again: set below, once the listener it hands
    // the object is there.
    const lost = {
      rewatch: async (): Promise<void> => {
        // Nothing to take up before the first watch is made.
      },
    };
    const listener = Object.assign(
      async (value: unknown): Promise<void> => {
        await page(value);
        pushed?.(value);
      },
      {
        // The object holds it no more: let go of by the page, or else
        // reset or dropped, and then taken up again.
        [Symbol.dispose]: () => {
          if (following()) {
            void lost.rewatch();
          }
        },
      }
    );
    lost.rewatch = async (): Promise<void> => {
      if (rewatching) {
        return;
      }
      rewatching = true;
      try {
        for (let attempt = 0; following(); attempt += 1) {
          // oxlint-disable-next-line no-await-in-loop -- one try at a time, waiting longer each
          await scheduler.wait(
            rewatchMs[Math.min(attempt, rewatchMs.length - 1)] ?? 0
          );
          if (!following()) {
            return;
          }
          try {
            // Signed out since: let go of, never taken up again. A
            // session that couldn't be read is read again next time.
            // oxlint-disable-next-line no-await-in-loop -- see above
            if (!(await this.#stillOpen())) {
              page[Symbol.dispose]();
              return;
            }
            // oxlint-disable-next-line no-await-in-loop -- see above
            watchId = await start(listener);
            return;
          } catch (error) {
            // Deleted (or never theirs): nothing more to follow. Let go of,
            // quietly: the page hears its callback let go of, and the chat
            // is gone from its list.
            if (agentErrors.codeOf(error) === "agent.chat_not_found") {
              page[Symbol.dispose]();
              return;
            }
            log.warn("chat.rewatch_failed", {
              ...logged,
              ...errorFields(error),
            });
          }
        }
      } finally {
        rewatching = false;
      }
    };
    try {
      watchId = await start(listener);
    } catch (error) {
      released = true;
      page[Symbol.dispose]();
      throw error;
    }
    return new Subscription(async () => {
      released = true;
      // The slot is free at once, and the listener forwards nothing
      // more; the object drops it now, or at its next update if it
      // can't be reached.
      page[Symbol.dispose]();
      try {
        await stop(watchId);
      } catch (error) {
        log.warn("chat.unwatch_failed", { ...logged, ...errorFields(error) });
      }
    });
  }
}
