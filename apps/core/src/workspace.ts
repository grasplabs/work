import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { agentErrors } from "@grasp-os/shared/agent";
import {
  agentChangeDraftSchema,
  agentDraftSchema,
} from "@grasp-os/shared/agents";
import type { AgentChangeDraft, AgentDraft } from "@grasp-os/shared/agents";
import {
  actorOf,
  auditEventSchema,
  auditProvenanceMaxItems,
  createAuditEvent,
  delegateActorOf,
} from "@grasp-os/shared/audit";
import type {
  AuditActor,
  AuditDetailValue,
  AuditEntry,
} from "@grasp-os/shared/audit";
import type { ChatSavedMemory } from "@grasp-os/shared/brain-memories";
import {
  chatChannelSchema,
  chatFilesMax,
  chatFilesPerQuestionMax,
  chatHistoryPage,
  chatPlatformName,
  isChatPictureType,
  chatMentionsMax,
  chatPlanSchema,
  chatPlatformSchema,
  chatToolEventsKept,
  heldAppCallsPage,
  seedTitleOf,
} from "@grasp-os/shared/chat";
import type {
  ChatChannel,
  ChatFile,
  ChatFileType,
  ChatHistoryPage,
  ChatMade,
  ChatMake,
  ChatPictureType,
  ChatMessage,
  ChatOutput,
  ChatPlan,
  ChatProvenance,
  ChatQueued,
  ChatRating,
  ChatStopped,
  ChatSearchHit,
  ChatSearchSnippet,
  ChatSummary,
  ChatToolEvent,
} from "@grasp-os/shared/chat";
import { foldOf, hasEvery, searchWordsOf } from "@grasp-os/shared/chat-search";
import type { ConnectionPerson } from "@grasp-os/shared/connect";
import { sha256Hex } from "@grasp-os/shared/encoding";
import {
  internalErrors,
  isExpectedError,
  withReference,
} from "@grasp-os/shared/errors";
import {
  chatIdSchema,
  chatRefSchema,
  identifierSchema,
  workspaceIdSchema,
} from "@grasp-os/shared/ids";
import type { ChatId, ChatRef } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import { modelEfforts, modelErrors } from "@grasp-os/shared/models";
import type { ModelWait } from "@grasp-os/shared/models";
import {
  bindingNameSchema,
  permissionActionSchema,
  permissionErrors,
} from "@grasp-os/shared/permissions";
import type { Authority } from "@grasp-os/shared/permissions";
import { redact } from "@grasp-os/shared/redact";
import type { Role } from "@grasp-os/shared/roles";
import { canBuild, roleSchema } from "@grasp-os/shared/roles";
import { subjectSchema } from "@grasp-os/shared/subject";
import type { Subject } from "@grasp-os/shared/subject";
import { DurableObject } from "cloudflare:workers";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  lt,
  lte,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { z } from "zod";

import { documentsOf } from "./agent-documents.ts";
import { isMessage } from "./agent-messages.ts";
import { requireAgentReaches } from "./agent-reach.ts";
import {
  auditAgentCall,
  chatAuthority,
  chatContext,
  revokedSince,
  workspaceAgentIdSchema,
} from "./agent-scope.ts";
import type {
  AgentScope,
  CodeRunAdmission,
  CodeRunCall,
} from "./agent-scope.ts";
import { heldIn } from "./agent-skills.ts";
import { builtNoteText, resultRunId, withheldResult } from "./agent.ts";
import type {
  CodeRunEnd,
  QuestionBuilt,
  TurnContext,
  TurnResult,
} from "./agent.ts";
import { turnAgent } from "./agents.ts";
import { drainObjectOutbox, uuidFromHash } from "./audit-outbox.ts";
import { accountNameOf, memberRole } from "./auth/identity.ts";
import { loneNotesPerDrain } from "./brain-hand-overs.ts";
import { chatTurnSource, eraseChat } from "./brain-next-origins.ts";
import { skillsFor, skillsReachOf } from "./brain-skills.ts";
import {
  channelText,
  heldWriteRefusal,
  turnCheckOf,
} from "./channels/stephen-rules.ts";
import type { HeldWriteRefusal, TurnCheck } from "./channels/stephen-rules.ts";
import { questionText } from "./chat-agent.ts";
import {
  audienceMaxMembers,
  audienceOf,
  keepAudience,
} from "./chat-audiences.ts";
import { revokeChatPermissions } from "./chat-connections.ts";
import type {
  ExportedFile,
  ExportedHeldCall,
  ExportedMessage,
  ExportedPage,
  ExportedTurnState,
} from "./chat-export.ts";
import type {
  QueuedQuestion,
  TurnCapture,
  TurnEnd,
  TurnMessage,
  TurnRequest,
  TurnStop,
} from "./chat-harness.ts";
import { ChatListWatch } from "./chat-list-watch.ts";
import type { ChatList, ChatListListener } from "./chat-list-watch.ts";
import {
  chatMessageOf,
  partialOf,
  savedOf,
  shownBuiltSchema,
} from "./chat-messages.ts";
import type { ShownBuilt } from "./chat-messages.ts";
import {
  saidOf,
  searchTermsOf,
  snippetOf,
  snippetReach,
} from "./chat-search.ts";
import { generatedTitle } from "./chat-titles.ts";
import { toolCallSchema, toolEventOf } from "./chat-tool-events.ts";
import type { ToolCall } from "./chat-tool-events.ts";
import { ChatWatch } from "./chat-watch.ts";
import type { ChatListener, ChatState } from "./chat-watch.ts";
import {
  codeLimits,
  codeRuntime,
  cutMarker,
  cutToBytes,
  utf8Bytes,
} from "./code-mode.ts";
import type { CodeRunStatus } from "./code-run-statuses.ts";
import { inList } from "./db/d1.ts";
import { migrateOnWake } from "./db/migrate.ts";
import migrations from "./db/workspace/migrations/migrations.js";
import {
  auditOutbox,
  brainCaptureIntents,
  chatBuildJobs,
  chatCodeRuns,
  chatDeletes,
  chatDraftContents,
  chatDraftFiles,
  chatDraftVersionFiles,
  chatDraftVersions,
  maxToolCallIdChars,
  chatDocuments,
  chatDrafts,
  chatFileParts,
  chatFiles,
  chatMessages,
  chatRequestKeys,
  chatRunSources,
  chatSearchText,
  chatSources,
  chatToolEvents,
  chats,
  deletedChats,
  heldAppCalls,
  memoryUses,
} from "./db/workspace/schema.ts";
import { chatWork } from "./drafts.ts";
import { callObject, chatSession } from "./durable-objects.ts";
import { dropHeldStarts, heldStartMs } from "./held-starts.ts";
import {
  brainMemoryOf,
  brainMemoryPrefix,
  brainMemorySchema,
  erasedSources,
  readableSources,
  withheldDetail,
} from "./history-access.ts";
import { allInOrder } from "./in-order.ts";
import { instructionFilesFor } from "./instruction-files.ts";
import type { InstructionContext } from "./instruction-files.ts";
import { chatTurnPurpose } from "./model-spend.ts";
import { modelSettings, models } from "./models.ts";
import type { OutsideTextNote } from "./outside-text.ts";
import { personalWorkspaceId } from "./personal-workspace.ts";
import type { WorkContext } from "./restricted.ts";
import { outsideReadOf } from "./ungranted-reads.ts";
import { retireUnseen } from "./unseen-memories.ts";

export type Chat = typeof chats.$inferSelect;

/**
 * A chat's turn while its Workspace waits on it: its ID (random, and only
 * this turn's, the request ID of its question in the chat's own object,
 * chat-session.ts), and what it gathers as the chat keeps its messages.
 * Only in memory: a turn the chat's object goes on with after this
 * object restarted keeps its messages all the same.
 */
interface LiveTurn {
  id: string;
  /** The agent it runs as: the one its answers are kept under. */
  agentId: string;
  /** Whether nobody asked for it there and then (`askUnattended`): it only reads. */
  unattended: boolean;
  /**
   * Gives the chat back the agent it had before this turn: set while the
   * turn may still be refused before it starts, and run as it ends then.
   */
  unstarted?: () => void;
  /** What the turn read through connections, for its check line. */
  reads: TurnCheck[];
  /**
   * The calls its code made, as the chat shows them: for a chat app's
   * request record (channels/stephen-requests.ts), which keeps the tools
   * and how each ended, never what they read. Only when its asker wants them.
   */
  calls?: ToolCall[];
  /**
   * The memories its agent saved for the person (agent-remember.ts), as
   * their notices show them: for a chat app's asker, who posts each with
   * its Undo (channels/remembered.ts). Only when its asker wants them.
   */
  remembered?: ChatSavedMemory[];
  /** Tells a chat platform's asker the answer's text so far. */
  onText?: (text: string) => unknown;
  /**
   * Whether it got under way (`started`), told once: true as it goes to
   * its ChatSession, false when it was refused before. What a question
   * queued into it (`send`) waits for first.
   */
  underWay: PromiseWithResolvers<boolean>;
  /** Settles once this object holds the turn no more (`#endLive`). */
  ended: PromiseWithResolvers<void>;
}

/**
 * A question for a chat's agent, the model to answer it with, and how hard
 * that model thinks first (`ChatQuestion`).
 */
/**
 * How often a chat platform is told an answer's text so far: Teams shows
 * an update about once a second, and each is a call back to the door.
 */
const textEveryMs = 300;

/**
 * How long a request's key is kept (`chatRequestKeys`): a page sends a
 * repeat within seconds, or when its connection is back.
 */
const requestKeyMs = 24 * 60 * 60 * 1000;

/**
 * The ID a page names a chat it starts by (`ChatStart`): a UUID as
 * browsers make one, lower case, of a version (1 to 8) and RFC 9562's
 * variant, so never the nil or the max UUID, nor two spellings of one.
 */
const newChatIdSchema = z
  .string()
  .regex(
    /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u
  )
  .pipe(chatIdSchema);

/**
 * `tell`, called with the latest text at most every {@link textEveryMs},
 * and once more at the end of a window that held more: text in between is
 * dropped, as the next call carries all of it.
 */
const throttled = (tell: (text: string) => unknown) => {
  let last = Number.NEGATIVE_INFINITY;
  let gone = false;
  let pending: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A caller that went away stops being told; the turn goes on.
  const send = async (text: string): Promise<void> => {
    last = Date.now();
    try {
      await tell(text);
    } catch {
      gone = true;
    }
  };
  return (text: string): void => {
    if (gone) {
      return;
    }
    const wait = last + textEveryMs - Date.now();
    if (wait <= 0) {
      void send(text);
      return;
    }
    pending = text;
    timer ??= setTimeout(() => {
      timer = undefined;
      if (pending !== undefined && !gone) {
        void send(pending);
        pending = undefined;
      }
    }, wait);
  };
};

/**
 * A chat others share on a chat platform, as its door names it: the Chat
 * SDK's thread, whether it is a group chat or a channel, and who is in it
 * now (`Audience` in chat-audiences.ts).
 */
const sharedChatSchema = z.strictObject({
  thread: z.string().min(1).max(2048),
  kind: z.enum(["group", "channel"]),
  audience: z.strictObject({
    members: z
      .array(z.string().min(1).max(256))
      .max(audienceMaxMembers + 1)
      .readonly(),
    outsiders: z.boolean(),
  }),
});
export type SharedChat = z.infer<typeof sharedChatSchema>;

/**
 * Where a question came in on a chat platform, as its door names it: a
 * direct message, which the platform's own data proves is the person and
 * the bot alone, or a chat others share. Always said, never assumed: a
 * question without one is refused.
 */
const chatPlaceSchema = z.union([
  z.strictObject({ kind: z.literal("direct") }),
  sharedChatSchema,
]);
export type ChatPlace = z.infer<typeof chatPlaceSchema>;

/**
 * The App chat `chat` worked on last, as its work names it (`chatWork` in
 * drafts.ts: the latest of the subjects its agent wrote or its Build it
 * made), for its instruction file; null when that is a workflow, or it
 * worked on nothing. Only in a chat of the person's own, in Grasp or
 * their direct message on a chat app: a shared thread is read by all in
 * it. Only its App's builders get its file, checked at each turn
 * (instruction-files.ts).
 */
const lastAppOf = async (
  env: Env,
  chat: ChatRef,
  thread: string | null
): Promise<string | null> => {
  if (thread !== null) {
    return null;
  }
  const [last] = await chatWork(env, chat);
  return last?.kind === "app" ? last.id : null;
};

/**
 * Where a chat's agent works, for its instruction files: never a person's
 * own file, nor an App's, where others read the answer (a chat others
 * share); in a chat of theirs, the App it worked on last (`lastAppOf`),
 * and their own file only in a turn
 * whose answer reaches them alone (`personal`, `answersAlone`): the one
 * gate their own recall and skills take too.
 */
const instructionContextOf = (
  shared: boolean,
  appId: string | null,
  personal: boolean
): InstructionContext => {
  if (shared) {
    return { conversation: "channel" };
  }
  return appId === null
    ? { conversation: "own", personal }
    : { conversation: "own", appId, personal };
};

/** The title of a chat others share on `platform`. */
const sharedTitle = (platform: string, kind: SharedChat["kind"]): string =>
  `${chatPlatformName(platform)} ${kind === "group" ? "group chat" : "channel"}`;

export const questionSchema = z.strictObject({
  text: z.string().trim().min(1).max(100_000),
  /** `<provider>/<model>`, one the deployment allows. */
  model: z.string().min(1),
  effort: z.enum(modelEfforts).optional(),
  /** The chat's files it carries (`attachFile`), each once. */
  files: z
    .array(z.uuid())
    .max(chatFilesPerQuestionMax)
    .refine((files) => new Set(files).size === files.length)
    .optional(),
  /** What it is about, as core found it (`ChatsApi.send`): never the page's word alone. */
  subject: subjectSchema.extend({ name: z.string().min(1) }).optional(),
  /**
   * What the person picked with `@` in it, as core found each for them
   * (`ChatsApi.send`), by name: never the page's word for a name.
   */
  mentions: z
    .array(
      z.discriminatedUnion("kind", [
        z.strictObject({
          kind: z.enum(["app", "workflow", "agent"]),
          id: z.string().min(1),
          name: z.string().min(1),
        }),
        z.strictObject({
          kind: z.literal("person"),
          id: z.string().min(1),
          name: z.string().min(1),
          role: roleSchema.optional(),
          teams: z.array(z.string()).optional(),
        }),
      ])
    )
    .max(chatMentionsMax)
    .optional(),
  /**
   * The person's question again, for the next agent they addressed in it:
   * kept for the model, never shown as a question of its own (`send`).
   */
  followUp: z.literal(true).optional(),
  /**
   * Build it, said to the chat's plan (by its call): what core made of it
   * (`ChatsApi.build`), never the page's word.
   */
  built: z
    .strictObject({
      plan: z.string(),
      app: z.strictObject({ id: z.string(), name: z.string() }).optional(),
      workflow: z.strictObject({ id: z.string(), name: z.string() }).optional(),
      project: z.string().optional(),
      agent: z.strictObject({ id: z.string(), name: z.string() }).optional(),
      agentAction: z.enum(["made", "changed"]).optional(),
      unfinished: z.literal(true).optional(),
    })
    .optional(),
});
export type Question = z.input<typeof questionSchema>;

/** What "Make something" started `chat` to make, as kept with it; null for any other chat. */
const makeOf = ({
  makeKind,
  makeProject,
}: Pick<Chat, "makeKind" | "makeProject">): ChatMake | null =>
  makeKind === null
    ? null
    : {
        kind: makeKind,
        ...(makeProject === null ? {} : { project: makeProject }),
      };

/** What a stored Build it built, as its message shows it; none for any other message. */
const builtOf = (stored: string | null): ShownBuilt | undefined => {
  if (stored === null) {
    return undefined;
  }
  const parsed = shownBuiltSchema.safeParse(JSON.parse(stored));
  return parsed.success ? parsed.data : undefined;
};

/**
 * What `#keep` keeps with a turn's message: the files and Build it of a
 * question, how long an answer thought, and the agent whose turn it is
 * from, for all but the person's own words.
 */
const keptWith = (
  message: Message,
  agentId: string,
  {
    files,
    thinkingMs,
    built,
  }: { files: readonly string[]; thinkingMs?: number; built?: ShownBuilt }
) => ({
  files,
  ...(thinkingMs === undefined ? {} : { thinkingMs }),
  ...(built === undefined ? {} : { built }),
  ...(message.role === "user" ? {} : { agentId }),
});

/**
 * What the next agent the person addressed in a question reads, after the
 * answers before it: core's words, with its name as the chat lists it.
 */
const followUpText = (name: string): string =>
  `The person addressed you too, ${JSON.stringify(name)}, in their question above. Answer it now as yourself, from what you know and may do. Don't repeat what another agent already said: add to it, or say where you differ.`;

/**
 * How a question sent while its chat's turn runs goes into that turn
 * (`ChatHarness.queueQuestion`): its own ID there, and the page's key for
 * it (`send`), which its entry keeps with it.
 */
interface QueuedAs {
  id: string;
  key: string | undefined;
}

/**
 * The turn's question (`TurnRequest`): as asked, with the files it carries,
 * what the chat was started to make (`make`), if anything, and the page's
 * key for it (`key`), which its entry keeps with it.
 */
const turnQuestion = (
  {
    text,
    model,
    effort,
    subject,
    mentions,
    built,
    followUp,
  }: z.output<typeof questionSchema>,
  files: { id: string; type: string }[],
  make: ChatMake | null,
  key: string | undefined
): TurnRequest["question"] => ({
  ...(followUp === undefined ? {} : { followUp }),
  ...(key === undefined ? {} : { key }),
  text,
  model,
  ...(effort === undefined ? {} : { effort }),
  files,
  ...(subject === undefined ? {} : { subject }),
  ...(mentions === undefined ? {} : { mentions }),
  ...(make === null ? {} : { make }),
  ...(built === undefined ? {} : { built }),
});

/**
 * What an answer may hold, as the person sees it labelled: everything the
 * chat has read from, and whether it read
 * restricted data, so the answer may carry sensitive content.
 */
export interface AnswerProvenance {
  sources: string[];
  restricted: boolean;
}

/** A turn's result, labelled with what it may hold. */
export type Answer = TurnResult & {
  provenance: AnswerProvenance;
  /**
   * In a chat that came through a chat platform: what the turn read, as a
   * held write's card says it on its check line (`turnCheckOf`), and the
   * mark of the text that told the model how to answer there
   * (`channelText`). Both `null` in Grasp's own app.
   */
  check: TurnCheck | null;
  channelText: string | null;
};

/**
 * A stored message, as pi shapes it. Stored by this object only, so the
 * shape is checked as far as telling the roles apart.
 */
const storedMessageSchema = z.custom<Message>(
  (value) => typeof value === "object" && value !== null && isMessage(value)
);

/**
 * A step's result as the chat shows it once what its run read was erased
 * (`#replaceErased`): the line the model gets in its place
 * (`withheldResult`), which names no cause, its call, run and how it
 * ended kept; any other message as it is.
 */
const withheldCopy = (message: Message): Message =>
  message.role === "toolResult"
    ? { ...message, content: [{ type: "text", text: withheldResult }] }
    : message;

/**
 * `shown` with the files its question carried, by its ID in `carried`;
 * as it is for any other message, or a question that carried none.
 */
const withFiles = (
  shown: ChatMessage | undefined,
  carried: ReadonlyMap<number, ChatFile[]> | undefined
): ChatMessage | undefined => {
  if (shown?.role !== "user") {
    return shown;
  }
  const files = carried?.get(shown.id);
  return files === undefined ? shown : { ...shown, files };
};

/**
 * A chat file's card columns: what its person and its agent see of it,
 * never its text, which only reading the file loads (`chatFile`).
 */
const chatFileCard = {
  id: chatFiles.id,
  name: chatFiles.name,
  type: chatFiles.type,
  bytes: chatFiles.bytes,
  createdAt: chatFiles.createdAt,
};

/** A chat file, as its person sees it, from its card's columns. */
const chatFileOf = ({
  id,
  name,
  type,
  bytes,
  createdAt,
}: Pick<
  typeof chatFiles.$inferSelect,
  "id" | "name" | "type" | "bytes" | "createdAt"
>): ChatFile => ({
  id,
  name,
  type,
  bytes,
  createdAt: createdAt.toISOString(),
});

/** The message a watcher saw last: none (`null`), or a stored one's ID. */
const afterSchema = z.int().nonnegative().nullable();

/** The message a page of history comes before (`history`). */
const beforeSchema = z.int().positive();

/**
 * Most characters a chat's transcript may hold: a chat past it takes no
 * more questions, so loading one never parses more than this and one turn.
 * The model reads as much of it, newest first, as its window takes
 * (`recentHistory` in agent.ts), which for every model is less than this.
 */
export const maxChatChars = 4_000_000;

/**
 * Most bytes of a picture one row keeps (`chat_file_parts`): SQLite here
 * keeps no value past 2 MB.
 */
export const chatFilePartBytes = 1024 * 1024;

/**
 * Most ended runs an object remembers, code runs and tool calls alike
 * (agent-tools.ts), to refuse and log a call from one: a few turns' worth.
 * A turn opens at most 430: 30 code runs, and 20 tool calls in each of
 * its 20 responses.
 */
export const endedRunsKept = 3000;

/**
 * Most code run records a chat keeps, newest first: a long chat's run
 * history, bounded (`chat_code_runs`).
 */
const codeRunRecordsKept = 1000;

/**
 * A code run as the object keeps its lease: open, with the API calls it
 * has made and when it opened (a revocation after that ends it), or
 * closed, by its end or a revocation, and whether a call after that was
 * logged yet.
 */
type CodeRunLease =
  | { calls: number; openedAt: number }
  | { closed: "ended" | "revoked"; reported: boolean };

/** What a code run's record keeps of its module, as it opens. */
export interface CodeRunOpening {
  toolCallId: string;
  sourceHash: string;
  sourceChars: number;
}

/**
 * The sources one API call of a code run read from, as it records them:
 * a connection, by its identifier.
 */
const sourcesSchema = z.array(identifierSchema).max(auditProvenanceMaxItems);

/** What a chat read, as `keepRead` keeps it (`trace:<chat>`). */
const traceSchema = z.array(z.string());

/**
 * Longest source a run's result rests on: a connection call's names its
 * connection, action and resource, each up to an identifier
 * (`connectionRead` in agent-scope.ts).
 */
const runReadMaxLength = 1024;

/** What one API call of a code run read, as the run keeps it. */
const runReadsSchema = z
  .array(z.string().min(1).max(runReadMaxLength))
  .max(auditProvenanceMaxItems);

/** A memory this person used, by its store and id, and when they last did. */
export interface MemoryUse {
  store: "own" | "shared";
  memory: string;
  at: number;
}

/**
 * The memory `source` pins as one a recall as the person handed over
 * (history-access.ts `brainMemoryOf`, under `brainMemoryPrefix`): what
 * counts as their use of it (`memory_uses`). A recall as the company pins
 * under another prefix, and counts as nobody's use.
 */
const memoryUseOf = (source: string) =>
  brainMemoryOf(source, brainMemoryPrefix);

/**
 * Most chats a person's list shows: their newest. Older ones are still
 * there, and open from a link.
 */
export const listedChats = 200;

/**
 * Most watchers one Workspace object keeps at once: a person's own object
 * holds their chats alone, so this bounds what their pages make it hold,
 * and nobody else's.
 */
const maxWatchers = 50;

/**
 * How long the object waits to deliver its audit events again while the
 * log is out of reach: at first, and at most, doubling in between.
 */
const auditRetryMs = { first: 5000, most: 15 * 60 * 1000 };

/**
 * The pauses before a chat's deletion is tried again (`#tryDelete`): the
 * first after `first`, doubling each time, never past `most`.
 */
const deleteRetryMs = { first: 5000, most: 15 * 60 * 1000 };

/** The pause before trying a deletion again after `attempts` failed. */
const deleteRetryAfter = (attempts: number): number =>
  Math.min(deleteRetryMs.first * 2 ** (attempts - 1), deleteRetryMs.most);

/**
 * Tries of a deletion that fail before each further failure is logged as
 * an error, not a warning: about an hour and a half of retries.
 */
const deleteAttemptsBeforeError = 10;

/** Deletions one alarm finishes at most: each takes a few subrequests. */
const deletesPerAlarm = 10;

/** Most chats a person keeps: delete one to make another. */
export const maxChatsPerPerson = 500;

/** Most chats one search finds: the most recently active first. */
export const searchHitsMax = 50;

/** What a turn its guard stopped ends with, as its person reads it. */
const turnStopError = (stop: TurnStop): Error => {
  switch (stop) {
    case "history_revoked": {
      return agentErrors.create("agent.history_revoked");
    }
    case "overdue": {
      return agentErrors.create("agent.turn_overdue");
    }
    case "lost": {
      return agentErrors.create("agent.turn_lost");
    }
    case "person_inactive": {
      return permissionErrors.create("permission.person_inactive");
    }
    case "unreadable": {
      return internalErrors.create("internal.unexpected");
    }
    default: {
      return internalErrors.create("internal.unexpected");
    }
  }
};

/**
 * Why a turn under way stopped short of an answer, as its person reads
 * it: an unplanned error is logged, and shown as one, with the log line's
 * request ID for them to quote.
 */
export const stopReason = (chatId: ChatId, error: unknown): string => {
  if (isExpectedError(error)) {
    return error.message;
  }
  const requestId = crypto.randomUUID();
  log.error("agent.turn_failed", { requestId, chatId, ...errorFields(error) });
  return withReference(
    internalErrors.create("internal.unexpected").message,
    requestId
  );
};

/**
 * What a chat that came through a chat platform read, as `trace:<chat>`:
 * each text value its connection reads returned, newest first, that its
 * writes are traced to before they are held (channels/stephen-rules.ts).
 * Kept across turns, up to {@link traceCharsMax}, oldest dropped first;
 * dropped whole once a source the chat read is erased (`#dropErasedCopies`).
 */
const traceKeyPrefix = "trace:";

/**
 * The sources a chat read found erased, as `erased:<chat>`, once what else
 * the chat keeps that may quote them is dropped (`#dropErasedCopies`):
 * dropped once for each, never again for a source already counted.
 */
const erasedKeyPrefix = "erased:";

const erasedKeptSchema = z.array(z.string());

/**
 * That its person's erasure began (`erasePerson`), as `erasing`: kept in
 * storage, so a restart before the wipe keeps it, and gone with the wipe,
 * which empties the storage.
 */
const erasingKey = "erasing";

/**
 * The plans of a chat Build it made, as `built:<chat>`: the calls that
 * proposed them (`takePlan`), so each is made once.
 */
const builtKeyPrefix = "built:";

/**
 * The person a turn talks with, by their account's name, when it has one:
 * only where the answer reaches them alone (`personal`).
 */
const namedPerson = async (
  env: Env,
  personId: string,
  personal: boolean
): Promise<Pick<TurnContext, "person">> => {
  if (!personal) {
    return {};
  }
  const name = await accountNameOf(env.DB, personId);
  return name === undefined ? {} : { person: { name } };
};

/** Whether a turn builds (`TurnContext.builds`): its person's own chat, with a role that builds. */
const buildsIn = ({
  shared,
  role,
}: {
  shared: boolean;
  role: Role | undefined;
}): boolean => !shared && role !== undefined && canBuild(role);

/**
 * Which agents a turn may draft for its person (`TurnContext.drafts`):
 * only one they asked for, in their own chat in Grasp; one of the
 * company's for its admins, else one of their own.
 */
const draftsOf = ({
  shared,
  unattended,
  via,
  role,
}: {
  shared: boolean;
  unattended: boolean;
  via: ChatChannel;
  role: Role | undefined;
}): TurnContext["drafts"] => {
  if (shared || unattended || via !== "web" || role === undefined) {
    return undefined;
  }
  return role === "admin" ? "company" : "own";
};

/** Where a chat keeps the changes to agents Change it took, by call. */
const changedKeyPrefix = "changed:";

/** How each call a person's press takes is read again. */
const takenSchemas = {
  proposePlan: chatPlanSchema,
  draftAgent: agentDraftSchema,
  draftAgentChange: agentChangeDraftSchema,
};

/** Where a chat keeps the agents it drafted that Make it took, by call. */
const draftedKeyPrefix = "drafted:";

/**
 * Where a chat keeps, by call, the agent Make it made of a draft whose
 * instructions it couldn't save: its next Make it saves them to that
 * agent, never making a second (chats-rpc.ts).
 */
const draftMadeKeyPrefix = "draft-made:";

const draftMadeSchema = z.record(z.string(), z.string());

const builtSchema = z.array(z.string());

/**
 * A chat whose turn runs, as `running:<chat>`: a copy of what its
 * `ChatSession` holds (`turnRunning`), for the chat's lists and watchers,
 * kept through a restart of this object. Never what decides a turn: that
 * object does.
 */
const runningKeyPrefix = "running:";

/**
 * The questions queued into a chat's turn that it hasn't taken yet, as
 * `queued:<chat>`: a copy of what its `ChatSession` holds in pi
 * (`turnQueued`), for its watchers, kept through a restart of this object.
 */
const queuedKeyPrefix = "queued:";

const chatQueuedSchema = z.array(
  z.object({ id: z.string(), text: z.string() })
);

/**
 * What of a chat's `ChatSession` its messages were kept of, as
 * `copied:<chat>`: the last entry, and the last answer kept with it. That
 * object copies at least once, so a copy it sends again after a restart
 * is passed over, and answered as the first was (`keepTurnMessages`).
 */
const copiedKeyPrefix = "copied:";

/** Most messages one page of `exportMessages` hands over. */
const exportPageMax = 200;

/**
 * Most bytes of messages one page of `exportMessages` hands over, past
 * its first: far under the 32 MiB an object's RPC carries. One message is
 * one row, at most the few MB the object's SQLite keeps in a row, so a
 * page of one always fits.
 */
const exportPageBytes = 4 * 1024 * 1024;

/** Where an export's page goes on after (a message's ID, 0 from the start), and how many it holds. */
const exportAfterSchema = z.int().nonnegative();
const exportLimitSchema = z.int().min(1).max(exportPageMax);

/** One of a picture's parts an export hands over (`exportFilePart`). */
const exportPartSchema = z.int().nonnegative();

/** A time as an export hands it over: milliseconds. */
const msOf = (date: Date): number => date.getTime();

const copiedSchema = z.object({
  through: z.number(),
  answer: z.number().optional(),
});

/** Most characters of what a chat read that its writes are traced to. */
const traceCharsMax = 200_000;

/** How a write a chat's agent had held for its person ended. */
export type HeldOutcome =
  | "confirmed"
  | "declined"
  | "expired"
  | "unknown"
  | "failed";

/** Most characters of a function's path a held App call keeps. */
const maxHeldFunctionChars = 256;

/** What holding a write to an App keeps (held-app-calls.ts). */
export interface HeldAppCallInput {
  agentId: string;
  appId: string;
  function: string;
  kind: string;
  request: string;
  requestHash: string;
}

/** A held App call, as its Workspace keeps it, with when it lapses. */
export interface HeldAppCallRow extends HeldAppCallInput {
  id: string;
  chatId: string;
  personId: string;
  heldAt: number;
  expiresAt: number;
}

/** `row` as its callers read it: its request as it was held. */
const heldAppCallRowOf = (
  row: typeof heldAppCalls.$inferSelect
): HeldAppCallRow => ({
  id: row.id,
  chatId: row.chatId,
  personId: row.personId,
  agentId: row.agentId,
  appId: row.appId,
  function: row.function,
  kind: row.kind,
  // Kept while it waits; decided in the write that empties it, and handed
  // back from the read before it.
  request: row.request ?? "",
  requestHash: row.requestHash,
  heldAt: row.heldAt.getTime(),
  expiresAt: row.heldAt.getTime() + heldStartMs,
});

/** A held write, as its chat's agent knows it: the ID its call answered with. */
const heldSchema = z.strictObject({
  id: z.uuid(),
  action: permissionActionSchema,
});

/**
 * What the agent is told of each outcome. Nothing of the action's answer:
 * that is an outside system's data, which the agent reads as a call's
 * result (`env.connections.outcome`, which the note names), never as one
 * of its instructions. Each says not to ask for the write again: a repeat
 * would be another write.
 */
const heldOutcomes: Record<HeldOutcome, string> = {
  confirmed:
    "The person confirmed it and it was carried out. Don't ask for it again.",
  declined:
    "The person declined it: it was not carried out and won't be. Don't ask for it again unless they say so.",
  expired:
    "It waited past the end of the company's day without the person confirming it, so it ended and was not carried out. If they still want it, ask for it afresh, with today's values.",
  unknown:
    "The person confirmed it and it was sent, but whether it took effect is unknown: it may have been carried out. It won't be sent again; check the outside system before asking for it again.",
  failed:
    "The person confirmed it, but carrying it out failed, so it may not have been done. It no longer waits for them; don't ask for it again unless they say so.",
};

/**
 * What a chat's code step has logged, as core keeps it for its watchers:
 * every line received (counted, and bounded, by core itself), how many
 * of them are shown, and the text shown, redacted over all of it and cut
 * at the output budget. A line is shown only once a read of revocations
 * that began after it arrived found none, so nothing logged after a
 * revocation is ever shown. Kept until the step's result is stored.
 */
interface RunOutput {
  runId: string;
  callId: string;
  agentId: string;
  lines: string[];
  rawBytes: number;
  shown: number;
  text: string;
  /** When the last read of revocations began; 0 before the first. */
  checkedAt: number;
  checking: boolean;
  /** The read of revocations under way, to join (`#checkNow`). */
  check: Promise<void> | undefined;
  /** The run is closing: a read now only looks for revocations. */
  closing: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** The run ended: no more lines, what is shown stays until its result. */
  ended: boolean;
  /**
   * How many lines there were once core cut what the run sent (a line cut
   * to the bytes left, or lines past the most it takes); `undefined` while
   * nothing was cut. What is shown up to there ends with the cut marker.
   */
  cutAt: number | undefined;
}

/** Most raw bytes of lines core takes from one run, whatever it sends. */
const maxRawOutputBytes = 2 * codeLimits.outputBytes;

/** The least time between two reads of revocations for one run's output. */
const outputCheckMs = 1000;

/**
 * Lines as a watcher sees them: redacted as a whole, and cut at the budget
 * or where core cut what the run sent (`cut`), with the marker saying so.
 */
const shownText = (lines: readonly string[], cut: boolean): string => {
  const text = redact(lines.join("\n"));
  const room = codeLimits.outputBytes - codeLimits.diagnosticBytes;
  if (!cut && utf8Bytes(text) <= room) {
    return text;
  }
  return `${cutToBytes(text, room - utf8Bytes(cutMarker))}${cutMarker}`;
};

/** The running step's output as watchers see it, without its bookkeeping. */
const outputOf = (
  output: { callId: string; text: string } | undefined
): ChatOutput | null =>
  output === undefined ? null : { callId: output.callId, text: output.text };

/**
 * Whether a turn of `chat` answers its person alone, so its recall may
 * hold what only they may read (their own store): only in a chat of
 * theirs that no thread others share is in, in a turn they started.
 * Their own chat in Grasp, and their direct message on a chat app (their
 * one chat there, `thread` null), which only a message the platform
 * itself names one-to-one reaches (`askThrough`, place `direct`): the
 * person and the agent alone (GRA-1821, decided 15 November 2026: the
 * agent there behaves as in their own chat in Grasp). The chat
 * app keeps that answer too, where its admins and compliance exports
 * read it. A chat for a thread others share (`thread`) is read by all of
 * them, however few the platform says it holds.
 *
 * A turn a schedule or an event woke (`unattended`) wasn't theirs to
 * start, and acts on what woke it: an event's words, from anyone, steer
 * it, and what it hands on goes where they lead, held changes included.
 * So it recalls nothing of their own store, though its chat may already
 * hold their own text an earlier turn of theirs recalled: that text is
 * there because they asked for it; a woken turn adds none they didn't.
 */
const answersAlone = (
  { thread }: Pick<Chat, "thread">,
  unattended: boolean
): boolean => thread === null && !unattended;

/** A turn's rows `turnForBrain` reads at a time, back from its answer. */
const turnRowsPerRead = 20;

/**
 * Whether `chat`'s turns go to its person's own Brain (GRA-1805): a chat
 * whose turns answer them alone (`answersAlone`), not restricted. Whether
 * its person asked the turn there and then is the turn's own (its
 * capture's `attended`).
 */
const handsTurnsOver = ({
  thread,
  restricted,
}: Pick<Chat, "thread" | "restricted">): boolean =>
  answersAlone({ thread }, false) && !restricted;

/**
 * A chat not being deleted (`chatDeletes`): one that is is gone for every
 * read of a person's surface and every chat app's thread, at once.
 */
const notDeleting = sql`not exists (select 1 from ${chatDeletes} where ${chatDeletes.chatId} = ${chats.id})`;

/**
 * The one rule for which of `personId`'s chats Grasp's own surfaces show
 * (GRA-1919): only one that came through Grasp's own app. A conversation
 * with the agent in a chat app (Teams, Slack, any other) is never a chat
 * in Grasp: no list, search or address shows or opens it, and asked for
 * by its ID it answers exactly as one that doesn't exist. It is kept here
 * all the same, for its agent and the Brain (`askThrough`,
 * `turnForBrain`), and its person deletes it from Settings
 * (`forgetChatApps`). Nor is one being deleted (`notDeleting`). Every
 * read a person's surface makes has it in its own statement, so a hidden
 * chat takes no slot and leaves no trace.
 */
const shownInGrasp = (personId: string) =>
  and(eq(chats.personId, personId), eq(chats.via, "web"), notDeleting);

/** A person's or team's workspace: chats and the Code Mode agent on Pi. */
export class Workspace extends DurableObject<Env> {
  readonly #db = drizzle(this.ctx.storage);

  /**
   * The questions this object is taking now, by chat: what each gathers
   * for its asker as its turn runs (`LiveTurn`). Only in memory: the turn
   * itself is its ChatSession's, and goes on there through a restart of
   * this object.
   */
  readonly #turns = new Map<ChatId, LiveTurn>();

  /**
   * Code runs' leases, as `<chat>/<run>` (`CodeRunLease`): their stubs
   * answer, and their writes are admitted, only while a run is open and
   * has calls left. In memory, so a restart ends every run (its record
   * says `interrupted`). Closed runs are kept, oldest first, only up to
   * {@link endedRunsKept}: a run forgotten answers as ended, unlogged.
   */
  readonly #codeRuns = new Map<string, CodeRunLease>();

  /**
   * What the code step running now in each chat has logged, as its
   * watchers see it before its result: for one run (`runId`), its UTF-8
   * size, and whether it was cut at the run's output budget. In memory
   * only, and gone once the run closes.
   */
  readonly #outputs = new Map<ChatId, RunOutput>();

  /**
   * The response each chat's agent is writing now, as it streams in: what
   * a watcher sees of it before it is stored. In memory only, like turns.
   */
  readonly #partials = new Map<ChatId, AssistantMessage>();

  /**
   * Why each chat's last question stopped before the agent answered, when
   * it wasn't the model (see `ChatUpdate.stopped`). In memory only.
   */
  readonly #stopped = new Map<ChatId, string>();
  /** The chats whose turn checks the drafts it wrote now (`turnChecking`). */
  readonly #checking = new Set<ChatId>();
  /**
   * What each chat's turn waits on now from its model, where it waits
   * (`turnWaiting`). In memory only.
   */
  readonly #waits = new Map<ChatId, ModelWait>();

  /**
   * Turns `send` started, each settled once its turn ends, and the chat
   * titles asked for as they began (`#nameChat`): the alarm waits for
   * them, so the object stays up while its agent works with nobody
   * waiting on a call.
   */
  readonly #sent = new Set<Promise<unknown>>();
  /** The questions sent with a key whose turn is still starting, by key (`send`). */
  readonly #starting = new Map<
    string,
    { chatId: ChatId; started: Promise<boolean> }
  >();

  /**
   * Whether its person's erasure began (`erasePerson`): from then on
   * nothing more is told in their chats (`#note`) or handed over of them
   * (`#exported`, `turnForBrain`), so nothing lands after the erasure. Read
   * from storage (`erasingKey`), so a restart before the wipe never opens
   * them again.
   */
  get #erasing(): boolean {
    return this.ctx.storage.kv.get(erasingKey) === true;
  }

  /**
   * Bumped whenever a chat's sources or restricted mode change, so a
   * watcher reads them again only then. In memory: a watcher starts with
   * none, so it reads them first.
   */
  readonly #provenanceVersions = new Map<ChatId, number>();

  /** The deletions under way in this instance (`#finishDelete`), by chat. */
  readonly #finishing = new Map<ChatId, Promise<void>>();

  /** How long the alarm waits before delivering audit events again. */
  #auditRetryMs = auditRetryMs.first;

  /**
   * Bumped whenever a chat's agent has a write held (`heldChanged`), so its
   * watchers read the held writes again. In memory only.
   */
  readonly #heldVersions = new Map<ChatId, number>();

  /** Who follows each chat (`watch`), by chat and watch ID. */
  readonly #watchers = new Map<ChatId, Map<string, ChatWatch>>();

  /**
   * Where each chat stood before the questions sent in it still being
   * taken moved it up (`#askedIn`), when those are, and every time such a
   * question moved it to.
   */
  readonly #asking = new Map<
    ChatId,
    { stood: Date; taking: Set<number>; moves: Set<number> }
  >();

  /** Who follows their list of chats (`watchChats`), by watch ID. */
  readonly #listWatchers = new Map<string, ChatListWatch>();

  /** Whether the list's watchers are told already this tick (`#listChanged`). */
  #listTold = false;

  /**
   * Bumped whenever a chat's agent writes an App's draft, so its watchers
   * read what it worked on again (`draftWritten`). In memory only.
   */
  readonly #worked = new Map<ChatId, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    migrateOnWake(ctx, migrations);
    this.#closeInterruptedRuns();
    // A deletion marked before a restart that cut its wake-up short.
    void ctx.blockConcurrencyWhile(async () => {
      await this.#armDeletes();
    });
  }

  /**
   * Marks every code run still `running` as `interrupted`: no run is open
   * when the object wakes, so each was ended by the restart, its lease
   * with it. Nothing is run again.
   */
  #closeInterruptedRuns(): void {
    this.#db
      .update(chatCodeRuns)
      .set({ status: "interrupted", endedAt: new Date() })
      .where(eq(chatCodeRuns.status, "running"))
      .run();
  }

  /**
   * Stores `message` as the chat's next, with how long it thought when it
   * is an answer that did, and marks the chat active then: every message
   * moves it up its person's list.
   */
  #store(
    chatId: ChatId,
    message: Message,
    thinkingMs: number | null = null,
    built: ShownBuilt | null = null,
    agentId: string | null = null,
    requestKey: string | null = null
  ): { id: number; createdAt: Date } {
    const stored = this.#db
      .insert(chatMessages)
      .values({
        chatId,
        message: JSON.stringify(message),
        createdAt: new Date(),
        thinkingMs,
        agentId,
        requestKey,
        built: built === null ? null : JSON.stringify(built),
      })
      .returning({ id: chatMessages.id, createdAt: chatMessages.createdAt })
      .get();
    this.#db
      .update(chats)
      .set({ lastAt: stored.createdAt })
      .where(eq(chats.id, chatId))
      .run();
    this.#keepSaid(chatId, stored.id, message);
    // A step's result changes nothing the list shows that the answer
    // around it won't: no title, read or working state, and its chat
    // moved up as it was asked in.
    if (message.role !== "toolResult") {
      this.#listChanged();
    }
    return stored;
  }

  /**
   * Keeps what message `messageId` of the chat said, for searches to look
   * through: a row of its own, empty when it said nothing, so a search
   * knows it was read.
   */
  #keepSaid(chatId: ChatId, messageId: number, message: Message): void {
    const said = saidOf(message);
    this.#db
      .insert(chatSearchText)
      .values({ messageId, chatId, said, folded: foldOf(said) })
      .onConflictDoNothing()
      .run();
  }

  /**
   * Keeps what was said in `personId`'s messages stored before searches
   * were, which have no row yet: each once, the first time a search needs
   * it.
   */
  #keepUnsaid(personId: string): void {
    const unread = this.#db
      .select({
        id: chatMessages.id,
        chatId: chatMessages.chatId,
        message: chatMessages.message,
      })
      .from(chatMessages)
      .innerJoin(chats, eq(chats.id, chatMessages.chatId))
      .leftJoin(chatSearchText, eq(chatSearchText.messageId, chatMessages.id))
      .where(and(shownInGrasp(personId), isNull(chatSearchText.messageId)))
      .all();
    for (const { id, chatId, message } of unread) {
      this.#keepSaid(
        chatId,
        id,
        storedMessageSchema.parse(JSON.parse(message))
      );
    }
  }

  /**
   * Where a search was said in chat `chatId`: around its first term said
   * anywhere in it (the whole search, else each word in turn), in the
   * first message that holds it, as a stretch SQLite cuts
   * {@link snippetReach} on each side; null when none was. What was said
   * is folded keeping each character in place, so where a term is in the
   * folded text is where it is in what was said.
   */
  #saidAround(chatId: ChatId, query: string): ChatSearchSnippet | null {
    for (const term of searchTermsOf(query)) {
      const [row] = this.ctx.storage.sql
        .exec<{ text: string; cutBefore: number; cutAfter: number }>(
          `SELECT substr(said, max(1, at - ?2), length(?1) + 2 * ?2) AS text,
                  at - ?2 > 1 AS cutBefore,
                  max(1, at - ?2) + length(?1) + 2 * ?2 <= length(said) AS cutAfter
             FROM (SELECT said, instr(folded, ?1) AS at
                     FROM chat_search_text
                    WHERE chat_id = ?3 AND instr(folded, ?1) > 0
                    ORDER BY message_id
                    LIMIT 1)`,
          term,
          snippetReach,
          chatId
        )
        .toArray();
      if (row !== undefined) {
        return snippetOf(row.text, query, {
          before: row.cutBefore === 1,
          after: row.cutAfter === 1,
        });
      }
    }
    return null;
  }

  /**
   * `personId`'s own chats that hold every word of `query` in their
   * title or what was said in them, the most recently active first: at most
   * {@link searchHitsMax}. One found only with what was said carries where
   * it was said. What was said is folded as it is kept, so SQLite looks
   * through it as it is, in any script; the few titles are compared here.
   */
  searchChats(personId: string, query: string): ChatSearchHit[] {
    const words = searchWordsOf(query);
    if (words.length === 0) {
      return [];
    }
    this.#keepUnsaid(personId);
    // Which words were said in each chat: "1" or "0" for each, in order.
    const saidWords = sql.join(
      words.map(
        (word) =>
          sql`exists (select 1 from ${chatSearchText} where ${chatSearchText.chatId} = ${chats.id} and instr(${chatSearchText.folded}, ${word}) > 0)`
      ),
      sql` || `
    );
    const rows = this.#db
      .select({
        id: chats.id,
        title: chats.title,
        createdAt: chats.createdAt,
        lastAt: chats.lastAt,
        makeKind: chats.makeKind,
        makeProject: chats.makeProject,
        archivedAt: chats.archivedAt,
        agentId: chats.agentId,
        readUpTo: chats.readUpTo,
        said: sql<string>`'' || ${saidWords}`,
      })
      .from(chats)
      .where(shownInGrasp(personId))
      .orderBy(desc(chats.lastAt))
      .all();
    const found = rows
      .filter((row) => {
        const named = foldOf(row.title);
        return words.every(
          (word, index) => row.said[index] === "1" || named.includes(word)
        );
      })
      .slice(0, searchHitsMax);
    return found.map((row) => ({
      chat: this.#summaryOf(row),
      said: hasEvery(query, row.title) ? null : this.#saidAround(row.id, query),
    }));
  }

  /**
   * Stores `message` as the chat's next (`#store`), and shows it to its
   * watchers; its ID.
   */
  #keep(
    chatId: ChatId,
    message: Message,
    {
      thinkingMs,
      files = [],
      built,
      agentId,
      key,
    }: {
      thinkingMs?: number;
      files?: readonly string[];
      built?: ShownBuilt;
      /** The agent whose turn it is from; none for the person's own words. */
      agentId?: string;
      /** The page's key for a question it sent (`send`). */
      key?: string;
    } = {}
  ): number {
    // A question and the files it carries are kept together: each file is
    // its, and no other's.
    const { id, createdAt } =
      files.length === 0
        ? this.#store(
            chatId,
            message,
            thinkingMs ?? null,
            built ?? null,
            agentId ?? null,
            key ?? null
          )
        : this.ctx.storage.transactionSync(() => {
            const stored = this.#store(
              chatId,
              message,
              thinkingMs ?? null,
              built ?? null,
              agentId ?? null,
              key ?? null
            );
            this.#db
              .update(chatFiles)
              .set({ messageId: stored.id })
              .where(
                and(
                  eq(chatFiles.chatId, chatId),
                  inArray(chatFiles.id, [...files]),
                  isNull(chatFiles.messageId)
                )
              )
              .run();
            return stored;
          });
    const shown = withFiles(
      chatMessageOf(
        id,
        message,
        createdAt,
        thinkingMs ?? null,
        message.role === "assistant" && this.#asksIn(chatId),
        built,
        agentId,
        key
      ),
      files.length === 0 ? undefined : this.#filesAfter(chatId, id - 1)
    );
    // A plan names the chat after what it makes, as a first question named
    // it after its words: the chat's own name, not the person's act.
    if (shown?.role === "assistant" && shown.planned !== undefined) {
      const [first] = shown.planned.parts;
      const main =
        shown.planned.parts.find(({ kind }) => kind === "app") ?? first;
      if (main !== undefined) {
        this.#db
          .update(chats)
          .set({ title: main.name })
          .where(eq(chats.id, chatId))
          .run();
      }
    }
    // A step's result shows all it logged: its output goes in the same update.
    if (message.role === "toolResult") {
      const output = this.#outputs.get(chatId);
      clearTimeout(output?.timer);
      this.#outputs.delete(chatId);
    }
    this.#changed(chatId, shown === undefined ? [] : [shown]);
    return id;
  }

  /**
   * Refuses `personId` a new chat once they keep {@link maxChatsPerPerson}
   * in Grasp (`shownInGrasp`). A chat app's conversations count toward no
   * cap: the person deletes them (`forgetChatApps`), and a chat app's
   * message is never refused for them.
   */
  requireRoomForChat(personId: string): void {
    const [kept] = this.#db
      .select({ count: count() })
      .from(chats)
      .where(shownInGrasp(personId))
      .all();
    if ((kept?.count ?? 0) >= maxChatsPerPerson) {
      throw agentErrors.create("agent.too_many_chats");
    }
  }

  /**
   * A new chat, which belongs to `personId`: agent `agentId` answers in it,
   * acting for them. Refused past {@link maxChatsPerPerson} in Grasp; a
   * chat app's conversation never is (`requireRoomForChat`). Made `by`
   * someone (the person, through the chat API), it is audited with it, in
   * the same transaction; core's own chats (tests) pass nobody.
   *
   * Made to fix a failed run (`fix`), it starts with the run's report
   * attached (`attachments`), audited as `workflow.run.fix_asked`, and
   * with what the report may hold data from as its sources; restricted
   * from the start, audited so, when the run's App is. All in the same
   * transaction: no turn can read the report before the chat carries it.
   *
   * Made through a chat platform (`via`, its adapter's name), it is that
   * platform's chat for good, and its agent's audit events name it; Grasp's
   * own app (`web`) otherwise. Started by "Make something" (`make`), it
   * keeps what it came to make, and the project Build it makes it in.
   *
   * Its ID is taken once in this object: a random one, or the one the
   * person's page named (`named`, with the start's key, `startChat`),
   * refused as if there were no such chat when a chat here has it or had
   * it (`deleted_chats`), and answered with the chat that start made
   * before. Only here: whatever is kept of a chat elsewhere is keyed by
   * its ref (`ChatRef`), this workspace's and its ID, so another person's
   * chat with the same ID is another chat.
   *
   * Synchronous, on this object's own storage alone, so nothing else here
   * runs in between: two messages of a chat app's conversation at once
   * make one chat (`askThrough`), and two starts of one chat at once make
   * it once.
   */
  createChat(
    title: string,
    personId: string,
    agentId: string,
    by?: AuditActor,
    via: ChatChannel = "web",
    thread?: string,
    make?: ChatMake,
    named?: { id: ChatId; key: string }
  ): Chat {
    // Only this object's own person's: every chat of theirs is here, and
    // whatever is kept of it elsewhere takes this object's name as its
    // workspace.
    if (this.ctx.id.name !== personalWorkspaceId(personId)) {
      throw agentErrors.create("agent.chat_not_found");
    }
    const agent = workspaceAgentIdSchema.safeParse(agentId);
    if (!agent.success) {
      // No agent core names: nowhere an agent can work.
      throw permissionErrors.create("permission.context_invalid");
    }
    const channel = chatChannelSchema.parse(via);
    const id = named?.id ?? chatIdSchema.parse(crypto.randomUUID());
    const repeated =
      named === undefined
        ? undefined
        : this.#startedChat(id, personId, named.key);
    if (repeated !== undefined) {
      return repeated;
    }
    const chat = this.ctx.storage.transactionSync(() => {
      // Never one of the person's own chats made over, nor one under a
      // deleted chat's ID, nor one past their most.
      const taken =
        this.#db
          .select({ id: chats.id })
          .from(chats)
          .where(eq(chats.id, id))
          .get() ??
        this.#db
          .select({ id: deletedChats.id })
          .from(deletedChats)
          .where(eq(deletedChats.id, id))
          .get();
      if (taken !== undefined) {
        throw agentErrors.create("agent.chat_not_found");
      }
      if (channel === "web") {
        this.requireRoomForChat(personId);
      }
      if (by !== undefined) {
        this.#outboxed(by, "chat.created", id, {});
      }
      const now = new Date();
      const made = this.#db
        .insert(chats)
        .values({
          id,
          title,
          createdAt: now,
          lastAt: now,
          personId,
          agentId: agent.data,
          via: channel,
          thread: thread ?? null,
          makeKind: make?.kind ?? null,
          makeProject: make?.project ?? null,
          // Nothing seen yet: every answer is news until its person looks.
          readUpTo: 0,
        })
        .returning()
        .get();
      if (named !== undefined) {
        this.#keepRequest("create", named.key, id);
      }
      return made;
    });
    this.#deliverAudit();
    this.#listChanged();
    return chat;
  }

  /**
   * Makes the chat `start` names, `personId`'s with ID `chatId`, as the
   * question that starts it goes (`send`, `attachFile`), unless that start
   * made it already: a repeat of it, from a page that never heard, or a
   * second tab, finds it, and two at once make it once. Anything else is
   * refused as if there were no such chat (`agent.chat_not_found`): an ID
   * that isn't a UUID, a chat there already (the person's own too, which
   * a start never takes over or makes over), a deleted one, or a start key
   * that made another chat. Another person's chat is never here.
   */
  startChat(
    chatId: unknown,
    personId: string,
    start: {
      key: string;
      title: string;
      agentId: string;
      make?: ChatMake | undefined;
      by: AuditActor;
    }
  ): void {
    const named = newChatIdSchema.safeParse(chatId);
    if (!named.success) {
      throw agentErrors.create("agent.chat_not_found");
    }
    this.createChat(
      start.title,
      personId,
      start.agentId,
      start.by,
      "web",
      undefined,
      start.make,
      { id: named.data, key: start.key }
    );
  }

  /**
   * The chat the start with `key` made, `personId`'s chat `chatId`, within
   * a day; none when it made none. Refused as no such chat once that chat
   * is gone, or for a key that made another.
   */
  #startedChat(
    chatId: ChatId,
    personId: string,
    key: string
  ): Chat | undefined {
    const made = this.#requested("create", key);
    if (made === undefined) {
      return undefined;
    }
    if (made.chatId !== chatId) {
      throw agentErrors.create("agent.chat_not_found");
    }
    return this.#graspChat(made.chatId, personId);
  }

  /**
   * Whether the start with `key` made `personId`'s chat `chatId` within a
   * day, as a repeat of it asks (`startChat`, chats-rpc.ts): refused as
   * no such chat once that chat is gone, or for a key that made another.
   */
  chatStartedWith(chatId: unknown, personId: string, key: string): boolean {
    const id = newChatIdSchema.safeParse(chatId);
    if (!id.success) {
      throw agentErrors.create("agent.chat_not_found");
    }
    return this.#startedChat(id.data, personId, key) !== undefined;
  }

  /**
   * The chat a request with `key` was kept for, and when, if one was
   * within a day, with the file an `attach` attached.
   */
  #requested(
    kind: "create" | "send" | "attach",
    key: string
  ): { chatId: ChatId; at: Date; fileId: string | null } | undefined {
    return this.#db
      .select({
        chatId: chatRequestKeys.chatId,
        at: chatRequestKeys.at,
        fileId: chatRequestKeys.fileId,
      })
      .from(chatRequestKeys)
      .where(
        and(
          eq(chatRequestKeys.kind, kind),
          eq(chatRequestKeys.key, key),
          gt(chatRequestKeys.at, new Date(Date.now() - requestKeyMs))
        )
      )
      .get();
  }

  /**
   * Whether the question `chat` took at `at` is still there: its turn
   * under way, or something of it kept. A key outlives a restart, and a
   * turn that had only just started may not: its question was kept
   * nowhere yet, so a repeat asks it again rather than answer for it.
   */
  async #questionStands(chat: Chat, at: Date): Promise<boolean> {
    if (this.#turns.has(chat.id)) {
      return true;
    }
    const kept = this.#db
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(
        and(eq(chatMessages.chatId, chat.id), gte(chatMessages.createdAt, at))
      )
      .limit(1)
      .get();
    return (
      kept !== undefined || (await this.#activeTurn(chat.id)) !== undefined
    );
  }

  /**
   * Keeps `key` for what `chatId` just took (for an `attach`, the file
   * `fileId`), and drops the keys past their day.
   */
  #keepRequest(
    kind: "create" | "send" | "attach",
    key: string,
    chatId: ChatId,
    fileId: string | null = null
  ): void {
    const now = Date.now();
    this.#db
      .delete(chatRequestKeys)
      .where(lte(chatRequestKeys.at, new Date(now - requestKeyMs)))
      .run();
    this.#db
      .insert(chatRequestKeys)
      .values({ kind, key, chatId, fileId, at: new Date(now) })
      // A question asked again after a restart lost it (`#questionStands`),
      // or a file attached again after it was removed (`#attachedWith`).
      .onConflictDoUpdate({
        target: [chatRequestKeys.kind, chatRequestKeys.key],
        set: { chatId, fileId, at: new Date(now) },
      })
      .run();
  }

  /**
   * The file `personId`'s chat attached with `key` within a day, as the
   * first call attached it: what a repeat of `attachFile` answers, and
   * what its caller asks first, so a repeat's bytes aren't read again
   * (chats-rpc.ts).
   */
  fileAttachedWith(
    chatId: unknown,
    personId: string,
    key: string
  ): ChatFile | undefined {
    const { id } = this.#graspChat(chatId, personId);
    return this.#attachedWith(id, key);
  }

  /**
   * The file chat `chatId` attached with `key` within a day, if it still
   * has it: one removed since is attached anew. Another chat's key is
   * refused, as it says nothing of a file here.
   */
  #attachedWith(chatId: ChatId, key: string): ChatFile | undefined {
    const taken = this.#requested("attach", key);
    if (taken === undefined) {
      return undefined;
    }
    if (taken.chatId !== chatId) {
      throw agentErrors.create("agent.invalid_request");
    }
    const row =
      taken.fileId === null
        ? undefined
        : this.#db
            .select(chatFileCard)
            .from(chatFiles)
            .where(
              and(eq(chatFiles.chatId, chatId), eq(chatFiles.id, taken.fileId))
            )
            .get();
    return row === undefined ? undefined : chatFileOf(row);
  }

  /**
   * Attaches a file to `personId`'s own chat, as the text core read from
   * it (chats-rpc.ts), or a picture whole, in parts
   * ({@link chatFilePartBytes}), for its next question to carry: refused
   * past {@link chatFilesMax}. Audited with its ID, type and size, never
   * its name, text or picture.
   */
  attachFile(
    chatId: unknown,
    personId: string,
    file:
      | { name: string; type: ChatFileType; bytes: number; text: string }
      | {
          name: string;
          type: ChatPictureType;
          bytes: number;
          picture: Uint8Array;
        },
    by: AuditActor,
    /**
     * The page's key for this file (`ChatsApi.attachFile`): a repeat
     * answers the file the first call attached, and attaches nothing.
     * Checked and kept in the same transaction as the file, so of two at
     * once only one attaches it.
     */
    key?: string
  ): ChatFile {
    const { id } = this.#graspChat(chatId, personId);
    if (this.#isDeleting(id)) {
      throw agentErrors.create("agent.chat_not_found");
    }
    const attached = this.ctx.storage.transactionSync(() => {
      const before =
        key === undefined ? undefined : this.#attachedWith(id, key);
      if (before !== undefined) {
        return before;
      }
      const [kept] = this.#db
        .select({ files: count() })
        .from(chatFiles)
        .where(eq(chatFiles.chatId, id))
        .all();
      if ((kept?.files ?? 0) >= chatFilesMax) {
        throw agentErrors.create("agent.too_many_files");
      }
      const row = this.#db
        .insert(chatFiles)
        .values({
          id: crypto.randomUUID(),
          chatId: id,
          messageId: null,
          name: file.name,
          type: file.type,
          bytes: file.bytes,
          // A picture has no text: the model sees it (`chatPicture`).
          text: "text" in file ? file.text : "",
          createdAt: new Date(),
        })
        .returning(chatFileCard)
        .get();
      if ("picture" in file) {
        const { picture } = file;
        for (
          let part = 0;
          part * chatFilePartBytes < picture.byteLength;
          part += 1
        ) {
          this.#db
            .insert(chatFileParts)
            .values({
              fileId: row.id,
              part,
              bytes: picture.subarray(
                part * chatFilePartBytes,
                (part + 1) * chatFilePartBytes
              ),
            })
            .run();
        }
      }
      this.#outboxed(by, "chat.file_attached", id, {
        file: row.id,
        type: file.type,
        bytes: file.bytes,
      });
      if (key !== undefined) {
        this.#keepRequest("attach", key, id, row.id);
      }
      return chatFileOf(row);
    });
    this.#deliverAudit();
    return attached;
  }

  /**
   * Removes a file `personId` attached to their own chat that no question
   * carries yet (one taken out of the box after a send that failed), so
   * it holds none of the chat's {@link chatFilesMax}. A file a question
   * carried stays with it: refused as `agent.file_not_found`, as one the
   * chat never had; and none is removed while the chat has a turn
   * (`agent.busy`). Audited with its ID.
   */
  removeFile(
    chatId: unknown,
    personId: string,
    fileId: string,
    by: AuditActor
  ): void {
    const { id } = this.#graspChat(chatId, personId);
    // A question starting in the chat may have chosen it already, and
    // binds it only once it is kept, after awaits (`#turn`): no file of
    // the chat is removed while it has a turn, which is taken before its
    // first await.
    if (this.#turns.has(id)) {
      throw agentErrors.create("agent.busy");
    }
    this.ctx.storage.transactionSync(() => {
      // A picture's parts first, as each names its file: only those of
      // the file removed here, none of one a question carried.
      this.#db
        .delete(chatFileParts)
        .where(
          inArray(
            chatFileParts.fileId,
            this.#db
              .select({ id: chatFiles.id })
              .from(chatFiles)
              .where(
                and(
                  eq(chatFiles.chatId, id),
                  eq(chatFiles.id, fileId),
                  isNull(chatFiles.messageId)
                )
              )
          )
        )
        .run();
      const removed = this.#db
        .delete(chatFiles)
        .where(
          and(
            eq(chatFiles.chatId, id),
            eq(chatFiles.id, fileId),
            isNull(chatFiles.messageId)
          )
        )
        .returning({ id: chatFiles.id })
        .get();
      if (removed === undefined) {
        throw agentErrors.create("agent.file_not_found");
      }
      this.#outboxed(by, "chat.file_removed", id, { file: removed.id });
    });
    this.#deliverAudit();
  }

  /**
   * The chat's files, in the order they were attached, with the question
   * that carried each (`null` while none has), for its agent
   * (`env.chat.files()` in agent-apis.ts): never their text.
   */
  chatFiles(chatId: ChatId): (ChatFile & { question: number | null })[] {
    return this.#db
      .select({ ...chatFileCard, messageId: chatFiles.messageId })
      .from(chatFiles)
      .where(eq(chatFiles.chatId, chatId))
      .orderBy(asc(chatFiles.createdAt), asc(chatFiles.id))
      .all()
      .map((row) => ({ ...chatFileOf(row), question: row.messageId }));
  }

  /**
   * One of the chat's files with its text, for its agent
   * (`env.chat.readFile`); `undefined` for none the chat has.
   */
  chatFile(
    chatId: ChatId,
    fileId: string
  ): (ChatFile & { text: string }) | undefined {
    const row = this.#db
      .select({ ...chatFileCard, text: chatFiles.text })
      .from(chatFiles)
      .where(and(eq(chatFiles.chatId, chatId), eq(chatFiles.id, fileId)))
      .get();
    return row === undefined
      ? undefined
      : { ...chatFileOf(row), text: row.text };
  }

  /**
   * One of the chat's pictures, its type and bytes, for its turn to show
   * the model (chat-harness.ts); `undefined` for none the chat has, and
   * for one larger than `maxBytes`, which isn't read.
   */
  chatPicture(
    chatId: ChatId,
    fileId: string,
    maxBytes = Number.POSITIVE_INFINITY
  ): { type: ChatPictureType; bytes: Uint8Array } | undefined {
    const file = this.#db
      .select({ type: chatFiles.type, bytes: chatFiles.bytes })
      .from(chatFiles)
      .where(and(eq(chatFiles.chatId, chatId), eq(chatFiles.id, fileId)))
      .get();
    if (
      file === undefined ||
      !isChatPictureType(file.type) ||
      file.bytes > maxBytes
    ) {
      return undefined;
    }
    const parts = this.#db
      .select({ bytes: chatFileParts.bytes })
      .from(chatFileParts)
      .where(eq(chatFileParts.fileId, fileId))
      .orderBy(asc(chatFileParts.part))
      .all();
    const bytes = new Uint8Array(
      parts.reduce((total, part) => total + part.bytes.byteLength, 0)
    );
    let at = 0;
    for (const part of parts) {
      bytes.set(part.bytes, at);
      at += part.bytes.byteLength;
    }
    return { type: file.type, bytes };
  }

  /**
   * One of the pictures of `personId`'s own chat in Grasp, for its page to
   * show again (chat-file-route.ts); `undefined` for any other chat's, a
   * file that isn't a picture, and one the chat doesn't have.
   */
  ownChatPicture(
    chatId: unknown,
    personId: string,
    fileId: string
  ): { type: ChatPictureType; bytes: Uint8Array } | undefined {
    const id = chatIdSchema.safeParse(chatId);
    if (!id.success || this.#isDeleting(id.data)) {
      return undefined;
    }
    const chat = this.#db
      .select({ id: chats.id })
      .from(chats)
      .where(and(eq(chats.id, id.data), shownInGrasp(personId)))
      .get();
    return chat === undefined ? undefined : this.chatPicture(chat.id, fileId);
  }

  /**
   * The files `fileIds` names, in that order, each attached to the chat
   * and carried by no question yet: what a question may carry. Refused
   * with `agent.file_not_found` for any other.
   */
  #unsentFiles(
    chatId: ChatId,
    fileIds: readonly string[]
  ): { id: string; name: string; type: ChatFileType | ChatPictureType }[] {
    if (fileIds.length === 0) {
      return [];
    }
    const rows = this.#db
      .select({
        id: chatFiles.id,
        name: chatFiles.name,
        type: chatFiles.type,
      })
      .from(chatFiles)
      .where(
        and(
          eq(chatFiles.chatId, chatId),
          inArray(chatFiles.id, [...fileIds]),
          isNull(chatFiles.messageId)
        )
      )
      .all();
    return fileIds.map((fileId) => {
      const row = rows.find(({ id }) => id === fileId);
      if (row === undefined) {
        throw agentErrors.create("agent.file_not_found");
      }
      return row;
    });
  }

  /**
   * The files each of the chat's questions after message `after` carried,
   * by the question's ID, in the order they were attached.
   */
  #filesAfter(chatId: ChatId, after: number): Map<number, ChatFile[]> {
    const carried = new Map<number, ChatFile[]>();
    const rows = this.#db
      .select({ ...chatFileCard, messageId: chatFiles.messageId })
      .from(chatFiles)
      .where(and(eq(chatFiles.chatId, chatId), gt(chatFiles.messageId, after)))
      .orderBy(asc(chatFiles.createdAt), asc(chatFiles.id))
      .all();
    for (const row of rows) {
      if (row.messageId !== null) {
        const files = carried.get(row.messageId) ?? [];
        files.push(chatFileOf(row));
        carried.set(row.messageId, files);
      }
    }
    return carried;
  }

  /**
   * Stores the audit event of a change to chat `chatId` in this object's
   * outbox: call it in the change's transaction, so both are kept or
   * neither, then `#deliverAudit`. Names the chat and this object, never
   * the chat's title, which may quote a question.
   */
  #outboxed(
    by: AuditActor,
    action:
      | "chat.created"
      | "chat.renamed"
      | "chat.archived"
      | "chat.unarchived"
      | "chat.filed"
      | "chat.unfiled"
      | "chat.answer_rated"
      | "chat.deleted"
      | "chat.moved"
      | "chat.draft_restored"
      | "chat.draft_defined"
      | "chat.file_attached"
      | "chat.file_removed"
      | "chat.draft_discarded",
    chatId: ChatId,
    detail: Record<string, AuditDetailValue> = {}
  ): void {
    this.#outboxEntry({
      actor: by,
      action,
      target: { type: "chat", id: chatId },
      detail: { workspace: this.ctx.id.name ?? null, ...detail },
    });
  }

  /** Stores `entry`'s event in the outbox, as `#outboxed` does. */
  #outboxEntry(entry: AuditEntry): void {
    const event = createAuditEvent(entry, "core");
    this.#db
      .insert(auditOutbox)
      .values({
        id: event.id,
        event: JSON.stringify(event),
        createdAt: new Date(),
      })
      .run();
  }

  /**
   * Delivers the outbox's events to the audit log now, in the background;
   * while any are left (the log out of reach), the alarm tries again,
   * waiting longer each time.
   */
  #deliverAudit(): void {
    // Beside every other change of the request: no note tried alone.
    this.ctx.waitUntil(this.#drainAudit(0));
  }

  /**
   * Drains the outbox, trying at most `loneNotes` notes alone
   * (brain-hand-overs.ts `handOverNotes`): none after a change, which may
   * be one of many in a request; a drain's share from the alarm, which
   * runs alone.
   */
  async #drainAudit(loneNotes: number): Promise<void> {
    const left = await drainObjectOutbox(
      this.env,
      this.ctx.storage.sql,
      loneNotes
    );
    if (left === 0) {
      this.#auditRetryMs = auditRetryMs.first;
      return;
    }
    const retryMs = this.#auditRetryMs;
    this.#auditRetryMs = Math.min(retryMs * 2, auditRetryMs.most);
    await this.#alarmBy(Date.now() + retryMs);
  }

  /**
   * Notes a turn of the chat its ChatSession settled (chat-harness.ts) for
   * its person's own Brain (GRA-1805), by its event (`chat.turn_noted`: a
   * note; whether it is kept is the hand-over's to record,
   * `brain.source.*`): an answered turn they asked there and then, in a
   * chat whose turns go there. None in a chat gone or being deleted.
   * Whose turn it was is the chat's, never the caller's; the hand-over
   * reads the chat again as it runs.
   *
   * Delivered at least once (a call retried, a capture whose retire
   * failed), and noted once: the event's ID comes from the turn's source
   * and its time from the answer as stored, so every delivery makes the
   * same event, which the outbox keeps once by its ID and the log keeps
   * once by its ID, also after a drain took the first.
   */
  async captureTurn(chatId: ChatId, capture: TurnCapture): Promise<void> {
    const { answerId } = capture;
    if (
      !capture.attended ||
      capture.outcome !== "answered" ||
      answerId === null
    ) {
      return;
    }
    const personId = this.#db
      .select({ personId: chats.personId })
      .from(chats)
      .where(eq(chats.id, chatId))
      .get()?.personId;
    if (personId === undefined) {
      return;
    }
    const source = chatTurnSource(personId, chatId, answerId).id;
    const id = uuidFromHash(await sha256Hex(`chat.turn_noted:${source}`));
    // Read again after the hash: the chat may have gone or changed since.
    const chat = this.#db
      .select({
        personId: chats.personId,
        via: chats.via,
        thread: chats.thread,
        restricted: chats.restricted,
      })
      .from(chats)
      .where(eq(chats.id, chatId))
      .get();
    const answer = this.#db
      .select({ createdAt: chatMessages.createdAt })
      .from(chatMessages)
      .where(
        and(eq(chatMessages.chatId, chatId), eq(chatMessages.id, answerId))
      )
      .get();
    if (
      chat?.personId !== personId ||
      answer === undefined ||
      this.#isDeleting(chatId) ||
      !handsTurnsOver(chat)
    ) {
      return;
    }
    const event = auditEventSchema.parse({
      actor: { type: "system" },
      action: "chat.turn_noted",
      target: { type: "chat_turn", id: source },
      detail: { workspace: this.ctx.id.name ?? null },
      id,
      at: answer.createdAt.toISOString(),
      source: "core",
    });
    this.#db
      .insert(auditOutbox)
      .values({ id, event: JSON.stringify(event), createdAt: new Date() })
      .onConflictDoNothing({ target: auditOutbox.id })
      .run();
    this.#deliverAudit();
  }

  /**
   * What `personId` asked in the turn of their chat `chatId` that ended
   * with message `answerId`, for their own Brain (brain-sources.ts): the
   * last question of theirs before that answer, their words alone (as
   * `questionText` reads them: no note of files, no recall). Never the
   * answer: it can quote anything the turn's prompt held (a step's result,
   * this turn's or an earlier one's; the recall; instruction files,
   * memories, skills), and a copy of it in their store would outlive that
   * being erased or their losing it (GRA-1855 gives an answer a record of
   * what it used). Read back from the answer, this turn's rows alone,
   * never the chat's history before it.
   *
   * `deleting` while a deletion of the chat or its person's erasure is
   * under way: the hand-over is tried again later, as that may yet fail,
   * and finds the chat gone once it is done. Skipped, with
   * why, otherwise: `deleted` once the chat is gone or someone else's, or the message isn't one of its answers;
   * `restricted` once it is no longer one whose turns go to the Brain
   * (`handsTurnsOver`: restricted since, say); `no_text` for a turn with
   * no words of theirs before its answer (files alone).
   */
  turnForBrain(
    chatId: string,
    personId: string,
    answerId: number
  ):
    | { kind: "question"; question: string }
    | { kind: "deleting" }
    | { kind: "skipped"; reason: "restricted" | "deleted" | "no_text" } {
    const deleted = { kind: "skipped", reason: "deleted" } as const;
    const id = chatIdSchema.safeParse(chatId);
    if (!id.success) {
      return deleted;
    }
    // Being deleted, which may yet fail: not gone, so not `deleted`.
    if (this.#erasing || this.#isDeleting(id.data)) {
      return { kind: "deleting" };
    }
    const chat = this.#db
      .select()
      .from(chats)
      .where(eq(chats.id, id.data))
      .get();
    if (chat === undefined || chat.personId !== personId) {
      return deleted;
    }
    if (!handsTurnsOver(chat)) {
      return { kind: "skipped", reason: "restricted" };
    }
    const parsed = (row: { message: string }) =>
      storedMessageSchema.parse(JSON.parse(row.message));
    const answer = this.#db
      .select()
      .from(chatMessages)
      .where(
        and(eq(chatMessages.chatId, id.data), eq(chatMessages.id, answerId))
      )
      .get();
    if (answer === undefined || parsed(answer).role !== "assistant") {
      return deleted;
    }
    // Back from the answer, a page at a time, to the person's question.
    let before = answerId;
    for (;;) {
      const page = this.#db
        .select()
        .from(chatMessages)
        .where(
          and(eq(chatMessages.chatId, id.data), lt(chatMessages.id, before))
        )
        .orderBy(desc(chatMessages.id))
        .limit(turnRowsPerRead)
        .all();
      const asked = page
        .map((row) => parsed(row))
        .find((message) => message.role === "user");
      if (asked?.role === "user") {
        const question = questionText(asked).trim();
        return question === ""
          ? { kind: "skipped", reason: "no_text" }
          : { kind: "question", question };
      }
      const last = page.at(-1);
      if (last === undefined || page.length < turnRowsPerRead) {
        return { kind: "skipped", reason: "no_text" };
      }
      before = last.id;
    }
  }

  /** Sets the alarm to go at `time` at the latest, never later than it was. */
  async #alarmBy(time: number): Promise<void> {
    const set = await this.ctx.storage.getAlarm();
    if (set === null || set > time) {
      await this.ctx.storage.setAlarm(time);
    }
  }

  // Restricted mode of a chat (see restricted.ts). A chat that isn't here
  // has nowhere to keep it: both say so, and whatever asked is refused.

  /**
   * The agent that works in the chat and whether the chat has read
   * restricted data; `undefined`: no such chat.
   */
  chatState(
    chatId: ChatId
  ): { agentId: string; restricted: boolean } | undefined {
    return this.#db
      .select({ agentId: chats.agentId, restricted: chats.restricted })
      .from(chats)
      .where(eq(chats.id, chatId))
      .get();
  }

  /** Whether the chat has read restricted data; `undefined`: no such chat. */
  isChatRestricted(chatId: ChatId): boolean | undefined {
    const [chat] = this.#db
      .select({ restricted: chats.restricted })
      .from(chats)
      .where(eq(chats.id, chatId))
      .all();
    return chat?.restricted;
  }

  /**
   * Whether the chat has handed its model or code something only its
   * person may read (private-reads.ts); `undefined`: no such chat.
   */
  isChatPrivateRead(chatId: ChatId): boolean | undefined {
    return this.#db
      .select({ privateRead: chats.privateRead })
      .from(chats)
      .where(eq(chats.id, chatId))
      .get()?.privateRead;
  }

  /**
   * Marks the chat as having handed its model or code something only its
   * person may read, for good (private-reads.ts), with `entry` in the
   * audit outbox in the same write the first time: `true` then, `false`
   * when it was marked already, `undefined` for no such chat.
   */
  markChatPrivateRead(chatId: ChatId, entry: AuditEntry): boolean | undefined {
    const marked = this.ctx.storage.transactionSync(() => {
      const chat = this.#db
        .select({ privateRead: chats.privateRead })
        .from(chats)
        .where(eq(chats.id, chatId))
        .get();
      if (chat === undefined || chat.privateRead) {
        return chat === undefined ? undefined : false;
      }
      this.#outboxEntry(entry);
      this.#db
        .update(chats)
        .set({ privateRead: true })
        .where(eq(chats.id, chatId))
        .run();
      return true;
    });
    if (marked === true) {
      this.#deliverAudit();
    }
    return marked;
  }

  /**
   * Holds a write to an App the chat's agent asked for (held-app-calls.ts)
   * for the chat's person: the same request still waiting in the chat is
   * the same hold, so a call made again (a step a restart ran again) is
   * held once. The call that holds it records it (`agent.call`, with the
   * hold's ID). Refused for a chat that isn't `personId`'s, and while its
   * model may still have what an erasure took (`#erasedUnseen`).
   */
  async holdAppCall(
    chatId: unknown,
    personId: string,
    held: HeldAppCallInput,
    now: number
  ): Promise<HeldAppCallRow> {
    const chat = this.#ownChat(chatId, personId);
    await this.#lapseHeldAppCalls(chat.id, now);
    const erasedKey = `${erasedKeyPrefix}${chat.id}`;
    const counted = JSON.stringify(this.ctx.storage.kv.get(erasedKey) ?? []);
    await this.#erasedUnseen(chat);
    const kept = this.ctx.storage.transactionSync(() => {
      // An erasure found meanwhile withdrew what waited: this too.
      if (
        JSON.stringify(this.ctx.storage.kv.get(erasedKey) ?? []) !== counted
      ) {
        throw agentErrors.create("agent.erasure_unchecked");
      }
      const waiting = this.#db
        .select()
        .from(heldAppCalls)
        .where(
          and(
            eq(heldAppCalls.chatId, chat.id),
            eq(heldAppCalls.status, "waiting"),
            eq(heldAppCalls.appId, held.appId),
            eq(heldAppCalls.requestHash, held.requestHash)
          )
        )
        .get();
      if (waiting !== undefined) {
        return waiting;
      }
      // Later than every hold of the chat before it, by a millisecond if it
      // must: holds asked for in the same millisecond keep the order asked,
      // which their cards keep (channels/cards.tsx `heldWritesCards`).
      const latest = this.#db
        .select({ heldAt: heldAppCalls.heldAt })
        .from(heldAppCalls)
        .where(eq(heldAppCalls.chatId, chat.id))
        .orderBy(desc(heldAppCalls.heldAt))
        .limit(1)
        .get();
      const heldAt = Math.max(now, (latest?.heldAt.getTime() ?? 0) + 1);
      return this.#db
        .insert(heldAppCalls)
        .values({
          id: crypto.randomUUID(),
          chatId: chat.id,
          personId,
          ...held,
          heldAt: new Date(heldAt),
          status: "waiting",
        })
        .returning()
        .get();
    });
    this.heldChanged(chat.id);
    // Ended at its day's end though nobody reads it again (a chat app's
    // card left unpressed): `#lapseDueHeldAppCalls`.
    await this.#alarmBy(kept.heldAt.getTime() + heldStartMs);
    return heldAppCallRowOf(kept);
  }

  /**
   * Ends every App write held here whose day is over (`#lapseHeldAppCalls`,
   * chat by chat), then sets the alarm for the next one's end: so a hold
   * nobody reads again, as a card in a chat app left unpressed, is still
   * ended at its time, its request emptied and its end recorded.
   */
  async #lapseDueHeldAppCalls(now: number): Promise<void> {
    const due = this.#db
      .selectDistinct({ chatId: heldAppCalls.chatId })
      .from(heldAppCalls)
      .where(
        and(
          eq(heldAppCalls.status, "waiting"),
          lte(heldAppCalls.heldAt, new Date(now - heldStartMs))
        )
      )
      .all();
    for (const { chatId } of due) {
      // oxlint-disable-next-line no-await-in-loop -- chat by chat, each in its own write
      await this.#lapseHeldAppCalls(chatIdSchema.parse(chatId), now);
    }
    const next = this.#db
      .select({ heldAt: heldAppCalls.heldAt })
      .from(heldAppCalls)
      .where(eq(heldAppCalls.status, "waiting"))
      .orderBy(asc(heldAppCalls.heldAt))
      .limit(1)
      .get();
    if (next !== undefined) {
      await this.#alarmBy(next.heldAt.getTime() + heldStartMs);
    }
  }

  /**
   * The App writes held for `personId` in their chat `chatId`, which came
   * through `via` (`#chatThrough`), that still wait, oldest first, a page
   * of at most `heldAppCallsPage`: none past their day, or resting on what
   * an erasure took (`#erasureChecked`). A full page goes
   * on `after` its last one's ID; an ID that names no hold of the chat
   * starts from the first.
   */
  async heldAppCalls(
    chatId: unknown,
    personId: string,
    via: ChatChannel,
    now: number,
    after?: string
  ): Promise<HeldAppCallRow[]> {
    const chat = this.#chatThrough(chatId, personId, via);
    await this.#lapseHeldAppCalls(chat.id, now);
    // None listed with what an erasure took (`#dropErasedCopies`).
    const waits = this.#db
      .select({ id: heldAppCalls.id })
      .from(heldAppCalls)
      .where(
        and(
          eq(heldAppCalls.chatId, chat.id),
          eq(heldAppCalls.status, "waiting")
        )
      )
      .get();
    if (waits !== undefined) {
      await this.#erasureChecked(chat);
    }
    const from =
      after === undefined
        ? undefined
        : this.#db
            .select({ id: heldAppCalls.id, heldAt: heldAppCalls.heldAt })
            .from(heldAppCalls)
            .where(
              and(eq(heldAppCalls.id, after), eq(heldAppCalls.chatId, chat.id))
            )
            .get();
    return this.#db
      .select()
      .from(heldAppCalls)
      .where(
        and(
          eq(heldAppCalls.chatId, chat.id),
          eq(heldAppCalls.personId, personId),
          eq(heldAppCalls.status, "waiting"),
          from === undefined
            ? undefined
            : or(
                gt(heldAppCalls.heldAt, from.heldAt),
                and(
                  eq(heldAppCalls.heldAt, from.heldAt),
                  gt(heldAppCalls.id, from.id)
                )
              )
        )
      )
      .orderBy(asc(heldAppCalls.heldAt), asc(heldAppCalls.id))
      .limit(heldAppCallsPage)
      .all()
      .map((row) => heldAppCallRowOf(row));
  }

  /**
   * Decides held App call `id` of `personId`'s chat `chatId`, which came
   * through `via` (`#chatThrough`), once: only while it waits, within its
   * day, and, to confirm it, only for the request whose SHA-256 is
   * `requestHash`, the one the person was shown, once what the chat read
   * was checked against what an erasure took (`#erasureChecked`). Its
   * request is emptied in
   * the same write, and handed back to run once confirmed. Anything else
   * (another's, decided already, lapsed, another request) answers as none:
   * `agent.held_call_not_found`.
   */
  async decideHeldAppCall(
    chatId: unknown,
    personId: string,
    via: ChatChannel,
    id: string,
    decision: { confirm: true; requestHash: string } | { confirm: false },
    now: number
  ): Promise<HeldAppCallRow> {
    const chat = this.#chatThrough(chatId, personId, via);
    await this.#lapseHeldAppCalls(chat.id, now);
    // Never carried out with what an erasure took (`#dropErasedCopies`).
    if (decision.confirm) {
      await this.#erasureChecked(chat);
    }
    const decided = this.ctx.storage.transactionSync(() => {
      const row = this.#db
        .select()
        .from(heldAppCalls)
        .where(
          and(
            eq(heldAppCalls.id, id),
            eq(heldAppCalls.chatId, chat.id),
            eq(heldAppCalls.personId, personId),
            eq(heldAppCalls.status, "waiting")
          )
        )
        .get();
      const taken =
        row !== undefined &&
        (!decision.confirm || row.requestHash === decision.requestHash)
          ? row
          : undefined;
      if (taken !== undefined) {
        this.#db
          .update(heldAppCalls)
          .set({
            status: decision.confirm ? "confirmed" : "declined",
            request: null,
          })
          .where(eq(heldAppCalls.id, taken.id))
          .run();
        // The person's decision, recorded before anything runs of it.
        this.#outboxEntry({
          actor: { type: "person", userId: personId },
          action: decision.confirm
            ? "chat.app_call.confirmed"
            : "chat.app_call.declined",
          target: { type: "app", id: taken.appId },
          detail: {
            workspace: this.ctx.id.name ?? null,
            chat: chat.id,
            held: taken.id,
            kind: taken.kind,
          },
        });
      }
      return taken;
    });
    if (decided === undefined) {
      throw agentErrors.create("agent.held_call_not_found");
    }
    this.#deliverAudit();
    this.heldChanged(chat.id);
    return heldAppCallRowOf(decided);
  }

  /**
   * Ends the App writes held in chat `chatId` that waited past their day
   * (`heldStartMs`, as a held start's) at `now`, never run: each is
   * `lapsed`, its request emptied and its end recorded
   * (`chat.app_call.lapsed`) in one write, then its agent told. Done
   * whenever the chat's held calls are next read, held or decided, so a
   * lapsed one is never listed, confirmed or kept with its request past
   * that read.
   */
  async #lapseHeldAppCalls(chatId: ChatId, now: number): Promise<void> {
    const lapsed = this.ctx.storage.transactionSync(() => {
      const rows = this.#db
        .select()
        .from(heldAppCalls)
        .where(
          and(
            eq(heldAppCalls.chatId, chatId),
            eq(heldAppCalls.status, "waiting"),
            lte(heldAppCalls.heldAt, new Date(now - heldStartMs))
          )
        )
        .all();
      for (const row of rows) {
        this.#db
          .update(heldAppCalls)
          .set({ status: "lapsed", request: null })
          .where(eq(heldAppCalls.id, row.id))
          .run();
        this.#outboxEntry({
          actor: { type: "system" },
          action: "chat.app_call.lapsed",
          target: { type: "app", id: row.appId },
          detail: {
            workspace: this.ctx.id.name ?? null,
            chat: chatId,
            held: row.id,
            kind: row.kind,
          },
        });
      }
      return rows;
    });
    if (lapsed.length === 0) {
      return;
    }
    this.#deliverAudit();
    this.heldChanged(chatId);
    for (const { id, function: name } of lapsed) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- one note each, in order
        await this.#note(
          chatId,
          `The write to an App you asked for, "${name}" (held ID ${id}), waited a day without the person confirming it, so it ended and was not carried out. If they still want it, ask for it afresh.`
        );
      } catch (error) {
        // Ended either way: the agent finds it no longer waits.
        log.warn("chat.held_app_call_lapse_note_failed", errorFields(error));
      }
    }
  }

  /**
   * Tells the agent of `personId`'s own chat how a write to an App it had
   * held for them ended, as `heldDecided` does a connection's: a notice
   * for its turn under way or its next. Nothing of the App's answer: the
   * agent reads the App again if it needs to. A confirmed one's outcome
   * (`chat.app_call.ended`, as the agent's for them: it ran, or failed or
   * was refused) is recorded first, so the person's confirmation never
   * stands alone for a write that was not done.
   */
  async heldAppCallDecided(
    chatId: unknown,
    personId: string,
    held: { id: string; function: string; appId: string; agentId: string },
    outcome: Exclude<HeldOutcome, "expired" | "unknown">
  ): Promise<void> {
    const chat = this.#ownChat(chatId, personId);
    const { id } = z.strictObject({ id: z.uuid() }).parse({ id: held.id });
    const name = z
      .string()
      .min(1)
      .max(maxHeldFunctionChars)
      .parse(held.function);
    if (outcome !== "declined") {
      this.#outboxEntry({
        actor: delegateActorOf(
          chatAuthority({ agentId: held.agentId, personId })
        ),
        action: "chat.app_call.ended",
        target: { type: "app", id: held.appId },
        detail: {
          workspace: this.ctx.id.name ?? null,
          chat: chat.id,
          held: id,
          outcome: outcome === "confirmed" ? "ok" : "failed",
        },
      });
      this.#deliverAudit();
    }
    await this.#note(
      chat.id,
      `The write to an App you asked for, "${name}" (held ID ${id}), was decided. ${heldOutcomes[outcome]}`
    );
  }

  /** Puts the chat in restricted mode, for good; `false`: no such chat. */
  restrictChat(chatId: ChatId): boolean {
    const changed = this.#db
      .update(chats)
      .set({ restricted: true })
      .where(eq(chats.id, chatId))
      .returning({ id: chats.id })
      .all();
    if (changed.length === 0) {
      return false;
    }
    this.#provenanceChanged(chatId);
    return true;
  }

  /**
   * Asks `text` in `personId`'s own chat on chat platform `via`, and waits
   * for the answer, telling `onText`, if given, the answer's text so far as
   * the model writes it, at most every {@link textEveryMs}: the chat is the person's one chat there, found by its
   * channel, or made on their first message, audited as theirs. Asked
   * with the deployment's default model, the first it allows, as Grasp's
   * own app starts with. Like `ask`, it takes its caller's word for who
   * asks: only the door of a chat platform calls it, once the platform's
   * verified sender id named the person (channels/door.ts).
   *
   * The door says where it was asked (`place`). In a direct message it is
   * that one chat, theirs alone (`answersAlone`). Asked where others read
   * the answer (a group chat, a channel), it is the person's one chat for
   * that thread instead, and who is in it is kept first: its agent reads
   * only what all of them may.
   */
  async askThrough(
    personId: string,
    agentId: string,
    via: string,
    text: string,
    onText: ((text: string) => unknown) | undefined,
    place: ChatPlace
  ): Promise<{
    chatId: ChatId;
    answer: Answer;
    calls: ToolCall[];
    remembered: ChatSavedMemory[];
  }> {
    const platform = chatPlatformSchema.parse(via);
    const parsedPlace = permissionErrors.parse(
      "permission.context_invalid",
      chatPlaceSchema,
      place
    );
    const where = parsedPlace.kind === "direct" ? undefined : parsedPlace;
    const [found] = this.#db
      .select()
      .from(chats)
      .where(
        and(
          eq(chats.personId, personId),
          eq(chats.via, platform),
          // A conversation being deleted is gone: the next message there
          // starts one anew.
          notDeleting,
          where === undefined
            ? isNull(chats.thread)
            : eq(chats.thread, where.thread)
        )
      )
      .orderBy(desc(chats.createdAt))
      .limit(1)
      .all();
    const chat =
      found ??
      this.createChat(
        where === undefined
          ? chatPlatformName(platform)
          : sharedTitle(platform, where.kind),
        personId,
        agentId,
        actorOf({ userId: personId, staff: false }, platform),
        platform,
        where?.thread
      );
    const {
      models: [model],
    } = await modelSettings(this.env);
    if (model === undefined) {
      throw modelErrors.create("model.no_provider");
    }
    if (where !== undefined) {
      await keepAudience(
        this.env,
        this.#refOf(chat.id),
        personId,
        where.audience
      );
    }
    const calls: ToolCall[] = [];
    const remembered: ChatSavedMemory[] = [];
    let answer: Answer;
    try {
      answer = await this.#turn(chat, { text, model }, false, {
        onText,
        calls,
        remembered,
      });
    } catch (error) {
      // What the turn saved before it threw reaches no notice: retired.
      await retireUnseen(
        this.env,
        personId,
        "turn_threw",
        remembered.map(({ memory }) => memory)
      );
      throw error;
    }
    return { chatId: chat.id, answer, calls, remembered };
  }

  /**
   * Asks the chat's agent a question and waits for its answer: the agent
   * loop runs here, its code runs in isolates of its own, and every model
   * request goes through the model gateway, and its rules, as the chat's
   * agent acting for the chat's person. One turn at a time per chat.
   * It takes its caller's word for who asks: a person's questions come
   * through `send`, which checks the chat is theirs.
   */
  async ask(chatId: unknown, question: Question): Promise<Answer> {
    return await this.#turn(this.#chat(chatId), question, false);
  }

  /**
   * A turn of the chat's agent that nobody asked for there and then: what
   * wakes an agent (a schedule, an event) asks through here, with its own
   * opening line as the question. As `ask`, but the turn only reads: a
   * change through a connection is held for the chat's person until they
   * confirm it, ending with the company's day, and every other write or
   * side effect of its code is refused (`AgentScope.unattended`). It takes
   * its caller's word for the chat, as `ask` does; nothing over `/rpc`
   * reaches it.
   */
  async askUnattended(chatId: unknown, question: Question): Promise<Answer> {
    return await this.#turn(this.#chat(chatId), question, true);
  }

  /**
   * Refuses a turn its person may no longer take, or one for a chat that
   * holds all it may; else their role, which the turn's context reads.
   */
  async #mayTakeTurn(
    chatId: Chat["id"],
    personId: Chat["personId"]
  ): Promise<Role> {
    const role = await memberRole(this.env.DB, personId);
    if (role === undefined) {
      throw permissionErrors.create("permission.person_inactive");
    }
    if (this.#storedChars(chatId) > maxChatChars) {
      throw agentErrors.create("agent.chat_full");
    }
    return role;
  }

  /**
   * One turn of `chat`'s agent (`ask`), `unattended` when nobody asked for
   * it there and then: every entry point says which, as what the turn may
   * read depends on it (`answersAlone`). `started` is called once the turn
   * is under way: the model admitted, and nothing kept yet. `calls` gets
   * each call its code makes, as it ends; `remembered` each memory its
   * agent saved, as it is kept.
   */
  async #turn(
    chat: Chat,
    question: Question,
    unattended: boolean,
    {
      started,
      onText,
      calls,
      remembered,
      key,
    }: {
      started?: () => void;
      onText?: (text: string) => unknown;
      calls?: ToolCall[];
      remembered?: ChatSavedMemory[];
      /** The page's key for the question, kept with it in its turn. */
      key?: string;
    } = {}
  ): Promise<Answer> {
    // What the turn's record times from (turn-records.ts).
    const sentAt = Date.now();
    const parsed = questionSchema.safeParse(question);
    if (!parsed.success) {
      throw agentErrors.create("agent.invalid_question");
    }
    // The agent acts for the chat's own person, as this object stored it,
    // never for whoever asks, and only while they are still a member.
    const { personId, via } = chat;
    // Being deleted: its writes are being rejected, and it takes no more.
    if (this.#isDeleting(chat.id)) {
      throw agentErrors.create("agent.chat_not_found");
    }
    // One asker here at a time, whose question this object prepares and
    // whose turn's messages it gathers (`LiveTurn`). Whether the chat may
    // take a turn at all is its ChatSession's to say (`ChatHarness.run`).
    if (this.#turns.has(chat.id)) {
      throw agentErrors.create("agent.busy");
    }
    // Taken before the first await, so a second question waits its turn
    // and the chat isn't deleted under it (`deleteChat`).
    const live: LiveTurn = {
      id: crypto.randomUUID(),
      agentId: chat.agentId,
      unattended,
      reads: [],
      calls,
      remembered,
      underWay: Promise.withResolvers(),
      ended: Promise.withResolvers(),
    };
    this.#turns.set(chat.id, live);
    try {
      // The checks before anything is prepared, each only a read, at once
      // and refused in this order, as one after another would be.
      const [, role, agent] = await allInOrder([
        // Refused while the chat's ChatSession has a turn under way: one
        // this object's restart left there. That object refuses it again
        // as it claims the turn. Asking opens the chat's pi meanwhile.
        (async () => {
          if ((await this.#activeTurn(chat.id)) !== undefined) {
            throw agentErrors.create("agent.busy");
          }
        })(),
        this.#mayTakeTurn(chat.id, personId),
        // The chat's agent as the company has it now: a paused one takes
        // no turn, nor one an admin deleted, and nothing is read for
        // either. Refused before its reach, so each for what it is.
        turnAgent(this.env, chat.agentId),
        // Another of the company's agents answers only those an admin let
        // it answer, and in a chat app only where it works (agent-reach.ts).
        requireAgentReaches(this.env, chat.agentId, personId, via),
      ]);
      // The agent this turn runs as becomes the chat's, before anything is
      // read for the turn: the chat is the context its reads and code work
      // in (restricted.ts), which is its agent's alone. A next question
      // that addresses none then goes to it, and a turn a restart cut
      // short keeps its answers under it (`keepTurnMessages`). After the
      // checks above, so no turn under way loses its chat to another agent.
      const was = this.#chat(chat.id).agentId;
      this.#setChatAgent(chat.id, chat.agentId);
      // Put back if the turn is refused before it starts (`#endLive`).
      live.unstarted = () => {
        this.#setChatAgent(chat.id, was);
      };
      // Before anything is kept: a file it names that the chat hasn't, or
      // that another question carried, refuses the question.
      const files = this.#unsentFiles(chat.id, parsed.data.files ?? []);
      // A turn nobody was there for says so in its scope, which every API
      // of its code reads: it only reads (agent-scope.ts, `unattended`).
      // Its person's own skills steer only a turn they asked for in their
      // own chat (`AgentScope.ownChat`): never a thread others share, nor
      // a turn nobody was there for.
      const scope = this.#scopeOf(chat, { unattended, turn: true });
      // The organization's agent, acting for the chat's person, in this chat:
      // the audit log's actor, and the rules' context (its restricted mode).
      const authority = chatAuthority(scope);
      const work = chatContext(scope);
      // A chat others share reads for all of them, as they were last
      // kept: one whose audience isn't kept reads nothing, so takes no turn.
      const shared = scope.shared === true;
      const audience = shared ? await audienceOf(this.env, work) : undefined;
      if (shared && audience === undefined) {
        throw permissionErrors.create("permission.context_invalid");
      }
      // Whether the turn's answer reaches its person alone: the one gate
      // for their own content, whatever reads it (`answersAlone`).
      const personal = answersAlone(chat, unattended);
      // What the model reads besides the question, and the model admitted,
      // at once: neither reads the other. A refusal of the context's is
      // said first, as before.
      const [context, asked] = await allInOrder([
        this.#turnContext(
          scope,
          authority,
          work,
          { shared, personal, unattended },
          agent,
          role
        ),
        // Refuses a model the deployment or its rules don't allow before
        // anything is kept or shown as started. The chat's object admits it
        // again for its turn, as it sets up a turn a restart cut short on
        // its own, with nobody here to admit it; and every request by the
        // rules then. The agent's own model, where an admin gave it one the
        // organization still has: else the one the question names.
        (async () => {
          const model = await this.#turnModel(
            agent?.model ?? undefined,
            parsed.data.model
          );
          await models(this.env).agent(
            {
              model,
              effort: parsed.data.effort,
              purpose: chatTurnPurpose,
              trigger: delegateActorOf(authority, via),
              provenance: this.#sources(chat.id),
              work: { authority, context: work },
            },
            () => this.#sources(chat.id)
          );
          return model;
        })(),
      ]);
      this.#stopped.delete(chat.id);
      // Under way: the chat keeps the agent it answers as.
      delete live.unstarted;
      live.underWay.resolve(true);
      started?.();
      this.#changed(chat.id);
      this.#listChanged();
      if (via === "web" && !unattended) {
        this.#nameChat(chat.id, parsed.data.text, scope);
      }
      if (onText !== undefined) {
        live.onText = throttled(onText);
      }
      const end = await this.#runTurn({
        turnId: live.id,
        sentAt,
        scope,
        question: turnQuestion(
          { ...parsed.data, model: asked },
          files,
          makeOf(chat),
          key
        ),
        shared,
        audience,
        personal,
        context,
        capture: { attended: !unattended },
      });
      if (end.stopped !== undefined) {
        throw turnStopError(end.stopped);
      }
      const result: TurnResult = {
        outcome: end.outcome,
        answer: end.answer,
        ...(end.error === undefined ? {} : { error: end.error }),
      };
      return {
        ...result,
        provenance: {
          sources: this.#sources(chat.id),
          restricted: this.isChatRestricted(chat.id) === true,
        },
        check: via === "web" ? null : turnCheckOf(live.reads),
        channelText: context.channel?.mark ?? null,
      };
    } finally {
      this.#endLive(chat.id, live);
    }
  }

  /**
   * Names chat `chatId` from `question` in the background, as its first
   * turn begins: asked once, when nothing was said in it yet and it is
   * still called after that question (`seedTitleOf`), never for a later
   * question, whether this one's title came or not. Nothing waits on it:
   * the title lands once the small model answers (chat-titles.ts), only if
   * the chat is still called so then, checked in the same write, so a
   * rename or a plan's name that came first stays. Never rejects; kept
   * with the turns the alarm waits for, so the object stays up for it.
   */
  #nameChat(
    chatId: ChatId,
    question: string,
    scope: Omit<AgentScope, "runId">
  ): void {
    const seed = seedTitleOf(question);
    const [said] = this.#db
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(eq(chatMessages.chatId, chatId))
      .limit(1)
      .all();
    if (said !== undefined || this.#chat(chatId).title !== seed) {
      return;
    }
    const naming = (async () => {
      try {
        const title = await generatedTitle(this.env, scope, question);
        if (title === undefined || title === seed) {
          return;
        }
        this.#db
          .update(chats)
          .set({ title })
          .where(and(eq(chats.id, chatId), eq(chats.title, seed)))
          .run();
        this.#listChanged();
      } catch (error) {
        // Never expected: the chat keeps its seed.
        log.error("chat.title_unsaved", errorFields(error));
      }
    })();
    this.#sent.add(naming);
    void this.#forget(naming);
  }

  /**
   * Ends what the object holds of `live`, the chat's turn, however it
   * ended: its partial answer and output dropped. What it used, the
   * cache's share included, is in its record (turn-records.ts).
   */
  #endLive(chatId: ChatId, live: LiveTurn): void {
    // Refused before it started: the chat stays with the agent it had.
    live.unstarted?.();
    live.underWay.resolve(false);
    live.ended.resolve();
    this.#turns.delete(chatId);
    this.#listChanged();
    this.#partials.delete(chatId);
    this.#waits.delete(chatId);
    // A turn that stopped short of a step's result shows no output on.
    const output = this.#outputs.get(chatId);
    clearTimeout(output?.timer);
    this.#outputs.delete(chatId);
    this.#changed(chatId);
  }

  /**
   * Runs the turn `request` in the chat's own object (chat-session.ts),
   * to its end. A call that broke on its way is made again: the turn goes
   * on there, and the same turn ID joins or finds it rather than asking
   * again (`ChatHarness.run`). That object owns the turn from here: it
   * refuses one while another runs, settles it, and delivers its capture.
   */
  async #runTurn(request: TurnRequest): Promise<TurnEnd> {
    return await this.#toSession(
      request.scope.chatId,
      async (session) => await session.run(request)
    );
  }

  /**
   * Makes `call` to the chat's own object (chat-session.ts), again when it
   * broke on its way (`callObject`), on a stub of its own each time.
   */
  async #toSession<T>(
    chatId: ChatId,
    call: (session: ReturnType<typeof chatSession>) => Promise<T>
  ): Promise<T> {
    return await callObject(async () => await call(this.#session(chatId)));
  }

  /** A stub of the chat's own object (chat-session.ts), here by its name. */
  #session(chatId: ChatId) {
    return chatSession(this.env, this.#refOf(chatId));
  }

  /** Chat `chatId` of this object's, as everything outside it names it. */
  #refOf(chatId: ChatId): ChatRef {
    return { workspaceId: workspaceIdSchema.parse(this.ctx.id.name), chatId };
  }

  /** The agent's scope in `chat`: where it is, whose agent, for whom. */
  #scopeOf(
    chat: Chat,
    {
      unattended = false,
      turn = false,
    }: { unattended?: boolean; turn?: boolean } = {}
  ): Omit<AgentScope, "runId"> {
    const { personId, agentId, via } = chat;
    // A turn whose answer reaches its person alone (`answersAlone`), in
    // Grasp or their direct message on a chat app: the only scope their
    // own skills steer (`AgentScope.ownChat`).
    const ownChat = turn && answersAlone(chat, unattended);
    const workspaceId = workspaceIdSchema.parse(this.ctx.id.name);
    return {
      workspaceId,
      agentId,
      chatId: chat.id,
      personId,
      via,
      ...(unattended ? { unattended: true } : {}),
      ...(ownChat ? { ownChat: true } : {}),
      ...(chat.thread === null ? {} : { shared: true }),
    };
  }

  /**
   * Asks `personId`'s own chat's agent a question (`ask`), and resolves
   * once the turn is under way; refused as `ask` refuses one that can't
   * start. The turn goes on with nobody waiting: its messages go to the
   * chat's watchers as they come, and why it stopped, if it stopped short
   * of an answer, with the chat's state (`ChatUpdate.stopped`).
   */
  async send(
    chatId: unknown,
    personId: string,
    question: Question,
    /**
     * The page's key for this question (`ChatQuestion.key`): a repeat is
     * the same question, taken once. One that comes while the first is
     * still starting waits on that start and resolves or is refused with
     * it; one after resolves at once. A question refused before it
     * started keeps no key, so the page may send it again.
     */
    key?: string
  ): Promise<void> {
    const chat = this.#graspChat(chatId, personId);
    if (key !== undefined && (await this.sentBefore(chatId, personId, key))) {
      return;
    }
    const started = Promise.withResolvers<boolean>();
    if (key !== undefined) {
      this.#starting.set(key, { chatId: chat.id, started: started.promise });
    }
    // Asked: first in its person's list now, as Send was pressed, not once
    // the question is shown (`#store`), which waits on the chat's object
    // and may take seconds; back where it was if it is refused.
    const asked = this.#askedIn(chat.id);
    void this.#takeQuestion(chat, question, started, key);
    try {
      await started.promise;
      if (key !== undefined) {
        this.#keepRequest("send", key, chat.id);
      }
      this.#settledAsk(chat.id, asked, true);
    } catch (error) {
      this.#settledAsk(chat.id, asked, false);
      throw error;
    } finally {
      if (key !== undefined) {
        this.#starting.delete(key);
      }
    }
    // The alarm keeps the object up until the turn ends (`alarm`).
    await this.#alarmBy(Date.now());
  }

  /**
   * Moves chat `chatId` up its person's list as a question is sent in it
   * (`send`), keeping where it stood before the first of those still
   * being taken: what a refused one puts it back to. Answers when.
   */
  #askedIn(chatId: ChatId): Date {
    const asked = new Date();
    const asking = this.#asking.get(chatId) ?? {
      stood: this.#chat(chatId).lastAt,
      taking: new Set<number>(),
      moves: new Set<number>(),
    };
    asking.taking.add(asked.getTime());
    asking.moves.add(asked.getTime());
    this.#asking.set(chatId, asking);
    this.#movedTo(chatId, asked);
    return asked;
  }

  /**
   * The question sent in chat `chatId` at `asked` was taken, or refused.
   * Taken, the chat was asked in then: where it stands from now on. Once
   * none is still being taken, a chat no question since moved (its last
   * activity still one of theirs) goes back to where it stood.
   */
  #settledAsk(chatId: ChatId, asked: Date, taken: boolean): void {
    const asking = this.#asking.get(chatId);
    if (asking === undefined) {
      return;
    }
    asking.taking.delete(asked.getTime());
    if (taken) {
      asking.stood = asked;
    }
    if (asking.taking.size > 0) {
      return;
    }
    this.#asking.delete(chatId);
    const { lastAt } = this.#chat(chatId);
    // Last moved by a refused question: back where it stood. One a
    // message or a note moved since stays where that put it.
    if (
      asking.moves.has(lastAt.getTime()) &&
      lastAt.getTime() !== asking.stood.getTime()
    ) {
      this.#movedTo(chatId, asking.stood, lastAt);
    }
  }

  /**
   * Moves the chat in its person's list to `lastAt`, as active then;
   * given `from`, only while nothing moved it since.
   */
  #movedTo(chatId: ChatId, lastAt: Date, from?: Date): void {
    this.#db
      .update(chats)
      .set({ lastAt })
      .where(
        and(
          eq(chats.id, chatId),
          from === undefined ? undefined : eq(chats.lastAt, from)
        )
      )
      .run();
    this.#listChanged();
  }

  /**
   * Whether `personId`'s chat took the question with `key` already
   * (`send`): resolves once it has, as the first call did, or is refused
   * with it; false for a key not taken, or one whose question a restart
   * lost. What `send`'s caller asks first, so a repeat is checked for
   * nothing a new question would be (chats-rpc.ts).
   */
  async sentBefore(
    chatId: unknown,
    personId: string,
    key: string
  ): Promise<boolean> {
    const chat = this.#graspChat(chatId, personId);
    const taken = this.#requested("send", key);
    // Another chat's key says nothing of this question.
    if (
      (taken ?? this.#starting.get(key) ?? { chatId: chat.id }).chatId !==
      chat.id
    ) {
      throw agentErrors.create("agent.invalid_question");
    }
    if (taken !== undefined && (await this.#questionStands(chat, taken.at))) {
      return true;
    }
    // After the last await, so of two repeats only one starts a turn.
    const starting = this.#starting.get(key);
    if (starting === undefined) {
      return false;
    }
    await starting.started;
    return true;
  }

  /**
   * Takes the question `send` was asked, and tells `started` once it is
   * taken, or why it wasn't: queued into the chat's turn while one runs
   * here (`#queueInto`), or into the one this object's restart left
   * running in its ChatSession (`#queueIntoLeft`), else asked in a turn of
   * its own (`#sentTurns`),
   * as it is once the turn it was meant for takes no more. Whether a turn
   * runs is decided with nothing awaited before the new one claims the
   * chat, so of two questions at once one starts it and the other queues.
   */
  async #takeQuestion(
    chat: Chat,
    question: Question,
    started: PromiseWithResolvers<boolean>,
    /** The page's key for it (`send`): its ID in the turn too, where given. */
    key: string | undefined
  ): Promise<void> {
    // The question's own ID in its turn: the same however often it is sent
    // there, as the page's key is.
    const id = key ?? crypto.randomUUID();
    // Whether the chat's ChatSession was asked for a turn this object's
    // restart left running there: once, and only when the chat shows one.
    let askedLeft = false;
    try {
      for (;;) {
        const live = this.#turns.get(chat.id);
        if (live === undefined && !askedLeft && this.#isRunning(chat.id)) {
          askedLeft = true;
          // oxlint-disable-next-line no-await-in-loop -- once, see above
          if (await this.#queueIntoLeft(chat, { id, key }, question)) {
            started.resolve(true);
            return;
          }
          // A turn may have started here meanwhile: looked for again.
          continue;
        }
        if (live === undefined) {
          const ended = this.#sentTurns(chat, question, started, key);
          this.#sent.add(ended);
          void this.#forget(ended);
          return;
        }
        if (
          // oxlint-disable-next-line no-await-in-loop -- once more only when that turn ended meanwhile
          await this.#queueInto(
            chat,
            {
              id: live.id,
              agentId: live.agentId,
              underWay: live.underWay.promise,
            },
            { id, key },
            question
          )
        ) {
          started.resolve(true);
          return;
        }
        // oxlint-disable-next-line no-await-in-loop -- see above
        await live.ended.promise;
      }
    } catch (error) {
      started.reject(error);
    }
  }

  /**
   * Queues `question`, a person's question to their chat's agent sent
   * while its turn `live` runs, into that turn (`ChatHarness.queueQuestion`), as
   * Claude Code, Codex and T3 Code take a message sent while their agent
   * works: shown queued (`turnQueued`) until the agent takes it as its
   * current step ends, then answered in order, in the same turn, by the
   * same model. Checked as a question of a turn of its own is, for what
   * still holds of it (its person, the chat's room, its files). One that
   * addresses another agent, which answers in a turn of its own, is
   * refused as before (`agent.busy`), as the turn's ChatSession refuses
   * one sent while a turn nobody asked for runs (a wake), which only
   * reads, so never answers in the person's own scope. False when the
   * turn takes no more.
   */
  async #queueInto(
    chat: Chat,
    live: Pick<LiveTurn, "id" | "agentId"> & { underWay: Promise<boolean> },
    /** Its own ID in the turn, and the page's key, which goes with it. */
    { id, key }: QueuedAs,
    question: Question
  ): Promise<boolean> {
    const parsed = questionSchema.safeParse(question);
    if (!parsed.success) {
      throw agentErrors.create("agent.invalid_question");
    }
    const {
      text,
      files = [],
      subject,
      mentions,
      built,
      followUp,
    } = parsed.data;
    if (
      followUp === true ||
      mentions?.some(({ kind }) => kind === "agent") === true
    ) {
      throw agentErrors.create("agent.busy");
    }
    if (!(await live.underWay)) {
      return false;
    }
    if (this.#isDeleting(chat.id)) {
      throw agentErrors.create("agent.chat_not_found");
    }
    // Its person still a member, the chat with room, and the turn's agent
    // not paused or deleted since it started: checked as a turn's are.
    await allInOrder([
      this.#mayTakeTurn(chat.id, chat.personId),
      turnAgent(this.env, live.agentId),
    ]);
    const carried = this.#unsentFiles(chat.id, files);
    const queued: QueuedQuestion = {
      id,
      ...(key === undefined ? {} : { key }),
      text,
      files: carried.map(({ id: fileId, type }) => ({ id: fileId, type })),
      ...(subject === undefined ? {} : { subject }),
      ...(mentions === undefined ? {} : { mentions }),
      ...(built === undefined ? {} : { built }),
    };
    return await this.#toSession(
      chat.id,
      async (session) => await session.queueQuestion(live.id, queued)
    );
  }

  /**
   * Queues `question` into the chat's turn that runs in its ChatSession
   * though this object holds none (`#turns`): one this object's restart
   * left there, which goes on answering. As `#queueInto` does, the turn
   * under way and running as the chat's agent, which it became as the turn
   * began. False when there is none, or it takes no more: the question is
   * then asked in a turn of its own, refused while that one settles
   * (`agent.busy`), as before.
   */
  async #queueIntoLeft(
    chat: Chat,
    as: QueuedAs,
    question: Question
  ): Promise<boolean> {
    const turnId = await this.#activeTurn(chat.id);
    if (turnId === undefined || this.#turns.has(chat.id)) {
      return false;
    }
    return await this.#queueInto(
      chat,
      {
        id: turnId,
        agentId: this.#chat(chat.id).agentId,
        underWay: Promise.resolve(true),
      },
      as,
      question
    );
  }

  /**
   * The turns of a question `send` was asked: one for each agent the
   * person addressed in it (an agent `mentions` names, as core found each
   * one they may ask, chats-rpc.ts), in the order they named them, each
   * answering as itself, with its own reach, classes and documents; else
   * one for the chat's agent. The first takes the question; each next one
   * takes it again, after the answers before it, which the person doesn't
   * see twice. The chat's agent becomes each in turn as its turn starts,
   * so a next question that addresses none goes to the last that answered.
   * A next turn starts only after the one before it ended as it should.
   */
  async #sentTurns(
    chat: Chat,
    question: Question,
    started: PromiseWithResolvers<boolean>,
    /** The page's key for the question, which the first turn keeps with it. */
    key: string | undefined
  ): Promise<void> {
    const addressed = (question.mentions ?? []).flatMap((mention) =>
      mention.kind === "agent" ? [mention] : []
    );
    const [first, ...rest] = addressed;
    let answered = await this.#sentTurn(
      first === undefined ? chat : { ...chat, agentId: first.id },
      question,
      started,
      false,
      key
    );
    for (const next of rest) {
      if (!answered) {
        return;
      }
      // Nobody waits on a next turn's start: one refused before it
      // starts (an agent paused meanwhile) says why on the chat, as one
      // stopped short does (`#sentTurn`, with no `started`).
      // oxlint-disable-next-line no-await-in-loop -- each agent answers after the one before it
      answered = await this.#sentTurn(
        { ...chat, agentId: next.id },
        {
          text: followUpText(next.name),
          model: question.model,
          ...(question.effort === undefined ? {} : { effort: question.effort }),
          followUp: true,
        },
        undefined,
        false
      );
    }
  }

  /**
   * As `askUnattended`, but resolves once the turn is under way, as `send`
   * does: what wakes an agent doesn't wait for its answer. Refused as
   * `ask` refuses a turn that can't start.
   */
  async sendUnattended(chatId: unknown, question: Question): Promise<void> {
    const chat = this.#chat(chatId);
    const started = Promise.withResolvers<boolean>();
    const ended = this.#sentTurn(chat, question, started, true);
    this.#sent.add(ended);
    void this.#forget(ended);
    await started.promise;
    await this.#alarmBy(Date.now());
  }

  /**
   * The turn `send` started: `started` resolves once it is under way, or
   * rejects with why it couldn't start. Why one under way stopped short
   * goes to the chat's watchers.
   */
  async #sentTurn(
    chat: Chat,
    question: Question,
    /**
     * Told once the turn is under way, or why it couldn't start; none for
     * a turn nobody waits on, whose reason goes on the chat instead.
     */
    started: PromiseWithResolvers<boolean> | undefined,
    unattended: boolean,
    /** The page's key for the question (`send`). */
    key?: string
  ): Promise<boolean> {
    let underWay = false;
    try {
      const answer = await this.#turn(chat, question, unattended, {
        started: () => {
          underWay = true;
          started?.resolve(true);
        },
        ...(key === undefined ? {} : { key }),
      });
      return answer.outcome === "answered";
    } catch (error) {
      if (!underWay && started !== undefined) {
        started.reject(error);
        return false;
      }
      this.#stopped.set(chat.id, stopReason(chat.id, error));
      this.#changed(chat.id);
      return false;
    }
  }

  /** Makes `agentId` the agent of the chat `chatId`, unless it already is. */
  #setChatAgent(chatId: ChatId, agentId: string): void {
    this.#db
      .update(chats)
      .set({ agentId })
      .where(and(eq(chats.id, chatId), ne(chats.agentId, agentId)))
      .run();
  }

  /** Forgets a turn `send` started once it has ended. */
  async #forget(ended: Promise<unknown>): Promise<void> {
    try {
      await ended;
    } finally {
      this.#sent.delete(ended);
    }
  }

  /**
   * Ends the App writes held here past their day (`#lapseDueHeldAppCalls`),
   * then waits for every turn `send` started, however long they take: an
   * object runs while an event of its own does, so it isn't evicted under
   * a turn nobody waits on. An alarm may run 15 minutes; a turn that takes
   * longer goes on while the object stays up. After a restart there are
   * none: the chat goes on from what it stored, told that its turn was cut
   * short (`#closeInterruptedTurns`).
   */
  override async alarm(): Promise<void> {
    await this.#finishDeletes();
    // Held App writes past their day end first, so the drain below takes
    // their records too.
    await this.#lapseDueHeldAppCalls(Date.now());
    // Audit events the log didn't take yet go first: a turn may run long.
    await this.#drainAudit(loneNotesPerDrain);
    while (this.#sent.size > 0) {
      // oxlint-disable-next-line no-await-in-loop -- until none is left, as more may start
      await Promise.all(this.#sent);
    }
  }

  /**
   * The model a turn asks: its agent's own (`agentModel`) while the
   * organization still has it among the models it chose, else the one the
   * question names. An agent whose model was taken away keeps answering.
   */
  async #turnModel(
    agentModel: string | undefined,
    named: string
  ): Promise<string> {
    if (agentModel === undefined || agentModel === named) {
      return named;
    }
    const { models: chosen } = await modelSettings(this.env);
    return chosen.includes(agentModel) ? agentModel : named;
  }

  /**
   * What the model reads this turn besides the question: the instruction
   * files of where it works (instruction-files.ts, read now, so an edit
   * counts from the next turn), the skills it may use, from the Brain,
   * and how to answer on the chat platform it came through, if any. Each
   * read on its own, so all at once; a refusal said in this order.
   */
  async #turnContext(
    scope: Parameters<typeof auditAgentCall>[1],
    authority: Authority,
    work: Extract<WorkContext, { type: "chat" }>,
    {
      shared,
      personal,
      unattended,
    }: { shared: boolean; personal: boolean; unattended: boolean },
    agent: Awaited<ReturnType<typeof turnAgent>>,
    /** The chat's person's role now (`#mayTakeTurn`). */
    role: Role
  ): Promise<TurnContext> {
    const chat = this.#chat(work.chatId);
    const { via } = chat;
    const [instructions, skills, channel, kept, person] = await allInOrder([
      this.#turnInstructions(chat, scope, authority, shared, personal),
      this.#turnSkills(scope, authority, shared),
      // A chat that came through a chat platform: how to answer there.
      via === "web" ? undefined : channelText(),
      // The documents an admin gave the chat's agent, by name.
      agent === undefined ? [] : documentsOf(this.env, agent.id),
      namedPerson(this.env, scope.personId, personal),
    ]);
    // Only who builds is told how, reads Grasp's docs and gets the APIs
    // and tools to build with, in their own chat, in Grasp's app or their
    // direct message on a chat app: thousands of tokens in every request,
    // of no use to anyone else. Building, an App included, needs a role
    // that builds (app-access.ts).
    const builds = buildsIn({ shared, role });
    // Who drafts an agent for its person to make (`draftAgent`).
    const drafts = draftsOf({ shared, unattended, via, role });
    const documents = kept.map(({ id, name, type }) => ({ id, name, type }));
    return {
      ...person,
      instructions: instructions.map(({ file, text }) => ({ file, text })),
      skills,
      channel,
      builds,
      ...(drafts === undefined ? {} : { drafts }),
      // The first agent as Grasp ships it, with no document, is told
      // nothing more.
      ...(agent === undefined ||
      (agent.changedAt === null && documents.length === 0)
        ? {}
        : {
            agent: {
              name: agent.name,
              ...(documents.length === 0 ? {} : { documents }),
            },
          }),
    };
  }

  /**
   * The instruction files a turn of `chat` reads. A Brain that can't give
   * them leaves the turn without them, as it does without skills
   * (`#turnSkills`) and without the person's own file when their store
   * fails (brain-next.ts): missing guidance is no question of access. A
   * refusal (who it acts for, where) still refuses the turn. One that went
   * without them is recorded, as the skills' call records it.
   */
  async #turnInstructions(
    chat: Chat,
    scope: Parameters<typeof auditAgentCall>[1],
    authority: Authority,
    shared: boolean,
    personal: boolean
  ): Promise<Awaited<ReturnType<typeof instructionFilesFor>>> {
    try {
      const appId = await lastAppOf(
        this.env,
        this.#refOf(chat.id),
        chat.thread
      );
      return await instructionFilesFor(
        this.env,
        authority,
        instructionContextOf(shared, appId, personal)
      );
    } catch (error) {
      if (permissionErrors.codeOf(error) !== undefined) {
        throw error;
      }
      log.warn("instructions.turn_unavailable", {
        errorName: error instanceof Error ? error.name : typeof error,
      });
      await auditAgentCall(this.env, scope, {
        method: "brain.instructions",
        detail: { files: 0, turn: true, unavailable: true },
      });
      return [];
    }
  }

  /**
   * The skills a turn may use, from the Brain: guidance, never a grant
   * (brain-skills.ts). Their own skills only where the scope says so, a
   * turn they asked for in their own chat, and their teams' only where
   * nobody else reads the answer (`skillsReachOf`); only those whose needs
   * the chat's agent meets now (`heldIn`). Recorded as the code's calls
   * are, by count. A Brain that can't answer leaves the turn without
   * them, not without an answer: missing guidance is no question of access.
   */
  async #turnSkills(
    scope: Parameters<typeof auditAgentCall>[1],
    authority: Authority,
    shared: boolean
  ): Promise<Awaited<ReturnType<typeof skillsFor>>> {
    let skills: Awaited<ReturnType<typeof skillsFor>> = [];
    let unavailable = false;
    try {
      const reach = skillsReachOf(scope, shared);
      skills = await skillsFor(
        this.env,
        authority,
        reach,
        heldIn(this.env, scope, reach)
      );
    } catch (error) {
      unavailable = true;
      log.warn("skills.turn_unavailable", {
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
    await auditAgentCall(this.env, scope, {
      method: "brain.skills",
      detail: {
        skills: skills.length,
        turn: true,
        ...(unavailable ? { unavailable } : {}),
      },
    });
    return skills;
  }

  /**
   * Opens a code run of the chat: its lease, and its record, as `running`
   * on this runtime. Its ID is random, and the only way its stubs reach
   * it. Called by the chat's turn `turnId` as it starts a run
   * (`runTurn`): the turn's draft writes make one version (`saveDraft`).
   */
  openCodeRun(chatId: ChatId, turnId: string, opening: CodeRunOpening): string {
    const id = crypto.randomUUID();
    this.ctx.storage.transactionSync(() => {
      this.#db
        .insert(chatCodeRuns)
        .values({
          id,
          chatId,
          turnId,
          ...opening,
          toolCallId: opening.toolCallId.slice(0, maxToolCallIdChars),
          ...codeRuntime(this.env),
          status: "running",
          startedAt: new Date(),
        })
        .run();
      // The chat keeps the records of its latest runs only.
      this.#db
        .delete(chatCodeRuns)
        .where(
          and(
            eq(chatCodeRuns.chatId, chatId),
            sql`${chatCodeRuns.id} NOT IN (SELECT ${chatCodeRuns.id} FROM ${chatCodeRuns} WHERE ${chatCodeRuns.chatId} = ${chatId} ORDER BY ${chatCodeRuns.startedAt} DESC LIMIT ${codeRunRecordsKept})`
          )
        )
        .run();
    });
    this.#codeRuns.set(`${chatId}/${id}`, { calls: 0, openedAt: Date.now() });
    return id;
  }

  /**
   * Closes a code run of the chat as it ended (`status`), unless a
   * revocation closed it first: that is how it ended, whatever its code
   * did after. Records it, and returns how it ended.
   */
  closeCodeRun(
    chatId: ChatId,
    runId: string,
    status: CodeRunStatus
  ): CodeRunStatus {
    const key = `${chatId}/${runId}`;
    const lease = this.#codeRuns.get(key);
    const ended: CodeRunStatus =
      lease !== undefined && "closed" in lease && lease.closed === "revoked"
        ? "revoked"
        : status;
    if (lease === undefined || !("closed" in lease)) {
      this.#closeLease(key, "ended");
    }
    // No more of its output is taken or shown; what is shown stays until
    // its result is stored (`#keep`), which shows all of it.
    const output = this.#outputs.get(chatId);
    if (output?.runId === runId) {
      output.ended = true;
      clearTimeout(output.timer);
      output.timer = undefined;
    }
    this.#db
      .update(chatCodeRuns)
      .set({ status: ended, endedAt: new Date() })
      .where(
        and(
          eq(chatCodeRuns.id, runId),
          eq(chatCodeRuns.chatId, chatId),
          eq(chatCodeRuns.status, "running")
        )
      )
      .run();
    return ended;
  }

  /**
   * Ends a code run of the chat's turn. Its lease closes first, at once
   * and whatever follows, so nothing it still does is admitted from here
   * on. Then revocations since it opened are read once more, so one its
   * code never called after is still noticed: the run is recorded as
   * revoked (once), and the turn hands on nothing of it. A read that
   * fails counts as a revocation: the run's result is withheld rather
   * than trusted unchecked.
   */
  async #endCodeRun(
    scope: Omit<AgentScope, "runId">,
    runId: string,
    status: CodeRunStatus
  ): Promise<CodeRunStatus> {
    // What the run logged before it ended is checked before it closes, as
    // its lines come before its end (chat-harness.ts): a revocation is
    // noticed where the run's own order puts it, however the calls raced.
    const output = this.#outputs.get(scope.chatId);
    if (
      output?.runId === runId &&
      (output.timer !== undefined || output.check !== undefined)
    ) {
      output.closing = true;
      await this.#checkNow(scope.chatId, output);
    }
    const admission = this.admitFromCodeRun(scope.chatId, runId);
    const ended = this.closeCodeRun(scope.chatId, runId, status);
    if (admission.call !== "open" || ended === "revoked") {
      return ended;
    }
    let revoked: boolean;
    let unreadable = false;
    try {
      revoked = await revokedSince(this.env, scope, admission.openedAt);
    } catch (error) {
      log.error("agent.revocation_read_failed", {
        chatId: scope.chatId,
        runId,
        ...errorFields(error),
      });
      revoked = true;
      unreadable = true;
    }
    if (!revoked) {
      return ended;
    }
    this.#dropOutput(scope.chatId, runId);
    this.#db
      .update(chatCodeRuns)
      .set({ status: "revoked" })
      .where(
        and(
          eq(chatCodeRuns.id, runId),
          eq(chatCodeRuns.chatId, scope.chatId),
          eq(chatCodeRuns.status, ended)
        )
      )
      .run();
    // Recorded through the outbox, which never fails the turn.
    await auditAgentCall(
      this.env,
      scope,
      { method: "executeCode" },
      {
        outcome: "refused",
        reason: unreadable
          ? "agent.revocation_read_failed"
          : "agent.run_revoked",
      }
    );
    return "revoked";
  }

  /**
   * Closes a code run of the chat's turn as `#endCodeRun` does: called by
   * the chat's own object (chat-session.ts) as each of its runs ends. For
   * the agent and person the chat holds, whatever the caller kept.
   */
  async endTurnRun(
    chatId: ChatId,
    runId: string,
    status: CodeRunStatus
  ): Promise<CodeRunEnd> {
    const ended = await this.#endCodeRun(
      this.#scopeOf(this.#chat(chatId)),
      runId,
      status
    );
    // Read once the run is closed, when none of its calls can record a
    // read any more: every read it hands on, as each call recorded it
    // before handing it to the run (`recordSources`). A revoked run hands
    // nothing on.
    if (ended === "revoked") {
      return { status: ended, readFrom: [] };
    }
    const readFrom = this.#db
      .select({ sourceId: chatRunSources.sourceId })
      .from(chatRunSources)
      .where(
        and(eq(chatRunSources.chatId, chatId), eq(chatRunSources.runId, runId))
      )
      .orderBy(chatRunSources.sourceId)
      .all()
      .flatMap(({ sourceId }) => outsideReadOf(sourceId) ?? []);
    const told =
      this.#db
        .select({ outsideText: chatCodeRuns.outsideText })
        .from(chatCodeRuns)
        .where(and(eq(chatCodeRuns.id, runId), eq(chatCodeRuns.chatId, chatId)))
        .get()?.outsideText ?? [];
    return { status: ended, readFrom: [...readFrom, ...told] };
  }

  /**
   * What the chat's turn may send now, asked by its own object before every
   * model request: the runs whose results it withholds (`#withheldRuns`),
   * everything the chat has read from, for the gateway's rules, and why it
   * may not go on, when its person may no longer act. For the agent and
   * person the chat holds, whatever the caller kept.
   */
  async turnGuard(chatId: ChatId): Promise<{
    withheld: string[];
    sources: string[];
    stop?: "person_inactive";
  }> {
    const scope = this.#scopeOf(this.#chat(chatId));
    const active = await memberRole(this.env.DB, scope.personId);
    return {
      withheld: [...(await this.#withheldRuns(scope))],
      sources: this.#sources(scope.chatId),
      ...(active === undefined ? { stop: "person_inactive" as const } : {}),
    };
  }

  /**
   * Whether the chat shows its turn running: a question this object is
   * taking (`#turns`), or a turn its ChatSession says runs (`turnRunning`).
   */
  #isRunning(chatId: ChatId): boolean {
    return (
      this.#turns.has(chatId) ||
      this.ctx.storage.kv.get(`${runningKeyPrefix}${chatId}`) !== undefined
    );
  }

  /**
   * The chat's `ChatSession` gave its turn up, as it couldn't open the
   * chat for a while (chat-session.ts): no longer running, and stopped
   * with why, which the chat shows with a Try again.
   */
  turnLost(chatId: ChatId): void {
    if (this.chatState(chatId) === undefined || this.#isDeleting(chatId)) {
      return;
    }
    this.#stopped.set(chatId, agentErrors.create("agent.turn_lost").message);
    this.turnRunning(chatId, false);
  }

  /**
   * The chat's `ChatSession` says whether a turn of the chat runs there,
   * as its record of the turn is claimed and settled (chat-harness.ts):
   * what the chat's lists and watchers show.
   */
  turnRunning(chatId: ChatId, running: boolean): void {
    if (this.chatState(chatId) === undefined || this.#isDeleting(chatId)) {
      return;
    }
    const key = `${runningKeyPrefix}${chatId}`;
    if (running) {
      this.ctx.storage.kv.put(key, true);
    } else {
      this.ctx.storage.kv.delete(key);
    }
    this.#changed(chatId);
    this.#listChanged();
  }

  /**
   * The chat's `ChatSession` says which questions queued into its turn it
   * hasn't taken yet (chat-harness.ts `queueQuestion`): what the chat's watchers
   * show, kept through a restart of this object.
   */
  turnQueued(chatId: ChatId, queued: readonly ChatQueued[]): void {
    if (this.chatState(chatId) === undefined || this.#isDeleting(chatId)) {
      return;
    }
    const key = `${queuedKeyPrefix}${chatId}`;
    if (queued.length === 0) {
      this.ctx.storage.kv.delete(key);
    } else {
      this.ctx.storage.kv.put(key, queued);
    }
    this.#changed(chatId);
  }

  /** The questions queued into the chat's turn, as its ChatSession last said. */
  #queued(chatId: ChatId): ChatQueued[] {
    const kept = chatQueuedSchema.safeParse(
      this.ctx.storage.kv.get(`${queuedKeyPrefix}${chatId}`)
    );
    return kept.success ? kept.data : [];
  }

  /**
   * The chat's turn under way, as its ChatSession, which owns it, says:
   * what a stop ends.
   */
  async #activeTurn(chatId: ChatId): Promise<string | undefined> {
    return await this.#toSession(
      chatId,
      async (session) => await session.activeTurn()
    );
  }

  /**
   * Keeps what the chat's turn committed, in order, as the chat shows it:
   * a question with the files it carries, and the agent's words as the
   * model wrote them. Each entry once
   * (`copiedKeyPrefix`): a copy its object sends again is passed over.
   * Answers the last answer kept of them, a response or a stopped turn's
   * end, for the turn's capture: as the first copy did, for one sent again.
   */
  keepTurnMessages(
    chatId: ChatId,
    messages: readonly TurnMessage[]
  ): number | undefined {
    if (this.chatState(chatId) === undefined || this.#isDeleting(chatId)) {
      return undefined;
    }
    const { agentId: chatAgent, personId, via } = this.#chat(chatId);
    const live = this.#turns.get(chatId);
    // What the model said is its turn's agent's: the live turn's, or, for
    // a turn a restart cut short, the chat's, which the turn set as it
    // started (`send`).
    const turnAgentId = live?.agentId ?? chatAgent;
    const copiedKey = `${copiedKeyPrefix}${chatId}`;
    const copied = copiedSchema.safeParse(this.ctx.storage.kv.get(copiedKey));
    const before = copied.success ? copied.data : { through: 0 };
    let { through, answer } = before;
    let answered = false;
    for (const {
      entryId,
      message,
      files = [],
      thinkingMs,
      built,
      key,
    } of messages) {
      answered ||= message.role === "assistant";
      if (entryId <= before.through) {
        continue;
      }
      through = Math.max(through, entryId);
      if (message.role === "assistant") {
        this.#partials.delete(chatId);
      }
      // A question with the key its page sent it with, which its entry
      // keeps (`TurnMessage.key`).
      const id = this.#keep(chatId, message, {
        ...keptWith(message, turnAgentId, { files, thinkingMs, built }),
        ...(key === undefined ? {} : { key }),
      });
      if (message.role === "assistant") {
        answer = id;
      }
      this.#savedIn({ personId, via }, live, message);
    }
    // With the messages: no await between, so they are stored together.
    if (through > before.through) {
      this.ctx.storage.kv.put(copiedKey, { through, answer });
    }
    return answered ? answer : undefined;
  }

  /**
   * A memory the chat's agent saved (`message`, a call of `remember`), for
   * the asker of the live turn who shows its notice. In a chat app's
   * conversation with nobody here to post it (the turn was cut short, or
   * its result came after the turn ended), nobody ever will: retired
   * (unseen-memories.ts). Grasp's own chat shows it from the message.
   */
  #savedIn(
    { personId, via }: Pick<Chat, "personId" | "via">,
    live: LiveTurn | undefined,
    message: Message
  ): void {
    const saved = message.role === "toolResult" ? savedOf(message) : undefined;
    if (saved === undefined) {
      return;
    }
    if (live?.remembered !== undefined) {
      live.remembered.push(saved);
    } else if (via !== "web") {
      this.ctx.waitUntil(
        retireUnseen(this.env, personId, "no_asker", [saved.memory])
      );
    }
  }

  /** Shows the chat's watchers the answer streaming in, or none. */
  showPartial(chatId: ChatId, partial: AssistantMessage | null): void {
    if (this.chatState(chatId) === undefined || this.#isDeleting(chatId)) {
      return;
    }
    if (partial === null) {
      this.#partials.delete(chatId);
    } else {
      this.#partials.set(chatId, partial);
      this.#turns.get(chatId)?.onText?.(partialOf(partial).text);
    }
    this.#changed(chatId);
  }

  /**
   * What code runs keep in this object now, read from its own state:
   * leases open and closed, and outputs held. After any number of runs,
   * none open and no output, and at most {@link endedRunsKept} closed.
   * What the runtime holds for them (isolates, RPC sessions) isn't here:
   * workerd offers no signal of it to read.
   */
  codeRunRetention(): { open: number; closed: number; outputs: number } {
    let open = 0;
    for (const lease of this.#codeRuns.values()) {
      if (!("closed" in lease)) {
        open += 1;
      }
    }
    return {
      open,
      closed: this.#codeRuns.size - open,
      outputs: this.#outputs.size,
    };
  }

  /**
   * Takes a line a code run of the chat logged, for its watchers as the
   * code step `callId`'s output: counted and bounded here, whatever the
   * isolate claims, and shown only once a read of revocations begun after
   * it arrived finds none (`#checkOutput`, at most once a second a run).
   * Dropped once the run has closed, so a line that arrives late reopens
   * nothing and reaches no other step or turn.
   */
  codeRunOutput(
    chatId: ChatId,
    runId: string,
    callId: string,
    line: string
  ): void {
    if (this.admitFromCodeRun(chatId, runId).call !== "open") {
      return;
    }
    const before = this.#outputs.get(chatId);
    const output: RunOutput =
      before?.runId === runId
        ? before
        : {
            runId,
            callId,
            agentId: this.#chat(chatId).agentId,
            lines: [],
            rawBytes: 0,
            shown: 0,
            text: "",
            checkedAt: 0,
            checking: false,
            check: undefined,
            closing: false,
            timer: undefined,
            ended: false,
            cutAt: undefined,
          };
    if (output.cutAt !== undefined) {
      return;
    }
    if (output.lines.length >= codeLimits.logLines) {
      output.cutAt = output.lines.length;
      this.#outputs.set(chatId, output);
      this.#scheduleOutputCheck(chatId, output);
      return;
    }
    // A line past the bytes left keeps what fits, never half a character,
    // and nothing after it is taken.
    const left = maxRawOutputBytes - output.rawBytes;
    const bytes = utf8Bytes(line);
    const kept = bytes <= left ? line : cutToBytes(line, left);
    output.lines.push(kept);
    output.rawBytes += bytes <= left ? bytes : utf8Bytes(kept);
    if (bytes > left) {
      output.cutAt = output.lines.length;
    }
    this.#outputs.set(chatId, output);
    this.#scheduleOutputCheck(chatId, output);
  }

  /** Reads revocations for `output` soon: at most once a second a run. */
  #scheduleOutputCheck(chatId: ChatId, output: RunOutput): void {
    if (output.checking || output.timer !== undefined || output.ended) {
      return;
    }
    const wait = Math.max(0, output.checkedAt + outputCheckMs - Date.now());
    output.timer = setTimeout(() => {
      void this.#checkNow(chatId, output);
    }, wait);
  }

  /**
   * Reads revocations for the run's output now, its timer cleared, or
   * joins the read under way.
   */
  async #checkNow(chatId: ChatId, output: RunOutput): Promise<void> {
    clearTimeout(output.timer);
    output.timer = undefined;
    output.check ??= (async () => {
      try {
        await this.#checkOutput(chatId, output);
      } finally {
        output.check = undefined;
      }
    })();
    await output.check;
  }

  /**
   * Reads revocations since the run opened, then shows the lines that had
   * arrived before the read began. One found (or a read that fails) closes
   * the run's lease as revoked and shows nothing more of it.
   */
  async #checkOutput(chatId: ChatId, output: RunOutput): Promise<void> {
    const admission = this.admitFromCodeRun(chatId, output.runId);
    if (this.#outputs.get(chatId) !== output || admission.call !== "open") {
      return;
    }
    output.checking = true;
    output.checkedAt = Date.now();
    const arrived = output.lines.length;
    let revoked: boolean;
    let unreadable = false;
    try {
      revoked = await revokedSince(
        this.env,
        { agentId: output.agentId, ...this.#refOf(chatId) },
        admission.openedAt
      );
    } catch (error) {
      log.error("agent.revocation_read_failed", {
        chatId,
        runId: output.runId,
        ...errorFields(error),
      });
      revoked = true;
      unreadable = true;
    } finally {
      output.checking = false;
    }
    if (this.#outputs.get(chatId) !== output || output.ended) {
      return;
    }
    if (revoked) {
      this.#dropOutput(chatId, output.runId);
      const chat = this.#chat(chatId);
      if (this.revokeCodeRun(chatId, output.runId)) {
        await auditAgentCall(
          this.env,
          {
            workspaceId: workspaceIdSchema.parse(this.ctx.id.name),
            agentId: chat.agentId,
            chatId,
            personId: chat.personId,
            via: chat.via,
          },
          { method: "output" },
          {
            outcome: "refused",
            reason: unreadable
              ? "agent.revocation_read_failed"
              : "agent.run_revoked",
          }
        );
      }
      return;
    }
    // A run closing shows its lines with its result, never just before.
    if (output.closing) {
      return;
    }
    output.shown = arrived;
    output.text = shownText(
      output.lines.slice(0, arrived),
      output.cutAt !== undefined && arrived >= output.cutAt
    );
    this.#changed(chatId);
    if (output.lines.length > output.shown) {
      this.#scheduleOutputCheck(chatId, output);
    }
  }

  /** Drops the run's output, shown or not, and tells the chat's watchers. */
  #dropOutput(chatId: ChatId, runId: string): void {
    const output = this.#outputs.get(chatId);
    if (output?.runId !== runId) {
      return;
    }
    clearTimeout(output.timer);
    this.#outputs.delete(chatId);
    this.#changed(chatId);
  }

  /**
   * Closes a code run's lease, and forgets the oldest closed runs past the
   * cap. Moved to the end, so the map keeps closed runs oldest first.
   */
  #closeLease(key: string, closed: "ended" | "revoked"): void {
    this.#codeRuns.delete(key);
    this.#codeRuns.set(key, { closed, reported: false });
    const ended = [...this.#codeRuns.keys()].filter((run) => {
      const lease = this.#codeRuns.get(run);
      return lease !== undefined && "closed" in lease;
    });
    const [oldest] = ended;
    if (ended.length > endedRunsKept && oldest !== undefined) {
      this.#codeRuns.delete(oldest);
    }
  }

  /**
   * Closes an open code run of the chat because a permission of its agent
   * was revoked after it opened (agent-scope.ts): none of its calls or
   * writes is admitted from then on. `false` when it was closed already.
   */
  revokeCodeRun(chatId: ChatId, runId: string): boolean {
    const key = `${chatId}/${runId}`;
    const lease = this.#codeRuns.get(key);
    if (lease === undefined || "closed" in lease) {
      return false;
    }
    this.#closeLease(key, "revoked");
    // The call that found the revocation records it: later calls aren't.
    this.#codeRuns.set(key, { closed: "revoked", reported: true });
    // What it logged goes unshown from here on.
    this.#dropOutput(chatId, runId);
    return true;
  }

  /**
   * Keeps one call of the chat's code run `runId` as the chat shows it
   * (`ChatToolEvent`), under the code step that made it, from the run's
   * own record, and tells the chat's watchers. Only for a run this object
   * still knows (open, or closed lately): a run from before a restart, or
   * another chat's, keeps nothing. Never refuses the call it describes.
   */
  recordToolCall(chatId: ChatId, runId: string, call: unknown): void {
    const parsed = toolCallSchema.safeParse(call);
    if (!(parsed.success && this.#codeRuns.has(`${chatId}/${runId}`))) {
      return;
    }
    this.#turns.get(chatId)?.calls?.push(parsed.data);
    const event = this.ctx.storage.transactionSync(() => {
      const run = this.#db
        .select({ callId: chatCodeRuns.toolCallId })
        .from(chatCodeRuns)
        .where(and(eq(chatCodeRuns.id, runId), eq(chatCodeRuns.chatId, chatId)))
        .get();
      if (run === undefined) {
        return null;
      }
      const row = {
        chatId,
        callId: run.callId,
        event: JSON.stringify(parsed.data),
        createdAt: new Date(),
      };
      const { id } = this.#db
        .insert(chatToolEvents)
        .values(row)
        .returning({ id: chatToolEvents.id })
        .get();
      // The chat keeps its latest calls only.
      this.#db
        .delete(chatToolEvents)
        .where(
          and(
            eq(chatToolEvents.chatId, chatId),
            sql`${chatToolEvents.id} NOT IN (SELECT ${chatToolEvents.id} FROM ${chatToolEvents} WHERE ${chatToolEvents.chatId} = ${chatId} ORDER BY ${chatToolEvents.id} DESC LIMIT ${chatToolEventsKept})`
          )
        )
        .run();
      return toolEventOf({ id, ...row }) ?? null;
    });
    if (event === null) {
      return;
    }
    for (const watch of this.#watchers.get(chatId)?.values() ?? []) {
      watch.push([], [event]);
    }
  }

  /** The calls of the chat's code it keeps, oldest first. */
  #toolEvents(chatId: ChatId): ChatToolEvent[] {
    return this.#db
      .select()
      .from(chatToolEvents)
      .where(eq(chatToolEvents.chatId, chatId))
      .orderBy(asc(chatToolEvents.id))
      .all()
      .flatMap((row) => {
        const event = toolEventOf(row);
        return event === undefined ? [] : [event];
      });
  }

  /**
   * Whether a code run of the chat may have a write admitted now, without
   * counting a call: `open` with when it opened, or why not. The check a
   * write makes as it commits, after its call was let in.
   */
  admitFromCodeRun(chatId: ChatId, runId: string): CodeRunAdmission {
    const lease = this.#codeRuns.get(`${chatId}/${runId}`);
    if (lease === undefined) {
      return { call: "ended" };
    }
    if ("closed" in lease) {
      return { call: lease.closed };
    }
    return { call: "open", openedAt: lease.openedAt };
  }

  /**
   * Stops `personId`'s own chat's running turn, if there is one: the model
   * request or code run in flight ends, and the turn answers `cancelled`;
   * the questions queued into it are dropped (pi withdraws them), as Codex
   * hands queued messages back on an interrupt rather than send them. The
   * page puts them back in its box. Answered once its ChatSession has the
   * stop, kept (`ChatSession.abort`):
   * a stop that can't reach it fails, for its person to try again.
   */
  async cancel(
    chatId: unknown,
    personId: string
  ): Promise<ChatStopped | false> {
    const { id } = this.#graspChat(chatId, personId);
    // The ChatSession's turn; or the question this object is preparing,
    // whose stop is kept for it as it is claimed.
    const turnId = (await this.#activeTurn(id)) ?? this.#turns.get(id)?.id;
    if (turnId === undefined) {
      return false;
    }
    const dropped = await this.#toSession(
      id,
      async (session) => await session.abort(turnId)
    );
    return { dropped };
  }

  /**
   * Has `personId`'s own chat's running turn take the questions queued
   * into it now (`ChatSession.sendNow`), stopping the answer being
   * written; nothing when no turn runs, or none is queued.
   */
  async sendNow(chatId: unknown, personId: string): Promise<void> {
    const { id } = this.#graspChat(chatId, personId);
    const turnId = await this.#activeTurn(id);
    if (turnId === undefined) {
      return;
    }
    await this.#toSession(id, async (session) => {
      await session.sendNow(turnId);
    });
  }

  /**
   * Counts one API call of a code run of the chat, and says whether it may
   * go on (see agent-apis.ts): `open` while the run is open and has made
   * fewer than {@link codeLimits}' `subRequests` calls (with when it
   * opened, which a revocation is checked against), `spent` past that,
   * `revoked` once a revocation closed it, and `ended` once the run has
   * ended, or for a run this object doesn't know (one from before a
   * restart). A call after a run closed is logged once per run.
   */
  callFromCodeRun(chatId: ChatId, runId: string): CodeRunCall {
    const key = `${chatId}/${runId}`;
    const lease = this.#codeRuns.get(key);
    if (lease === undefined) {
      return { call: "ended", first: false };
    }
    if ("closed" in lease) {
      if (lease.reported) {
        return { call: lease.closed, first: false };
      }
      // Code still acting after its run closed: worth seeing in the logs.
      log.warn("agent.run_ended", { chatId, runId, closed: lease.closed });
      this.#codeRuns.set(key, { ...lease, reported: true });
      return { call: lease.closed, first: true };
    }
    if (lease.calls >= codeLimits.subRequests) {
      // Counted once past the most, so only the first refusal says so.
      this.#codeRuns.set(key, { ...lease, calls: codeLimits.subRequests + 1 });
      return { call: "spent", first: lease.calls === codeLimits.subRequests };
    }
    this.#codeRuns.set(key, { ...lease, calls: lease.calls + 1 });
    return { call: "open", first: false, openedAt: lease.openedAt };
  }

  /**
   * Records what an API call of a code run of the chat read from (see
   * agent-apis.ts), before the call hands over what it read: why not, and
   * nothing recorded, once the run has ended or a revocation closed it, so
   * the call must not hand it over (`open` when recorded). Each source is kept once, for good; every later model request of
   * the chat carries them all.
   */
  recordSources(
    chatId: ChatId,
    runId: string,
    ids: readonly string[],
    /** What the run's result rests on, if not `ids` (a connection call's grant). */
    runReads?: readonly string[]
  ): CodeRunAdmission["call"] {
    const { call } = this.admitFromCodeRun(chatId, runId);
    if (call !== "open") {
      return call;
    }
    const sources = sourcesSchema.parse(ids);
    const reads =
      runReads === undefined ? sources : runReadsSchema.parse(runReads);
    this.ctx.storage.transactionSync(() => {
      this.#keepSources(chatId, sources);
      // And with the run: what its result rests on (`#withheldRuns`).
      this.#keepRunSources(chatId, runId, reads);
    });
    return call;
  }

  /**
   * Keeps what a connection read of a code run of a chat platform's chat
   * returned (`values`, its text values), that the chat's later writes are
   * traced to, and, while its turn is under way, what it read for the
   * turn's check line (`check`). Why not, and nothing kept, once the run
   * has ended or a revocation closed it, or while what an erasure found
   * took is not yet kept from the model (`revoked`; `open` when kept).
   */
  keepRead(
    chatId: ChatId,
    runId: string,
    values: readonly string[],
    check: TurnCheck
  ): CodeRunAdmission["call"] {
    const { call } = this.admitFromCodeRun(chatId, runId);
    if (call !== "open") {
      return call;
    }
    // A read that may echo what an erasure found since took, as a run
    // still under way may, is never kept back after the trace was dropped
    // for it (`#dropErasedCopies`): refused until the model is kept from it.
    if (this.#erasedUnwithheld(chatId)) {
      return "revoked";
    }
    this.#turns.get(chatId)?.reads.push(check);
    const key = `${traceKeyPrefix}${chatId}`;
    const kept = traceSchema.safeParse(this.ctx.storage.kv.get(key));
    const trace: string[] = [];
    let chars = 0;
    for (const value of new Set([
      ...values,
      ...(kept.success ? kept.data : []),
    ])) {
      if (chars + value.length > traceCharsMax) {
        continue;
      }
      chars += value.length;
      trace.push(value);
    }
    this.ctx.storage.kv.put(key, trace);
    return call;
  }

  /**
   * Why a write of a chat platform's chat can't be held, or `undefined`
   * when it can (channels/stephen-rules.ts): `input`, against the fields
   * its action takes (`inputs`), traced to what the chat's person said in
   * it and what it read (`keepRead`).
   */
  heldWriteRefusal(
    chatId: ChatId,
    input: unknown,
    inputs: readonly string[] | null,
    senders: readonly string[] = []
  ): HeldWriteRefusal | undefined {
    const kept = traceSchema.safeParse(
      this.ctx.storage.kv.get(`${traceKeyPrefix}${chatId}`)
    );
    const said = this.#transcript(chatId)
      .flatMap((message) => {
        if (message.role !== "user") {
          return [];
        }
        return typeof message.content === "string"
          ? [message.content]
          : message.content.flatMap((part) =>
              part.type === "text" ? [part.text] : []
            );
      })
      .join("\n");
    return heldWriteRefusal(input, inputs, {
      said,
      read: kept.success ? kept.data : [],
      senders,
    });
  }

  /**
   * Whether the chat's agent is offered `askQuestions`: in Grasp's own
   * app, never in a chat app's chat (agent.ts), which can't show them.
   */
  #asksIn(chatId: ChatId): boolean {
    const chat = this.#db
      .select({ via: chats.via })
      .from(chats)
      .where(eq(chats.id, chatId))
      .get();
    return chat?.via === "web";
  }

  /**
   * What chat `chatId` has read: each source of its code runs, once. What a
   * run its agent had started copies (GRA-1093, workflow-starts.ts), as
   * whatever its input carries came from those. Withheld ones too
   * (`#withheldRuns`): a concurrent turn may withhold one after the agent's
   * call already carried it, and one withheld is unreadable now, so the
   * run is refused at once. Fail closed: a chat with a source it can't read
   * starts runs that release nothing until it can read it again.
   *
   * `null` for a chat this object doesn't hold, or holds no more, or is
   * deleting (`deleteChat`): its sources are gone with it, so no start of
   * its agent's can be held to them, and the caller refuses the start.
   */
  heldSourcesOf(chatId: unknown): string[] | null {
    const parsed = chatIdSchema.safeParse(chatId);
    if (!parsed.success || this.#isDeleting(parsed.data)) {
      return null;
    }
    const id = parsed.data;
    const held = this.#db
      .select({ id: chats.id })
      .from(chats)
      .where(eq(chats.id, id))
      .get();
    if (held === undefined) {
      return null;
    }
    return this.#db
      .selectDistinct({ sourceId: chatRunSources.sourceId })
      .from(chatRunSources)
      .where(eq(chatRunSources.chatId, id))
      .all()
      .map(({ sourceId }) => sourceId);
  }

  /**
   * Notes with a code run of the chat the connections whose own words an
   * API call of it hands over without calling them (`told`: their tools'
   * names and descriptions, their account's name), before the call hands
   * them over: what the run's result is marked with as text from outside
   * (`endTurnRun`), never a read of the chat's or the run's. The same
   * refusal once the run isn't open.
   */
  noteOutsideText(
    chatId: ChatId,
    runId: string,
    told: readonly OutsideTextNote[]
  ): CodeRunAdmission["call"] {
    const { call } = this.admitFromCodeRun(chatId, runId);
    if (call !== "open") {
      return call;
    }
    const where = and(
      eq(chatCodeRuns.id, runId),
      eq(chatCodeRuns.chatId, chatId)
    );
    // Read and written with no await between: nothing else runs here.
    const row = this.#db
      .select({ outsideText: chatCodeRuns.outsideText })
      .from(chatCodeRuns)
      .where(where)
      .get();
    // A run whose record is gone (pruned) can't be marked: refused.
    if (row === undefined) {
      return "ended";
    }
    const noted = row.outsideText ?? [];
    const keys = new Set(
      noted.map(({ connectionId, told: what }) => `${connectionId}/${what}`)
    );
    const added = told.filter(
      ({ connectionId, told: what }) => !keys.has(`${connectionId}/${what}`)
    );
    if (added.length > 0) {
      this.#db
        .update(chatCodeRuns)
        .set({ outsideText: [...noted, ...added] })
        .where(where)
        .run();
    }
    return call;
  }

  /**
   * Records with the run alone what an API call of it read (an App's
   * answer or files, the Knowledge catalog), before the call hands it
   * over: what the run's result rests on (`#withheldRuns`), never the
   * chat's provenance, which the model rules judge (`recordSources`). The
   * same refusal once the run isn't open.
   */
  recordRunReads(
    chatId: ChatId,
    runId: string,
    ids: readonly string[]
  ): CodeRunAdmission["call"] {
    const { call } = this.admitFromCodeRun(chatId, runId);
    if (call === "open") {
      this.#keepRunSources(chatId, runId, runReadsSchema.parse(ids));
    }
    return call;
  }

  /**
   * Keeps `sources` with run `runId`, each once, and, of the memories a
   * recall as its person handed over among them (`memoryUseOf`), when
   * they last used each (`memory_uses`), in one transaction.
   */
  #keepRunSources(
    chatId: ChatId,
    runId: string,
    sources: readonly string[]
  ): void {
    if (sources.length === 0) {
      return;
    }
    const used = sources.flatMap((source) => memoryUseOf(source) ?? []);
    this.ctx.storage.transactionSync(() => {
      this.#db
        .insert(chatRunSources)
        .select(
          sql`SELECT ${chatId}, ${runId}, value, NULL FROM json_each(${JSON.stringify(sources)}) WHERE true`
        )
        .onConflictDoNothing()
        .run();
      if (used.length > 0) {
        // One statement however many: each a bound value would pass the
        // object's bound on a statement's variables (100).
        this.ctx.storage.sql.exec(
          `INSERT INTO memory_uses (store, memory, used_at)
          SELECT value ->> 0, value ->> 1, ?2 FROM json_each(?1) WHERE true
          ON CONFLICT (store, memory)
          DO UPDATE SET used_at = max(used_at, excluded.used_at)`,
          JSON.stringify(used.map(({ store, memory }) => [store, memory])),
          Date.now()
        );
      }
    });
  }

  /**
   * When this person last used each memory they used, at or before
   * `until` (milliseconds): a memory a recall as them last handed over
   * then (`memory_uses`), which their own recall ranks memories by
   * (brain-next.ts `recallAs`). Theirs alone, so one person's use never
   * reaches another's recall. One scan of their uses, a row a memory; a
   * row that isn't a memory's place is passed over, never failing recall.
   */
  memoriesUsed(until: number): MemoryUse[] {
    return this.#db
      .select()
      .from(memoryUses)
      .where(lte(memoryUses.usedAt, new Date(until)))
      .all()
      .flatMap(({ store, memory, usedAt }) => {
        // A row is a pin's place: read back by the same rule
        // (history-access.ts `brainMemorySchema`).
        const place = brainMemorySchema.safeParse([store, memory]);
        return place.success
          ? [
              {
                store: place.data[0],
                memory: place.data[1],
                at: usedAt.getTime(),
              },
            ]
          : [];
      });
  }

  /**
   * The code runs of the chat whose results may not reach the model now
   * (`withheld` in chat-agent.ts): its agent may no longer read, for its
   * person, something one of them read (`readableSources`). The sources
   * newly found unreadable are marked and audited in one transaction, as
   * one event by the agent acting for the person, with how many runs it
   * newly withheld and sources of each kind, never which or what was
   * read, and why the chat's audience cut what a recall as the company
   * handed over, if it did (`withheldDetail`): one cause, a source
   * narrowed that dozens of pinned memories rest on, is one event
   * (GRA-1882). One this check read as withheld and readable again is
   * unmarked, so a later revocation is audited again. A check that fails withholds every run
   * that read anything, unmarked: rather withheld than sent unchecked.
   * Nothing is read from core for a chat whose runs read nothing.
   */
  async #withheldRuns(scope: Omit<AgentScope, "runId">): Promise<Set<string>> {
    const { chatId } = scope;
    const rows = this.#db
      .select()
      .from(chatRunSources)
      .where(eq(chatRunSources.chatId, chatId))
      .all();
    if (rows.length === 0) {
      return new Set();
    }
    const checked = [...new Set(rows.map(({ sourceId }) => sourceId))];
    let found: Awaited<ReturnType<typeof readableSources>>;
    try {
      found = await readableSources(this.env, scope, checked);
    } catch (error) {
      log.warn("agent.history_check_failed", { chatId, ...errorFields(error) });
      return new Set(rows.map(({ runId }) => runId));
    }
    const { readable, audience } = found;
    const unreadable = checked.filter((source) => !readable.has(source));
    // Readable again: only what this check read as withheld, as it was, so
    // one a check alongside withheld since stays so.
    const back = rows.flatMap(({ runId, sourceId, withheldAt }) =>
      withheldAt !== null && readable.has(sourceId)
        ? [{ runId, sourceId, withheldAt }]
        : []
    );
    const actor = delegateActorOf(chatAuthority(scope), scope.via);
    // Marked as the rows are now, in the same transaction as the event: a
    // check that ran alongside this one marked, and audited, its own.
    const audited = this.ctx.storage.transactionSync(() => {
      // Runs an earlier event withheld, as they were before this check
      // unmarks any: counted by it, not again.
      const counted = new Set(
        this.#db
          .selectDistinct({ runId: chatRunSources.runId })
          .from(chatRunSources)
          .where(
            and(
              eq(chatRunSources.chatId, chatId),
              isNotNull(chatRunSources.withheldAt)
            )
          )
          .all()
          .map(({ runId }) => runId)
      );
      for (const { runId, sourceId, withheldAt } of back) {
        this.#db
          .update(chatRunSources)
          .set({ withheldAt: null })
          .where(
            and(
              eq(chatRunSources.chatId, chatId),
              eq(chatRunSources.runId, runId),
              eq(chatRunSources.sourceId, sourceId),
              eq(chatRunSources.withheldAt, withheldAt)
            )
          )
          .run();
      }
      const fresh = this.#db
        .update(chatRunSources)
        .set({ withheldAt: new Date() })
        .where(
          and(
            eq(chatRunSources.chatId, chatId),
            isNull(chatRunSources.withheldAt),
            inList(chatRunSources.sourceId, unreadable)
          )
        )
        .returning({
          runId: chatRunSources.runId,
          sourceId: chatRunSources.sourceId,
        })
        .all();
      if (fresh.length === 0) {
        return false;
      }
      const runs = new Set(
        fresh.flatMap(({ runId }) => (counted.has(runId) ? [] : [runId]))
      );
      this.#outboxEntry({
        actor,
        action: "chat.history_withheld",
        target: { type: "chat", id: chatId },
        detail: {
          workspace: this.ctx.id.name ?? null,
          ...withheldDetail({
            runs: runs.size,
            sources: fresh.map(({ sourceId }) => sourceId),
            audience,
          }),
        },
      });
      return true;
    });
    if (audited) {
      this.#deliverAudit();
    }
    // Whatever is unreadable now, newly or not (narrowed first, erased
    // since; a check that failed before): if erased, what the chat shows of
    // it goes too. A repeat replaces nothing more, and nothing is asked of
    // the Brain for a chat whose unreadable sources hold none of its pins.
    if (unreadable.length > 0) {
      await this.#replaceErased(scope, unreadable);
    }
    const withheld = new Set(unreadable);
    return new Set(
      rows.flatMap(({ runId, sourceId }) =>
        withheld.has(sourceId) ? [runId] : []
      )
    );
  }

  /**
   * Replaces what the chat shows of each run resting on what an erasure
   * took for good (history-access.ts `erasedSources`), of `sources` (all
   * the chat's runs read when none are given): its result, in the chat's
   * own copy, by the line the model gets in its place, so no read of the
   * copy (the chat as its person opens it, core's reads of its
   * transcript) holds it again (GRA-1807). A run only no longer readable
   * keeps what it showed: its person saw it while they could. Answers the
   * runs the chat may not show as stored: none once replaced; every run
   * that read anything when the Brain can't be asked, shown withheld
   * (`#shownAfter`) and rewritten by a later check. Asked again each
   * time: an erasure is never undone, so a repeat replaces nothing more.
   */
  async #replaceErased(
    scope: Omit<AgentScope, "runId">,
    sources?: readonly string[]
  ): Promise<ReadonlySet<string>> {
    const { chatId } = scope;
    const rows = this.#db
      .select({
        runId: chatRunSources.runId,
        sourceId: chatRunSources.sourceId,
      })
      .from(chatRunSources)
      .where(eq(chatRunSources.chatId, chatId))
      .all();
    let erased: Set<string>;
    try {
      erased = await erasedSources(
        this.env,
        scope.personId,
        sources ?? [...new Set(rows.map(({ sourceId }) => sourceId))]
      );
    } catch (error) {
      log.warn("agent.erased_check_failed", { chatId, ...errorFields(error) });
      return new Set(rows.map(({ runId }) => runId));
    }
    const runs = [
      ...new Set(
        rows.flatMap(({ runId, sourceId }) =>
          erased.has(sourceId) ? [runId] : []
        )
      ),
    ];
    if (runs.length > 0 && !this.#isDeleting(chatId)) {
      this.#replaceResults(chatId, runs);
      this.#dropErasedCopies(chatId, [...erased]);
    }
    return new Set();
  }

  /**
   * Refuses (`agent.erasure_unchecked`) unless what chat `chat` read was
   * just checked against what an erasure took, and what it keeps of that
   * replaced or dropped (`#replaceErased`): before anything it keeps that
   * may quote it is listed, handed over or carried out. Asked again once
   * the Brain answers.
   */
  async #erasureChecked(chat: Chat): Promise<void> {
    const unchecked = await this.#replaceErased(this.#scopeOf(chat));
    if (unchecked.size > 0) {
      throw agentErrors.create("agent.erasure_unchecked");
    }
  }

  /**
   * Refuses (`agent.erasure_unchecked`) holding a write in chat `chat`
   * while its model may still have what an erasure took, or while that
   * can't be asked: a run of the chat resting on an erased source that no
   * check before a model request withheld yet (`#withheldRuns` marks it,
   * as an erased source is never readable again), whose result the request
   * may quote. Held after the next request, as the model no longer has it.
   * A write held before the erasure is withdrawn once it is found
   * (`#dropErasedCopies`).
   */
  async #erasedUnseen(chat: Chat): Promise<void> {
    const unmarked = this.#db
      .selectDistinct({ sourceId: chatRunSources.sourceId })
      .from(chatRunSources)
      .where(
        and(
          eq(chatRunSources.chatId, chat.id),
          isNull(chatRunSources.withheldAt)
        )
      )
      .all()
      .map(({ sourceId }) => sourceId);
    let erased: Set<string>;
    try {
      erased = await erasedSources(this.env, chat.personId, unmarked);
    } catch (error) {
      log.warn("agent.erased_check_failed", {
        chatId: chat.id,
        ...errorFields(error),
      });
      throw agentErrors.create("agent.erasure_unchecked");
    }
    if (erased.size > 0) {
      throw agentErrors.create("agent.erasure_unchecked");
    }
  }

  /** The sources chat `chatId` read found erased so far (`erasedKeyPrefix`). */
  #erasedKept(chatId: ChatId): string[] {
    return (
      erasedKeptSchema.safeParse(
        this.ctx.storage.kv.get(`${erasedKeyPrefix}${chatId}`)
      ).data ?? []
    );
  }

  /**
   * Whether chat `chatId`'s model may still have what an erasure found
   * since took: a run's read of a source counted erased (`#erasedKept`)
   * that no check before a model request withheld yet (`#withheldRuns`).
   */
  #erasedUnwithheld(chatId: ChatId): boolean {
    const erased = this.#erasedKept(chatId);
    return (
      erased.length > 0 &&
      this.#db
        .select({ runId: chatRunSources.runId })
        .from(chatRunSources)
        .where(
          and(
            eq(chatRunSources.chatId, chatId),
            isNull(chatRunSources.withheldAt),
            inList(chatRunSources.sourceId, erased)
          )
        )
        .get() !== undefined
    );
  }

  /**
   * Drops what else chat `chatId` keeps that may quote sources `erased` it
   * read, found erased (`#replaceErased`), the first time any of them is
   * (`erasedKeyPrefix`): a later erasure drops again, a repeat nothing, so
   * what the chat keeps after it is never dropped for it. Neither names the
   * run it came from, so all of it goes:
   * - what its connection reads returned that its writes are traced to
   *   (`keepRead`): holding less only refuses more of its writes
   *   (channels/stephen-rules.ts) until it reads again;
   * - every App write still held for its person, withdrawn unrun, its
   *   request and function's name emptied and its end recorded (`chat.app_call.withdrawn`) in
   *   the same write, then its agent told to ask afresh: no rule finds what
   *   of a request quotes what was erased, and a request blanked is not the
   *   one they were shown.
   */
  #dropErasedCopies(chatId: ChatId, erased: readonly string[]): void {
    const key = `${erasedKeyPrefix}${chatId}`;
    const withdrawn = this.ctx.storage.transactionSync(() => {
      const counted = this.#erasedKept(chatId);
      const fresh = erased.filter((source) => !counted.includes(source));
      const held = this.#db
        .select({ id: chats.id })
        .from(chats)
        .where(eq(chats.id, chatId))
        .get();
      // Nothing kept for a chat deleted meanwhile.
      if (fresh.length === 0 || held === undefined) {
        return [];
      }
      this.ctx.storage.kv.put(key, [...counted, ...fresh]);
      this.ctx.storage.kv.delete(`${traceKeyPrefix}${chatId}`);
      const rows = this.#db
        .update(heldAppCalls)
        // Its function's name too: the agent's own words, which may quote it.
        .set({ status: "withdrawn", request: null, function: "" })
        .where(
          and(
            eq(heldAppCalls.chatId, chatId),
            eq(heldAppCalls.status, "waiting")
          )
        )
        .returning()
        .all();
      for (const row of rows) {
        this.#outboxEntry({
          actor: { type: "system" },
          action: "chat.app_call.withdrawn",
          target: { type: "app", id: row.appId },
          detail: {
            workspace: this.ctx.id.name ?? null,
            chat: chatId,
            held: row.id,
            kind: row.kind,
          },
        });
      }
      return rows;
    });
    if (withdrawn.length === 0) {
      return;
    }
    this.#deliverAudit();
    this.heldChanged(chatId);
    // Told after: a check before a turn's model request comes here too,
    // and the chat's object waits on it then.
    this.ctx.waitUntil(this.#noteWithdrawn(chatId, withdrawn));
  }

  /**
   * Tells the agent of chat `chatId` each held App write in `withdrawn` was
   * withdrawn, by its ID alone: nothing it named may quote what was erased.
   */
  async #noteWithdrawn(
    chatId: ChatId,
    withdrawn: readonly { id: string }[]
  ): Promise<void> {
    for (const { id } of withdrawn) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- one note each, in order
        await this.#note(
          chatId,
          `The write to an App you asked for (held ID ${id}) was withdrawn before the person decided it: this chat can no longer read something it may have come from, so it was not carried out. Tell them, and if they still want it, ask for it afresh.`
        );
      } catch (error) {
        // Withdrawn either way: the agent finds it no longer waits.
        log.warn("chat.held_app_call_withdraw_note_failed", errorFields(error));
      }
    }
  }

  /**
   * Replaces the stored result of each run in `runs` by `withheldCopy`,
   * read again in the same transaction: one copied in since is replaced
   * too, and one replaced already is left as it is.
   */
  #replaceResults(chatId: ChatId, runs: readonly string[]): void {
    this.ctx.storage.transactionSync(() => {
      const rows = this.#db
        .select({ id: chatMessages.id, message: chatMessages.message })
        .from(chatMessages)
        .where(
          and(
            eq(chatMessages.chatId, chatId),
            sql`json_extract(${chatMessages.message}, '$.details.runId') IN (SELECT value FROM json_each(${JSON.stringify(runs)}))`
          )
        )
        .all();
      for (const row of rows) {
        const stored = storedMessageSchema.parse(JSON.parse(row.message));
        const replaced = JSON.stringify(withheldCopy(stored));
        if (stored.role === "toolResult" && replaced !== row.message) {
          this.#db
            .update(chatMessages)
            .set({ message: replaced })
            .where(eq(chatMessages.id, row.id))
            .run();
        }
      }
    });
  }

  /**
   * Keeps `sources` with the chat, each once, for good: one statement
   * whatever their number, the list bound as one JSON value, as the
   * object's SQLite takes at most 100 bound values a statement.
   */
  #keepSources(chatId: ChatId, sources: readonly string[]): void {
    if (sources.length === 0) {
      return;
    }
    // The WHERE keeps SQLite from reading ON CONFLICT as a join.
    this.#db
      .insert(chatSources)
      .select(
        sql`SELECT ${chatId}, value, ${Date.now()} FROM json_each(${JSON.stringify(sources)}) WHERE true`
      )
      .onConflictDoNothing()
      .run();
    this.#provenanceChanged(chatId);
  }

  /** Everything the chat has read from, as `recordSources` kept it. */
  #sources(chatId: ChatId): string[] {
    return this.#db
      .select({ sourceId: chatSources.sourceId })
      .from(chatSources)
      .where(eq(chatSources.chatId, chatId))
      .all()
      .map(({ sourceId }) => sourceId);
  }

  /**
   * The chat's transcript, oldest first, as pi keeps it; for core's own
   * reads. A person follows their chat through `watch`, which checks it is
   * theirs.
   */
  messages(chatId: unknown): Message[] {
    return this.#transcript(this.#chat(chatId).id);
  }

  /**
   * `personId`'s chats in Grasp (`shownInGrasp`), the most recently active
   * first: at most {@link listedChats}. Those they archived only with
   * `archived`, and then only those; with `project`, only those they filed in
   * it.
   */
  chats(personId: string, archived = false, project?: string): ChatSummary[] {
    return this.#db
      .select({
        id: chats.id,
        title: chats.title,
        agentId: chats.agentId,
        createdAt: chats.createdAt,
        lastAt: chats.lastAt,
        makeKind: chats.makeKind,
        makeProject: chats.makeProject,
        archivedAt: chats.archivedAt,
        readUpTo: chats.readUpTo,
      })
      .from(chats)
      .where(
        and(
          shownInGrasp(personId),
          archived ? isNotNull(chats.archivedAt) : isNull(chats.archivedAt),
          project === undefined ? undefined : eq(chats.projectId, project)
        )
      )
      .orderBy(desc(chats.lastAt))
      .limit(listedChats)
      .all()
      .map((chat) => this.#summaryOf(chat));
  }

  /** A chat as its person's list shows it. */
  #summaryOf(
    chat: Pick<
      typeof chats.$inferSelect,
      | "id"
      | "title"
      | "agentId"
      | "createdAt"
      | "lastAt"
      | "makeKind"
      | "makeProject"
      | "archivedAt"
      | "readUpTo"
    >
  ): ChatSummary {
    const running = this.#isRunning(chat.id);
    return {
      id: chat.id,
      title: chat.title,
      agentId: chat.agentId,
      createdAt: chat.createdAt.toISOString(),
      lastAt: chat.lastAt.toISOString(),
      running,
      // While its agent works the list shows that instead: unread once done.
      unread: !running && this.#hasUnseenAnswer(chat.id, chat.readUpTo),
      make: makeOf(chat),
      archived: chat.archivedAt !== null,
    };
  }

  /**
   * Whether the chat holds an answer stored after `readUpTo`, the last
   * message its person saw. None for a chat with no read position, made
   * before chats kept one: read, so they don't all light up at once. Only
   * the agent's answers: the person's own questions and a step's result
   * are never news to them. By the chat's index, stopping at the first.
   */
  #hasUnseenAnswer(chatId: ChatId, readUpTo: number | null): boolean {
    if (readUpTo === null) {
      return false;
    }
    return (
      this.#db
        .select({ id: chatMessages.id })
        .from(chatMessages)
        .where(
          and(
            eq(chatMessages.chatId, chatId),
            gt(chatMessages.id, readUpTo),
            sql`json_extract(${chatMessages.message}, '$.role') = 'assistant'`
          )
        )
        .limit(1)
        .get() !== undefined
    );
  }

  /**
   * Marks `personId`'s chat `chatId` seen up to its latest message, or
   * to `upTo`, the newest the page shows, where that is older
   * (`ChatsApi.markRead`), never back: a page that shows less, on another
   * device, leaves it where a newer one put it. The last message they had
   * seen before: 0 for none, null for a chat made before chats kept it,
   * which counts as read. Only their own chat in Grasp
   * (`#graspChat`): anyone else's is refused as if there were none.
   */
  markChatRead(
    chatId: unknown,
    personId: string,
    upTo?: number
  ): number | null {
    const chat = this.#graspChat(chatId, personId);
    const latest = this.#db
      .select({ id: sql<number | null>`max(${chatMessages.id})` })
      .from(chatMessages)
      .where(eq(chatMessages.chatId, chat.id))
      .get()?.id;
    const seen =
      typeof latest === "number" && upTo !== undefined
        ? Math.min(latest, upTo)
        : latest;
    if (typeof seen === "number" && seen > (chat.readUpTo ?? 0)) {
      this.#db
        .update(chats)
        .set({ readUpTo: seen })
        .where(eq(chats.id, chat.id))
        .run();
      this.#listChanged();
    }
    return chat.readUpTo;
  }

  /**
   * `personId`'s chat for `subject`, an App or a workflow: of `drafted`,
   * the chats that worked on it (`chatsWorkedOn`: whose agent wrote its
   * draft, or whose Build it made it), the one active last, as their list
   * shows it, so its page carries on where they left it, with all it
   * knows; `null` while they have none, when the next question there
   * starts one. Only a chat Grasp shows them (`shownInGrasp`): never a
   * chat app's conversation, theirs alone or shared.
   */
  subjectChat(
    personId: string,
    subject: Subject,
    drafted: readonly string[]
  ): ChatSummary | null {
    const chat = this.#db
      .select()
      .from(chats)
      .where(
        and(
          shownInGrasp(personId),
          sql`${chats.id} IN (SELECT value FROM json_each(${JSON.stringify(drafted)}))`
        )
      )
      .orderBy(desc(chats.lastAt))
      .get();
    return chat === undefined ? null : this.#summaryOf(chat);
  }

  /** `personId`'s chat `chatId`, as their list shows it, listed or not. */
  chatSummary(chatId: unknown, personId: string): ChatSummary {
    return this.#summaryOf(this.#graspChat(chatId, personId));
  }

  /**
   * The plan of `personId`'s chat `chatId` proposed by the call `callId`
   * (`proposePlan`), as the tool took it, taken for Build it
   * (`ChatsApi.build`): once, so what it lists is made once. A call the
   * chat doesn't hold, one that proposed nothing the tool took, or a plan
   * taken already is `agent.plan_not_found`; while its agent works,
   * `agent.busy`. `releasePlan` gives it back
   * when Build it made nothing.
   */
  takePlan(
    chatId: unknown,
    personId: string,
    callId: unknown
  ): { plan: ChatPlan; make: ChatMake | null } {
    const { chat, args } = this.#takeCall(chatId, personId, callId, {
      tool: "proposePlan",
      keyPrefix: builtKeyPrefix,
      notFound: "agent.plan_not_found",
    });
    const plan = chatPlanSchema.parse(args);
    return { plan, make: makeOf(chat) };
  }

  /**
   * Takes the agent `personId`'s chat `chatId` drafted with the call
   * `callId` (`draftAgent`), as the call kept it, to make it once: a
   * chat they don't hold, a draft the tool refused or none, or one taken
   * already is `agent.draft_not_found`; while its agent works,
   * `agent.busy`. `releaseAgentDraft` gives it back when Make it made
   * nothing.
   */
  takeAgentDraft(
    chatId: unknown,
    personId: string,
    callId: unknown
  ): { draft: AgentDraft; made: string | null } {
    const { chat, args } = this.#takeCall(chatId, personId, callId, {
      tool: "draftAgent",
      keyPrefix: draftedKeyPrefix,
      notFound: "agent.draft_not_found",
    });
    const kept = draftMadeSchema.safeParse(
      this.ctx.storage.kv.get(`${draftMadeKeyPrefix}${chat.id}`)
    );
    // `#takeCall` took a string call alone.
    const made =
      kept.success && typeof callId === "string"
        ? kept.data[callId]
        : undefined;
    return { draft: agentDraftSchema.parse(args), made: made ?? null };
  }

  /**
   * Takes the change to an agent `personId`'s chat `chatId` drafted with
   * the call `callId` (`draftAgentChange`), to make once, and when it was
   * drafted (`at`): refused as `takeAgentDraft` refuses.
   * `releaseAgentChange` gives it back when Change it changed nothing.
   */
  takeAgentChange(
    chatId: unknown,
    personId: string,
    callId: unknown
  ): { change: AgentChangeDraft; at: Date } {
    const { args, at } = this.#takeCall(chatId, personId, callId, {
      tool: "draftAgentChange",
      keyPrefix: changedKeyPrefix,
      notFound: "agent.draft_not_found",
    });
    return { change: agentChangeDraftSchema.parse(args), at };
  }

  /** Gives back a change `takeAgentChange` took, of which Change it changed nothing. */
  releaseAgentChange(chatId: ChatId, callId: string): void {
    this.#releaseCall(`${changedKeyPrefix}${chatId}`, callId);
  }

  /** Gives back a draft `takeAgentDraft` took, of which Make it made nothing. */
  releaseAgentDraft(chatId: ChatId, callId: string): void {
    this.#releaseCall(`${draftedKeyPrefix}${chatId}`, callId);
  }

  /**
   * Gives back a draft `takeAgentDraft` took, of which Make it made the
   * agent `agentId` but couldn't save its instructions: taken again, it
   * names that agent (`made`), so Make it saves them to it and makes no
   * second. In one step, so it is never given back without it.
   */
  keepAgentDraftMade(chatId: ChatId, callId: string, agentId: string): void {
    this.ctx.storage.transactionSync(() => {
      const key = `${draftMadeKeyPrefix}${chatId}`;
      const kept = draftMadeSchema.safeParse(this.ctx.storage.kv.get(key));
      this.ctx.storage.kv.put(key, {
        ...(kept.success ? kept.data : {}),
        [callId]: agentId,
      });
      this.#releaseCall(`${draftedKeyPrefix}${chatId}`, callId);
    });
  }

  /**
   * The arguments of the call `callId` to `tool` in `personId`'s chat
   * `chatId`, as the tool took them, marked taken under `keyPrefix` so
   * none is taken twice; `notFound` for a chat they don't hold, a call
   * the tool refused, none, or one taken already, and `agent.busy` while
   * the chat's agent works.
   */
  #takeCall(
    chatId: unknown,
    personId: string,
    callId: unknown,
    {
      tool,
      keyPrefix,
      notFound,
    }: {
      tool: keyof typeof takenSchemas;
      keyPrefix: string;
      notFound: "agent.plan_not_found" | "agent.draft_not_found";
    }
  ): { chat: Chat; args: unknown; at: Date } {
    const chat = this.#graspChat(chatId, personId);
    const { id } = chat;
    // Its question would be refused: nothing is made for it.
    if (this.#turns.has(id) || this.#isRunning(id)) {
      throw agentErrors.create("agent.busy");
    }
    const key = `${keyPrefix}${id}`;
    const kept = builtSchema.safeParse(this.ctx.storage.kv.get(key));
    const taken = kept.success ? kept.data : [];
    const transcript = this.#transcript(id);
    const refused = new Set(
      transcript.flatMap((message) =>
        message.role === "toolResult" && message.isError
          ? [message.toolCallId]
          : []
      )
    );
    const isCall = (part: { type: string; name?: string; id?: string }) =>
      part.type === "toolCall" && part.name === tool && part.id === callId;
    const response = transcript.find(
      (message) => message.role === "assistant" && message.content.some(isCall)
    );
    const call =
      response?.role === "assistant"
        ? response.content.find(isCall)
        : undefined;
    const schema = takenSchemas[tool];
    const args =
      call?.type === "toolCall" && !refused.has(call.id)
        ? schema.safeParse(call.arguments)
        : undefined;
    if (
      typeof callId !== "string" ||
      args?.success !== true ||
      taken.includes(callId)
    ) {
      throw agentErrors.create(notFound);
    }
    this.ctx.storage.kv.put(key, [...taken, callId]);
    return { chat, args: args.data, at: new Date(response?.timestamp ?? 0) };
  }

  /** Gives back the call `callId` taken under `key`. */
  #releaseCall(key: string, callId: string): void {
    const kept = builtSchema.safeParse(this.ctx.storage.kv.get(key));
    if (kept.success) {
      this.ctx.storage.kv.put(
        key,
        kept.data.filter((each) => each !== callId)
      );
    }
  }

  /** Gives back a plan `takePlan` took, of which Build it made nothing. */
  releasePlan(chatId: ChatId, callId: string): void {
    this.#releaseCall(`${builtKeyPrefix}${chatId}`, callId);
  }

  /**
   * Keeps Build it on `personId`'s chat `chatId` when what it made can't
   * go on in a turn (`ChatsApi.build`): their `text` with what was made
   * (`built`), shown as a turn shows it, so the plan waits no more; the
   * agent told what was made (`#note`), and the chat stopped for
   * `stopped`, to try again. What was made is the chat's work already
   * (`keepMadeInChat`), so its page carries on in this chat.
   */
  async keepBuilt(
    chatId: unknown,
    personId: string,
    {
      text,
      built,
      stopped,
    }: { text: string; built: QuestionBuilt; stopped: string }
  ): Promise<void> {
    const chat = this.#graspChat(chatId, personId);
    const { plan, app, workflow } = built;
    this.#keep(
      chat.id,
      { role: "user", content: text, timestamp: Date.now() },
      {
        built: {
          plan,
          ...(app === undefined ? {} : { app }),
          ...(workflow === undefined ? {} : { workflow }),
        },
      }
    );
    this.#stopped.set(chat.id, stopped);
    this.#changed(chat.id);
    try {
      await this.#note(chat.id, builtNoteText(built));
    } catch (error) {
      // Kept and shown all the same.
      log.warn("agent.built_untold", {
        chatId: chat.id,
        ...errorFields(error),
      });
    }
  }

  /**
   * Keeps what `personId` thought of an answer of their own chat, or
   * takes it back (`null`): refused for anything but an answer of that
   * chat. Audited as `by`'s, as a rename is: that they rated an answer
   * of the chat, never which way or why, which stay theirs alone.
   */
  rateAnswer(
    chatId: unknown,
    personId: string,
    messageId: number,
    rating: ChatRating | null,
    by: AuditActor
  ): void {
    const { id } = this.#graspChat(chatId, personId);
    const row = this.#db
      .select({ message: chatMessages.message })
      .from(chatMessages)
      .where(and(eq(chatMessages.chatId, id), eq(chatMessages.id, messageId)))
      .get();
    if (
      row === undefined ||
      storedMessageSchema.parse(JSON.parse(row.message)).role !== "assistant"
    ) {
      throw agentErrors.create("agent.invalid_request");
    }
    this.ctx.storage.transactionSync(() => {
      this.#db
        .update(chatMessages)
        .set({
          rating: rating?.value ?? null,
          ratingReason: rating?.reason ?? null,
        })
        .where(eq(chatMessages.id, messageId))
        .run();
      this.#outboxed(by, "chat.answer_rated", id);
    });
    this.#deliverAudit();
  }

  /** Renames `personId`'s own chat, audited as `by`'s. */
  renameChat(
    chatId: unknown,
    personId: string,
    title: string,
    by: AuditActor
  ): void {
    const { id } = this.#graspChat(chatId, personId);
    this.ctx.storage.transactionSync(() => {
      this.#db.update(chats).set({ title }).where(eq(chats.id, id)).run();
      this.#outboxed(by, "chat.renamed", id);
    });
    this.#deliverAudit();
    this.#listChanged();
  }

  /**
   * Files `personId`'s own chat in project `project`, or takes it out of
   * the one it is in (`null`), audited as `by`'s; nothing, and no event,
   * where it is so already. A chat moved from one project straight to
   * another records the one it came `from` too. Whether they may put it
   * in that project is the caller's to check (`ChatsRpc.setProject`).
   */
  setChatProject(
    chatId: unknown,
    personId: string,
    project: string | null,
    by: AuditActor
  ): void {
    const chat = this.#graspChat(chatId, personId);
    if (chat.projectId === project) {
      return;
    }
    this.ctx.storage.transactionSync(() => {
      this.#db
        .update(chats)
        .set({ projectId: project })
        .where(eq(chats.id, chat.id))
        .run();
      if (project === null) {
        this.#outboxed(by, "chat.unfiled", chat.id, {
          project: chat.projectId,
        });
      } else {
        this.#outboxed(by, "chat.filed", chat.id, {
          project,
          ...(chat.projectId === null ? {} : { from: chat.projectId }),
        });
      }
    });
    this.#deliverAudit();
  }

  /**
   * Archives `personId`'s own chat, out of their list, or brings it back
   * (`archived` false), audited as `by`'s; nothing, and no event, where it
   * is so already. Nothing else about the chat changes: it opens and takes
   * questions as ever.
   */
  archiveChat(
    chatId: unknown,
    personId: string,
    archived: boolean,
    by: AuditActor
  ): void {
    const chat = this.#graspChat(chatId, personId);
    if ((chat.archivedAt !== null) === archived) {
      return;
    }
    this.ctx.storage.transactionSync(() => {
      this.#db
        .update(chats)
        .set({ archivedAt: archived ? new Date() : null })
        .where(eq(chats.id, chat.id))
        .run();
      // With the project it is filed in then, null for none: the record
      // shows it after the chat is moved or taken out.
      this.#outboxed(
        by,
        archived ? "chat.archived" : "chat.unarchived",
        chat.id,
        { project: chat.projectId }
      );
    });
    this.#deliverAudit();
    this.#listChanged();
  }

  /**
   * Deletes `personId`'s own chat once its agent isn't working on it
   * (`agent.busy` while it is), audited as `by`'s. Marked first
   * (`chatDeletes`), in one transaction: from then on the chat is gone
   * from every surface, takes nothing more, and its watchers get nothing
   * more. Then each step of the deletion runs (`#finishDelete`), now and,
   * until all are through, again from the object's alarm, so it finishes
   * by itself whatever fails meanwhile and whoever waits. Asked again for
   * a chat being deleted, it does nothing more.
   */
  async deleteChat(
    chatId: unknown,
    personId: string,
    person: ConnectionPerson,
    by: AuditActor
  ): Promise<void> {
    if (person.userId !== personId) {
      throw agentErrors.create("agent.chat_not_found");
    }
    const id = chatIdSchema.safeParse(chatId);
    if (
      id.success &&
      this.#isDeleting(id.data) &&
      this.#chat(id.data).personId === personId
    ) {
      return;
    }
    const chat = this.#graspChat(chatId, personId);
    this.#markDeleting([chat.id], person, by, true);
    await this.#armDeletes();
    await this.#tryDelete(chat.id);
  }

  /**
   * Deletes every conversation `personId` had with an agent in a chat app
   * (Teams, Slack), which Grasp never shows them as a chat
   * (`shownInGrasp`), each as `deleteChat` deletes a chat: what their
   * Brain kept of it, the writes held in it, the connections granted in
   * it, the transcript its agent replays, its rows. Their next message
   * there starts a conversation anew. What the chat app itself keeps of
   * it is the chat app's. One its agent is working in stays
   * (`agent.conversation_answering`, once the others are marked); every
   * other is marked at once and finishes by itself, as `deleteChat`'s
   * does. Asked again while some are being deleted, refused
   * (`agent.delete_under_way`): that call answers for them. Audited once
   * for the action, as `by`'s, with how many went and how many didn't:
   * never one event per conversation, nor anything they said. How many it
   * deleted.
   */
  async forgetChatApps(
    personId: string,
    person: ConnectionPerson,
    by: AuditActor
  ): Promise<number> {
    if (person.userId !== personId) {
      throw agentErrors.create("agent.chat_not_found");
    }
    const conversations = this.#db
      .select({ id: chats.id })
      .from(chats)
      .where(and(eq(chats.personId, personId), ne(chats.via, "web")))
      .all();
    if (conversations.some(({ id }) => this.#isDeleting(id))) {
      throw agentErrors.create("agent.delete_under_way");
    }
    const answering = conversations.filter(({ id }) => this.#turns.has(id));
    const going = conversations.flatMap(({ id }) =>
      this.#turns.has(id) ? [] : [id]
    );
    this.#markDeleting(going, person, by, false);
    this.#outboxEntry({
      actor: by,
      action: "chat.apps_deleted",
      target: { type: "person", id: personId },
      detail: {
        workspace: this.ctx.id.name ?? null,
        deleted: going.length,
        failed: answering.length,
      },
    });
    this.#deliverAudit();
    if (going.length > 0) {
      await this.#armDeletes();
      await Promise.all(
        going.map(async (id) => {
          await this.#tryDelete(id);
        })
      );
    }
    if (answering.length > 0) {
      throw agentErrors.create("agent.conversation_answering");
    }
    return going.length;
  }

  /**
   * Marks chats `ids` deleted by `by` for `person` (`chatDeletes`), in one
   * transaction, each tried first by the caller and then by the alarm
   * (`#finishDeletes`); recorded each as `chat.deleted` unless `audited`
   * is false, for an action that records itself once (`forgetChatApps`).
   * Refused (`agent.busy`) while the agent of any works in it.
   */
  #markDeleting(
    ids: readonly ChatId[],
    person: ConnectionPerson,
    by: AuditActor,
    audited: boolean
  ): void {
    if (ids.some((id) => this.#turns.has(id))) {
      throw agentErrors.create("agent.busy");
    }
    const nextAt = new Date(Date.now() + deleteRetryMs.first);
    this.ctx.storage.transactionSync(() => {
      for (const chatId of ids) {
        this.#db
          .insert(chatDeletes)
          .values({ chatId, person, actor: by, audited, nextAt })
          .onConflictDoNothing()
          .run();
      }
    });
    for (const id of ids) {
      for (const watch of this.#watchers.get(id)?.values() ?? []) {
        watch[Symbol.dispose]();
      }
      this.#watchers.delete(id);
    }
    this.#listChanged();
  }

  // What a chat's own object (chat-session.ts) takes over of the chat as
  // kept here (chat-export.ts): nothing but what an erasure took changes
  // (`#exportedChecked`), so a part asked for again answers the same, and a
  // take-over cut short goes on. Each takes the chat's reference: the
  // object's own name is all a chat's object knows of itself before it
  // holds the chat, which it checks every caller against from then on.
  // `undefined` for a chat this object isn't, or doesn't hold, or is
  // deleting, and while its person is being erased.

  /** Chat `ref`, when this object holds it and neither it nor its person is being deleted. */
  #exported(ref: ChatRef): Chat | undefined {
    const { workspaceId, chatId } = chatRefSchema.parse(ref);
    if (
      workspaceId !== this.ctx.id.name ||
      this.#erasing ||
      this.#isDeleting(chatId)
    ) {
      return undefined;
    }
    return this.#db.select().from(chats).where(eq(chats.id, chatId)).get();
  }

  /**
   * Chat `ref` as `#exported` finds it, once what an erasure took is
   * replaced or dropped (`#erasureChecked`): refused while that can't be
   * asked, for the take-over to ask again later.
   */
  async #exportedChecked(ref: ChatRef): Promise<Chat | undefined> {
    const held = this.#exported(ref);
    if (held === undefined) {
      return undefined;
    }
    await this.#erasureChecked(held);
    // Read again after the await: the chat may have gone meanwhile.
    return this.#exported(ref);
  }

  /**
   * A page of chat `ref`'s messages after the one with ID `after` (0 from
   * the start), oldest first, at most `limit` (1 to
   * {@link exportPageMax}) and {@link exportPageBytes} past the first,
   * with what the chat is, the last pi entry its messages here hold
   * (`copiedKeyPrefix`), and where the next page goes on. What an erasure
   * took is replaced first, as before the chat is shown (`watch`):
   * refused (`agent.erasure_unchecked`) while that can't be asked, for the
   * take-over to ask again later.
   */
  async exportMessages(
    ref: ChatRef,
    after: unknown,
    limit: unknown
  ): Promise<ExportedPage | undefined> {
    const since = exportAfterSchema.safeParse(after);
    const most = exportLimitSchema.safeParse(limit);
    if (!since.success || !most.success) {
      throw agentErrors.create("agent.invalid_request");
    }
    const chat = await this.#exportedChecked(ref);
    if (chat === undefined) {
      return undefined;
    }
    // One more than asked, to tell whether a page follows.
    const rows = this.#db
      .select({
        id: chatMessages.id,
        message: chatMessages.message,
        createdAt: chatMessages.createdAt,
        thinkingMs: chatMessages.thinkingMs,
        built: chatMessages.built,
        agentId: chatMessages.agentId,
        rating: chatMessages.rating,
        ratingReason: chatMessages.ratingReason,
        requestKey: chatMessages.requestKey,
        bytes: sql<number>`length(CAST(${chatMessages.message} AS BLOB))`,
      })
      .from(chatMessages)
      .where(
        and(eq(chatMessages.chatId, chat.id), gt(chatMessages.id, since.data))
      )
      .orderBy(asc(chatMessages.id))
      .limit(most.data + 1)
      .all();
    const page: ExportedMessage[] = [];
    let bytes = 0;
    for (const { bytes: size, ...row } of rows) {
      if (
        page.length === most.data ||
        (page.length > 0 && bytes + size > exportPageBytes)
      ) {
        break;
      }
      bytes += size;
      page.push({ ...row, createdAt: msOf(row.createdAt) });
    }
    const copied = copiedSchema.safeParse(
      this.ctx.storage.kv.get(`${copiedKeyPrefix}${chat.id}`)
    );
    const { personId, via, agentId, thread, restricted, privateRead } = chat;
    return {
      facts: { personId, via, agentId, thread, restricted, privateRead },
      through: copied.success ? copied.data.through : null,
      page,
      next: page.length < rows.length ? (page.at(-1)?.id ?? null) : null,
    };
  }

  /**
   * Chat `ref`'s files, each one's record and how many parts its bytes
   * are in (`exportFilePart`). Small whatever the chat: at most
   * `chatFilesMax` records, and no file's bytes.
   */
  exportFiles(ref: ChatRef): ExportedFile[] | undefined {
    const chat = this.#exported(ref);
    if (chat === undefined) {
      return undefined;
    }
    return this.#db
      .select({
        id: chatFiles.id,
        messageId: chatFiles.messageId,
        name: chatFiles.name,
        type: chatFiles.type,
        createdAt: chatFiles.createdAt,
        bytes: chatFiles.bytes,
        pictureParts: sql<number>`(select count(*) from ${chatFileParts} where ${chatFileParts.fileId} = ${chatFiles.id})`,
      })
      .from(chatFiles)
      .where(eq(chatFiles.chatId, chat.id))
      .orderBy(asc(chatFiles.createdAt), asc(chatFiles.id))
      .all()
      .map(({ pictureParts, ...row }) => ({
        ...row,
        createdAt: msOf(row.createdAt),
        parts: isChatPictureType(row.type) ? pictureParts : 1,
      }));
  }

  /**
   * Part `part` of file `fileId` of chat `ref` (`exportFiles`): one of a
   * picture's 1 MB parts, or a file's text whole (at most 1 MB) as its one.
   */
  exportFilePart(
    ref: ChatRef,
    fileId: string,
    part: unknown
  ): Uint8Array | undefined {
    const at = exportPartSchema.safeParse(part);
    if (!at.success) {
      throw agentErrors.create("agent.invalid_request");
    }
    const chat = this.#exported(ref);
    if (chat === undefined) {
      return undefined;
    }
    const file = this.#db
      .select({ type: chatFiles.type, text: chatFiles.text })
      .from(chatFiles)
      .where(and(eq(chatFiles.chatId, chat.id), eq(chatFiles.id, fileId)))
      .get();
    if (file === undefined) {
      return undefined;
    }
    if (!isChatPictureType(file.type)) {
      return at.data === 0
        ? new TextEncoder().encode(file.text ?? "")
        : undefined;
    }
    return this.#db
      .select({ bytes: chatFileParts.bytes })
      .from(chatFileParts)
      .where(
        and(eq(chatFileParts.fileId, fileId), eq(chatFileParts.part, at.data))
      )
      .get()?.bytes;
  }

  /**
   * The App writes held in chat `ref`, whatever became of them, once what
   * an erasure took is dropped (`#exportedChecked`). Small whatever the
   * chat: a write keeps its request only while it waits, at most a day,
   * and one decided, lapsed or withdrawn keeps none.
   */
  async exportHeldAppCalls(
    ref: ChatRef
  ): Promise<ExportedHeldCall[] | undefined> {
    const chat = await this.#exportedChecked(ref);
    if (chat === undefined) {
      return undefined;
    }
    return this.#db
      .select()
      .from(heldAppCalls)
      .where(eq(heldAppCalls.chatId, chat.id))
      .all()
      .map(({ chatId: _chat, heldAt, ...held }) => ({
        ...held,
        heldAt: msOf(heldAt),
      }));
  }

  /**
   * What chat `ref` read and ran: its sources, its runs' sources, its code
   * runs' records, its tool calls as shown, what it read that its writes
   * are traced to (`traceKeyPrefix`), and which of its calls a press took
   * (`builtKeyPrefix`, `draftedKeyPrefix`, `changedKeyPrefix`,
   * `draftMadeKeyPrefix`). IDs and records but for the trace, which is
   * text the chat read: handed over once what an erasure took is dropped
   * from it (`#exportedChecked`). Not paged: it is what this object reads whole
   * before every model request of the chat (`turnGuard`, whose sources
   * cross to the chat's object each time), with at most
   * `chatToolEventsKept` events and `traceCharsMax` of trace beside it.
   */
  async exportTurnState(ref: ChatRef): Promise<ExportedTurnState | undefined> {
    const chat = await this.#exportedChecked(ref);
    if (chat === undefined) {
      return undefined;
    }
    const chatId = chat.id;
    const takenOf = (prefix: string): string[] =>
      builtSchema.safeParse(this.ctx.storage.kv.get(`${prefix}${chatId}`))
        .data ?? [];
    return {
      sources: this.#db
        .select()
        .from(chatSources)
        .where(eq(chatSources.chatId, chatId))
        .all()
        .map(({ sourceId, createdAt }) => ({
          sourceId,
          createdAt: msOf(createdAt),
        })),
      runSources: this.#db
        .select()
        .from(chatRunSources)
        .where(eq(chatRunSources.chatId, chatId))
        .all()
        .map(({ runId, sourceId, withheldAt }) => ({
          runId,
          sourceId,
          withheldAt: withheldAt === null ? null : msOf(withheldAt),
        })),
      codeRuns: this.#db
        .select()
        .from(chatCodeRuns)
        .where(eq(chatCodeRuns.chatId, chatId))
        .all()
        .map(({ chatId: _chat, startedAt, endedAt, ...run }) => ({
          ...run,
          startedAt: msOf(startedAt),
          endedAt: endedAt === null ? null : msOf(endedAt),
        })),
      toolEvents: this.#db
        .select()
        .from(chatToolEvents)
        .where(eq(chatToolEvents.chatId, chatId))
        .all()
        .map(({ chatId: _chat, createdAt, ...event }) => ({
          ...event,
          createdAt: msOf(createdAt),
        })),
      trace:
        traceSchema.safeParse(
          this.ctx.storage.kv.get(`${traceKeyPrefix}${chatId}`)
        ).data ?? [],
      taken: {
        proposePlan: takenOf(builtKeyPrefix),
        draftAgent: takenOf(draftedKeyPrefix),
        draftAgentChange: takenOf(changedKeyPrefix),
      },
      draftMade:
        draftMadeSchema.safeParse(
          this.ctx.storage.kv.get(`${draftMadeKeyPrefix}${chatId}`)
        ).data ?? {},
    };
  }

  /** Whether chat `chatId` is being deleted (`chatDeletes`). */
  #isDeleting(chatId: ChatId): boolean {
    return (
      this.#db
        .select({ chatId: chatDeletes.chatId })
        .from(chatDeletes)
        .where(eq(chatDeletes.chatId, chatId))
        .get() !== undefined
    );
  }

  /**
   * Wakes the object when the next deletion under way is due
   * (`chatDeletes`). Called once deletions are marked, and as the object
   * starts, so a mark kept is never left without a wake-up: a restart
   * between the two arms it as the object starts again, and an alarm that
   * can't be written resets the object, which does the same.
   */
  async #armDeletes(): Promise<void> {
    const next = this.#db
      .select({ nextAt: chatDeletes.nextAt })
      .from(chatDeletes)
      .orderBy(asc(chatDeletes.nextAt))
      .limit(1)
      .get();
    if (next === undefined) {
      return;
    }
    try {
      await this.#alarmBy(Math.max(next.nextAt.getTime(), Date.now()));
    } catch {
      this.ctx.abort(
        "The alarm that finishes a chat's deletion could not be set."
      );
    }
  }

  /**
   * Finishes every deletion due (`chatDeletes`), at most
   * {@link deletesPerAlarm} at a time, and wakes the object again for
   * what is left: at once for more due, else when the next is.
   */
  async #finishDeletes(): Promise<void> {
    if (this.#erasing) {
      return;
    }
    const now = Date.now();
    const due = this.#db
      .select({ chatId: chatDeletes.chatId })
      .from(chatDeletes)
      .where(lte(chatDeletes.nextAt, new Date(now)))
      .orderBy(asc(chatDeletes.nextAt))
      .limit(deletesPerAlarm)
      .all();
    for (const { chatId } of due) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time, few subrequests each
      await this.#tryDelete(chatId);
    }
    await this.#armDeletes();
  }

  /**
   * Tries chat `id`'s deletion once (`#finishDelete`); one that fails is
   * logged, and tried again by the alarm after a pause that doubles each
   * time, at most {@link deleteRetryMs}`.most`.
   */
  async #tryDelete(id: ChatId): Promise<void> {
    try {
      await this.#finishDelete(id);
    } catch (error) {
      const row = this.#db
        .select({ attempts: chatDeletes.attempts })
        .from(chatDeletes)
        .where(eq(chatDeletes.chatId, id))
        .get();
      if (row === undefined) {
        return;
      }
      const attempts = row.attempts + 1;
      const nextAt = Date.now() + deleteRetryAfter(attempts);
      this.#db
        .update(chatDeletes)
        .set({ attempts, nextAt: new Date(nextAt) })
        .where(eq(chatDeletes.chatId, id))
        .run();
      // Logged as an error once it keeps failing, for alerting; tried
      // again all the same.
      (attempts >= deleteAttemptsBeforeError ? log.error : log.warn)(
        "chat.delete_failed",
        {
          workspace: this.ctx.id.name,
          chatId: id,
          attempts,
          ...errorFields(error),
        }
      );
      await this.#armDeletes();
    }
  }

  /**
   * Each step of deleting chat `id` (`chatDeletes`), every one safe to
   * repeat: erases its turns from its person's own Brain (`eraseChat`,
   * which also closes the chat there, so no turn is handed over after),
   * rejects every write its agent holds (connect's `declineChatActions`,
   * each recorded there), revokes every connection granted or asked for
   * in it and every workflow start its agent asked to have confirmed,
   * keeps its ID taken, erases what its agent kept, and then deletes its
   * rows with its mark, in one transaction. One at a time for a chat.
   */
  async #finishDelete(id: ChatId): Promise<void> {
    const under = this.#finishing.get(id);
    if (under !== undefined) {
      await under;
      return;
    }
    const finishing = this.#deleteSteps(id);
    this.#finishing.set(id, finishing);
    try {
      await finishing;
    } finally {
      this.#finishing.delete(id);
    }
  }

  async #deleteSteps(id: ChatId): Promise<void> {
    const marked = this.#db
      .select()
      .from(chatDeletes)
      .where(eq(chatDeletes.chatId, id))
      .get();
    if (marked === undefined) {
      return;
    }
    const { person, actor: by, audited } = marked;
    // The chat's row may be gone already (a release before this one
    // deleted it and left the mark): what lives outside goes all the same,
    // for the person the mark names, and the mark with it.
    const personId =
      this.#db
        .select({ personId: chats.personId })
        .from(chats)
        .where(eq(chats.id, id))
        .get()?.personId ?? person.userId;
    await eraseChat(this.env, personId, id);
    const ref = this.#refOf(id);
    const declined = await this.env.CONNECT.declineChatActions({
      person,
      ...ref,
    });
    // Counted as it goes: a repeat rejects only what is left.
    this.#db
      .update(chatDeletes)
      .set({ declined: sql`${chatDeletes.declined} + ${declined}` })
      .where(eq(chatDeletes.chatId, id))
      .run();
    // No connection granted in the chat outlives it (chat-connections.ts).
    await revokeChatPermissions(
      this.env,
      { chat: ref },
      { userId: personId, actor: by },
      "chat_deleted"
    );
    // Nor any workflow start its agent asked its person to confirm.
    await dropHeldStarts(this.env, { chat: ref });
    // And what its agent kept, the transcript the model reads with it:
    // erased for good, so nothing told it meanwhile is kept.
    await this.#toSession(id, async (session) => {
      await session.erase();
    });
    // Their rows go with it below.
    const finished = this.ctx.storage.transactionSync(() => {
      // Nothing more once the mark is gone: its person's erasure wiped the
      // object meanwhile, and nothing of the chat may come back into it.
      const { declined: total } = this.#db
        .delete(chatDeletes)
        .where(eq(chatDeletes.chatId, id))
        .returning({ declined: chatDeletes.declined })
        .get() ?? { declined: undefined };
      if (total === undefined) {
        return false;
      }
      this.#db
        .delete(brainCaptureIntents)
        .where(eq(brainCaptureIntents.evidenceId, id))
        .run();
      this.#db.delete(heldAppCalls).where(eq(heldAppCalls.chatId, id)).run();
      // A picture's parts before its file, and the files before its
      // messages: a file names the question that carried it.
      this.#db
        .delete(chatFileParts)
        .where(
          inArray(
            chatFileParts.fileId,
            this.#db
              .select({ id: chatFiles.id })
              .from(chatFiles)
              .where(eq(chatFiles.chatId, id))
          )
        )
        .run();
      this.#db.delete(chatFiles).where(eq(chatFiles.chatId, id)).run();
      this.#db
        .delete(chatSearchText)
        .where(eq(chatSearchText.chatId, id))
        .run();
      this.#db.delete(chatMessages).where(eq(chatMessages.chatId, id)).run();
      this.#db.delete(chatSources).where(eq(chatSources.chatId, id)).run();
      this.#db.delete(chatDocuments).where(eq(chatDocuments.chatId, id)).run();
      this.#db
        .delete(chatRunSources)
        .where(eq(chatRunSources.chatId, id))
        .run();
      this.#db.delete(chatCodeRuns).where(eq(chatCodeRuns.chatId, id)).run();
      // An earlier release's build jobs of the chat (schema.ts).
      this.#db.delete(chatBuildJobs).where(eq(chatBuildJobs.chatId, id)).run();
      this.#db
        .delete(chatToolEvents)
        .where(eq(chatToolEvents.chatId, id))
        .run();
      // What an earlier release kept of the chat's own drafts (schema.ts):
      // rows that name it, which go with it.
      this.#dropChatDrafts(id);
      this.#db
        .delete(chatRequestKeys)
        .where(eq(chatRequestKeys.chatId, id))
        .run();
      this.#db.delete(chats).where(eq(chats.id, id)).run();
      // Its ID stays taken here for good (`createChat`).
      this.#db.insert(deletedChats).values({ id }).onConflictDoNothing().run();
      this.ctx.storage.kv.delete(`${traceKeyPrefix}${id}`);
      this.ctx.storage.kv.delete(`${erasedKeyPrefix}${id}`);
      this.ctx.storage.kv.delete(`${builtKeyPrefix}${id}`);
      this.ctx.storage.kv.delete(`${runningKeyPrefix}${id}`);
      this.ctx.storage.kv.delete(`${queuedKeyPrefix}${id}`);
      this.ctx.storage.kv.delete(`${copiedKeyPrefix}${id}`);
      this.ctx.storage.kv.delete(`${draftMadeKeyPrefix}${id}`);
      if (audited) {
        this.#outboxed(by, "chat.deleted", id, { declined: total });
      }
      return true;
    });
    if (!finished) {
      return;
    }
    this.#deliverAudit();
    this.#stopped.delete(id);
    this.#provenanceVersions.delete(id);
    this.#heldVersions.delete(id);
    this.#worked.delete(id);
  }

  /**
   * Erases everything this object holds, as core asks once an admin erased
   * the person it is for (GRA-903, GRA-1181; core's person-erasure.ts):
   * it is theirs alone (`personalWorkspaceId`), and nobody else's data is
   * ever in it. Actions held for them in connect are connect's erasure
   * step's (`erasePersonal` drops every one made for them), not this. First what lives outside it: any connection granted in
   * their chats, and the stores their drafts' previews wrote to. Then its own storage, all of
   * it, once its audit outbox is delivered (an event never goes with it),
   * and the object restarts empty. Refused (`agent.busy`) while a turn
   * runs; asking again finishes what a failure left. Answers how many
   * chats it held.
   */
  async erasePerson(personId: string): Promise<{ chats: number }> {
    if (this.ctx.id.name !== `person:${personId}`) {
      throw agentErrors.create("agent.chat_not_found");
    }
    if (this.#turns.size > 0) {
      throw agentErrors.create("agent.busy");
    }
    // Nothing more is told in their chats from now on, also after a
    // restart before the wipe (`#erasing`), and the capture intents kept
    // for today's Brain go: nothing delivers them any more.
    this.ctx.storage.kv.put(erasingKey, true);
    this.#db
      .delete(brainCaptureIntents)
      .where(eq(brainCaptureIntents.state, "pending"))
      .run();
    await Promise.allSettled(this.#sent);
    const held = this.#db.select({ id: chats.id }).from(chats).all();
    const ids = held.map(({ id }) => id);
    for (const id of ids) {
      // oxlint-disable-next-line no-await-in-loop -- one chat at a time
      await this.#toSession(id, async (session) => {
        await session.erase();
      });
    }
    for (const id of ids) {
      // oxlint-disable-next-line no-await-in-loop -- one chat at a time
      await revokeChatPermissions(
        this.env,
        { chat: this.#refOf(id) },
        { userId: null, actor: { type: "system" } },
        "person_removed"
      );
    }
    // Every event of what it did is in the log before its outbox goes.
    if (
      (await drainObjectOutbox(
        this.env,
        this.ctx.storage.sql,
        loneNotesPerDrain
      )) > 0
    ) {
      throw internalErrors.create("internal.unexpected");
    }
    for (const watchers of this.#watchers.values()) {
      for (const watch of watchers.values()) {
        watch[Symbol.dispose]();
      }
    }
    this.#watchers.clear();
    for (const watch of this.#listWatchers.values()) {
      watch[Symbol.dispose]();
    }
    this.#listWatchers.clear();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    // Its tables went with its storage: they are made again, empty, as for
    // a new object, and nothing it held in memory of a chat stays.
    migrateOnWake(this.ctx, migrations);
    for (const kept of [
      this.#partials,
      this.#stopped,
      this.#outputs,
      this.#provenanceVersions,
      this.#heldVersions,
      this.#worked,
    ]) {
      kept.clear();
    }
    this.#codeRuns.clear();
    return { chats: ids.length };
  }

  /**
   * Follows `personId`'s own chat: `listener` gets the messages stored
   * after the one with ID `after` (for `null`, its first page, `#firstPage`)
   * and the chat as it is now, then an update on every change
   * (chat-watch.ts). Returns the ID `unwatch` drops it by; one that can't
   * be reached drops itself.
   */
  async watch(
    chatId: unknown,
    personId: string,
    after: unknown,
    listener: ChatListener
  ): Promise<string> {
    const since = afterSchema.safeParse(after);
    if (!since.success) {
      throw agentErrors.create("agent.invalid_request");
    }
    // What an erasure took is replaced before anything of the chat is shown.
    const masked = await this.#replaceErased(
      this.#scopeOf(this.#graspChat(chatId, personId))
    );
    // Read again after the await: the chat may have gone meanwhile.
    const { id, readUpTo } = this.#graspChat(chatId, personId);
    this.#requireRoomToWatch();
    const page =
      since.data === null
        ? this.#firstPage(id, readUpTo)
        : { after: since.data, older: undefined };
    const watchId = crypto.randomUUID();
    const watch = new ChatWatch(
      listener.dup(),
      () => this.#state(id),
      () => this.#provenance(id),
      () => {
        this.unwatch(id, watchId);
      },
      readUpTo,
      page.older,
      since.data === null ? this.#answeredBuilds(id) : undefined
    );
    const watchers = this.#watchers.get(id) ?? new Map<string, ChatWatch>();
    watchers.set(watchId, watch);
    this.#watchers.set(id, watchers);
    watch.push(this.#shownAfter(id, page.after, masked), this.#toolEvents(id));
    return watchId;
  }

  /**
   * The page of `personId`'s chat before the message with ID `before`, as
   * the watch sends messages (`history`): what an erasure took replaced,
   * then read in one go, so a message stored meanwhile is never in it.
   */
  async history(
    chatId: unknown,
    personId: string,
    before: unknown
  ): Promise<ChatHistoryPage> {
    const upTo = beforeSchema.safeParse(before);
    if (!upTo.success) {
      throw agentErrors.create("agent.invalid_request");
    }
    const masked = await this.#replaceErased(
      this.#scopeOf(this.#graspChat(chatId, personId))
    );
    // Read again after the await: the chat may have gone meanwhile.
    const { id } = this.#graspChat(chatId, personId);
    const { after, older } = this.#pageBefore(id, upTo.data);
    return {
      messages: this.#shownAfter(id, after, masked, upTo.data),
      older,
    };
  }

  /**
   * Where a watch from the start begins (after the message with ID
   * `after`), and whether there is more before (`older`): its newest page
   * (`#pageBefore`), or, when the person hadn't seen as far back
   * (`readUpTo`), everything they hadn't seen, so the chat opens at its
   * New line with nothing more to read. A chat made before chats kept
   * where their person read to counts as read.
   */
  #firstPage(
    chatId: ChatId,
    readUpTo: number | null
  ): { after: number; older: boolean } {
    const page = this.#pageBefore(chatId);
    if (readUpTo === null || readUpTo >= page.after) {
      return page;
    }
    const after = this.#turnOf(chatId, readUpTo + 1) - 1;
    return { after, older: this.#anyFrom(chatId, after) };
  }

  /**
   * Where the page of chat `chatId` before message `before` (its newest,
   * for none) begins: after the ID it answers, so it holds at most
   * {@link chatHistoryPage} messages and the rest of the turn its first
   * one is in (`#turnOf`); and whether anything is older. Read by the
   * index on the chat's messages.
   */
  #pageBefore(
    chatId: ChatId,
    before?: number
  ): { after: number; older: boolean } {
    const ofChat = and(
      eq(chatMessages.chatId, chatId),
      before === undefined ? undefined : lt(chatMessages.id, before)
    );
    const oldest = this.#db
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(ofChat)
      .orderBy(desc(chatMessages.id))
      .limit(1)
      .offset(chatHistoryPage - 1)
      .get();
    if (oldest === undefined) {
      return { after: 0, older: false };
    }
    const after = this.#turnOf(chatId, oldest.id) - 1;
    return { after, older: this.#anyFrom(chatId, after) };
  }

  /**
   * Where the turn of chat `chatId`'s message with ID `id` begins: the ID
   * of its question, the last at or before it, or `id` itself with none.
   * A page starts there, never in the middle of an answer.
   */
  #turnOf(chatId: ChatId, id: number): number {
    const question = this.#db
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.chatId, chatId),
          lte(chatMessages.id, id),
          sql`json_extract(${chatMessages.message}, '$.role') = 'user'`
        )
      )
      .orderBy(desc(chatMessages.id))
      .limit(1)
      .get();
    return question?.id ?? id;
  }

  /**
   * What each Build it of chat `chatId` made whose turn its agent answered:
   * the last Build it of each, answered when an answer came after it. Read
   * from the whole chat, as a page of it may hold neither (`ChatUpdate.answeredBuilds`).
   */
  #answeredBuilds(chatId: ChatId): ChatMade[] {
    const builds = this.#db
      .select({ id: chatMessages.id, built: chatMessages.built })
      .from(chatMessages)
      .where(
        and(eq(chatMessages.chatId, chatId), isNotNull(chatMessages.built))
      )
      .orderBy(asc(chatMessages.id))
      .all();
    if (builds.length === 0) {
      return [];
    }
    const answered =
      this.#db
        .select({ id: chatMessages.id })
        .from(chatMessages)
        .where(
          and(
            eq(chatMessages.chatId, chatId),
            sql`json_extract(${chatMessages.message}, '$.role') = 'assistant'`
          )
        )
        .orderBy(desc(chatMessages.id))
        .limit(1)
        .get()?.id ?? 0;
    // The last Build it of each thing it made.
    const last = new Map<string, { made: ChatMade; at: number }>();
    for (const { id, built } of builds) {
      const shown = builtOf(built);
      for (const kind of ["app", "workflow"] as const) {
        const made = shown?.[kind];
        if (made !== undefined) {
          last.set(`${kind}:${made.id}`, {
            made: { kind, id: made.id },
            at: id,
          });
        }
      }
    }
    return [...last.values()].flatMap(({ made, at }) =>
      answered > at ? [made] : []
    );
  }

  /** Whether chat `chatId` has a message with an ID up to `upTo`. */
  #anyFrom(chatId: ChatId, upTo: number): boolean {
    return (
      this.#db
        .select({ id: chatMessages.id })
        .from(chatMessages)
        .where(and(eq(chatMessages.chatId, chatId), lte(chatMessages.id, upTo)))
        .limit(1)
        .get() !== undefined
    );
  }

  /** Refuses another watcher once the object holds its most (chats' and lists' together). */
  #requireRoomToWatch(): void {
    let watching = this.#listWatchers.size;
    for (const watchers of this.#watchers.values()) {
      watching += watchers.size;
    }
    if (watching >= maxWatchers) {
      throw agentErrors.create("agent.too_many_watches");
    }
  }

  /**
   * Follows `personId`'s list of chats, as `chats` gives it: `listener`
   * gets the whole list, then what changes in it (chat-watch.ts,
   * `ChatListWatch`). Returns the ID `unwatchChats` drops it by; one that
   * can't be reached drops itself.
   */
  watchChats(personId: string, listener: ChatListListener): string {
    this.#requireRoomToWatch();
    const watchId = crypto.randomUUID();
    const watch = new ChatListWatch(listener.dup(), personId, () => {
      this.unwatchChats(watchId);
    });
    this.#listWatchers.set(watchId, watch);
    watch.push(this.#listOf(personId));
    return watchId;
  }

  /** Drops the list's watcher `watchChats` kept as `watchId`, if it still does. */
  unwatchChats(watchId: string): void {
    const watch = this.#listWatchers.get(watchId);
    this.#listWatchers.delete(watchId);
    watch?.[Symbol.dispose]();
  }

  /**
   * Tells whoever follows a list of chats that it may have changed: a
   * chat made, renamed, archived or deleted, asked in, answered, running
   * or not, read. Once a tick, however many changes it made: each
   * watcher then sends only what of its list did change.
   */
  #listChanged(): void {
    if (this.#listTold || this.#listWatchers.size === 0) {
      return;
    }
    this.#listTold = true;
    queueMicrotask(() => {
      this.#listTold = false;
      // Read once for each person followed, whoever many follow it.
      const lists = new Map<string, ChatList>();
      for (const watch of this.#listWatchers.values()) {
        const list = lists.get(watch.personId) ?? this.#listOf(watch.personId);
        lists.set(watch.personId, list);
        watch.push(list);
      }
    });
  }

  /** `personId`'s list as its watchers follow it: what `chats` gives, and how many they archived. */
  #listOf(personId: string): ChatList {
    return {
      chats: this.chats(personId),
      archived: this.#archivedCount(personId),
    };
  }

  /** How many chats `personId` archived. */
  #archivedCount(personId: string): number {
    return (
      this.#db
        .select({ archived: count() })
        .from(chats)
        .where(and(shownInGrasp(personId), isNotNull(chats.archivedAt)))
        .get()?.archived ?? 0
    );
  }

  /** Drops the watcher `watch` kept as `watchId`, if it still does. */
  unwatch(chatId: ChatId, watchId: string): void {
    const watchers = this.#watchers.get(chatId);
    const watch = watchers?.get(watchId);
    watchers?.delete(watchId);
    if (watchers?.size === 0) {
      this.#watchers.delete(chatId);
    }
    watch?.[Symbol.dispose]();
  }

  /**
   * Tells the chat's watchers its agent had a write held for the person
   * (agent-connections.ts), so the page shows it to confirm at once, in
   * the middle of a turn too. Nothing of the write itself.
   */
  heldChanged(chatId: ChatId): void {
    this.#heldVersions.set(chatId, (this.#heldVersions.get(chatId) ?? 0) + 1);
    this.#changed(chatId);
  }

  /**
   * Tells the agent of `personId`'s own chat how a call it had held for
   * them ended (pending-actions.ts), a write or a read (GRA-1928), which
   * it otherwise never learns: a notice in its context
   * (`ChatSession.note`), which the turn under way reads before its next
   * request, or else the next turn. The person isn't shown it: they
   * decided it. No turn starts here: confirmed in the chat, its page goes
   * on in a turn the person's own message starts (GRA-2224).
   */
  async heldDecided(
    chatId: unknown,
    personId: string,
    held: { id: string; action: string },
    outcome: HeldOutcome
  ): Promise<void> {
    const chat = this.#ownChat(chatId, personId);
    const { id, action } = heldSchema.parse(held);
    // Once by the held call's ID: it is decided once, and its decider sends
    // this again should this object reset under the call (pending-actions.ts).
    await this.#note(
      chat.id,
      `The call you asked for, "${action}" (pending ID ${id}), was decided. ${heldOutcomes[outcome]} Read how it ended, with what it returned, with \`env.connections.outcome("${id}")\`.`,
      `held:${id}`
    );
  }

  /**
   * Tells the chat's agent `text` (`ChatSession.note`), and moves the chat
   * up its person's list: often decided elsewhere, it is where the agent
   * can now go on. Refused while the chat is deleted or its person
   * erased: what is told then would outlive the erasure. Its callers keep
   * the decision all the same. Told once by `requestId`: a caller that may
   * send the same notice again names it, else each call is its own.
   */
  async #note(
    chatId: ChatId,
    text: string,
    requestId: string = crypto.randomUUID()
  ): Promise<void> {
    if (this.#isDeleting(chatId) || this.#erasing) {
      throw agentErrors.create("agent.chat_not_found");
    }
    // Again on a stub of its own should the chat's object reset under the
    // call, as one that opens cold under load can: a decision's notice is
    // never dropped for a restart (`#toSession`), and never told twice for
    // one that came after it was kept (`requestId`).
    await this.#toSession(chatId, async (session) => {
      await session.note(text, requestId);
    });
    this.#db
      .update(chats)
      .set({ lastAt: new Date() })
      .where(eq(chats.id, chatId))
      .run();
    this.#listChanged();
    this.#changed(chatId);
  }

  /**
   * Tells the agent of `personId`'s own chat how a connection it asked for
   * there was decided (chat-connections.ts), as `heldDecided` does a
   * write: a notice for its turn under way or its next, and the page reads what
   * waits again. No turn starts: the person says what to do next.
   */
  async connectionDecided(
    chatId: unknown,
    personId: string,
    { binding, decision }: { binding: string; decision: "granted" | "denied" }
  ): Promise<void> {
    const chat = this.#ownChat(chatId, personId);
    const name = bindingNameSchema.parse(binding);
    await this.#note(
      chat.id,
      decision === "granted"
        ? `The connection you asked for as "${name}" was granted, in this chat only: \`env.connections.call("${name}", …)\` works now.`
        : `The connection you asked for as "${name}" was denied: this chat can't use it. Don't ask for it again unless the person says so.`
    );
    this.heldChanged(chat.id);
  }

  /**
   * Tells the agent of `personId`'s own chat how the packages it asked for
   * there were decided (packages/requests.ts), as `connectionDecided` does
   * a connection: a notice for its turn under way or its next, and the
   * page reads what waits again. No turn starts.
   */
  async packagesDecided(
    chatId: unknown,
    personId: string,
    decision: "approved" | "denied"
  ): Promise<void> {
    const chat = this.#ownChat(chatId, personId);
    await this.#note(
      chat.id,
      decision === "approved"
        ? "The npm packages you asked for were approved: code that imports them builds now."
        : "The npm packages you asked for were denied. Don't ask for them again unless the person says so."
    );
    this.heldChanged(chat.id);
  }

  /**
   * Refuses a chat that isn't `personId`'s own, as if there were none: for
   * what core keeps of a chat elsewhere (its connection and package
   * requests).
   */
  requireChat(chatId: unknown, personId: string): ChatId {
    return this.#graspChat(chatId, personId).id;
  }

  // What a chat's agent writes of Apps' drafts (agent-builds.ts), which
  // live in core's database (drafts.ts): only what the chat's thread
  // shows of it. Only core calls these, for the chat's agent.

  /**
   * The turn and code step (its tool call's ID) of the chat's code run
   * `runId`, from the run's own record: what a draft's checkpoint names,
   * never what the run's code says. Nulls for a run that isn't there.
   */
  codeRunOf(
    chatId: ChatId,
    runId: string
  ): { turnId: string | null; callId: string | null } {
    const run = this.#db
      .select({ callId: chatCodeRuns.toolCallId, turnId: chatCodeRuns.turnId })
      .from(chatCodeRuns)
      .where(and(eq(chatCodeRuns.id, runId), eq(chatCodeRuns.chatId, chatId)))
      .get();
    return { turnId: run?.turnId ?? null, callId: run?.callId ?? null };
  }

  /**
   * Tells the chat's watchers its agent wrote an App's draft, so they read
   * what it worked on again (`ChatsApi.worked`). The App's preview hears
   * of the write from the write itself (drafts.ts).
   */
  draftWritten(chatId: unknown): void {
    const chat = chatIdSchema.safeParse(chatId);
    if (!chat.success) {
      return;
    }
    this.#worked.set(chat.data, (this.#worked.get(chat.data) ?? 0) + 1);
    this.#changed(chat.data);
  }

  /**
   * Deletes what an earlier release kept of chat `id`'s own drafts and
   * their previews (schema.ts: unused since the App's one shared draft):
   * its rows name the chat, so they go with it.
   */
  #dropChatDrafts(id: ChatId): void {
    this.#db.delete(chatDraftFiles).where(eq(chatDraftFiles.chatId, id)).run();
    this.#db
      .delete(chatDraftVersionFiles)
      .where(eq(chatDraftVersionFiles.chatId, id))
      .run();
    this.#db
      .delete(chatDraftContents)
      .where(eq(chatDraftContents.chatId, id))
      .run();
    this.#db
      .delete(chatDraftVersions)
      .where(eq(chatDraftVersions.chatId, id))
      .run();
    this.#db.delete(chatDrafts).where(eq(chatDrafts.chatId, id)).run();
  }

  /**
   * Whether the chat's turn checks the drafts it wrote now
   * (agent-builds.ts, `turnCheck`): what its watchers show while the turn
   * goes on past its answer.
   */
  turnChecking(chatId: unknown, checking: boolean): void {
    const chat = chatIdSchema.safeParse(chatId);
    if (!chat.success) {
      return;
    }
    if (checking) {
      this.#checking.add(chat.data);
    } else {
      this.#checking.delete(chat.data);
    }
    this.#changed(chat.data);
  }

  /**
   * Shows the chat's watchers what its turn's model request waits on (the
   * model gateway's `ModelWait`), or that it no longer waits.
   */
  turnWaiting(chatId: ChatId, waiting: ModelWait | null): void {
    if (this.chatState(chatId) === undefined || this.#isDeleting(chatId)) {
      return;
    }
    if (waiting === null) {
      this.#waits.delete(chatId);
    } else {
      this.#waits.set(chatId, waiting);
    }
    this.#changed(chatId);
  }

  /** Tells the chat's watchers it changed, with the messages just stored. */
  #changed(chatId: ChatId, messages: readonly ChatMessage[] = []): void {
    for (const watch of this.#watchers.get(chatId)?.values() ?? []) {
      watch.push(messages);
    }
  }

  /** The chat as its watchers see it now, besides its messages. */
  #state(chatId: ChatId): ChatState {
    const partial = this.#partials.get(chatId);
    const stopped = this.#stopped.get(chatId);
    return {
      partial:
        partial === undefined
          ? null
          : {
              // Whose it is, so the page names the agent writing it.
              agentId:
                this.#turns.get(chatId)?.agentId ?? this.#chat(chatId).agentId,
              ...partialOf(partial),
            },
      output: outputOf(this.#outputs.get(chatId)),
      running: this.#isRunning(chatId),
      queued: this.#queued(chatId),
      provenanceVersion: this.#provenanceVersions.get(chatId) ?? 0,
      stopped: stopped ?? null,
      held: this.#heldVersions.get(chatId) ?? 0,
      worked: this.#worked.get(chatId) ?? 0,
      checking: this.#checking.has(chatId),
      waiting: this.#waits.get(chatId) ?? null,
    };
  }

  /** What the chat's answers may hold: read only when it changed. */
  #provenance(chatId: ChatId): ChatProvenance {
    return {
      sources: this.#sources(chatId),
      restricted: this.isChatRestricted(chatId) === true,
    };
  }

  /** Marks the chat's provenance changed, and tells its watchers. */
  #provenanceChanged(chatId: ChatId): void {
    this.#provenanceVersions.set(
      chatId,
      (this.#provenanceVersions.get(chatId) ?? 0) + 1
    );
    this.#changed(chatId);
  }

  /**
   * The chat's messages stored after the one with ID `after`, as shown:
   * the result of each run in `masked` as its replacement would read
   * (`#replaceErased`).
   */
  #shownAfter(
    chatId: ChatId,
    after: number,
    masked: ReadonlySet<string> = new Set(),
    /** Only those before the message with this ID, a page of history's. */
    before?: number
  ): ChatMessage[] {
    const asking = this.#asksIn(chatId);
    const carried = this.#filesAfter(chatId, after);
    return this.#db
      .select()
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.chatId, chatId),
          gt(chatMessages.id, after),
          before === undefined ? undefined : lt(chatMessages.id, before)
        )
      )
      .orderBy(asc(chatMessages.id))
      .all()
      .flatMap((row) => {
        const {
          id,
          message,
          createdAt,
          thinkingMs,
          built,
          agentId,
          requestKey,
        } = row;
        const stored = storedMessageSchema.parse(JSON.parse(message));
        const run = resultRunId(stored);
        const shown = withFiles(
          chatMessageOf(
            id,
            run !== undefined && masked.has(run)
              ? withheldCopy(stored)
              : stored,
            createdAt,
            thinkingMs,
            asking,
            builtOf(built),
            agentId ?? undefined,
            requestKey ?? undefined
          ),
          carried
        );
        if (shown === undefined) {
          return [];
        }
        return shown.role === "assistant" && row.rating !== null
          ? [
              {
                ...shown,
                rating: {
                  value: row.rating,
                  ...(row.ratingReason === null
                    ? {}
                    : { reason: row.ratingReason }),
                },
              },
            ]
          : [shown];
      });
  }

  /**
   * The chat, if it is `personId`'s and one Grasp shows them
   * (`shownInGrasp`): what every by-ID read of a person's surface goes
   * through. Anything else, anyone else's or a chat app's conversation,
   * is refused in the same statement, as if there were none.
   */
  #graspChat(chatId: unknown, personId: string): Chat {
    const id = chatIdSchema.safeParse(chatId);
    const chat = id.success
      ? this.#db
          .select()
          .from(chats)
          .where(and(eq(chats.id, id.data), shownInGrasp(personId)))
          .get()
      : undefined;
    if (chat === undefined) {
      throw agentErrors.create("agent.chat_not_found");
    }
    return chat;
  }

  /**
   * The chat, if it is `personId`'s, whichever channel it came through:
   * for core's own calls on a decision made for it (`heldDecided`,
   * `connectionDecided`, `packagesDecided`), a chat app's included, never
   * for what a person's surface reads (`#graspChat`). Anyone else's is
   * refused as if there were none.
   */
  #ownChat(chatId: unknown, personId: string): Chat {
    const chat = this.#chat(chatId);
    if (chat.personId !== personId) {
      throw agentErrors.create("agent.chat_not_found");
    }
    return chat;
  }

  /**
   * The chat, if it is `personId`'s and came through `via`: where its held
   * App calls are shown, so the only place they are listed and decided
   * (GRA-1929). Grasp's own app (`web`) never finds a chat app's, as
   * `#graspChat`; a chat app's card finds only its own platform's. Anything
   * else is refused as if there were none.
   */
  #chatThrough(chatId: unknown, personId: string, via: ChatChannel): Chat {
    const chat = this.#ownChat(chatId, personId);
    if (chat.via !== via) {
      throw agentErrors.create("agent.chat_not_found");
    }
    return chat;
  }

  #chat(chatId: unknown): Chat {
    const id = chatIdSchema.safeParse(chatId);
    const chat = id.success
      ? this.#db.select().from(chats).where(eq(chats.id, id.data)).get()
      : undefined;
    if (chat === undefined) {
      throw agentErrors.create("agent.chat_not_found");
    }
    return chat;
  }

  #storedChars(chatId: ChatId): number {
    const [row] = this.ctx.storage.sql
      .exec<{ chars: number }>(
        "SELECT coalesce(sum(length(message)), 0) AS chars FROM chat_messages WHERE chat_id = ?",
        chatId
      )
      .toArray();
    return row?.chars ?? 0;
  }

  #transcript(chatId: ChatId): Message[] {
    return this.#db
      .select({ message: chatMessages.message })
      .from(chatMessages)
      .where(eq(chatMessages.chatId, chatId))
      .orderBy(asc(chatMessages.id))
      .all()
      .map(({ message }) => storedMessageSchema.parse(JSON.parse(message)));
  }
}
