import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { isAppLayout } from "@grasp-os/compiler";
import { generatedPaths, generateModules } from "@grasp-os/sdk/host";
import { agentErrors } from "@grasp-os/shared/agent";
import { appErrors } from "@grasp-os/shared/apps";
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
  chatPlatformSchema,
  chatToolEventsKept,
  readOnlyRevision,
} from "@grasp-os/shared/chat";
import type {
  ChatChannel,
  ChatCitedDocument,
  ChatDraft,
  ChatDraftVersion,
  ChatFile,
  ChatFileType,
  ChatMessage,
  ChatOutput,
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
  appIdSchema,
  chatIdSchema,
  identifierSchema,
  storeIdSchema,
  workspaceIdSchema,
} from "@grasp-os/shared/ids";
import type { AppId, ChatId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import { modelEfforts, modelErrors } from "@grasp-os/shared/models";
import { operationErrors } from "@grasp-os/shared/operations";
import {
  bindingNameSchema,
  permissionActionSchema,
  permissionErrors,
} from "@grasp-os/shared/permissions";
import { redact } from "@grasp-os/shared/redact";
import type { ScreenProblem, ServerLog } from "@grasp-os/shared/screens";
import { customWidgetsMax } from "@grasp-os/shared/widgets";
import type { CustomWidgetId, WidgetSpec } from "@grasp-os/shared/widgets";
import type { RunFailure } from "@grasp-os/shared/workflows";
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
  max,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { z } from "zod";

import { isMessage } from "./agent-messages.ts";
import {
  auditAgentCall,
  chatAuthority,
  chatContext,
  revokedSince,
  runRefusal,
  workspaceAgentIdSchema,
} from "./agent-scope.ts";
import type {
  AgentScope,
  CodeRunAdmission,
  CodeRunCall,
} from "./agent-scope.ts";
import { inOwnWords } from "./agent.ts";
import type { TurnContext, TurnResult } from "./agent.ts";
import { draftFiles } from "./apps.ts";
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
import { BuildJobRecords } from "./build-job-records.ts";
import type {
  BuildJobAdmission,
  BuildJobEnd,
  BuildJobOpening,
  BuildJobRow,
} from "./build-job-records.ts";
import {
  channelText,
  heldWriteRefusal,
  turnCheckOf,
  withoutLinks,
} from "./channels/stephen-rules.ts";
import type { HeldWriteRefusal, TurnCheck } from "./channels/stephen-rules.ts";
import { revokeChatPermissions } from "./chat-connections.ts";
import type {
  TurnEnd,
  TurnMessage,
  TurnRequest,
  TurnStop,
} from "./chat-harness.ts";
import { chatMessageOf, noteLinksOf, partialOf } from "./chat-messages.ts";
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
import { discardFixtureStore } from "./data-stores.ts";
import { migrateOnWake } from "./db/migrate.ts";
import migrations from "./db/workspace/migrations/migrations.js";
import {
  auditOutbox,
  brainCaptureIntents,
  chatAttachments,
  chatCodeRuns,
  chatDraftFiles,
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
  previewStores,
} from "./db/workspace/schema.ts";
import { DraftVersions } from "./draft-versions.ts";
import { chatSession } from "./durable-objects.ts";
import { dropHeldStarts } from "./held-starts.ts";
import { readableSources, withheldSourceDetail } from "./history-access.ts";
import {
  audienceMaxMembers,
  audienceOf,
  keepAudience,
} from "./knowledge/access.ts";
import { readAsDelegate } from "./knowledge/binding.ts";
import { catalog, noteListedSkills } from "./knowledge/catalog.ts";
import { cited } from "./knowledge/citations.ts";
import { forContext } from "./knowledge/memory.ts";
import { brainOf } from "./knowledge/ports.ts";
import { hasBrainGrant } from "./knowledge/recall-grants.ts";
import { inputTokens, modelSettings, models } from "./models.ts";
import { PreviewBuilds } from "./preview-builds.ts";
import type { PreviewBuilt } from "./preview-builds.ts";
import { functionProblem, PreviewReports } from "./preview-reports.ts";
import type { Reports } from "./preview-reports.ts";
import type { WorkContext } from "./restricted.ts";
import { SealedPreviews } from "./sealed-previews.ts";
import { runEngine } from "./workflows/engine.ts";

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

/** A build job, with the chat's agent and person it acts for. */
export type BuildJob = BuildJobRow & { agentId: string; personId: string };

/** What the agent of a chat is told as a build job it submitted ends. */
const jobEnded = (job: BuildJobRow, end: BuildJobEnd): string => {
  if (end.status === "cancelled") {
    return "was cancelled";
  }
  if (end.status === "revoked") {
    return "ended: a permission of yours was revoked since it was submitted";
  }
  if (end.status === "failed") {
    return "failed";
  }
  return job.kind === "check"
    ? "finished checking the draft"
    : "finished: the draft was proposed, or its check says why not";
};

/**
 * A chat's draft of an App (agent-builds.ts): the version it started
 * from, and the changes its agent wrote over it, by path (null deletes a
 * file). `revision` is 0 while there is none.
 */
export interface Draft {
  base: number | null;
  changes: Record<string, string | null>;
  revision: number;
}

/** What a chat's agent spent building Apps this turn: the Apps it created (agent-builds.ts). */
interface TurnBuilds {
  created: number;
}

/**
 * A failed run a new chat's agent is asked to fix (`fixRun` in
 * chats-rpc.ts): its report, attached to the chat as data, and what the
 * report may hold data from, which the chat carries from the start.
 */
export interface RunToFix {
  report: RunFailure;
  /** The run, and every source its App may have read (app-provenance.ts). */
  sources: string[];
  /** Whether the run's App is restricted: then the chat is, from the start. */
  restricted: boolean;
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
});
export type Question = z.input<typeof questionSchema>;

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

/**
 * A failure report attached to a chat (`attachments`), as this object
 * stored it: checked as far as being an object.
 */
const storedReportSchema = z.custom<RunFailure>(
  (value) => typeof value === "object" && value !== null
);

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

/** How often a check waiting for a preview reads its reports again. */
const previewPollMs = 100;

/** Most chats a person keeps: delete one to make another. */
export const maxChatsPerPerson = 500;

/** Most chats one search finds: the most recently active first. */
export const searchHitsMax = 50;

/**
 * Why a turn under way stopped short of an answer, as its person reads
 * it: an unplanned error is logged, and shown as one, with the log line's
 * request ID for them to quote.
 */
/**
 * How many times a turn is asked of the chat's own object, should the
 * object's restart break the call: the turn goes on there meanwhile.
 */
const turnAttempts = 3;

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

const stopReason = (chatId: ChatId, error: unknown): string => {
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
 * A chat whose turn runs in its `ChatSession`, as that object says
 * (`turnRunning`): kept in storage, so a restart of this object mid-turn
 * still shows the chat running while its turn goes on there.
 */
const runningKeyPrefix = "running:";

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
   * The turns running now, by chat, to cancel them. Only in memory: a turn
   * ends with the object, and the chat goes on from what it stored. Each
   * is also marked in storage while it runs (`turnKeyPrefix`), so the wake
   * after a restart tells the chat its turn was cut short.
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

  /**
   * What each chat's agent spent building Apps this turn: the repair
   * loop's count and the Apps it created (agent-builds.ts). In memory: a
   * restart ends the turn, and the next question starts them again anyway.
   */
  readonly #builds = new Map<ChatId, TurnBuilds>();

  /** Who follows each chat (`watch`), by chat and watch ID. */
  readonly #watchers = new Map<ChatId, Map<string, ChatWatch>>();

  /** The chats' build jobs (build-jobs.ts). */
  readonly #jobs = new BuildJobRecords(this.#db);
  /** Every version of the chats' drafts (draft-versions.ts). */
  readonly #versions = new DraftVersions(this.#db);

  /** The chats' previews of their drafts of spec 8 Apps (sealed-previews.ts). */
  readonly #sealedPreviews = new SealedPreviews(
    this.ctx,
    this.env,
    this.#db,
    (chatId, appId) =>
      this.#db
        .select({ revision: chatDrafts.revision })
        .from(chatDrafts)
        .where(and(eq(chatDrafts.chatId, chatId), eq(chatDrafts.appId, appId)))
        .get()?.revision
  );

  /** What those previews ran into (preview-reports.ts). */
  readonly #previewReports = new PreviewReports();
  /** What bounds those previews' builds (preview-builds.ts). */
  readonly #previewBuilds = new PreviewBuilds();

  /**
   * Bumped whenever a chat's agent writes or drops a draft, so its
   * watchers read the drafts again, and preview the latest. In memory only.
   */
  readonly #draftVersions = new Map<ChatId, number>();

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
    thinkingMs: number | null = null
  ): { id: number; createdAt: Date } {
    const stored = this.#db
      .insert(chatMessages)
      .values({
        chatId,
        message: JSON.stringify(message),
        createdAt: new Date(),
        thinkingMs,
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
      chat: {
        id: row.id,
        title: row.title,
        createdAt: row.createdAt.toISOString(),
        lastAt: row.lastAt.toISOString(),
        running: this.#isRunning(row.id),
        appId: row.appId,
        via: row.via,
      },
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
    }: { thinkingMs?: number; files?: readonly string[] } = {}
  ): number {
    // A question and the files it carries are kept together: each file is
    // its, and no other's.
    const { id, createdAt } =
      files.length === 0
        ? this.#store(chatId, message, thinkingMs ?? null)
        : this.ctx.storage.transactionSync(() => {
            const stored = this.#store(chatId, message, thinkingMs ?? null);
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
        message.role === "assistant" && this.#asksIn(chatId)
      ),
      files.length === 0 ? undefined : this.#filesAfter(chatId, id - 1)
    );
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
   * own app (`web`) otherwise.
   */
  createChat(
    title: string,
    personId: string,
    agentId: string,
    by?: AuditActor,
    fix?: RunToFix,
    via: ChatChannel = "web",
    thread?: string,
    /** The App the chat is for (`appChat`), if any. */
    appId?: AppId
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
          restricted: fix?.restricted === true,
          via: channel,
          thread: thread ?? null,
          appId: appId ?? null,
        })
        .returning()
        .get();
      if (fix !== undefined) {
        this.#attachRun(made, fix, by);
      }
      return made;
    });
    this.#deliverAudit();
    return chat;
  }

  /**
   * A new chat of `personId`'s to fix a failed run (`createChat` with
   * `fix`), made only if the deployment allows `model`, which its question
   * will name: a refused model leaves no chat without a question.
   */
  async createFixChat(
    title: string,
    personId: string,
    agentId: string,
    by: AuditActor,
    fix: RunToFix,
    model: string
  ): Promise<Chat> {
    const { models: allowed } = await modelSettings(this.env);
    if (!allowed.includes(model)) {
      throw modelErrors.create("model.not_allowed");
    }
    return this.createChat(title, personId, agentId, by, fix);
  }

  /**
   * Attaches the report of the run `fix` names to the new chat, with its
   * sources, and audits it: in `createChat`'s transaction.
   */
  #attachRun(chat: Chat, fix: RunToFix, by: AuditActor | undefined): void {
    const { report, sources, restricted } = fix;
    const { id, createdAt, personId, agentId, via } = chat;
    this.#db
      .insert(chatAttachments)
      .values({
        chatId: id,
        runId: report.run,
        report: JSON.stringify(report),
        createdAt,
      })
      .run();
    const carried = [...new Set([report.run, ...sources])];
    this.#keepSources(id, carried);
    const workspace = this.ctx.id.name ?? null;
    if (by !== undefined) {
      this.#outboxEntry({
        actor: by,
        action: "workflow.run.fix_asked",
        target: { type: "workflow_run", id: report.run },
        detail: {
          app: report.app,
          workflow: report.workflow,
          version: report.version,
          chat: id,
          workspace,
        },
      });
    }
    if (restricted) {
      // As restricted.ts records a chat entering restricted mode.
      this.#outboxEntry({
        actor: delegateActorOf(chatAuthority({ agentId, personId }), via),
        action: "context.restricted",
        target: { type: "chat", id },
        provenance: carried.slice(0, auditProvenanceMaxItems),
        detail: { workspace },
      });
    }
  }

  /**
   * The reports of the failed runs the chat was started to fix, oldest
   * first, as data for its agent (`env.chat.attachments()` in
   * agent-apis.ts). Core's own read: the agent's code reaches only its
   * own chat's.
   */
  attachments(chatId: ChatId): RunFailure[] {
    return this.#db
      .select({ report: chatAttachments.report })
      .from(chatAttachments)
      .where(eq(chatAttachments.chatId, chatId))
      .orderBy(asc(chatAttachments.createdAt), asc(chatAttachments.runId))
      .all()
      .map(({ report }) => storedReportSchema.parse(JSON.parse(report)));
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
   * Settles a turn whose messages are all kept: its capture intent (none
   * in a chat in restricted mode), delivered soon, the alarm set first so
   * a delivery cut short is tried again (brain-capture.ts).
   */
  #captureTurn(facts: TurnFacts): void {
    const chatId = chatIdSchema.parse(facts.chatId);
    const eligible = this.isChatRestricted(chatId) === false;
    this.ctx.storage.transactionSync(() => {
      if (eligible) {
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
      }
    });
    if (eligible) {
      this.ctx.waitUntil(this.#captureSoon());
    }
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
          return id.success && this.isChatRestricted(id.data) === false;
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
        undefined,
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
    calls?: ToolCall[]
  ): Promise<Answer> {
    const parsed = questionSchema.safeParse(question);
    if (!parsed.success) {
      throw agentErrors.create("agent.invalid_question");
    }
    // The agent acts for the chat's own person, as this object stored it,
    // never for whoever asks, and only while they are still a member.
    const { personId, agentId, via } = chat;
    // Being deleted: its writes are being rejected, and it takes no more.
    if (this.#deleting.has(chat.id)) {
      throw agentErrors.create("agent.chat_not_found");
    }
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
      await this.#mayTakeTurn(chat.id, personId);
      // Before anything is kept: a file it names that the chat hasn't, or
      // that another question carried, refuses the question.
      const files = this.#unsentFiles(chat.id, parsed.data.files ?? []);
      const scope = this.#scopeOf(chat);
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
      const context = await this.#turnContext(scope, authority, work, shared);
      // Refuses a model the deployment or its rules don't allow before
      // anything is kept: the chat's object admits it again for its turn,
      // and every request again by the rules as they stand then.
      const { model } = await models(this.env).agent(
        {
          model: parsed.data.model,
          effort: parsed.data.effort,
          purpose: "chat.turn",
          trigger: delegateActorOf(authority, via),
          provenance: this.#sources(chat.id),
          work: { authority, context: work },
        },
        () => this.#sources(chat.id)
      );
      this.#stopped.delete(chat.id);
      // Each question gives the repair loop its full count again.
      this.#builds.delete(chat.id);
      started?.();
      this.#changed(chat.id);
      if (onText !== undefined) {
        live.onText = throttled(onText);
      }
      const { text, model: asked, effort } = parsed.data;
      const end = await this.#runTurn({
        turnId: live.id,
        scope,
        question: {
          text,
          model: asked,
          ...(effort === undefined ? {} : { effort }),
          files,
        },
        shared,
        readsBrain: await hasBrainGrant(this.env, authority),
        context,
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
      // Settled: its outcome's capture for the Brain (brain-capture.ts).
      this.#captureTurn({
        chatId: chat.id,
        turnId: live.id,
        personId,
        agentId,
        audience: audience === undefined ? null : [...audience.members],
        outcome: result.outcome,
        answerId: answer ?? null,
        model: model.id,
        occurredAt: new Date().toISOString(),
      });
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
   * to its end. A call the object's restart broke is made again: the turn
   * goes on there, and the same turn ID finds it rather than asking again.
   */
  async #runTurn(request: TurnRequest): Promise<TurnEnd> {
    const session = chatSession(
      this.env,
      request.scope.workspaceId,
      request.scope.chatId
    );
    for (let attempt = 1; ; attempt += 1) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- again only once it broke
        return await session.run(request);
      } catch (error) {
        if (isExpectedError(error) || attempt >= turnAttempts) {
          throw error;
        }
        log.warn("agent.turn_retried", {
          chatId: request.scope.chatId,
          turnId: request.turnId,
          attempt,
          ...errorFields(error),
        });
      }
    }
  }

  /** The agent's scope in `chat`: where it is, whose agent, for whom. */
  #scopeOf(chat: Chat): Omit<AgentScope, "runId"> {
    const { personId, agentId, via } = chat;
    const workspaceId = workspaceIdSchema.parse(this.ctx.id.name);
    return { workspaceId, agentId, chatId: chat.id, personId, via };
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
   * The turn `send` started: `started` resolves once it is under way, or
   * rejects with why it couldn't start. Why one under way stopped short
   * goes to the chat's watchers.
   */
  async #sentTurn(
    chat: Chat,
    question: Question,
    started: PromiseWithResolvers<boolean>
  ): Promise<void> {
    let underWay = false;
    try {
      await this.#turn(chat, question, () => {
        underWay = true;
        started.resolve(true);
      });
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
   * What the model reads this turn besides the question: the memory of the
   * person's own chat (the company's files and their USER.md, read now and
   * recorded as sources), the skills in the chat's Knowledge catalog, and
   * how to answer on the chat platform it came through, if any.
   */
  async #turnContext(
    scope: Parameters<typeof auditAgentCall>[1],
    authority: Parameters<typeof forContext>[1],
    work: Extract<WorkContext, { type: "chat" }>,
    shared: boolean
  ): Promise<TurnContext> {
    // Never the person's own USER.md where others read the answer.
    const memory = await forContext(
      this.env,
      authority,
      work,
      shared ? { type: "channel" } : { type: "own" }
    );
    this.#keepSources(work.chatId, memory.provenance.collectionIds);
    // The skills listed go into the prompt: a read of their collections,
    // noted as any Knowledge read is (restricting the chat first were any
    // sensitive), and carried as the chat's sources like memory.
    const { collections, skills, listed } = await readAsDelegate(
      this.env,
      authority,
      work,
      undefined,
      async (reader) => {
        const found = await catalog(brainOf(this.env), reader);
        return {
          ...found,
          listed: await noteListedSkills(
            brainOf(this.env),
            reader,
            found.skills
          ),
        };
      }
    );
    this.#keepSources(work.chatId, listed.collectionIds);
    // Recorded as the code's catalog call is: what the agent saw listed.
    await auditAgentCall(this.env, scope, {
      method: "knowledge.catalog",
      detail: {
        collections: collections.length,
        skills: skills.length,
        turn: true,
      },
    });
    const { via } = this.#chat(work.chatId);
    // A chat that came through a chat platform: how to answer there.
    const channel = via === "web" ? undefined : await channelText();
    // An App's own chat: the App its builds change.
    const app = this.chatApp(work.chatId);
    return { memory, skills, channel, ...(app === null ? {} : { app }) };
  }

  /**
   * Opens a code run of the chat: its lease, and its record, as `running`
   * on this runtime. Its ID is random, and the only way its stubs reach
   * it. Called by the chat's turn as it starts a run (`runTurn`).
   */
  openCodeRun(chatId: ChatId, opening: CodeRunOpening): string {
    const id = crypto.randomUUID();
    this.ctx.storage.transactionSync(() => {
      this.#db
        .insert(chatCodeRuns)
        .values({
          id,
          chatId,
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
   * the chat's own object (chat-session.ts) as each of its runs ends.
   */
  async endTurnRun(
    scope: Omit<AgentScope, "runId">,
    runId: string,
    status: CodeRunStatus
  ): Promise<CodeRunStatus> {
    return await this.#endCodeRun(scope, runId, status);
  }

  /**
   * What the chat's turn may send now, asked by its own object before every
   * model request: the runs whose results it withholds (`#withheldRuns`),
   * everything the chat has read from, for the gateway's rules, and why it
   * may not go on, when its person may no longer act.
   */
  async turnGuard(scope: Omit<AgentScope, "runId">): Promise<{
    withheld: string[];
    sources: string[];
    stop?: "person_inactive";
  }> {
    const active = await memberRole(this.env.DB, scope.personId);
    return {
      withheld: [...(await this.#withheldRuns(scope))],
      sources: this.#sources(scope.chatId),
      ...(active === undefined ? { stop: "person_inactive" as const } : {}),
    };
  }

  /**
   * Keeps what the chat's turn committed, in order, as the chat shows it:
   * a question with the files it carries; in a chat platform's chat, the
   * agent's words without links (`withoutLinks`).
   */
  /**
   * Whether the chat's turn runs: from the question until its
   * `ChatSession` says it runs (`#turns`), then as that object says.
   */
  #isRunning(chatId: ChatId): boolean {
    return (
      this.#turns.has(chatId) ||
      this.ctx.storage.kv.get(`${runningKeyPrefix}${chatId}`) !== undefined
    );
  }

  /**
   * The chat's `ChatSession` tells whether its turn runs, as its agent's
   * run starts and ends (chat-harness.ts): what the chat shows as running.
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

  keepTurnMessages(chatId: ChatId, messages: readonly TurnMessage[]): void {
    const chat = this.chatState(chatId);
    if (chat === undefined || this.#deleting.has(chatId)) {
      return;
    }
    const { via } = this.#chat(chatId);
    const live = this.#turns.get(chatId);
    for (const { message, files = [], thinkingMs } of messages) {
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
        { files, ...(thinkingMs === undefined ? {} : { thinkingMs }) }
      );
      if (live !== undefined && message.role === "assistant") {
        live.answer = id;
      }
    }
  }

  /** Shows the chat's watchers the answer streaming in, or none. */
  showPartial(chatId: ChatId, partial: AssistantMessage | null): void {
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
      output.timer = undefined;
      void this.#checkOutput(chatId, output);
    }, wait);
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
   * Refuses a write of a code run whose lease is closed: checked in the
   * same transaction as the write, so a run that ended or was revoked
   * writes nothing after.
   */
  #requireOpenRun(chatId: ChatId, runId: string): void {
    const { call } = this.admitFromCodeRun(chatId, runId);
    if (call !== "open") {
      throw agentErrors.create(
        call === "revoked" ? "agent.run_revoked" : "agent.run_ended"
      );
    }
  }

  /**
   * Stops `personId`'s own chat's running turn, if there is one: the model
   * request or code run in flight ends, and the turn answers `cancelled`.
   */
  cancel(chatId: unknown, personId: string): boolean {
    const { id } = this.#ownChat(chatId, personId);
    const turn = this.#turns.get(id);
    // Running as its ChatSession says, too: a turn this object's restart
    // left there.
    const running = this.#isRunning(id);
    if (running) {
      this.ctx.waitUntil(
        chatSession(
          this.env,
          this.#scopeOf(this.#chat(id)).workspaceId,
          id
        ).abort(turn?.id)
      );
    }
    if (turn !== undefined) {
      // The build jobs it submitted are the turn's work: they end with it.
      this.#terminateJobs(this.#jobs.cancelRunning(id, turn.id));
    }
    return running;
  }

  /**
   * Opens a build job of the chat for its open code run `runId`, in the
   * same step as the check that the run is open (build-jobs.ts): bound to
   * the run's turn, the draft of App `appId` as it is now (its revision),
   * and the authority the run acts on (granted when it opened). Its ID is
   * random. Refused, opening nothing, once the chat has as many jobs
   * running as it may.
   */
  openBuildJob(
    chatId: ChatId,
    runId: string,
    job: Pick<BuildJobOpening, "appId" | "kind" | "message">
  ): { id: string; revision: number } | { refused: "jobs" } {
    const lease = this.admitFromCodeRun(chatId, runId);
    const turn = this.#turns.get(chatId);
    if (lease.call !== "open" || turn === undefined) {
      throw runRefusal(lease.call === "revoked" ? "revoked" : "ended");
    }
    if (this.#jobs.full(chatId)) {
      return { refused: "jobs" };
    }
    const id = crypto.randomUUID();
    const { revision } = this.draft(chatId, job.appId);
    this.#jobs.open({
      ...job,
      id,
      chatId,
      turnId: turn.id,
      runId,
      revision,
      grantedAt: lease.openedAt,
    });
    return { id, revision };
  }

  /** The chat's running build jobs, with when each was submitted. */
  runningBuildJobs(chatId: ChatId): { id: string; createdAt: Date }[] {
    return this.#jobs.running(chatId);
  }

  /**
   * The chat's build job `id`, with the agent and person it acts for, as
   * the chat has them now; none for another chat's, or a deleted chat's.
   */
  buildJob(chatId: unknown, id: string): BuildJob | undefined {
    const chat = chatIdSchema.safeParse(chatId);
    const row = chat.success ? this.#jobs.byId(chat.data, id) : undefined;
    if (row === undefined) {
      return undefined;
    }
    const { agentId, personId } = this.#chat(row.chatId);
    return { ...row, agentId, personId };
  }

  /**
   * Whether the chat's build job `id` may take a step or have a write
   * admitted now, with when its authority was granted (agent-scope.ts
   * reads revocations since). A job the object lacks is cancelled.
   */
  admitFromBuildJob(chatId: unknown, id: string): BuildJobAdmission {
    const chat = chatIdSchema.safeParse(chatId);
    // A chat being deleted admits nothing of its jobs (`deleteChat`).
    return chat.success && !this.#deleting.has(chat.data)
      ? this.#jobs.admission(chat.data, id)
      : { call: "cancelled" };
  }

  /**
   * Ends the chat's running build job `id` as `end` says, once: `false`
   * when it had ended already. Its turn's agent is told how it ended, if
   * that turn still runs, before its next model request, in a notice that
   * is never stored with the chat (`LiveTurn`); no other turn ever is, and
   * nothing of its result goes with it: the agent reads that with
   * `env.build.job`.
   */
  endBuildJob(chatId: unknown, id: string, end: BuildJobEnd): boolean {
    const chat = chatIdSchema.safeParse(chatId);
    const job = chat.success ? this.#jobs.byId(chat.data, id) : undefined;
    if (job?.status !== "running") {
      return false;
    }
    const turn = this.#turns.get(job.chatId);
    this.#jobs.end(job.chatId, id, end);
    if (turn?.id === job.turnId) {
      const content = `Build job ${id} (${job.kind} of App ${job.appId}, submitted by code run ${job.runId}) ${jobEnded(job, end)}. Read how it ended with \`env.build.job("${id}")\`.`;
      // Before the turn's next request, never shown as the person's.
      this.ctx.waitUntil(
        chatSession(
          this.env,
          this.#scopeOf(this.#chat(job.chatId)).workspaceId,
          job.chatId
        ).steer(content)
      );
    }
    return true;
  }

  /**
   * Records the tree the chat's running build job `id` is about to commit
   * over `parent` (build-jobs.ts): `false` once the job has ended.
   */
  intendBuildCommit(
    chatId: unknown,
    id: string,
    parent: number | null,
    tree: string
  ): boolean {
    return this.#jobs.intend(chatIdSchema.parse(chatId), id, parent, tree);
  }

  /** Records the version the chat's build job `id` committed: its receipt. */
  recordBuildReceipt(chatId: unknown, id: string, version: number): void {
    this.#jobs.receipt(chatIdSchema.parse(chatId), id, version);
  }

  /**
   * Terminates the engine's instances of build jobs the object just
   * ended, with nobody waiting: each refuses every later step anyway
   * (build-jobs.ts), so this only stops their work sooner.
   */
  #terminateJobs(ids: readonly string[]): void {
    if (ids.length === 0) {
      return;
    }
    const engine = runEngine(this.env);
    this.ctx.waitUntil(
      Promise.all(
        ids.map(async (id) => {
          try {
            await engine.terminate(id);
          } catch (error) {
            log.warn("agent.job_terminate_failed", {
              jobId: id,
              ...errorFields(error),
            });
          }
        })
      )
    );
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
   * (`withholdRuns` in agent.ts): its agent may no longer read, for its
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
        createdAt: chats.createdAt,
        lastAt: chats.lastAt,
        appId: chats.appId,
        via: chats.via,
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
      "id" | "title" | "createdAt" | "lastAt" | "appId" | "via"
    >
  ): ChatSummary {
    return {
      id: chat.id,
      title: chat.title,
      createdAt: chat.createdAt.toISOString(),
      lastAt: chat.lastAt.toISOString(),
      running: this.#isRunning(chat.id),
      appId: chat.appId,
      via: chat.via,
    };
  }

  /**
   * `personId`'s chat for App `appId`, the one they last used, as their
   * list shows it; `null` while they have none. A chat others share on a
   * chat platform is never one.
   */
  appChat(personId: string, appId: AppId): ChatSummary | null {
    const chat = this.#db
      .select()
      .from(chats)
      .where(
        and(
          eq(chats.personId, personId),
          eq(chats.appId, appId),
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
    // Its build jobs end before anything here awaits, so none commits while
    // it is deleted; they stay ended should the delete then fail.
    this.#terminateJobs(this.#jobs.cancelRunning(id));
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
      // Every App it has a draft of, even one with no changes left: its
      // preview may still run.
      const drafted = this.#db
        .select({ appId: chatDrafts.appId })
        .from(chatDrafts)
        .where(eq(chatDrafts.chatId, id))
        .all();
      // What the Brain captured of its turns goes before it does: should
      // that fail, the chat stays (brain-capture.ts).
      await eraseCaptured(this.env, [id]);
      // And what its agent kept, the transcript the model reads with it.
      await chatSession(this.env, workspaceId, id).erase();
      // Their rows go with it below.
      this.ctx.storage.transactionSync(() => {
        this.#jobs.deleteChat(id);
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
        this.#db
          .delete(chatToolEvents)
          .where(eq(chatToolEvents.chatId, id))
          .run();
        this.#db
          .delete(chatAttachments)
          .where(eq(chatAttachments.chatId, id))
          .run();
        this.#dropDrafts(
          eq(chatDraftFiles.chatId, id),
          eq(chatDrafts.chatId, id)
        );
        this.#versions.deleteChat(id);
        this.#db.delete(chats).where(eq(chats.id, id)).run();
        this.ctx.storage.kv.delete(`${traceKeyPrefix}${id}`);
        this.ctx.storage.kv.delete(`${runningKeyPrefix}${id}`);
        this.#outboxed(by, "chat.deleted", id, { declined });
      });
      this.#deliverAudit();
      for (const { appId } of drafted) {
        this.#dropPreview(id, appId);
      }
      this.#stopped.delete(id);
      this.#provenanceVersions.delete(id);
      this.#heldVersions.delete(id);
      this.#draftVersions.delete(id);
      this.#builds.delete(id);
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
    for (const id of ids) {
      this.#terminateJobs(this.#jobs.cancelRunning(id));
    }
    if (ids.length > 0) {
      await eraseCaptured(this.env, ids);
    }
    const workspaceId = workspaceIdSchema.parse(this.ctx.id.name);
    for (const id of ids) {
      // oxlint-disable-next-line no-await-in-loop -- one chat at a time
      await chatSession(this.env, workspaceId, id).erase();
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
    const drafted = this.#db
      .select({ chatId: chatDrafts.chatId, appId: chatDrafts.appId })
      .from(chatDrafts)
      .all();
    for (const { chatId, appId } of drafted) {
      this.#dropPreview(chatId, appId);
    }
    const stores = this.#db
      .select({ storeId: previewStores.storeId })
      .from(previewStores)
      .all();
    for (const { storeId } of stores) {
      // One the weekly sweep discarded first (sealed-previews.ts) is gone
      // with core's record of it: discarded already, and its row here
      // goes with the rest of the object's storage below.
      // oxlint-disable-next-line no-await-in-loop -- one store at a time
      const recorded = await this.env.DB.prepare(
        "SELECT 1 AS found FROM preview_fixture_stores WHERE store_id = ?"
      )
        .bind(storeId)
        .first<{ found: number }>();
      if (recorded !== null) {
        // oxlint-disable-next-line no-await-in-loop -- one store at a time
        await discardFixtureStore(this.env, storeIdSchema.parse(storeId));
      }
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
    // a new object, and nothing it held in memory of a chat stays. Its
    // previews were dropped above (`#dropPreview`, for every draft); the
    // preview updates it waits on hold only tokens, and end on their own.
    migrateOnWake(this.ctx, migrations);
    for (const kept of [
      this.#partials,
      this.#stopped,
      this.#outputs,
      this.#provenanceVersions,
      this.#heldVersions,
      this.#draftVersions,
      this.#builds,
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

  /** Tells the chat's agent `text` (`ChatSession.note`). */
  async #note(chatId: ChatId, text: string): Promise<void> {
    const workspaceId = workspaceIdSchema.parse(this.ctx.id.name);
    await chatSession(this.env, workspaceId, chatId).note(text);
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
   * Refuses a chat that isn't `personId`'s own, as if there were none: for
   * what core keeps of a chat elsewhere (its connection requests).
   */
  requireChat(chatId: unknown, personId: string): ChatId {
    return this.#ownChat(chatId, personId).id;
  }

  // A chat's drafts of Apps (agent-builds.ts). Only core calls these, for
  // the chat's agent, having checked the person's role in the App and the
  // agent's permission first.

  /** The chat's draft of App `appId`; revision 0 while it has none. */
  draft(chatId: ChatId, appId: string): Draft {
    const row = this.#db
      .select()
      .from(chatDrafts)
      .where(and(eq(chatDrafts.chatId, chatId), eq(chatDrafts.appId, appId)))
      .get();
    if (row === undefined) {
      return { base: null, changes: {}, revision: 0 };
    }
    const files = this.#db
      .select({ path: chatDraftFiles.path, content: chatDraftFiles.content })
      .from(chatDraftFiles)
      .where(
        and(eq(chatDraftFiles.chatId, chatId), eq(chatDraftFiles.appId, appId))
      )
      .all();
    return {
      base: row.base,
      changes: Object.fromEntries(
        files.map(({ path, content }) => [path, content])
      ),
      revision: row.revision,
    };
  }

  /**
   * The revision of the chat's draft of App `appId`: 0 when there is none
   * (or no such chat). Its revision alone, for a check that runs often
   * (preview-stream-relay.ts), never its files.
   */
  draftRevision(chatId: unknown, appId: string): number {
    const chat = chatIdSchema.safeParse(chatId);
    if (!chat.success) {
      return 0;
    }
    const row = this.#db
      .select({ revision: chatDrafts.revision })
      .from(chatDrafts)
      .where(and(eq(chatDrafts.chatId, chat.data), eq(chatDrafts.appId, appId)))
      .get();
    return row?.revision ?? 0;
  }

  /**
   * The title of `personId`'s own chat `chatId`; `null` when it is gone,
   * or not theirs. For a review of what the chat's agent proposed, read by
   * the person it acted for alone: a title may quote their question.
   */
  chatTitle(chatId: unknown, personId: string): string | null {
    const id = chatIdSchema.safeParse(chatId);
    if (!id.success) {
      return null;
    }
    const row = this.#db
      .select({ title: chats.title, personId: chats.personId })
      .from(chats)
      .where(eq(chats.id, id.data))
      .get();
    return row?.personId === personId ? row.title : null;
  }

  /**
   * `personId`'s own chat's drafts with changes, the most recently
   * written first: which Apps, over which version, and the paths each
   * changes, and which of those it deletes.
   */
  drafts(chatId: unknown, personId: string): ChatDraft[] {
    const { id } = this.#ownChat(chatId, personId);
    // A chat's few drafts, read by their key and sorted here.
    const rows = this.#db
      .select()
      .from(chatDrafts)
      .where(eq(chatDrafts.chatId, id))
      .all()
      .toSorted(
        (one, other) => other.updatedAt.getTime() - one.updatedAt.getTime()
      );
    // In key order: by App, then path. Whether each is deleted (it has no
    // content), without reading any file's content.
    const paths = this.#db
      .select({
        appId: chatDraftFiles.appId,
        path: chatDraftFiles.path,
        deleted: isNull(chatDraftFiles.content).mapWith(Boolean),
      })
      .from(chatDraftFiles)
      .where(eq(chatDraftFiles.chatId, id))
      .orderBy(asc(chatDraftFiles.appId), asc(chatDraftFiles.path))
      .all();
    // A draft whose changes are all gone keeps its row (its revision
    // goes on), and isn't one to show.
    return rows.flatMap(({ appId, base, revision, updatedAt, callId }) => {
      const files = paths.filter((row) => row.appId === appId);
      return files.length === 0
        ? []
        : [
            {
              app: appId,
              base,
              changed: files.map(({ path }) => path),
              deleted: files
                .filter(({ deleted }) => deleted)
                .map(({ path }) => path),
              revision,
              updatedAt: updatedAt.toISOString(),
              callId,
            },
          ];
    });
  }

  /**
   * Writes `changes` into the chat's draft of App `appId`, over version
   * `base`, and drops its changes to the paths in `unchanged` (back as the
   * base has them), only over the revision `revision` the write read (0:
   * there was none): `false`, and nothing written, when another write
   * landed since, or the chat is gone. Refused, in the same transaction,
   * once the code run `runId` that writes it has closed. Kept as the
   * draft's next version, too (draft-versions.ts).
   */
  saveDraft(
    chatId: ChatId,
    appId: string,
    base: number | null,
    changes: Record<string, string | null>,
    unchanged: readonly string[],
    revision: number,
    runId: string
  ): boolean {
    const saved = this.ctx.storage.transactionSync(() => {
      this.#requireOpenRun(chatId, runId);
      const [row] = this.#db
        .select({ revision: chatDrafts.revision })
        .from(chatDrafts)
        .where(and(eq(chatDrafts.chatId, chatId), eq(chatDrafts.appId, appId)))
        .all();
      if (
        (row?.revision ?? 0) !== revision ||
        this.chatState(chatId) === undefined
      ) {
        return false;
      }
      const updatedAt = new Date();
      // The code step that writes it, from the run's own record: never
      // what the run's code says.
      const callId =
        this.#db
          .select({ callId: chatCodeRuns.toolCallId })
          .from(chatCodeRuns)
          .where(eq(chatCodeRuns.id, runId))
          .get()?.callId ?? null;
      this.#db
        .insert(chatDrafts)
        .values({
          chatId,
          appId,
          base,
          revision: revision + 1,
          updatedAt,
          callId,
        })
        .onConflictDoUpdate({
          target: [chatDrafts.chatId, chatDrafts.appId],
          set: { base, revision: revision + 1, updatedAt, callId },
        })
        .run();
      for (const [path, content] of Object.entries(changes)) {
        this.#db
          .insert(chatDraftFiles)
          .values({ chatId, appId, path, content })
          .onConflictDoUpdate({
            target: [
              chatDraftFiles.chatId,
              chatDraftFiles.appId,
              chatDraftFiles.path,
            ],
            set: { content },
          })
          .run();
      }
      for (const path of unchanged) {
        this.#db
          .delete(chatDraftFiles)
          .where(
            and(
              eq(chatDraftFiles.chatId, chatId),
              eq(chatDraftFiles.appId, appId),
              eq(chatDraftFiles.path, path)
            )
          )
          .run();
      }
      this.#versions.keep(
        chatId,
        appId,
        this.draft(chatId, appId),
        { callId },
        updatedAt
      );
      return true;
    });
    if (saved) {
      // The preview of the revision before is over once its server code
      // changed: its database goes now. A write of screens alone runs on
      // as it was, store and all (sealed-previews.ts). Its problems are
      // not the new revision's either way (preview-reports.ts).
      this.#sealedPreviews.revised(chatId, appId, this.draft(chatId, appId));
      this.#draftsChanged(chatId);
    }
    return saved;
  }

  /** Tells the chat's watchers its drafts changed. */
  #draftsChanged(chatId: ChatId): void {
    this.#draftVersions.set(chatId, (this.#draftVersions.get(chatId) ?? 0) + 1);
    this.#changed(chatId);
  }

  /**
   * Drops the chat's draft of App `appId`: for an open code run (`runId`,
   * refused in the same transaction once it has closed), or, once a
   * proposal committed it, only while it is still at the `revision` it
   * committed: a proposal the run's lease admitted is followed through
   * whatever came after. `false` when it changed since, or the chat is
   * gone.
   */
  dropDraft(
    chatId: ChatId,
    appId: string,
    by: { runId: string } | { revision: number }
  ): boolean {
    const dropped = this.ctx.storage.transactionSync(() => {
      if ("runId" in by) {
        this.#requireOpenRun(chatId, by.runId);
      }
      const now = this.draft(chatId, appId);
      if ("revision" in by && now.revision !== by.revision) {
        return false;
      }
      if (this.chatState(chatId) === undefined) {
        return false;
      }
      // Its changes go; its revision goes on, a row made for it if there
      // was none, so a write that read an earlier one (0, before the
      // draft's first write landed, too) lands on nothing (`saveDraft`).
      this.#db
        .delete(chatDraftFiles)
        .where(
          and(
            eq(chatDraftFiles.chatId, chatId),
            eq(chatDraftFiles.appId, appId)
          )
        )
        .run();
      const updatedAt = new Date();
      this.#db
        .insert(chatDrafts)
        .values({
          chatId,
          appId,
          base: null,
          revision: now.revision + 1,
          updatedAt,
          callId: null,
        })
        .onConflictDoUpdate({
          target: [chatDrafts.chatId, chatDrafts.appId],
          set: { revision: now.revision + 1, updatedAt, callId: null },
        })
        .run();
      return true;
    });
    if (dropped) {
      this.#dropPreview(chatId, appId);
      this.#draftsChanged(chatId);
    }
    return dropped;
  }

  /**
   * The versions of `personId`'s own chat's draft of App `appId`, newest
   * first (draft-versions.ts).
   */
  draftVersions(
    chatId: unknown,
    personId: string,
    appId: string
  ): ChatDraftVersion[] {
    const { id } = this.#ownChat(chatId, personId);
    return this.#versions.list(id, appId);
  }

  /**
   * Version `number` of `personId`'s own chat's draft of App `appId`, as
   * a draft at the revision it made: to preview, read-only.
   */
  draftVersion(
    chatId: unknown,
    personId: string,
    appId: string,
    number: unknown
  ): Draft {
    const { id } = this.#ownChat(chatId, personId);
    return this.#versions.read(id, appId, number).draft;
  }

  /**
   * Makes version `number` of `personId`'s own chat's draft of App
   * `appId` the draft again, as its next version, audited as `by`'s: no
   * version is changed. Over whatever the draft is now, as the person
   * chose it; a write of the agent's that read the draft before lands on
   * nothing (`saveDraft`).
   */
  restoreDraftVersion(
    chatId: unknown,
    personId: string,
    appId: string,
    number: unknown,
    by: AuditActor
  ): ChatDraftVersion {
    const { id } = this.#ownChat(chatId, personId);
    const restored = this.ctx.storage.transactionSync(() => {
      const { version, draft } = this.#versions.read(id, appId, number);
      const revision = this.draft(id, appId).revision + 1;
      const updatedAt = new Date();
      this.#db
        .insert(chatDrafts)
        .values({
          chatId: id,
          appId,
          base: draft.base,
          revision,
          updatedAt,
          callId: null,
        })
        .onConflictDoUpdate({
          target: [chatDrafts.chatId, chatDrafts.appId],
          set: { base: draft.base, revision, updatedAt, callId: null },
        })
        .run();
      this.#db
        .delete(chatDraftFiles)
        .where(
          and(eq(chatDraftFiles.chatId, id), eq(chatDraftFiles.appId, appId))
        )
        .run();
      for (const [path, content] of Object.entries(draft.changes)) {
        this.#db
          .insert(chatDraftFiles)
          .values({ chatId: id, appId, path, content })
          .run();
      }
      const kept = this.#versions.keep(
        id,
        appId,
        { ...draft, revision },
        { restoredFrom: version.number },
        updatedAt
      );
      this.#outboxed(by, "chat.draft_restored", id, {
        app: appId,
        version: kept.number,
        restoredFrom: version.number,
      });
      return kept;
    });
    this.#deliverAudit();
    this.#dropPreview(id, appId);
    this.#draftsChanged(id);
    return restored;
  }

  /**
   * Discards `personId`'s own chat's draft of App `appId`, audited as
   * `by`'s: its changes go, its versions stay (to restore one), and its
   * revision goes on, so a write of the agent's that read the draft
   * before lands on nothing (`saveDraft`). Whatever the draft is now, as
   * the person chose it; a draft that changes nothing is discarded all the
   * same, and audited once each time.
   */
  discardDraft(
    chatId: unknown,
    personId: string,
    appId: string,
    by: AuditActor
  ): void {
    const { id } = this.#ownChat(chatId, personId);
    // No await from here to the outbox: the drop and its event are
    // written together, as one of the object's turns.
    const { revision } = this.draft(id, appId);
    if (!this.dropDraft(id, appId, { revision })) {
      throw appErrors.create("app.conflict");
    }
    this.#outboxed(by, "chat.draft_discarded", id, {
      app: appId,
      revision: revision + 1,
    });
    this.#deliverAudit();
  }

  /** Stops the chat's preview of App `appId`, and forgets its reports. */
  #dropPreview(chatId: ChatId, appId: string): void {
    this.#sealedPreviews.drop(chatId, appId);
    this.#previewReports.drop(chatId, appId);
  }

  // A chat's preview of its draft of an App (sealed-previews.ts), for the chat's
  // own person and the chat's agent acting for them: core checks the
  // person's role in the App first (chats-rpc.ts, agent-builds.ts).

  /**
   * `personId`'s own chat's draft of App `appId`, to preview, which they
   * have open in the side panel now: `app.no_draft` while it changes
   * nothing.
   */
  previewDraft(chatId: unknown, personId: string, appId: string): Draft {
    const { id, draft } = this.#draftToPreview(chatId, personId, appId);
    this.#previewReports.opened(id, appId);
    return draft;
  }

  /**
   * `previewDraft`, for a screen of it at `revision`: the draft's own, or
   * one since which only its screens changed (`SealedPreviews.serves`);
   * `app.preview_outdated` otherwise.
   */
  #servedDraft(
    chatId: unknown,
    personId: string,
    appId: string,
    revision: unknown
  ): Draft {
    const draft = this.previewDraft(chatId, personId, appId);
    if (
      !this.#sealedPreviews.serves(
        chatIdSchema.parse(chatId),
        appId,
        draft,
        revision
      )
    ) {
      throw appErrors.create("app.preview_outdated");
    }
    return draft;
  }

  /**
   * What `build` answers, a build of `what` (the kind of ask and its
   * screen) of `personId`'s own chat's preview of App `appId`, at
   * `revision` (the draft's now when not named): one build per revision,
   * shared by every ask for it while it runs (preview-builds.ts);
   * `app.preview_outdated` for a revision the draft moved past. The
   * caller builds; this only shares what it answers.
   */
  async previewBuild(
    chatId: unknown,
    personId: string,
    appId: string,
    what: string,
    revision: number | undefined,
    build: () => Promise<PreviewBuilt>
  ): Promise<PreviewBuilt> {
    // `app.no_draft` for an App the chat builds no draft of.
    const { id, draft } = this.#draftToPreview(chatId, personId, appId);
    return await this.#previewBuilds.build(
      `${id}:${appId}:${what}`,
      revision ?? draft.revision,
      draft.revision,
      build
    );
  }

  /**
   * Whether a screen of the chat's draft of App `appId` at `revision`
   * still reaches it (`SealedPreviews.serves`): for what follows it
   * outside this object, a live query or a stream (chats-rpc.ts).
   */
  previewServes(chatId: unknown, appId: string, revision: unknown): boolean {
    const chat = chatIdSchema.safeParse(chatId);
    return (
      chat.success &&
      this.#sealedPreviews.serves(
        chat.data,
        appId,
        this.draft(chat.data, appId),
        revision
      )
    );
  }

  /** `personId`'s own chat's draft of App `appId`: `app.no_draft` while it changes nothing. */
  #draftToPreview(
    chatId: unknown,
    personId: string,
    appId: string
  ): { id: ChatId; draft: Draft } {
    const { id } = this.#ownChat(chatId, personId);
    const draft = this.draft(id, appId);
    if (Object.keys(draft.changes).length === 0) {
      throw appErrors.create("app.no_draft");
    }
    return { id, draft };
  }

  /**
   * Keeps `problem`, what the preview of `personId`'s own chat's draft of
   * App `appId` at `revision` reported on `screen`, for the agent's next
   * check (preview-reports.ts): only of the draft's own revision, which a
   * frame names for what that revision's screen ran into, an update of it
   * the frame tried and rolled back too (@grasp-os/sdk's
   * preview-updates.ts). Dropped for any other: an earlier screen's
   * problems decide nothing of the draft now. Never kept for a preview
   * opened read-only (a version of the draft or of the App): a chat with
   * no draft is at that revision too, yet nothing it reports is its
   * draft's.
   */
  previewReport(
    chatId: unknown,
    personId: string,
    appId: string,
    revision: unknown,
    screen: string,
    problem: ScreenProblem
  ): void {
    const { id } = this.#ownChat(chatId, personId);
    const draft = this.draft(id, appId);
    if (revision === readOnlyRevision || revision !== draft.revision) {
      return;
    }
    this.#previewReports.report(id, appId, draft.revision, {
      source: "screen",
      at: screen,
      ...problem,
    });
  }

  /**
   * What the preview of the chat's draft of App `appId` at `revision` ran
   * into, and what its server code logged, for the agent's checks of the
   * draft (agent-builds.ts): while the person has it open in the side
   * panel, waiting up to `waitMs` for it to report on that revision at
   * all, as a check may come right after the write. `seen` is false when
   * it didn't: nobody has it open (answered at once), or its screens
   * neither called the server nor failed.
   */
  async previewReports(
    chatId: ChatId,
    appId: string,
    revision: number,
    waitMs: number
  ): Promise<Reports> {
    const until = Date.now() + waitMs;
    let now = this.#previewReports.read(chatId, appId, revision);
    while (
      !now.seen &&
      Date.now() < until &&
      this.#previewReports.isOpen(chatId, appId)
    ) {
      // oxlint-disable-next-line no-await-in-loop -- polls until it reported, or the wait ends
      await scheduler.wait(previewPollMs);
      now = this.#previewReports.read(chatId, appId, revision);
    }
    return now;
  }

  /**
   * Keeps what the server code of the chat's draft of App `appId` at
   * `revision` wrote with `console` in its preview: for the preview's
   * tail alone (server-logs.ts).
   */
  previewLogs(
    chatId: ChatId,
    appId: string,
    revision: number,
    logs: ServerLog[]
  ): void {
    this.#previewReports.log(chatId, appId, revision, logs);
  }

  /**
   * Calls the function `request` names (its text, as a screen sends it)
   * in the preview of `personId`'s own chat's draft of App `appId`, as a
   * screen of the draft at `revision` does (sealed-previews.ts):
   * `app.preview_outdated` once the draft is at another. A failure that
   * is the draft's to fix is kept for the agent's next check. Answers the
   * call's result, a refusal included, and what a query read, as JSON
   * text (`PreviewAnswer`): plain data, whatever the call answered.
   */
  async previewFunction(
    chatId: unknown,
    personId: string,
    appId: string,
    revision: unknown,
    request: unknown,
    options: {
      kind?: "query";
      deadline?: number;
      chargeWindow?: (pages: number, whole: number) => Promise<void>;
    } = {}
  ): Promise<string> {
    const draft = this.#servedDraft(chatId, personId, appId, revision);
    const id = chatIdSchema.parse(chatId);
    // A screen of the draft's own revision: only what it ran into decides
    // the draft's check. A frame still on an earlier screen of the same
    // server code is answered, but what it saw is that earlier screen's,
    // never the draft's: it marks nothing seen and fails nothing.
    const ranDraft = revision === draft.revision;
    try {
      // What the draft's code threw, for the agent's check alone: the
      // screen's answer stays `internal.unexpected`, with no message.
      let thrown: string | undefined;
      const answered = await this.#sealedPreviews.call(
        id,
        personId,
        appIdSchema.parse(appId),
        draft,
        request,
        {
          ...options,
          // `serves` checked it is a revision: what its function logs is
          // that screen's.
          revision: Number(revision),
          draftFailure: (message) => {
            thrown = message;
          },
        }
      );
      const problem = functionProblem(request, answered.answer.result, thrown);
      if (problem !== undefined && ranDraft) {
        this.#previewReports.report(id, appId, draft.revision, problem);
      }
      return JSON.stringify(answered);
    } finally {
      // Once the call ended, however: its failure is kept by then.
      if (ranDraft) {
        this.#previewReports.saw(id, appId, draft.revision);
      }
    }
  }

  /**
   * Starts, joins or (`attach`) reads again `personId`'s invocation of the
   * streaming action `request` names (its text, as a screen sends it) in
   * the preview of their own chat's draft of App `appId` at `revision`
   * (sealed-previews.ts): `app.preview_outdated` once the draft is at
   * another. Answers its frames, as JSON lines: progress, then its result.
   */
  async previewStream(
    chatId: unknown,
    personId: string,
    appId: string,
    revision: unknown,
    request: unknown,
    attach: boolean
  ): Promise<ReadableStream<Uint8Array>> {
    const draft = this.#servedDraft(chatId, personId, appId, revision);
    return await this.#sealedPreviews.openStream(
      chatIdSchema.parse(chatId),
      personId,
      appIdSchema.parse(appId),
      draft,
      request,
      attach,
      // `serves` checked it is a revision: what the stream logs is that
      // screen's.
      Number(revision)
    );
  }

  /**
   * Asks `personId`'s invocation of the streaming action `request` names,
   * in the preview of their own chat's draft of App `appId` at
   * `revision`, to stop: whether it was still running.
   */
  async previewCancelStream(
    chatId: unknown,
    personId: string,
    appId: string,
    revision: unknown,
    request: unknown
  ): Promise<boolean> {
    const draft = this.#servedDraft(chatId, personId, appId, revision);
    return await this.#sealedPreviews.cancelStream(
      chatIdSchema.parse(chatId),
      personId,
      appIdSchema.parse(appId),
      draft,
      request
    );
  }

  /**
   * The `@server/_generated/api` references the screens of `personId`'s own chat's draft
   * of App `appId` at `revision` import: generated from its draft
   * release, sealed now if it isn't yet; null when it generates none.
   * Throws as the seal does for a draft that doesn't build or inspect.
   */
  async previewReferences(
    chatId: unknown,
    personId: string,
    appId: string,
    revision: unknown
  ): Promise<string | null> {
    const { id, draft } = this.#draftToPreview(chatId, personId, appId);
    if (draft.revision !== revision) {
      throw appErrors.create("app.preview_outdated");
    }
    const app = appIdSchema.parse(appId);
    const { release, version } = await this.#sealedPreviews.release(
      id,
      app,
      draft
    );
    const generated = await generateModules(release.app, {
      resourceId: app,
      resourceVersion: version,
    });
    return generated[generatedPaths.api] ?? null;
  }

  /**
   * Whether `personId`'s own chat's draft of App `appId` is of spec 8's
   * layout, so its preview runs on its sealed draft release
   * (sealed-previews.ts) and never as v1 server code.
   */
  async sealsDraft(
    chatId: unknown,
    personId: string,
    appId: string
  ): Promise<boolean> {
    const { draft } = this.#draftToPreview(chatId, personId, appId);
    const files = await draftFiles(this.env, appIdSchema.parse(appId), draft);
    return isAppLayout(Object.fromEntries(files));
  }

  /**
   * Calls the public function at `path` of `personId`'s own chat's draft
   * of App `appId` with `input`, in its preview, as the draft is now: for
   * the chat's agent (`env.build.call`), which hears how it went, so
   * nothing is kept of it. `operation.not_found` for a path that isn't a
   * public function of the draft. Answers as JSON text (`FunctionAnswer`).
   */
  async callDraftFunction(
    chatId: unknown,
    personId: string,
    appId: string,
    path: string,
    input: unknown
  ): Promise<string> {
    const { id, draft } = this.#draftToPreview(chatId, personId, appId);
    const app = appIdSchema.parse(appId);
    const { release } = await this.#sealedPreviews.release(id, app, draft);
    const operation = Object.hasOwn(release.app.operations, path)
      ? release.app.operations[path]
      : undefined;
    if (operation === undefined || operation.visibility !== "public") {
      throw operationErrors.create("operation.not_found");
    }
    const request = JSON.stringify({
      reference: { name: path, kind: operation.kind },
      input,
    });
    // What the draft's code threw, for the agent's own call: as data in
    // its tool's result, never in any screen's answer.
    let thrown: string | undefined;
    const { answer } = await this.#sealedPreviews.call(
      id,
      personId,
      app,
      draft,
      request,
      {
        draftFailure: (message) => {
          thrown = message;
        },
      }
    );
    return JSON.stringify(
      thrown === undefined ? answer : { ...answer, thrown }
    );
  }

  /** Deletes the draft files and drafts the conditions name, in that order. */
  #dropDrafts(files: SQL | undefined, drafts: SQL | undefined): void {
    this.#db.delete(chatDraftFiles).where(files).run();
    this.#db.delete(chatDrafts).where(drafts).run();
  }

  /** What the chat's agent spent building Apps this turn. */
  #turnBuilds(chatId: ChatId): TurnBuilds {
    const found = this.#builds.get(chatId);
    if (found !== undefined) {
      return found;
    }
    const made: TurnBuilds = { created: 0 };
    this.#builds.set(chatId, made);
    return made;
  }

  /**
   * Takes one of the Apps the chat's agent may create this turn, for the
   * code run `runId`, refused once that run has closed: `false` once it
   * created `limit`.
   */
  takeCreate(chatId: ChatId, limit: number, runId: string): boolean {
    this.#requireOpenRun(chatId, runId);
    const turn = this.#turnBuilds(chatId);
    if (turn.created >= limit) {
      return false;
    }
    turn.created += 1;
    return true;
  }

  /** Gives back an App taken with `takeCreate` that wasn't created. */
  releaseCreate(chatId: ChatId): void {
    const turn = this.#turnBuilds(chatId);
    turn.created = Math.max(0, turn.created - 1);
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
      drafts: this.#draftVersions.get(chatId) ?? 0,
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
      .flatMap(({ id, message, createdAt, thinkingMs }) => {
        const shown = withFiles(
          chatMessageOf(
            id,
            storedMessageSchema.parse(JSON.parse(message)),
            createdAt,
            givenBy(id),
            thinkingMs,
            asking
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
