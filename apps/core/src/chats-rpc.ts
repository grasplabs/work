import { agentErrors } from "@grasp-os/shared/agent";
import { actorOf } from "@grasp-os/shared/audit";
import {
  chatMakeSchema,
  chatMentionsSchema,
  chatTitleSchema,
  unmetNeeds,
} from "@grasp-os/shared/chat";
import type {
  ChatBuild,
  ChatBuilt,
  ChatMake,
  ChatPlan,
  ChatConnectionRequest,
  ChatCitedDocument,
  ChatFile,
  ChatFileInput,
  ChatQuestion,
  ChatSearchHit,
  ChatsApi,
  ChatAgent,
  ChatSummary,
  ChatUpdate,
  ChatWork,
  MentionablePerson,
} from "@grasp-os/shared/chat";
import type { DependencyRequest } from "@grasp-os/shared/dependencies";
import { chatIdSchema } from "@grasp-os/shared/ids";
import type { ChatId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import type { ModelEfforts } from "@grasp-os/shared/models";
import { requireBuilder } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { subjectSchema } from "@grasp-os/shared/subject";
import type { Subject, SubjectKind } from "@grasp-os/shared/subject";
import { z } from "zod";

import { turnAgent } from "./agents.ts";
import { createFromBlueprint } from "./app-blueprints.ts";
import { appKind, createApp, editableApp } from "./apps.ts";
import { chatAgentOf, chatAgentsFor } from "./chat-agents.ts";
import { chatRequests, decideInChat } from "./chat-connections.ts";
import { readChatFile } from "./chat-files.ts";
import { mentionablePeople, mentionsOf } from "./chat-mentions.ts";
import { personOf } from "./connections.ts";
import { chatWork, chatsWorkedOn, keepMadeInChat } from "./drafts.ts";
import { workspace } from "./durable-objects.ts";
import { modelSettings, modelEffortsOf } from "./models.ts";
import { chatPackageRequests } from "./packages/requests.ts";
import { callbackFor, isStub } from "./page-callbacks.ts";
import type { StillOpen } from "./page-callbacks.ts";
import { personalWorkspaceId } from "./personal-workspace.ts";
import { requireProjectRole } from "./project-access.ts";
import { makeInProject } from "./projects.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";
import { requireNotStaff } from "./sharing.ts";
import { Subscription } from "./subscription.ts";
import {
  workflowKind,
  createWorkflowResource,
  requireWorkflowRole,
} from "./workflow-resources.ts";
import { makeOf, questionSchema, stopReason } from "./workspace.ts";
import type { Chat } from "./workspace.ts";

/**
 * A question as the page sends it: what it is about, and what it
 * mentions, named by ID alone. What Build it made is core's to say
 * (`build`), never the page's.
 */
const askedSchema = questionSchema.omit({ built: true }).extend({
  subject: subjectSchema.optional(),
  mentions: chatMentionsSchema.optional(),
});

/** Build it as the page sends it (`ChatBuild`). */
const buildSchema = questionSchema
  .pick({ text: true, model: true, effort: true })
  .extend({ plan: z.string().min(1).max(256) });

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

/** What Build it's question is about: the App it made, or else its workflow. */
const subjectOfBuilt = ({ app, workflow }: ChatBuilt) => {
  if (app !== undefined) {
    return { subject: { kind: "app" as const, ...app } };
  }
  return workflow === undefined
    ? {}
    : { subject: { kind: "workflow" as const, ...workflow } };
};

/** A chat just made, as its person's list shows it: nothing running in it yet. */
const summaryOfMade = (chat: Chat): ChatSummary => ({
  id: chat.id,
  title: chat.title,
  agentId: chat.agentId,
  createdAt: chat.createdAt.toISOString(),
  lastAt: chat.lastAt.toISOString(),
  running: false,
  via: chat.via,
  make: makeOf(chat),
});

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
   * Whether this connection may still follow chats, before each push: its
   * session holds, as the connection's own check last read it, the same
   * reading its calls share (at most `sessionRecheckMs` old,
   * session-check.ts).
   */
  readonly #stillOpen: StillOpen;
  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
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

  async agents(): Promise<ChatAgent[]> {
    return await withPerson(
      this.#check,
      async ({ userId }) => await chatAgentsFor(this.#env, userId)
    );
  }

  /**
   * A new chat, with the agent `agentId` (`chatAgentOf`), or the company's
   * first; from "Make something" (`make`), keeping what it came to make,
   * for a builder, and the project, for a builder of it, checked now:
   * Build it makes things there.
   */
  async create(
    title: string,
    agentId?: string,
    make?: ChatMake
  ): Promise<ChatSummary> {
    return await withPerson(this.#check, async (person) => {
      const { userId } = person;
      const parsed = chatTitleSchema.safeParse(title);
      const making =
        make === undefined ? undefined : chatMakeSchema.safeParse(make);
      if (!parsed.success || making?.success === false) {
        throw agentErrors.create(
          parsed.success ? "agent.invalid_request" : "agent.invalid_title"
        );
      }
      if (making !== undefined) {
        requireBuilder(person);
        if (making.data.project !== undefined) {
          requireNotStaff(person);
          await requireProjectRole(
            this.#env,
            person,
            making.data.project,
            "builder"
          );
        }
      }
      // Only an agent the person may talk to, refused before a chat is made.
      const agent = await chatAgentOf(this.#env, userId, agentId);
      const chat = await this.#chatsOf(userId).createChat(
        parsed.data,
        userId,
        agent,
        actorOf(person),
        "web",
        undefined,
        making?.data
      );
      return summaryOfMade(chat);
    });
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
        await chatsWorkedOn(this.#env, { kind, id }, person.userId)
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
    await withPerson(this.#check, async (person) => {
      const id = chatIdOf(chatId);
      // Its strings and effort only: whatever else the page passed goes no
      // further.
      const parsed = askedSchema.safeParse(question);
      if (!parsed.success) {
        throw agentErrors.create("agent.invalid_question");
      }
      const { subject: named, mentions: picked, ...asked } = parsed.data;
      const [subject, mentions] = await Promise.all([
        named === undefined ? undefined : this.#subjectOf(person, named),
        picked === undefined || picked.length === 0
          ? undefined
          : mentionsOf(this.#env, person, picked),
      ]);
      await this.#chatsOf(person.userId).send(id, person.userId, {
        ...asked,
        ...(subject === undefined ? {} : { subject }),
        ...(mentions === undefined ? {} : { mentions }),
      });
    });
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
      const id = chatIdOf(chatId);
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
                chatId: id,
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
              const workflow = await createWorkflowResource(
                this.#env,
                person,
                workflowNameOf(workflowPart.name)
              );
              made.workflow = { id: workflow.id, name: workflowPart.name };
              await keptInChat(
                this.#env,
                workflowKind,
                workflow.id,
                person.userId,
                { chatId: id, turnId: null, callId }
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

  async cited(chatId: string, messageId: number): Promise<ChatCitedDocument[]> {
    return await withPerson(
      this.#check,
      async ({ userId }) =>
        await this.#chatsOf(userId).cited(chatIdOf(chatId), userId, messageId)
    );
  }

  /** The person's own chat `chatId`, or refused as if there were none. */
  async #ownChat(userId: string, chatId: unknown): Promise<ChatId> {
    return await this.#chatsOf(userId).requireChat(chatIdOf(chatId), userId);
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
          person.userId,
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
