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
  ChatFile,
  ChatFileInput,
  ChatQuestion,
  ChatSearchHit,
  ChatsApi,
  ChatAgent,
  ChatSummary,
  ChatUpdate,
  ChatWork,
  HeldAppCall,
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
import { firstAgentId, turnAgent } from "./agents.ts";
import { createFromBlueprint } from "./app-blueprints.ts";
import { appKind, createApp, editableApp } from "./apps.ts";
import { chatAgentOf, chatAgentsFor } from "./chat-agents.ts";
import { chatRequests, decideInChat } from "./chat-connections.ts";
import { readChatFile } from "./chat-files.ts";
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
import { requireCompanyAdmin, requireKnownTeams } from "./stephen-reach.ts";
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
      const id = chatIdOf(chatId);
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
      try {
        await this.#setDrafted(person, agent.id, draft);
      } catch (error) {
        log.warn("agent.drafted_unfinished", errorFields(error));
        // Never left answering with less narrowed than its card: with no
        // app saved it would use any app. Paused, it answers nothing until
        // its page is finished.
        await this.#pauseQuietly(person, agent.id);
        return { id: agent.id, name: agent.name, unfinished: true };
      }
      try {
        await chats.send(id, person.userId, asked);
      } catch (error) {
        log.warn("agent.drafted_unanswered", errorFields(error));
      }
      return { id: agent.id, name: agent.name };
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
      const id = chatIdOf(chatId);
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
      try {
        await this.#setChanged(person, agent, change, callId);
      } catch (error) {
        log.warn("agent.change_unfinished", errorFields(error));
        // An app the card took off may still be on: paused, it answers
        // nothing until its page is finished.
        await this.#pauseQuietly(person, agent.id);
        return { id: agent.id, name: agent.name, unfinished: true };
      }
      try {
        await chats.send(id, person.userId, asked);
      } catch (error) {
        log.warn("agent.change_unanswered", errorFields(error));
      }
      return { id: agent.id, name: agent.name };
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
      await changeAgent(this.#env, person, agent.id, {
        name: agent.name,
        face: agent.face,
        job,
        modelRole: agent.modelRole,
        model: agent.model,
      });
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
          on
        );
      }
    }
    if (audience !== undefined) {
      // Whom it reaches, and nothing else: whether it answers at all stays
      // as it is, which the card never showed.
      const { on } = await readAgentSettings(this.#env, agent.id);
      await setAgentReach(this.#env, person, agent.id, on, audience);
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
        true
      );
    }
    if (audience !== undefined) {
      await setAgentReach(this.#env, person, agentId, true, audience);
    }
    for (const toolClass of classes) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time, each audited
      await setAgentToolClass(this.#env, person, agentId, toolClass, {
        who: "asClass",
      });
    }
    if (schedule !== undefined) {
      await makeAgentWake(this.#env, person, agentId, {
        ...schedule,
        personId: person.userId,
      });
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

  // Grasp's own chats' held App calls alone: a chat app's are shown and
  // decided on its card there (channels/held.ts), and its conversation is
  // no chat here (GRA-1919).
  async heldCalls(chatId: string, after?: string): Promise<HeldAppCall[]> {
    return await withPerson(
      this.#check,
      async (person) =>
        await heldAppCallsOf(this.#env, person, chatId, "web", after)
    );
  }

  async confirmHeldCall(
    chatId: string,
    id: string,
    requestHash: string
  ): Promise<void> {
    await withPerson(this.#check, async (person) => {
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
      await declineHeldAppCall(this.#env, person, { chatId, via: "web" }, id);
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
