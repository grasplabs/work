import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { agentErrors } from "@grasp-os/shared/agent";
import {
  actorOf,
  auditProvenanceMaxItems,
  createAuditEvent,
  delegateActorOf,
} from "@grasp-os/shared/audit";
import type {
  AuditActor,
  AuditDetailValue,
  AuditEntry,
} from "@grasp-os/shared/audit";
import {
  chatChannelSchema,
  chatFilesMax,
  chatFilesPerQuestionMax,
  chatPlatformName,
  chatMentionsMax,
  chatPlanSchema,
  chatPlatformSchema,
  chatSubjectSchema,
  chatToolEventsKept,
} from "@grasp-os/shared/chat";
import type {
  ChatChannel,
  ChatCitedDocument,
  ChatFile,
  ChatFileType,
  ChatMake,
  ChatMessage,
  ChatOutput,
  ChatPlan,
  ChatProvenance,
  ChatSearchHit,
  ChatSearchSnippet,
  ChatSummary,
  ChatToolEvent,
} from "@grasp-os/shared/chat";
import { foldOf, hasEvery, searchWordsOf } from "@grasp-os/shared/chat-search";
import type { ConnectionPerson } from "@grasp-os/shared/connect";
import {
  dashboardErrors,
  dashboardWidgetIdSchema,
  standardWidgetIdSchema,
} from "@grasp-os/shared/dashboard";
import type {
  DashboardLayout,
  DashboardWidgetId,
  StandardWidgetId,
} from "@grasp-os/shared/dashboard";
import {
  internalErrors,
  isExpectedError,
  withReference,
} from "@grasp-os/shared/errors";
import {
  chatIdSchema,
  identifierSchema,
  workspaceIdSchema,
} from "@grasp-os/shared/ids";
import type { AppId, ChatId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import { modelEfforts, modelErrors } from "@grasp-os/shared/models";
import {
  bindingNameSchema,
  permissionActionSchema,
  permissionErrors,
} from "@grasp-os/shared/permissions";
import type { Authority } from "@grasp-os/shared/permissions";
import { redact } from "@grasp-os/shared/redact";
import { canBuild, roleSchema } from "@grasp-os/shared/roles";
import { customWidgetsMax } from "@grasp-os/shared/widgets";
import type { CustomWidgetId, WidgetSpec } from "@grasp-os/shared/widgets";
import { DurableObject } from "cloudflare:workers";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  or,
  max,
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
import { builtNoteText, inOwnWords } from "./agent.ts";
import type { QuestionBuilt, TurnContext, TurnResult } from "./agent.ts";
import { turnAgent } from "./agents.ts";
import { drainObjectOutbox } from "./audit-outbox.ts";
import { memberRole } from "./auth/identity.ts";
import {
  drainCaptures,
  eraseCaptured,
  turnEventId,
  turnOutcome,
  turnSource,
} from "./brain-capture.ts";
import type { CaptureStore, TurnFacts } from "./brain-capture.ts";
import { skillsFor } from "./brain-skills.ts";
import {
  channelText,
  heldWriteRefusal,
  turnCheckOf,
  withoutLinks,
} from "./channels/stephen-rules.ts";
import type { HeldWriteRefusal, TurnCheck } from "./channels/stephen-rules.ts";
import { revokeChatPermissions } from "./chat-connections.ts";
import type {
  TurnCapture,
  TurnEnd,
  TurnMessage,
  TurnRequest,
  TurnStop,
} from "./chat-harness.ts";
import {
  chatMessageOf,
  noteLinksOf,
  partialOf,
  shownBuiltSchema,
} from "./chat-messages.ts";
import type { ShownBuilt } from "./chat-messages.ts";
import {
  saidOf,
  searchTermsOf,
  snippetOf,
  snippetReach,
} from "./chat-search.ts";
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
import { keptWidgetOf } from "./custom-widgets.ts";
import type { KeptWidget } from "./custom-widgets.ts";
import { migrateOnWake } from "./db/migrate.ts";
import migrations from "./db/workspace/migrations/migrations.js";
import {
  auditOutbox,
  brainCaptureIntents,
  chatBuildJobs,
  chatCodeRuns,
  chatDraftContents,
  chatDraftFiles,
  chatDraftVersionFiles,
  chatDraftVersions,
  maxToolCallIdChars,
  chatDocuments,
  chatDrafts,
  chatFiles,
  chatMessages,
  chatRunSources,
  chatSearchText,
  chatSources,
  chatToolEvents,
  chats,
  customWidgets,
  dashboardWidgets,
  dashboards,
} from "./db/workspace/schema.ts";
import { callObject, chatSession } from "./durable-objects.ts";
import { dropHeldStarts } from "./held-starts.ts";
import { readableSources, withheldSourceDetail } from "./history-access.ts";
import { instructionFilesFor } from "./instruction-files.ts";
import type { InstructionContext } from "./instruction-files.ts";
import {
  audienceMaxMembers,
  audienceOf,
  keepAudience,
} from "./knowledge/access.ts";
import { readAsDelegate } from "./knowledge/binding.ts";
import { cited } from "./knowledge/citations.ts";
import { brainOf } from "./knowledge/ports.ts";
import { hasBrainGrant } from "./knowledge/recall-grants.ts";
import { inputTokens, modelSettings, models } from "./models.ts";
import type { WorkContext } from "./restricted.ts";

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
  /** What the turn read through connections, for its check line. */
  reads: TurnCheck[];
  /**
   * The calls its code made, as the chat shows them: for a chat app's
   * request record (channels/stephen-requests.ts), which keeps the tools
   * and how each ended, never what they read. Only when its asker wants them.
   */
  calls?: ToolCall[];
  /** The last response it kept: its answer, once it ends. */
  answer?: number;
  /** Tells a chat platform's asker the answer's text so far. */
  onText?: (text: string) => unknown;
  /**
   * What its model requests read from the provider's prompt cache, of all
   * the prompt tokens they sent, recorded once the turn ends.
   */
  cache: { requests: number; inputTokens: number; cacheReadTokens: number };
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
 * now (`Audience` in knowledge/access.ts).
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
 * Where a chat's agent works, for its instruction files: never a person's
 * own file where others read the answer (a chat others share); a chat
 * platform's direct message is the person's, without an App; Grasp's own
 * chat is theirs, about the App it was made for, if any.
 */
const instructionContextOf = (
  shared: boolean,
  via: ChatChannel,
  appId: string | null
): InstructionContext => {
  if (shared) {
    return { conversation: "channel" };
  }
  if (via !== "web") {
    return { conversation: "direct" };
  }
  return appId === null
    ? { conversation: "own" }
    : { conversation: "own", appId };
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
  subject: chatSubjectSchema.extend({ name: z.string().min(1) }).optional(),
  /**
   * What the person picked with `@` in it, as core found each for them
   * (`ChatsApi.send`), by name: never the page's word for a name.
   */
  mentions: z
    .array(
      z.discriminatedUnion("kind", [
        z.strictObject({
          kind: z.enum(["app", "workflow"]),
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
   * Build it, said to the chat's plan (by its call): what core made of it
   * (`ChatsApi.build`), never the page's word.
   */
  built: z
    .strictObject({
      plan: z.string(),
      app: z.strictObject({ id: z.string(), name: z.string() }).optional(),
      workflow: z.strictObject({ id: z.string(), name: z.string() }).optional(),
      project: z.string().optional(),
    })
    .optional(),
});
export type Question = z.input<typeof questionSchema>;

/** What "Make something" started `chat` to make, as kept with it; null for any other chat. */
export const makeOf = ({
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
 * The turn's question (`TurnRequest`): as asked, with the files it carries,
 * and what the chat was started to make (`make`), if anything.
 */
const turnQuestion = (
  {
    text,
    model,
    effort,
    subject,
    mentions,
    built,
  }: z.output<typeof questionSchema>,
  files: { id: string; type: string }[],
  make: ChatMake | null
): TurnRequest["question"] => ({
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
 * chat has read from (collections and connections), and whether it read
 * restricted data, so the answer may carry sensitive content.
 */
export interface AnswerProvenance {
  sources: string[];
  restricted: boolean;
}

/**
 * A turn's result, labelled with what it may hold, with the documents its
 * answer cites: those its chat's code was given before it that it links
 * to, each while the chat's agent may still read it for its person
 * (`ChatCitedDocument`). A channel shows them as the answer's sources.
 */
export type Answer = TurnResult & {
  provenance: AnswerProvenance;
  cited: ChatCitedDocument[];
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

/**
 * Most characters a chat's transcript may hold: a chat past it takes no
 * more questions, so loading one never parses more than this and one turn.
 * The model reads as much of it, newest first, as its window takes
 * (`recentHistory` in agent.ts), which for every model is less than this.
 */
export const maxChatChars = 4_000_000;

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
 * a few collections or a connection, each an identifier.
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

/** Most documents one read hands a chat's code: a page of hits or links. */
const givenMaxPerRead = 1000;

/**
 * The documents one read hands a chat's code, by ID: the first
 * {@link givenMaxPerRead}, as a read past them is still handed over (its
 * answers then cite no more of it).
 */
const givenSchema = z
  .array(identifierSchema)
  .transform((ids) => ids.slice(0, givenMaxPerRead));

/**
 * Most documents a chat keeps as given (`chatDocuments`): its answers may
 * cite those, the newest; an older one is dropped as a newer comes in.
 */
export const chatDocumentsMax = 500;

/**
 * How long Grasp holds a widget in hand at most (`claimWidget`): longer
 * than making one takes, with its repairs, so a request that never let go
 * of it doesn't hold it for good.
 */
const widgetHandMs = 5 * 60 * 1000;

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

/** How long the alarm waits before delivering turns' outcomes again. */
const captureRetryMs = 60 * 1000;

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
 * Kept across turns, up to {@link traceCharsMax}, oldest dropped first.
 */
const traceKeyPrefix = "trace:";

/**
 * The plans of a chat Build it made, as `built:<chat>`: the calls that
 * proposed them (`takePlan`), so each is made once.
 */
const builtKeyPrefix = "built:";

const builtSchema = z.array(z.string());

/**
 * A chat whose turn runs, as `running:<chat>`: a copy of what its
 * `ChatSession` holds (`turnRunning`), for the chat's lists and watchers,
 * kept through a restart of this object. Never what decides a turn: that
 * object does.
 */
const runningKeyPrefix = "running:";

/**
 * What of a chat's `ChatSession` its messages were kept of, as
 * `copied:<chat>`: the last entry, and the last answer kept with it. That
 * object copies at least once, so a copy it sends again after a restart
 * is passed over, and answered as the first was (`keepTurnMessages`).
 */
const copiedKeyPrefix = "copied:";

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
   * The widgets Grasp is making or changing now, by `<person>/<widget>`,
   * each until when it holds them (`claimWidget`).
   */
  readonly #widgetsInHand = new Map<string, number>();

  /**
   * Turns `send` started, each settled once its turn ends: the alarm waits
   * for them, so the object stays up while its agent works with nobody
   * waiting on a call.
   */
  readonly #sent = new Set<Promise<void>>();

  /** The deliveries of capture intents under way (`#deliverCaptures`). */
  readonly #delivering = new Set<Promise<void>>();

  /**
   * Set once its person's erasure began (`erasePerson`): from then on no
   * capture of a turn is delivered to the Brain, so none lands after the
   * erasure took out what the Brain held of their chats.
   */
  #erasing = false;

  /**
   * Bumped whenever a chat's sources or restricted mode change, so a
   * watcher reads them again only then. In memory: a watcher starts with
   * none, so it reads them first.
   */
  readonly #provenanceVersions = new Map<ChatId, number>();

  /**
   * Chats being deleted (`deleteChat`): they take no question meanwhile.
   * In memory, for the one call that deletes: a restart ends that call.
   */
  readonly #deleting = new Set<ChatId>();

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
   * Bumped whenever a chat's agent writes an App's draft, so its watchers
   * read what it worked on again (`draftWritten`). In memory only.
   */
  readonly #worked = new Map<ChatId, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    migrateOnWake(ctx, migrations);
    this.#closeInterruptedRuns();
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
    built: ShownBuilt | null = null
  ): { id: number; createdAt: Date } {
    const stored = this.#db
      .insert(chatMessages)
      .values({
        chatId,
        message: JSON.stringify(message),
        createdAt: new Date(),
        thinkingMs,
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
      .where(
        and(eq(chats.personId, personId), isNull(chatSearchText.messageId))
      )
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
        appId: chats.appId,
        via: chats.via,
        makeKind: chats.makeKind,
        makeProject: chats.makeProject,
        agentId: chats.agentId,
        said: sql<string>`'' || ${saidWords}`,
      })
      .from(chats)
      .where(eq(chats.personId, personId))
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
    }: {
      thinkingMs?: number;
      files?: readonly string[];
      built?: ShownBuilt;
    } = {}
  ): number {
    // A question and the files it carries are kept together: each file is
    // its, and no other's.
    const { id, createdAt } =
      files.length === 0
        ? this.#store(chatId, message, thinkingMs ?? null, built ?? null)
        : this.ctx.storage.transactionSync(() => {
            const stored = this.#store(
              chatId,
              message,
              thinkingMs ?? null,
              built ?? null
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
        message.role === "assistant" ? this.#givenBy(chatId)(id) : undefined,
        thinkingMs ?? null,
        message.role === "assistant" && this.#asksIn(chatId),
        built
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

  /** Refuses `personId` a new chat once they keep {@link maxChatsPerPerson}. */
  requireRoomForChat(personId: string): void {
    const [kept] = this.#db
      .select({ count: count() })
      .from(chats)
      .where(eq(chats.personId, personId))
      .all();
    if ((kept?.count ?? 0) >= maxChatsPerPerson) {
      throw agentErrors.create("agent.too_many_chats");
    }
  }

  /**
   * A new chat, which belongs to `personId`: agent `agentId` answers in it,
   * acting for them. Refused past {@link maxChatsPerPerson}. Made `by`
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
   */
  createChat(
    title: string,
    personId: string,
    agentId: string,
    by?: AuditActor,
    via: ChatChannel = "web",
    thread?: string,
    /** The App the chat is for (`appChat`), if any. */
    appId?: AppId,
    make?: ChatMake
  ): Chat {
    const agent = workspaceAgentIdSchema.safeParse(agentId);
    if (!agent.success) {
      // No agent core names: nowhere an agent can work.
      throw permissionErrors.create("permission.context_invalid");
    }
    const channel = chatChannelSchema.parse(via);
    this.requireRoomForChat(personId);
    const id = chatIdSchema.parse(crypto.randomUUID());
    const chat = this.ctx.storage.transactionSync(() => {
      if (by !== undefined) {
        this.#outboxed(
          by,
          "chat.created",
          id,
          appId === undefined ? {} : { app: appId }
        );
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
          appId: appId ?? null,
          makeKind: make?.kind ?? null,
          makeProject: make?.project ?? null,
        })
        .returning()
        .get();
      return made;
    });
    this.#deliverAudit();
    return chat;
  }

  /**
   * Attaches a file to `personId`'s own chat, as the text core read from
   * it (chats-rpc.ts), for its next question to carry: refused past
   * {@link chatFilesMax}. Audited with its ID, type and size, never its
   * name or text.
   */
  attachFile(
    chatId: unknown,
    personId: string,
    file: { name: string; type: ChatFileType; bytes: number; text: string },
    by: AuditActor
  ): ChatFile {
    const { id } = this.#ownChat(chatId, personId);
    if (this.#deleting.has(id)) {
      throw agentErrors.create("agent.chat_not_found");
    }
    const attached = this.ctx.storage.transactionSync(() => {
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
          ...file,
          createdAt: new Date(),
        })
        .returning(chatFileCard)
        .get();
      this.#outboxed(by, "chat.file_attached", id, {
        file: row.id,
        type: file.type,
        bytes: file.bytes,
      });
      return row;
    });
    this.#deliverAudit();
    return chatFileOf(attached);
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
    const { id } = this.#ownChat(chatId, personId);
    // A question starting in the chat may have chosen it already, and
    // binds it only once it is kept, after awaits (`#turn`): no file of
    // the chat is removed while it has a turn, which is taken before its
    // first await.
    if (this.#turns.has(id)) {
      throw agentErrors.create("agent.busy");
    }
    this.ctx.storage.transactionSync(() => {
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
   * The files `fileIds` names, in that order, each attached to the chat
   * and carried by no question yet: what a question may carry. Refused
   * with `agent.file_not_found` for any other.
   */
  #unsentFiles(
    chatId: ChatId,
    fileIds: readonly string[]
  ): { id: string; name: string; type: ChatFileType }[] {
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
    this.ctx.waitUntil(this.#drainAudit());
  }

  async #drainAudit(): Promise<void> {
    const left = await drainObjectOutbox(this.env, this.ctx.storage.sql);
    if (left === 0) {
      this.#auditRetryMs = auditRetryMs.first;
      return;
    }
    const retryMs = this.#auditRetryMs;
    this.#auditRetryMs = Math.min(retryMs * 2, auditRetryMs.most);
    await this.#alarmBy(Date.now() + retryMs);
  }

  /**
   * Keeps the capture intent of a turn of the chat its ChatSession settled
   * (chat-harness.ts), as its outcome for the Brain: once, by the turn's
   * event ID, however often it is delivered; none in a chat in restricted
   * mode, or one gone or being deleted. Whose turn it was is the chat's,
   * never the caller's. Delivered soon, the alarm set first so a delivery
   * cut short is tried again (brain-capture.ts).
   */
  captureTurn(chatId: ChatId, capture: TurnCapture): void {
    const chat = this.#db
      .select({ personId: chats.personId, agentId: chats.agentId })
      .from(chats)
      .where(eq(chats.id, chatId))
      .get();
    if (
      chat === undefined ||
      this.#deleting.has(chatId) ||
      this.isChatRestricted(chatId) !== false
    ) {
      return;
    }
    const facts: TurnFacts = {
      chatId,
      turnId: capture.turnId,
      personId: chat.personId,
      agentId: chat.agentId,
      audience: capture.audience,
      outcome: capture.outcome,
      answerId: capture.answerId,
      model: capture.model,
      occurredAt: new Date().toISOString(),
    };
    this.#db
      .insert(brainCaptureIntents)
      .values({
        eventId: turnEventId(facts),
        evidenceId: chatId,
        facts: JSON.stringify(facts),
        createdAt: new Date(),
      })
      .onConflictDoNothing({ target: brainCaptureIntents.eventId })
      .run();
    this.ctx.waitUntil(this.#captureSoon());
  }

  async #captureSoon(): Promise<void> {
    await this.#alarmBy(Date.now() + captureRetryMs);
    await this.#deliverCaptures();
  }

  /** Delivers the turns' pending intents; the alarm tries again if any are left. */
  async #deliverCaptures(): Promise<void> {
    if (this.#erasing) {
      return;
    }
    const delivering = (async () => {
      if (await drainCaptures(this.env, this.#captures())) {
        await this.#alarmBy(Date.now() + captureRetryMs);
      }
    })();
    this.#delivering.add(delivering);
    try {
      await delivering;
    } finally {
      this.#delivering.delete(delivering);
    }
  }

  /** This object's store of its turns' capture intents (brain-capture.ts). */
  #captures(): CaptureStore {
    const db = this.#db;
    return {
      source: turnSource(this.ctx.id.name ?? this.ctx.id.toString()),
      pending: async (limit) =>
        await Promise.resolve(
          db
            .select({
              seq: brainCaptureIntents.seq,
              eventId: brainCaptureIntents.eventId,
              evidenceId: brainCaptureIntents.evidenceId,
              facts: brainCaptureIntents.facts,
              attempts: brainCaptureIntents.attempts,
            })
            .from(brainCaptureIntents)
            .where(eq(brainCaptureIntents.state, "pending"))
            .orderBy(
              asc(brainCaptureIntents.attempts),
              asc(brainCaptureIntents.seq)
            )
            .limit(limit)
            .all()
        ),
      settled: async (seq) => {
        db.delete(brainCaptureIntents)
          .where(eq(brainCaptureIntents.seq, seq))
          .run();
        await Promise.resolve();
      },
      failed: async (seq, code, dead) => {
        db.update(brainCaptureIntents)
          .set({
            attempts: sql`${brainCaptureIntents.attempts} + 1`,
            lastError: code,
            ...(dead ? { state: "dead" as const } : {}),
          })
          .where(eq(brainCaptureIntents.seq, seq))
          .run();
        await Promise.resolve();
      },
      outcomeOf: async ({ facts }) =>
        await turnOutcome(this.env, facts, (chatId) => {
          const id = chatIdSchema.safeParse(chatId);
          // A chat being deleted has its captures erased (`deleteChat`).
          return (
            id.success &&
            !this.#deleting.has(id.data) &&
            this.isChatRestricted(id.data) === false
          );
        }),
    };
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
   * Asked where others read the answer (`shared`: a group chat, a
   * channel), it is the person's one chat for that thread instead, and who
   * is in it is kept first: its agent reads only what all of them may.
   */
  async askThrough(
    personId: string,
    agentId: string,
    via: string,
    text: string,
    onText?: (text: string) => unknown,
    shared?: SharedChat
  ): Promise<{ chatId: string; answer: Answer; calls: ToolCall[] }> {
    const platform = chatPlatformSchema.parse(via);
    const where = sharedChatSchema.optional().parse(shared);
    const [found] = this.#db
      .select()
      .from(chats)
      .where(
        and(
          eq(chats.personId, personId),
          eq(chats.via, platform),
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
        {
          workspaceId: workspaceIdSchema.parse(this.ctx.id.name),
          chatId: chat.id,
        },
        personId,
        where.audience
      );
    }
    const calls: ToolCall[] = [];
    return {
      chatId: chat.id,
      answer: await this.#turn(chat, { text, model }, undefined, onText, calls),
      calls,
    };
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
    return await this.#turn(this.#chat(chatId), question);
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
    return await this.#turn(
      this.#chat(chatId),
      question,
      undefined,
      undefined,
      undefined,
      true
    );
  }

  /**
   * Refuses a turn its person may no longer take, or one for a chat that
   * holds all it may.
   */
  async #mayTakeTurn(
    chatId: Chat["id"],
    personId: Chat["personId"]
  ): Promise<void> {
    if ((await memberRole(this.env.DB, personId)) === undefined) {
      throw permissionErrors.create("permission.person_inactive");
    }
    if (this.#storedChars(chatId) > maxChatChars) {
      throw agentErrors.create("agent.chat_full");
    }
  }

  /**
   * One turn of `chat`'s agent (`ask`). `started` is called once the turn
   * is under way: the model admitted, and nothing kept yet. `calls` gets
   * each call its code makes, as it ends.
   */
  async #turn(
    chat: Chat,
    question: Question,
    started?: () => void,
    onText?: (text: string) => unknown,
    calls?: ToolCall[],
    unattended?: boolean
  ): Promise<Answer> {
    const parsed = questionSchema.safeParse(question);
    if (!parsed.success) {
      throw agentErrors.create("agent.invalid_question");
    }
    // The agent acts for the chat's own person, as this object stored it,
    // never for whoever asks, and only while they are still a member.
    const { personId, via } = chat;
    // Being deleted: its writes are being rejected, and it takes no more.
    if (this.#deleting.has(chat.id)) {
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
      reads: [],
      calls,
      cache: { requests: 0, inputTokens: 0, cacheReadTokens: 0 },
    };
    this.#turns.set(chat.id, live);
    try {
      // Refused before anything is prepared while the chat's ChatSession
      // has a turn under way: one this object's restart left there. That
      // object refuses it again as it claims the turn.
      if ((await this.#activeTurn(chat.id)) !== undefined) {
        throw agentErrors.create("agent.busy");
      }
      await this.#mayTakeTurn(chat.id, personId);
      // The chat's agent as the company has it now: a paused one takes no
      // turn, nor one an admin deleted, and nothing is read for either.
      // Before its reach is asked, so each is refused for what it is.
      const agent = await turnAgent(this.env, chat.agentId);
      // Another of the company's agents answers only those an admin let
      // it answer, and in a chat app only where it works (agent-reach.ts).
      await requireAgentReaches(this.env, chat.agentId, personId, via);
      // Before anything is kept: a file it names that the chat hasn't, or
      // that another question carried, refuses the question.
      const files = this.#unsentFiles(chat.id, parsed.data.files ?? []);
      // A turn nobody was there for says so in its scope, which every API
      // of its code reads: it only reads (agent-scope.ts, `unattended`).
      const scope = this.#scopeOf(chat, unattended);
      // The organization's agent, acting for the chat's person, in this chat:
      // the audit log's actor, and the rules' context (its restricted mode).
      const authority = chatAuthority(scope);
      const work = chatContext(scope);
      // A chat others share reads for all of them, as they were last
      // kept: one whose audience isn't kept reads nothing, so takes no turn.
      const shared = chat.thread !== null;
      const audience = shared ? await audienceOf(this.env, work) : undefined;
      if (shared && audience === undefined) {
        throw permissionErrors.create("permission.context_invalid");
      }
      // Before the model is admitted: what memory reads is a source too.
      const context = await this.#turnContext(
        scope,
        authority,
        work,
        shared,
        agent
      );
      // Refuses a model the deployment or its rules don't allow before
      // anything is kept or shown as started, and names the model the
      // turn's capture records. The chat's object admits it again for its
      // turn, as it sets up a turn a restart cut short on its own, with
      // nobody here to admit it; and every request by the rules then.
      // The agent's own model, where an admin gave it one the organization
      // still has: else the one the question names.
      const asked = await this.#turnModel(
        context.agentModel,
        parsed.data.model
      );
      const { model } = await models(this.env).agent(
        {
          model: asked,
          effort: parsed.data.effort,
          purpose: "chat.turn",
          trigger: delegateActorOf(authority, via),
          provenance: this.#sources(chat.id),
          work: { authority, context: work },
        },
        () => this.#sources(chat.id)
      );
      this.#stopped.delete(chat.id);
      started?.();
      this.#changed(chat.id);
      if (onText !== undefined) {
        live.onText = throttled(onText);
      }
      const end = await this.#runTurn({
        turnId: live.id,
        scope,
        question: turnQuestion(
          { ...parsed.data, model: asked },
          files,
          makeOf(chat)
        ),
        shared,
        readsBrain: await hasBrainGrant(this.env, authority),
        context,
        capture: {
          model: model.id,
          audience: audience === undefined ? null : [...audience.members],
        },
      });
      if (end.stopped !== undefined) {
        throw turnStopError(end.stopped);
      }
      const { answer } = live;
      const result: TurnResult = {
        outcome: end.outcome,
        answer: via === "web" ? end.answer : withoutLinks(end.answer),
        ...(end.error === undefined ? {} : { error: end.error }),
      };
      return {
        ...result,
        provenance: {
          sources: this.#sources(chat.id),
          restricted: this.isChatRestricted(chat.id) === true,
        },
        cited:
          answer === undefined ? [] : await this.#citedOrNone(scope, answer),
        check: via === "web" ? null : turnCheckOf(live.reads),
        channelText: context.channel?.mark ?? null,
      };
    } finally {
      this.#endLive(chat.id, live);
    }
  }

  /**
   * Ends what the object holds of `live`, the chat's turn, however it
   * ended: its cache share logged, its partial answer and output dropped.
   */
  #endLive(chatId: ChatId, live: LiveTurn): void {
    const { cache } = live;
    if (cache.requests > 0) {
      // A log line, as the compiler's cache logs its own (`build.cache`):
      // a measure of how the cache does, not something done.
      log.info("chat.turn_cache", {
        chatId,
        turnId: live.id,
        ...cache,
        share: cache.cacheReadTokens / cache.inputTokens,
      });
    }
    this.#turns.delete(chatId);
    this.#partials.delete(chatId);
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
    return chatSession(
      this.env,
      workspaceIdSchema.parse(this.ctx.id.name),
      chatId
    );
  }

  /** The agent's scope in `chat`: where it is, whose agent, for whom. */
  #scopeOf(chat: Chat, unattended = false): Omit<AgentScope, "runId"> {
    const { personId, agentId, via } = chat;
    const workspaceId = workspaceIdSchema.parse(this.ctx.id.name);
    return {
      workspaceId,
      agentId,
      chatId: chat.id,
      personId,
      via,
      ...(unattended ? { unattended: true } : {}),
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
    question: Question
  ): Promise<void> {
    const chat = this.#ownChat(chatId, personId);
    const started = Promise.withResolvers<boolean>();
    const ended = this.#sentTurn(chat, question, started);
    this.#sent.add(ended);
    void this.#forget(ended);
    await started.promise;
    // The alarm keeps the object up until the turn ends (`alarm`).
    await this.#alarmBy(Date.now());
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
    started: PromiseWithResolvers<boolean>,
    unattended?: boolean
  ): Promise<void> {
    let underWay = false;
    try {
      await this.#turn(
        chat,
        question,
        () => {
          underWay = true;
          started.resolve(true);
        },
        undefined,
        undefined,
        unattended
      );
    } catch (error) {
      if (!underWay) {
        started.reject(error);
        return;
      }
      this.#stopped.set(chat.id, stopReason(chat.id, error));
      this.#changed(chat.id);
    }
  }

  /** Forgets a turn `send` started once it has ended. */
  async #forget(ended: Promise<void>): Promise<void> {
    try {
      await ended;
    } finally {
      this.#sent.delete(ended);
    }
  }

  /**
   * Waits for every turn `send` started, however long they take: an
   * object runs while an event of its own does, so it isn't evicted under
   * a turn nobody waits on. An alarm may run 15 minutes; a turn that takes
   * longer goes on while the object stays up. After a restart there are
   * none: the chat goes on from what it stored, told that its turn was cut
   * short (`#closeInterruptedTurns`).
   */
  override async alarm(): Promise<void> {
    // Audit events the log didn't take yet go first: a turn may run long.
    await this.#drainAudit();
    await this.#deliverCaptures();
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
   * and how to answer on the chat platform it came through, if any.
   */
  async #turnContext(
    scope: Parameters<typeof auditAgentCall>[1],
    authority: Authority,
    work: Extract<WorkContext, { type: "chat" }>,
    shared: boolean,
    agent: Awaited<ReturnType<typeof turnAgent>>
  ): Promise<TurnContext> {
    const { via, appId } = this.#chat(work.chatId);
    const instructions = await instructionFilesFor(
      this.env,
      authority,
      instructionContextOf(shared, via, appId)
    );
    // The skills the chat may use, from the Brain: guidance every member
    // may read, as the company's instruction file, never a grant
    // (brain-skills.ts). Recorded as the code's calls are, by count. A
    // Brain that can't answer leaves the turn without them, not without
    // an answer: missing guidance is no question of access.
    let skills: Awaited<ReturnType<typeof skillsFor>> = [];
    let unavailable = false;
    try {
      skills = await skillsFor(this.env, authority);
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
    // A chat that came through a chat platform: how to answer there.
    const channel = via === "web" ? undefined : await channelText();
    // Only who builds reads Grasp's docs, in their own chat: thousands of
    // tokens in every request, of no use to anyone else. Building, an App
    // included, needs a role that builds (app-access.ts).
    const role = await memberRole(this.env.DB, scope.personId);
    const builds = !shared && role !== undefined && canBuild(role);
    // The documents an admin gave the chat's agent, by name.
    const kept =
      agent === undefined ? [] : await documentsOf(this.env, agent.id);
    const documents = kept.map(({ id, name, type }) => ({ id, name, type }));
    return {
      instructions: instructions.map(({ file, text }) => ({ file, text })),
      skills,
      channel,
      builds,
      // The first agent as Grasp ships it, with no document, is told
      // nothing more.
      ...(agent === undefined ||
      (agent.changedAt === null && documents.length === 0)
        ? {}
        : {
            agent: {
              name: agent.name,
              instructions: agent.instructions,
              ...(documents.length === 0 ? {} : { documents }),
            },
          }),
      // The model an admin gave the agent, for its turns.
      ...(agent?.model === null || agent?.model === undefined
        ? {}
        : { agentModel: agent.model }),
    };
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
  ): Promise<CodeRunStatus> {
    return await this.#endCodeRun(
      this.#scopeOf(this.#chat(chatId)),
      runId,
      status
    );
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
   * The chat's `ChatSession` says whether a turn of the chat runs there,
   * as its record of the turn is claimed and settled (chat-harness.ts):
   * what the chat's lists and watchers show.
   */
  turnRunning(chatId: ChatId, running: boolean): void {
    if (this.chatState(chatId) === undefined || this.#deleting.has(chatId)) {
      return;
    }
    const key = `${runningKeyPrefix}${chatId}`;
    if (running) {
      this.ctx.storage.kv.put(key, true);
    } else {
      this.ctx.storage.kv.delete(key);
    }
    this.#changed(chatId);
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
   * a question with the files it carries; in a chat platform's chat, the
   * agent's words without links (`withoutLinks`). Each entry once
   * (`copiedKeyPrefix`): a copy its object sends again is passed over.
   * Answers the last answer kept of them, a response or a stopped turn's
   * end, for the turn's capture: as the first copy did, for one sent again.
   */
  keepTurnMessages(
    chatId: ChatId,
    messages: readonly TurnMessage[]
  ): number | undefined {
    if (this.chatState(chatId) === undefined || this.#deleting.has(chatId)) {
      return undefined;
    }
    const { via } = this.#chat(chatId);
    const live = this.#turns.get(chatId);
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
    } of messages) {
      answered ||= message.role === "assistant";
      if (entryId <= before.through) {
        continue;
      }
      through = Math.max(through, entryId);
      if (message.role === "assistant") {
        this.#partials.delete(chatId);
        // Only a response the provider counted a prompt for: not a request
        // the gateway refused, held or cancelled before any count.
        const prompt = inputTokens(message.usage);
        if (live !== undefined && prompt > 0) {
          live.cache.requests += 1;
          live.cache.inputTokens += prompt;
          live.cache.cacheReadTokens += message.usage.cacheRead;
        }
      }
      const id = this.#keep(
        chatId,
        via === "web" ? message : inOwnWords(message),
        {
          files,
          ...(thinkingMs === undefined ? {} : { thinkingMs }),
          ...(built === undefined ? {} : { built }),
        }
      );
      if (message.role === "assistant") {
        answer = id;
        if (live !== undefined) {
          live.answer = id;
        }
      }
    }
    // With the messages: no await between, so they are stored together.
    if (through > before.through) {
      this.ctx.storage.kv.put(copiedKey, { through, answer });
    }
    return answered ? answer : undefined;
  }

  /** Shows the chat's watchers the answer streaming in, or none. */
  showPartial(chatId: ChatId, partial: AssistantMessage | null): void {
    if (this.chatState(chatId) === undefined || this.#deleting.has(chatId)) {
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
        { agentId: output.agentId, chatId },
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
   * request or code run in flight ends, and the turn answers `cancelled`.
   * Answered once its ChatSession has the stop, kept (`ChatSession.abort`):
   * a stop that can't reach it fails, for its person to try again.
   */
  async cancel(chatId: unknown, personId: string): Promise<boolean> {
    const { id } = this.#ownChat(chatId, personId);
    // The ChatSession's turn; or the question this object is preparing,
    // whose stop is kept for it as it is claimed.
    const turnId = (await this.#activeTurn(id)) ?? this.#turns.get(id)?.id;
    if (turnId === undefined) {
      return false;
    }
    await this.#toSession(id, async (session) => {
      await session.abort(turnId);
    });
    return true;
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
    documentIds: readonly string[] = [],
    /** What the run's result rests on, if not `ids` (a connection call's grant). */
    runReads?: readonly string[]
  ): CodeRunAdmission["call"] {
    const { call } = this.admitFromCodeRun(chatId, runId);
    if (call !== "open") {
      return call;
    }
    const sources = sourcesSchema.parse(ids);
    const given = givenSchema.parse(documentIds);
    const reads =
      runReads === undefined ? sources : runReadsSchema.parse(runReads);
    this.ctx.storage.transactionSync(() => {
      this.#keepSources(chatId, sources);
      this.#keepGiven(chatId, given);
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
   * has ended or a revocation closed it (`open` when kept).
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
   * Keeps `documentIds` as given to the chat's code: each once, after the
   * chat's last message when it first was, then drops the oldest past
   * {@link chatDocumentsMax}: given after an earlier message, or in an
   * earlier read since the same one (insertion order, `rowid`).
   */
  #keepGiven(chatId: ChatId, documentIds: readonly string[]): void {
    if (documentIds.length === 0) {
      return;
    }
    const last = this.#db
      .select({ id: max(chatMessages.id) })
      .from(chatMessages)
      .where(eq(chatMessages.chatId, chatId))
      .get();
    // The WHERE keeps SQLite from reading ON CONFLICT as a join.
    this.#db
      .insert(chatDocuments)
      .select(
        sql`SELECT ${chatId}, value, ${last?.id ?? 0} FROM json_each(${JSON.stringify([...new Set(documentIds)])}) WHERE true`
      )
      .onConflictDoNothing()
      .run();
    this.#db.run(
      sql`DELETE FROM ${chatDocuments} WHERE ${chatDocuments.chatId} = ${chatId} AND ${chatDocuments.documentId} NOT IN (SELECT ${chatDocuments.documentId} FROM ${chatDocuments} WHERE ${chatDocuments.chatId} = ${chatId} ORDER BY ${chatDocuments.givenAfter} DESC, rowid DESC LIMIT ${chatDocumentsMax})`
    );
  }

  /**
   * Whether the chat's message `messageId` may cite a document: one given
   * to the chat's code before it was stored (after an earlier message),
   * that the chat still keeps.
   */
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

  #givenBy(
    chatId: ChatId
  ): (messageId: number) => (documentId: string) => boolean {
    const given = new Map(
      this.#db
        .select({
          documentId: chatDocuments.documentId,
          givenAfter: chatDocuments.givenAfter,
        })
        .from(chatDocuments)
        .where(eq(chatDocuments.chatId, chatId))
        .all()
        .map(({ documentId, givenAfter }) => [documentId, givenAfter])
    );
    return (messageId) => (documentId) => {
      const givenAfter = given.get(documentId);
      return givenAfter !== undefined && messageId > givenAfter;
    };
  }

  /**
   * The documents the chat's message `messageId` cites, as `personId`'s
   * page shows them under it (`ChatsApi.cited`): only in their own chat.
   */
  async cited(
    chatId: unknown,
    personId: string,
    messageId: unknown
  ): Promise<ChatCitedDocument[]> {
    const chat = this.#ownChat(chatId, personId);
    const id = z.int().positive().safeParse(messageId);
    if (!id.success) {
      return [];
    }
    const workspaceId = workspaceIdSchema.parse(this.ctx.id.name);
    const scope = {
      workspaceId,
      agentId: chat.agentId,
      chatId: chat.id,
      personId,
    };
    return await this.#cited(scope, id.data);
  }

  /**
   * The documents the chat's answer `messageId` cites (`citedIn`), each
   * looked up now as the chat's agent acting for its person, so one either
   * may no longer read is left out; none for a message that isn't an
   * answer, or one that cites nothing.
   */
  async #cited(
    scope: Pick<AgentScope, "workspaceId" | "agentId" | "chatId" | "personId">,
    messageId: number
  ): Promise<ChatCitedDocument[]> {
    const stored = this.#db
      .select()
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.chatId, scope.chatId),
          eq(chatMessages.id, messageId)
        )
      )
      .get();
    const links =
      stored === undefined
        ? []
        : noteLinksOf(
            storedMessageSchema.parse(JSON.parse(stored.message)),
            this.#givenBy(scope.chatId)(stored.id)
          );
    if (links.length === 0) {
      return [];
    }
    return await readAsDelegate(
      this.env,
      chatAuthority(scope),
      chatContext(scope),
      undefined,
      async (reader) => await cited(brainOf(this.env), reader, links)
    );
  }

  /**
   * `#cited` for a turn that has answered: the answer is stored and shown
   * by then, so documents that can't be looked up now (Knowledge's
   * database, or what the agent may read, failing) leave the turn's result
   * without any, and never fail an answered turn. The page asks again
   * (`cited`).
   */
  async #citedOrNone(
    scope: Pick<AgentScope, "workspaceId" | "agentId" | "chatId" | "personId">,
    messageId: number
  ): Promise<ChatCitedDocument[]> {
    try {
      return await this.#cited(scope, messageId);
    } catch (error) {
      log.warn("agent.cited_failed", {
        chatId: scope.chatId,
        ...errorFields(error),
      });
      return [];
    }
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
    if (!parsed.success || this.#deleting.has(parsed.data)) {
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

  /** Keeps `sources` with run `runId`, each once. */
  #keepRunSources(
    chatId: ChatId,
    runId: string,
    sources: readonly string[]
  ): void {
    if (sources.length === 0) {
      return;
    }
    this.#db
      .insert(chatRunSources)
      .select(
        sql`SELECT ${chatId}, ${runId}, value, NULL FROM json_each(${JSON.stringify(sources)}) WHERE true`
      )
      .onConflictDoNothing()
      .run();
  }

  /**
   * The code runs of the chat whose results may not reach the model now
   * (`withheld` in chat-agent.ts): its agent may no longer read, for its
   * person, something one of them read (`readableSources`). A source
   * newly found unreadable is marked and audited once, in one
   * transaction, by the agent acting for the person, naming the run and
   * the source, never what was read; one readable again is unmarked, so a
   * later revocation is audited again. A check that fails withholds every
   * run that read anything, unmarked: rather withheld than sent
   * unchecked. Nothing is read from core for a chat whose runs read
   * nothing.
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
    let readable: Set<string>;
    try {
      readable = await readableSources(this.env, scope, [
        ...new Set(rows.map(({ sourceId }) => sourceId)),
      ]);
    } catch (error) {
      log.warn("agent.history_check_failed", { chatId, ...errorFields(error) });
      return new Set(rows.map(({ runId }) => runId));
    }
    const withheld = rows.filter(({ sourceId }) => !readable.has(sourceId));
    const fresh = withheld.filter(({ withheldAt }) => withheldAt === null);
    const back = rows.filter(
      ({ sourceId, withheldAt }) =>
        withheldAt !== null && readable.has(sourceId)
    );
    if (fresh.length > 0 || back.length > 0) {
      const actor = delegateActorOf(chatAuthority(scope), scope.via);
      this.ctx.storage.transactionSync(() => {
        for (const { runId, sourceId, withheldAt } of [...fresh, ...back]) {
          this.#db
            .update(chatRunSources)
            .set({ withheldAt: withheldAt === null ? new Date() : null })
            .where(
              and(
                eq(chatRunSources.chatId, chatId),
                eq(chatRunSources.runId, runId),
                eq(chatRunSources.sourceId, sourceId)
              )
            )
            .run();
        }
        for (const { runId, sourceId } of fresh) {
          this.#outboxEntry({
            actor,
            action: "chat.history_withheld",
            target: { type: "chat", id: chatId },
            detail: {
              workspace: this.ctx.id.name ?? null,
              run: runId,
              ...withheldSourceDetail(sourceId),
            },
          });
        }
      });
      if (fresh.length > 0) {
        this.#deliverAudit();
      }
    }
    return new Set(withheld.map(({ runId }) => runId));
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
   * `personId`'s chats, the most recently active first: at most
   * {@link listedChats}.
   */
  chats(personId: string): ChatSummary[] {
    return this.#db
      .select({
        id: chats.id,
        title: chats.title,
        agentId: chats.agentId,
        createdAt: chats.createdAt,
        lastAt: chats.lastAt,
        appId: chats.appId,
        via: chats.via,
        makeKind: chats.makeKind,
        makeProject: chats.makeProject,
      })
      .from(chats)
      .where(eq(chats.personId, personId))
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
      | "appId"
      | "via"
      | "makeKind"
      | "makeProject"
    >
  ): ChatSummary {
    return {
      id: chat.id,
      title: chat.title,
      agentId: chat.agentId,
      createdAt: chat.createdAt.toISOString(),
      lastAt: chat.lastAt.toISOString(),
      running: this.#isRunning(chat.id),
      appId: chat.appId,
      via: chat.via,
      make: makeOf(chat),
    };
  }

  /**
   * `personId`'s chat for App `appId`: the one that last worked on it, as
   * their list shows it, whether made for the App or one among `drafted`,
   * whose agent wrote its draft (a chat started on Chat that built it), so
   * the App's page carries on where they left it, with all it knows;
   * `null` while they have none. A chat others share on a chat platform is
   * never one.
   */
  appChat(
    personId: string,
    appId: AppId,
    drafted: readonly string[]
  ): ChatSummary | null {
    const chat = this.#db
      .select()
      .from(chats)
      .where(
        and(
          eq(chats.personId, personId),
          or(
            eq(chats.appId, appId),
            sql`${chats.id} IN (SELECT value FROM json_each(${JSON.stringify(drafted)}))`
          ),
          isNull(chats.thread)
        )
      )
      .orderBy(desc(chats.lastAt))
      .get();
    return chat === undefined ? null : this.#summaryOf(chat);
  }

  /** `personId`'s chat `chatId`, as their list shows it, listed or not. */
  chatSummary(chatId: unknown, personId: string): ChatSummary {
    return this.#summaryOf(this.#ownChat(chatId, personId));
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
    const chat = this.#ownChat(chatId, personId);
    const { id } = chat;
    // Its question would be refused: nothing is made for it.
    if (this.#turns.has(id) || this.#isRunning(id)) {
      throw agentErrors.create("agent.busy");
    }
    const key = `${builtKeyPrefix}${id}`;
    const kept = builtSchema.safeParse(this.ctx.storage.kv.get(key));
    const built = kept.success ? kept.data : [];
    const transcript = this.#transcript(id);
    const refused = new Set(
      transcript.flatMap((message) =>
        message.role === "toolResult" && message.isError
          ? [message.toolCallId]
          : []
      )
    );
    const call = transcript
      .flatMap((message) =>
        message.role === "assistant" ? message.content : []
      )
      .find(
        (part) =>
          part.type === "toolCall" &&
          part.name === "proposePlan" &&
          part.id === callId
      );
    const plan =
      call?.type === "toolCall" && !refused.has(call.id)
        ? chatPlanSchema.safeParse(call.arguments)
        : undefined;
    if (
      typeof callId !== "string" ||
      plan?.success !== true ||
      built.includes(callId)
    ) {
      throw agentErrors.create("agent.plan_not_found");
    }
    this.ctx.storage.kv.put(key, [...built, callId]);
    return { plan: plan.data, make: makeOf(chat) };
  }

  /** Gives back a plan `takePlan` took, of which Build it made nothing. */
  releasePlan(chatId: ChatId, callId: string): void {
    const key = `${builtKeyPrefix}${chatId}`;
    const kept = builtSchema.safeParse(this.ctx.storage.kv.get(key));
    if (kept.success) {
      this.ctx.storage.kv.put(
        key,
        kept.data.filter((each) => each !== callId)
      );
    }
  }

  /**
   * Keeps Build it on `personId`'s chat `chatId` when what it made can't
   * go on in a turn (`ChatsApi.build`): their `text` with what was made
   * (`built`), shown as a turn shows it, so the plan waits no more; the
   * chat made the App's when it is for none, so the App's page carries on
   * in it and what is asked there is about the App; the agent told what
   * was made (`#note`), and the chat stopped for `stopped`, to try again.
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
    const chat = this.#ownChat(chatId, personId);
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
    if (app !== undefined && chat.appId === null) {
      this.#db
        .update(chats)
        .set({ appId: app.id })
        .where(eq(chats.id, chat.id))
        .run();
    }
    this.#stopped.set(chat.id, stopped);
    this.#changed(chat.id);
    try {
      await this.#note(chat.id, builtNoteText(built));
    } catch (error) {
      // Kept and shown all the same: the next question is about the App.
      log.warn("agent.built_untold", {
        chatId: chat.id,
        ...errorFields(error),
      });
    }
  }

  /** The App chat `chatId` is for, or null: what its agent is told (`env.chat.info`). */
  chatApp(chatId: ChatId): string | null {
    return (
      this.#db
        .select({ appId: chats.appId })
        .from(chats)
        .where(eq(chats.id, chatId))
        .get()?.appId ?? null
    );
  }

  /**
   * `personId`'s dashboard as they last saved it, in order; `null` when
   * they never did. A widget this release no longer has, or one Grasp made
   * that they no longer have, is left out.
   */
  dashboardLayout(personId: string): DashboardLayout | null {
    const saved = this.#db
      .select({ personId: dashboards.personId })
      .from(dashboards)
      .where(eq(dashboards.personId, personId))
      .get();
    if (saved === undefined) {
      return null;
    }
    const made = new Set<string>(this.#customWidgetIds(personId));
    const widgets = this.#db
      .select({ widgetId: dashboardWidgets.widgetId })
      .from(dashboardWidgets)
      .where(eq(dashboardWidgets.personId, personId))
      .orderBy(asc(dashboardWidgets.position))
      .all()
      .flatMap(({ widgetId }) => {
        const widget = dashboardWidgetIdSchema.safeParse(widgetId);
        return widget.success &&
          (standardWidgetIdSchema.safeParse(widget.data).success ||
            made.has(widget.data))
          ? [widget.data]
          : [];
      });
    return { widgets };
  }

  /**
   * Saves `personId`'s whole dashboard, `widgets` in order (checked by
   * the caller, `dashboardLayoutSchema`), in place of what they saved
   * before: in one transaction, so a reader sees one or the other. A
   * widget Grasp made that they don't have refuses it.
   */
  saveDashboardLayout(
    personId: string,
    widgets: readonly DashboardWidgetId[]
  ): void {
    const made = new Set<string>(this.#customWidgetIds(personId));
    if (
      widgets.some(
        (widget) =>
          !standardWidgetIdSchema.safeParse(widget).success && !made.has(widget)
      )
    ) {
      throw dashboardErrors.create("dashboard.invalid_layout");
    }
    this.ctx.storage.transactionSync(() => {
      this.#placeWidgets(personId, widgets);
    });
  }

  /** Puts `widgets` on `personId`'s dashboard, in order, in place of what was there. */
  #placeWidgets(personId: string, widgets: readonly DashboardWidgetId[]): void {
    const updatedAt = new Date();
    this.#db
      .insert(dashboards)
      .values({ personId, updatedAt })
      .onConflictDoUpdate({ target: dashboards.personId, set: { updatedAt } })
      .run();
    this.#db
      .delete(dashboardWidgets)
      .where(eq(dashboardWidgets.personId, personId))
      .run();
    if (widgets.length > 0) {
      this.#db
        .insert(dashboardWidgets)
        .values(
          widgets.map((widgetId, position) => ({
            personId,
            position,
            widgetId,
          }))
        )
        .run();
    }
  }

  /** The IDs of the widgets Grasp made for `personId`. */
  #customWidgetIds(personId: string): CustomWidgetId[] {
    return this.#db
      .select({ id: customWidgets.id })
      .from(customWidgets)
      .where(eq(customWidgets.personId, personId))
      .all()
      .map(({ id }) => id);
  }

  /**
   * The widgets Grasp made for `personId`, oldest first, each whose spec
   * still reads as one (`widgetSpecSchema`).
   */
  customWidgets(personId: string): KeptWidget[] {
    return this.#db
      .select()
      .from(customWidgets)
      .where(eq(customWidgets.personId, personId))
      .orderBy(asc(customWidgets.madeAt))
      .all()
      .flatMap((row) => {
        const kept = keptWidgetOf(row);
        return kept === undefined ? [] : [kept];
      });
  }

  /** Widget `id` Grasp made for `personId`; `null` when they have none such. */
  customWidget(personId: string, id: CustomWidgetId): KeptWidget | null {
    const row = this.#db
      .select()
      .from(customWidgets)
      .where(
        and(eq(customWidgets.personId, personId), eq(customWidgets.id, id))
      )
      .get();
    return (row === undefined ? undefined : keptWidgetOf(row)) ?? null;
  }

  /**
   * Takes widget `id` of `personId`'s in hand while Grasp works on it:
   * false when it is in hand already, unless that hand has been held past
   * {@link widgetHandMs}, as by a request that never came back.
   */
  claimWidget(personId: string, id: string): boolean {
    const key = `${personId}/${id}`;
    const now = Date.now();
    const held = this.#widgetsInHand.get(key);
    if (held !== undefined && held > now) {
      return false;
    }
    this.#widgetsInHand.set(key, now + widgetHandMs);
    return true;
  }

  /** Lets go of widget `id` of `personId`'s (`claimWidget`). */
  releaseWidget(personId: string, id: string): void {
    this.#widgetsInHand.delete(`${personId}/${id}`);
  }

  /**
   * Keeps a widget Grasp made or changed for `personId`: a new one goes
   * last on their dashboard (their board as it begins, `offered`, when
   * they never saved one), and at most {@link customWidgetsMax} are kept;
   * a changed one keeps its place. Refused as `dashboard.widget_not_found`
   * for a change to one they no longer have.
   */
  keepCustomWidget(
    personId: string,
    widget: { id: CustomWidgetId; spec: WidgetSpec; asked: string },
    {
      change,
      offered,
      by,
      attempts,
    }: {
      change: boolean;
      offered: readonly StandardWidgetId[];
      /** Who asked: the person, or a chat's agent for them. */
      by: AuditActor;
      /** The model calls it took. */
      attempts: number;
    }
  ): KeptWidget {
    const now = new Date();
    const spec = JSON.stringify(widget.spec);
    const kept = this.ctx.storage.transactionSync(() => {
      // Recorded with the change, or neither: what was asked stays out,
      // as it may quote anything.
      this.#outboxEntry({
        actor: by,
        action: change ? "dashboard.widget_changed" : "dashboard.widget_made",
        target: { type: "widget", id: widget.id },
        detail: { person: personId, attempts },
      });
      if (change) {
        const changed = this.#db
          .update(customWidgets)
          .set({ spec, asked: widget.asked, changedAt: now })
          .where(
            and(
              eq(customWidgets.personId, personId),
              eq(customWidgets.id, widget.id)
            )
          )
          .returning()
          .get();
        const shown = changed === undefined ? undefined : keptWidgetOf(changed);
        if (shown === undefined) {
          throw dashboardErrors.create("dashboard.widget_not_found");
        }
        return shown;
      }
      if (this.#customWidgetIds(personId).length >= customWidgetsMax) {
        throw dashboardErrors.create("dashboard.too_many_widgets");
      }
      const row = this.#db
        .insert(customWidgets)
        .values({
          personId,
          id: widget.id,
          spec,
          asked: widget.asked,
          madeAt: now,
          changedAt: now,
        })
        .returning()
        .get();
      const board = this.dashboardLayout(personId)?.widgets ?? offered;
      this.#placeWidgets(personId, [...board, widget.id]);
      const made = keptWidgetOf(row);
      if (made === undefined) {
        throw dashboardErrors.create("dashboard.widget_unreadable");
      }
      return made;
    });
    this.#deliverAudit();
    return kept;
  }

  /**
   * Takes widget `id` off `personId`'s dashboard and forgets it; false when
   * they had none such.
   */
  removeCustomWidget(
    personId: string,
    id: CustomWidgetId,
    by: AuditActor
  ): boolean {
    const removed = this.ctx.storage.transactionSync(() => {
      const gone = this.#db
        .delete(customWidgets)
        .where(
          and(eq(customWidgets.personId, personId), eq(customWidgets.id, id))
        )
        .returning({ id: customWidgets.id })
        .get();
      if (gone === undefined) {
        return false;
      }
      const board = this.dashboardLayout(personId);
      if (board !== null) {
        this.#placeWidgets(personId, board.widgets);
      }
      this.#outboxEntry({
        actor: by,
        action: "dashboard.widget_removed",
        target: { type: "widget", id },
        detail: { person: personId },
      });
      return true;
    });
    if (removed) {
      this.#deliverAudit();
    }
    return removed;
  }

  /** Renames `personId`'s own chat, audited as `by`'s. */
  renameChat(
    chatId: unknown,
    personId: string,
    title: string,
    by: AuditActor
  ): void {
    const { id } = this.#ownChat(chatId, personId);
    this.ctx.storage.transactionSync(() => {
      this.#db.update(chats).set({ title }).where(eq(chats.id, id)).run();
      this.#outboxed(by, "chat.renamed", id);
    });
    this.#deliverAudit();
  }

  /**
   * Deletes `personId`'s own chat once its agent isn't working on it:
   * rejects every write its agent holds for `person` (connect's
   * `declineChatActions`, each recorded there) and revokes every
   * connection granted or asked for in it, each audited, then deletes it with its
   * messages and sources, audited as `by`'s. While it does, the chat is
   * marked deleting and takes no question, so no write can be held after
   * the rejecting; if rejecting or revoking fails, the mark goes and the
   * chat stays.
   * Its watchers get nothing more. How many writes it rejected.
   */
  async deleteChat(
    chatId: unknown,
    personId: string,
    person: ConnectionPerson,
    by: AuditActor
  ): Promise<number> {
    const { id } = this.#ownChat(chatId, personId);
    if (person.userId !== personId) {
      throw agentErrors.create("agent.chat_not_found");
    }
    if (this.#turns.has(id) || this.#deleting.has(id)) {
      throw agentErrors.create("agent.busy");
    }
    this.#deleting.add(id);
    try {
      const workspaceId = workspaceIdSchema.parse(this.ctx.id.name);
      const declined = await this.env.CONNECT.declineChatActions({
        person,
        workspaceId,
        chatId: id,
      });
      // No connection granted in the chat outlives it (chat-connections.ts).
      await revokeChatPermissions(
        this.env,
        { chatId: id },
        { userId: personId, actor: by },
        "chat_deleted"
      );
      // Nor any workflow start its agent asked its person to confirm.
      await dropHeldStarts(this.env, { chatId: id });
      // What the Brain captured of its turns goes before it does: should
      // that fail, the chat stays (brain-capture.ts). After any delivery
      // under way, as for a person's erasure: one that records the chat's
      // after this finds it being deleted, and takes it back.
      await Promise.allSettled(this.#delivering);
      await eraseCaptured(this.env, [id]);
      // And what its agent kept, the transcript the model reads with it:
      // erased for good, so nothing told it meanwhile is kept.
      await this.#toSession(id, async (session) => {
        await session.erase();
      });
      // Their rows go with it below.
      this.ctx.storage.transactionSync(() => {
        this.#db
          .delete(brainCaptureIntents)
          .where(eq(brainCaptureIntents.evidenceId, id))
          .run();
        // Before its messages: a file names the question that carried it.
        this.#db.delete(chatFiles).where(eq(chatFiles.chatId, id)).run();
        this.#db
          .delete(chatSearchText)
          .where(eq(chatSearchText.chatId, id))
          .run();
        this.#db.delete(chatMessages).where(eq(chatMessages.chatId, id)).run();
        this.#db.delete(chatSources).where(eq(chatSources.chatId, id)).run();
        this.#db
          .delete(chatDocuments)
          .where(eq(chatDocuments.chatId, id))
          .run();
        this.#db
          .delete(chatRunSources)
          .where(eq(chatRunSources.chatId, id))
          .run();
        this.#db.delete(chatCodeRuns).where(eq(chatCodeRuns.chatId, id)).run();
        // An earlier release's build jobs of the chat (schema.ts).
        this.#db
          .delete(chatBuildJobs)
          .where(eq(chatBuildJobs.chatId, id))
          .run();
        this.#db
          .delete(chatToolEvents)
          .where(eq(chatToolEvents.chatId, id))
          .run();
        // What an earlier release kept of the chat's own drafts (schema.ts):
        // rows that name it, which go with it.
        this.#dropChatDrafts(id);
        this.#db.delete(chats).where(eq(chats.id, id)).run();
        this.ctx.storage.kv.delete(`${traceKeyPrefix}${id}`);
        this.ctx.storage.kv.delete(`${builtKeyPrefix}${id}`);
        this.ctx.storage.kv.delete(`${runningKeyPrefix}${id}`);
        this.ctx.storage.kv.delete(`${copiedKeyPrefix}${id}`);
        this.#outboxed(by, "chat.deleted", id, { declined });
      });
      this.#deliverAudit();
      this.#stopped.delete(id);
      this.#provenanceVersions.delete(id);
      this.#heldVersions.delete(id);
      this.#worked.delete(id);
      for (const watch of this.#watchers.get(id)?.values() ?? []) {
        watch[Symbol.dispose]();
      }
      this.#watchers.delete(id);
      return declined;
    } finally {
      this.#deleting.delete(id);
    }
  }

  /**
   * Erases everything this object holds, as core asks once an admin erased
   * the person it is for (GRA-903, GRA-1181; core's person-erasure.ts):
   * it is theirs alone (`personalWorkspaceId`), and nobody else's data is
   * ever in it. Actions held for them in connect are connect's erasure
   * step's (`erasePersonal` drops every one made for them), not this. First what lives outside it: what the Brain captured of
   * their chats' turns, any connection granted in those chats, and the
   * stores their drafts' previews wrote to. Then its own storage, all of
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
    // No capture of their turns reaches the Brain from now on: none
    // pending is delivered, and any delivery under way ends before the
    // Brain's copies of their chats are erased, so nothing lands after.
    this.#erasing = true;
    this.#db
      .delete(brainCaptureIntents)
      .where(eq(brainCaptureIntents.state, "pending"))
      .run();
    await Promise.allSettled([...this.#sent, ...this.#delivering]);
    const held = this.#db.select({ id: chats.id }).from(chats).all();
    const ids = held.map(({ id }) => id);
    if (ids.length > 0) {
      await eraseCaptured(this.env, ids);
    }
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
        { chatId: id },
        { userId: null, actor: { type: "system" } },
        "person_removed"
      );
    }
    // Every event of what it did is in the log before its outbox goes.
    if ((await drainObjectOutbox(this.env, this.ctx.storage.sql)) > 0) {
      throw internalErrors.create("internal.unexpected");
    }
    for (const watchers of this.#watchers.values()) {
      for (const watch of watchers.values()) {
        watch[Symbol.dispose]();
      }
    }
    this.#watchers.clear();
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
   * after the one with ID `after` (all of them for `null`) and the chat as
   * it is now, then an update on every change (chat-watch.ts). Returns the
   * ID `unwatch` drops it by; one that can't be reached drops itself.
   */
  watch(
    chatId: unknown,
    personId: string,
    after: unknown,
    listener: ChatListener
  ): string {
    const { id } = this.#ownChat(chatId, personId);
    const since = afterSchema.safeParse(after);
    if (!since.success) {
      throw agentErrors.create("agent.invalid_request");
    }
    let watching = 0;
    for (const watchers of this.#watchers.values()) {
      watching += watchers.size;
    }
    if (watching >= maxWatchers) {
      throw agentErrors.create("agent.too_many_watches");
    }
    const watchId = crypto.randomUUID();
    const watch = new ChatWatch(
      listener.dup(),
      () => this.#state(id),
      () => this.#provenance(id),
      () => {
        this.unwatch(id, watchId);
      }
    );
    const watchers = this.#watchers.get(id) ?? new Map<string, ChatWatch>();
    watchers.set(watchId, watch);
    this.#watchers.set(id, watchers);
    watch.push(this.#shownAfter(id, since.data ?? 0), this.#toolEvents(id));
    return watchId;
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
   * Tells the agent of `personId`'s own chat how a write it had held for
   * them ended (pending-actions.ts), which it otherwise never learns: a
   * notice in its context (`ChatSession.note`), which the turn under way
   * reads before its next request, or else the next turn. The person isn't
   * shown it: they decided it. No turn starts.
   */
  async heldDecided(
    chatId: unknown,
    personId: string,
    held: { id: string; action: string },
    outcome: HeldOutcome
  ): Promise<void> {
    const chat = this.#ownChat(chatId, personId);
    const { id, action } = heldSchema.parse(held);
    await this.#note(
      chat.id,
      `The change you asked for, "${action}" (pending ID ${id}), was decided. ${heldOutcomes[outcome]} Read how it ended, with what it returned, with \`env.connections.outcome("${id}")\`.`
    );
  }

  /**
   * Tells the chat's agent `text` (`ChatSession.note`), and moves the chat
   * up its person's list: often decided elsewhere, it is where the agent
   * can now go on. Refused while the chat is deleted or its person
   * erased: what is told then would outlive the erasure. Its callers keep
   * the decision all the same.
   */
  async #note(chatId: ChatId, text: string): Promise<void> {
    if (this.#deleting.has(chatId) || this.#erasing) {
      throw agentErrors.create("agent.chat_not_found");
    }
    // Again on a stub of its own should the chat's object reset under the
    // call, as one that opens cold under load can: a decision's notice is
    // never dropped for a restart (`#toSession`).
    await this.#toSession(chatId, async (session) => {
      await session.note(text);
    });
    this.#db
      .update(chats)
      .set({ lastAt: new Date() })
      .where(eq(chats.id, chatId))
      .run();
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
    return this.#ownChat(chatId, personId).id;
  }

  // What a chat's agent writes of Apps' drafts (agent-builds.ts), which
  // live in core's database (app-drafts.ts): only what the chat's thread
  // shows of it. Only core calls these, for the chat's agent.

  /**
   * The turn and code step (its tool call's ID) of the chat's code run
   * `runId`, from the run's own record: what a draft's undo point names,
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
   * of the write from the write itself (app-drafts.ts).
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
      partial: partial === undefined ? null : partialOf(partial),
      output: outputOf(this.#outputs.get(chatId)),
      running: this.#isRunning(chatId),
      provenanceVersion: this.#provenanceVersions.get(chatId) ?? 0,
      stopped: stopped ?? null,
      held: this.#heldVersions.get(chatId) ?? 0,
      worked: this.#worked.get(chatId) ?? 0,
      checking: this.#checking.has(chatId),
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

  /** The chat's messages stored after the one with ID `after`, as shown. */
  #shownAfter(chatId: ChatId, after: number): ChatMessage[] {
    const givenBy = this.#givenBy(chatId);
    const asking = this.#asksIn(chatId);
    const carried = this.#filesAfter(chatId, after);
    return this.#db
      .select()
      .from(chatMessages)
      .where(and(eq(chatMessages.chatId, chatId), gt(chatMessages.id, after)))
      .orderBy(asc(chatMessages.id))
      .all()
      .flatMap(({ id, message, createdAt, thinkingMs, built }) => {
        const shown = withFiles(
          chatMessageOf(
            id,
            storedMessageSchema.parse(JSON.parse(message)),
            createdAt,
            givenBy(id),
            thinkingMs,
            asking,
            builtOf(built)
          ),
          carried
        );
        return shown === undefined ? [] : [shown];
      });
  }

  /**
   * The chat, if it is `personId`'s: the one person its agent acts for,
   * and the only one who reaches it. Anyone else's is refused as if there
   * were none.
   */
  #ownChat(chatId: unknown, personId: string): Chat {
    const chat = this.#chat(chatId);
    if (chat.personId !== personId) {
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
