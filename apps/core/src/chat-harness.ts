import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Message,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import {
  AssistantEntry,
  CompactionEntry,
  ConversationBusy,
  createRegistry,
  DEFAULT_COMPACTION_POLICY,
  defineDoc,
  defineDocFamily,
  Harness,
  ResetEntry,
  ToolResultEntry,
} from "@earendil-works/pi-durable";
import type {
  Conversation,
  ConversationView,
  Cursor,
  EntryId,
  EntryRecord,
  JsonObject,
  ConversationRetryPolicy,
  Registry,
  SessionEnd,
  SettledSubmissionRecord,
  Storage,
  Submission,
  SubmissionId,
  SubmissionRecord,
  Wake,
} from "@earendil-works/pi-durable";
import { agentErrors } from "@grasp-os/shared/agent";
import { delegateActorOf } from "@grasp-os/shared/audit";
import type { ChatMake, ChatQueued } from "@grasp-os/shared/chat";
import { isExpectedError } from "@grasp-os/shared/errors";
import { errorFields, log } from "@grasp-os/shared/log";
import type { ModelEffort, ModelWait } from "@grasp-os/shared/models";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { quietLoader } from "@grasp-os/shared/quiet-loader";
import { z } from "zod";

import { apisFor } from "./agent-apis.ts";
import { turnCheck } from "./agent-builds.ts";
import { isMessage, showThinkingName } from "./agent-messages.ts";
import { lastWordsOf, rememberTool } from "./agent-remember.ts";
import { chatAuthority, chatContext } from "./agent-scope.ts";
import type { AgentScope } from "./agent-scope.ts";
import { showThinking } from "./agent-thinking.ts";
import { textOf } from "./agent.ts";
import type {
  CodeTurn,
  QuestionBuilt,
  QuestionMention,
  QuestionSubject,
  TurnContext,
  TurnOutcome,
} from "./agent.ts";
import { memberOf } from "./auth/identity.ts";
import { readThinkingBrain } from "./brain-rpc.ts";
import {
  chatAgent,
  needsRebase,
  noteKind,
  noticeKind,
  questionContent,
  questionKind,
  questionText,
  rebase,
  recallTextOf,
} from "./chat-agent.ts";
import type { Audience } from "./chat-audiences.ts";
import { coreMessageProvider, shownBuiltSchema } from "./chat-messages.ts";
import type { ShownBuilt } from "./chat-messages.ts";
import { codeTimeoutMs } from "./code-mode.ts";
import { callObject, workspace } from "./durable-objects.ts";
import { allInOrder } from "./in-order.ts";
import { chatTurnPurpose } from "./model-spend.ts";
import { inputTokens, modelFailureOf, models } from "./models.ts";
import type { AgentModel } from "./models.ts";
import { sessionHost } from "./sandboxed.ts";
import { recallForTurn, turnRecallTool } from "./turn-recall.ts";
import type { TurnRecall } from "./turn-recall.ts";
import { recordTurn } from "./turn-records.ts";
import type { ChatTurn } from "./turn-records.ts";

// A chat's turns on pi-durable (GRA-1529), in the chat's own object
// (chat-session.ts): one Harness on the object's SQLite, its root
// conversation the chat's. Each turn installs the chat agent's extension
// (chat-agent.ts) with what that turn runs with, behind the model gateway:
// one provider, the turn's admitted model, through which every request
// goes, summaries included, metered and audited as the chat's. pi stores
// the transcript, compacts it, and picks a turn cut short up again.
//
// This object owns the chat's turn, in one record (`TurnDoc`): claimed by
// `run` before anything is awaited, and refused while another is
// unsettled; set up and admitted again from it after a restart; settled
// once (`#settle`), by `run` or, for a turn nothing waits on, by the sync;
// its capture for the Brain delivered once after. The Workspace holds no
// turn state of its own: one ordered sync (`#sync`) copies to it what was
// committed (`keepTurnMessages`), the answer streaming in, whether a turn
// runs, and the capture. The code runs, their leases and what the chat
// may no longer read stay the Workspace's. Once
// the chat holds a result it may no longer read, its context is rebased
// (`rebase` in chat-agent.ts) before its next turn, and after a turn the
// guard stopped for it.

/**
 * What a chat's Harness needs of where it runs, and nothing else: on
 * Cloudflare its Durable Object (chat-session.ts), the one host there is.
 */
export interface ChatHost {
  /** Opens the storage pi keeps the chat in, again for each open. */
  storage: () => Promise<Storage>;
  /**
   * Wakes the host when `wake` says, to `resume`: pi's `onWake`, and the
   * Harness's own retry of a sync that failed (`ChatHarness.wake`).
   */
  arm: (wake: Wake) => void;
  /** Keeps the host up until `work` settles: work no call waits on. */
  waitUntil: (work: Promise<unknown>) => void;
}

/** One question of a chat, as its Workspace hands it over. */
export interface TurnRequest {
  /** The turn's ID: the request ID of its input, so a retry finds it. */
  turnId: string;
  /**
   * When its question reached the chat's Workspace, in ms since the epoch:
   * what the turn's record times from (`#recordOf`).
   */
  sentAt: number;
  scope: Omit<AgentScope, "runId">;
  question: {
    text: string;
    /** `<provider>/<model>`, one the deployment allows. */
    model: string;
    effort?: ModelEffort;
    /** The files it carries: their IDs and types. */
    files: { id: string; type: string }[];
    /** What it is about: the page it was asked on, by name. */
    subject?: QuestionSubject;
    /** What the person picked with `@` in it, each by name. */
    mentions?: QuestionMention[];
    /** What "Make something" started the chat to make, if it did. */
    make?: ChatMake;
    /** Build it, said to the chat's plan: what core made of it (`ChatsApi.build`). */
    built?: QuestionBuilt;
    /**
     * The person's question again, for the next agent they addressed in
     * it (workspace.ts, `send`): for the model, never shown as a question.
     */
    followUp?: true;
  };
  /** A chat others share, which reads only what they all may. */
  shared: boolean;
  /**
   * Who is in a chat others share, as the turn was admitted for
   * (`chat_audiences`, kept from the platform's roster for the message):
   * with anyone Grasp can't name as a member in it, its recall reads
   * nothing (turn-recall.ts). None in one's own; a shared chat's turn
   * without it recalls nothing.
   */
  audience?: Audience;
  /**
   * Whether the answer reaches the person alone, so the recall before the
   * question may hold what only they may read (their own store,
   * turn-recall.ts): their own chat, in Grasp or their direct message on
   * a chat app, in a turn they started (workspace.ts, `answersAlone`).
   */
  personal: boolean;
  context: TurnContext;
  /** What the turn's capture for the Brain records besides how it ended. */
  capture: {
    /**
     * Whether its person asked it there and then: never so for a turn
     * something woke (`Workspace.askUnattended`).
     */
    attended: boolean;
  };
}

/**
 * What a turn's capture for the Brain holds, as its ChatSession delivers
 * it: how it ended, the message it answered with, if any, and whether its
 * person asked it there and then (`Workspace.captureTurn`).
 */
export type TurnCapture = {
  outcome: TurnOutcome;
  answerId: number | null;
} & Pick<TurnRequest["capture"], "attended">;

/** Why a turn stopped before it answered, when no model said so. */
export type TurnStop =
  | "history_revoked"
  | "person_inactive"
  | "unreadable"
  | "overdue"
  | "lost";

/** How a turn ended, as its Workspace reads it. */
export interface TurnEnd {
  outcome: TurnOutcome;
  /** The model's last words: its answer, or where it stopped. */
  answer: string;
  /** Why it failed, in the gateway's words. */
  error?: string;
  stopped?: TurnStop;
}

/**
 * A question its person sent while the chat's turn ran, as its Workspace
 * hands it over to be queued into that turn (`ChatHarness.queueQuestion`).
 */
export interface QueuedQuestion {
  /** Its own ID, which the Workspace made: its request ID, so a retry finds it. */
  id: string;
  text: string;
  /** The files it carries: their IDs and types. */
  files: { id: string; type: string }[];
  subject?: QuestionSubject;
  mentions?: QuestionMention[];
  built?: QuestionBuilt;
}

/** A message for the Workspace to show, with the files a question carries. */
export interface TurnMessage {
  /** The chat's entry it shows, so a copy sent again is kept once. */
  entryId: number;
  message: Message;
  files?: string[];
  /** For the person's Build it: the plan it built and what that made. */
  built?: ShownBuilt;
  /** How long a response thought, as its stream showed it. */
  thinkingMs?: number;
  /** A question queued into its turn (`ChatHarness.queueQuestion`). */
  queued?: true;
}

const context = BACKGROUND_CONTEXT;

/** The provider every request of the chat goes through: the model gateway. */
const gateway = "grasp";

/**
 * How the request ID of a notice to turn `turnId` begins: pi keeps it with
 * the input, so the turn's last input is found by it (`#lastInputOf`).
 */
const noticeRequestPrefix = (turnId: string): string => `notice:${turnId}:`;

/**
 * How the request ID of a question queued into turn `turnId` begins
 * (`ChatHarness.queueQuestion`), its own or sent again at once (`sendNow`): it is
 * one of the turn's inputs, found as a notice is (`#lastInputOf`).
 */
const queuedRequestPrefix = (turnId: string): string => `queued:${turnId}:`;

/**
 * Most checks of a turn's drafts (`turnCheck`, agent-builds.ts): as the
 * agent's instructions stop it once the same error comes back three
 * times, so a turn that can't fix its drafts spends no more on trying.
 */
const maxTurnChecks = 3;

/** What a turn that only showed its thinking is asked, once, before it ends. */
const wordsPlease =
  "You showed your thinking in the brain, but wrote no answer. Now write your answer to the person in words.";

/** Whether a chat's Harness has asked the model anything yet (`retryPolicy`). */
interface Asked {
  since: boolean;
}

/**
 * pi's retry of a turn's request, for one kind of failure only: a request
 * a restart cut off (an eviction, a deploy, a reset), which pi counts as a
 * failed attempt where pi 1.4 sent it again as it opened. It is sent again
 * at once, as before, and at most four times in a row, as before (pi 1.4
 * parked a request the fifth restart cut off). That one may have been
 * billed, as it could before.
 *
 * Every other failure comes from the model gateway, which retries what may
 * be retried (a rate limit, after the wait the provider asked for; never
 * what may have been billed) and says why a request failed in the end: pi
 * retrying that too would multiply the attempts and send again what may
 * have been billed. pi reads one policy for both, so it is on only until
 * the Harness starts a turn's request (the chat agent's `beforeRequest`),
 * or any answer, a summary's too, comes back failed: a restart opens a new
 * Harness, whose first act for a request a restart cut off is to count it
 * (pi's `interrupted`), before that request is sent again; and a summary
 * that answers meanwhile changes nothing. Once off, what the gateway
 * answers is final. Only a summary failing in that window, as a request
 * is cut off, makes the request end at its first cut.
 */
const retryPolicy = (asked: boolean): Partial<ConversationRetryPolicy> =>
  asked ? { enabled: false } : { enabled: true, maxRetries: 4, baseDelayMs: 0 };
// A summary a restart cut off alongside the request is sent again as it
// was (pi doesn't count it): it asks the model only after the request,
// which pi reserves first and which reads this policy at once.

/** How soon the object wakes to sync again after a sync failed. */
const syncRetryMs = 15_000;

/**
 * Most a turn pi runs may go without pi committing anything (a word, a
 * step, a result) before it is stopped as overdue (`#watchdog`): past the
 * gateway's 15 minutes for one request, which streams as it goes, and any
 * code run's limit. A turn that keeps going is never stopped for it.
 */
const turnIdleMs = 20 * 60_000;

/** Most a turn may run however it goes: a turn calling tools without end. */
const turnMostMs = 4 * 60 * 60_000;

/**
 * `turnIdleMs`, or less where tests set `CHAT_TURN_IDLE_MS`; never set in
 * wrangler.jsonc.
 */
const turnIdleOf = (env: Pick<Env, "CHAT_TURN_IDLE_MS">): number => {
  const set = Number(env.CHAT_TURN_IDLE_MS);
  return Number.isInteger(set) && set > 0 ? set : turnIdleMs;
};

/**
 * The chat's turn: the one record of it, under way or the last. Written
 * as the turn is claimed (`#take`), before anything else of it, so a turn
 * this object holds no record of never ran; settled once (`#settle`), its
 * request then kept without what it read (its memory), which only a turn
 * under way needs. `answerId` is the Workspace's message it answered
 * with, as the copies say. `captureOwed` while the settled turn's capture
 * (`CaptureDoc`) waits to be delivered: a copy that comes after the turn
 * settled names its answer there, in the same commit.
 */
interface TurnRecord extends JsonObject {
  request: string;
  ended: boolean;
  answerId: number | null;
  captureOwed: boolean;
  /** When the turn was claimed: none in a record an earlier release wrote. */
  startedAt: number | null;
}

/**
 * What the chat's object saw of its turn under way as it went, for the
 * turn's record (`#recordOf`): when its first model request went out,
 * its first token came, and its first text reached the chat's
 * Workspace; what each request used as the gateway charged it, its
 * summaries' too, cancelled ones included (models.ts `chargedAnswer`);
 * and what the gateway told it of fallbacks and rate limits
 * (`ModelWait`). Only in memory: after a restart, only what came since.
 */
interface Pace {
  turnId: string;
  /** Whether a restart cut the turn short, so its times are unknown. */
  resumed: boolean;
  firstRequestAt?: number;
  firstTokenAt?: number;
  firstTextAt?: number;
  /** Prompt tokens with the cache's, as the gateway counts them. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** US dollars at list prices. */
  cost: number;
  fallbacks: number;
  rateLimitWaits: number;
  rateLimitWaitMs: number;
  /** When the rate limit waited out now began. */
  waitingSince?: number;
}

const paceOf = (turnId: string, resumed: boolean): Pace => ({
  turnId,
  resumed,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cost: 0,
  fallbacks: 0,
  rateLimitWaits: 0,
  rateLimitWaitMs: 0,
});

/**
 * `events`, one request's, passed on as they come: `first` told as the
 * first token comes (the first delta of text, thinking or a tool call),
 * and `last` given the response it ended with, answered or failed.
 */
const tapped = (
  events: AssistantMessageEventStream,
  first: () => void,
  last: (response: AssistantMessage) => void
): AssistantMessageEventStream => {
  const out = createAssistantMessageEventStream();
  void (async () => {
    let seen = false;
    try {
      for await (const event of events) {
        if (!seen && event.type.endsWith("_delta")) {
          seen = true;
          first();
        }
        if (event.type === "done") {
          last(event.message);
        } else if (event.type === "error") {
          last(event.error);
        }
        out.push(event);
      }
    } finally {
      // A stream that ended without its last event ends here too.
      out.end();
    }
  })();
  return out;
};

/**
 * The end of the turn that settles as failed because restarts cut it off
 * too often (`#endOf`), told apart in its record.
 */
const cutOffTooOften = "Restarts cut the turn off too often for it to go on.";

/**
 * Why a turn that ended as `end` failed, for its record: what stopped it
 * (`TurnStop`), restarts, or the gateway's code for its failure (models.ts
 * `modelFailureOf`). None for a turn that answered or was cancelled.
 */
const failureCodeOf = (end: TurnEnd): string | null => {
  if (end.stopped !== undefined) {
    return end.stopped;
  }
  if (end.outcome !== "failed") {
    return null;
  }
  return end.error === cutOffTooOften
    ? "chat.cut_off"
    : modelFailureOf(end.error);
};

/** A turn just settled with its end, what its record holds (`#record`). */
interface SettledTurn {
  request: TurnRequest;
  end: TurnEnd;
  /** The chat's newest entry as it settled: the last its facts read. */
  upTo: EntryId | undefined;
  /** What this object saw of it, if it is the turn it saw. */
  pace: Pace | undefined;
}

/** What the turn's committed entries say of it, for its record. */
interface TurnFacts {
  tools: Record<string, { calls: number; ms: number }>;
  retries: number;
  stopReason: string | null;
  compacted: boolean;
  /** Questions queued into it (`queueQuestion`) that pi placed. */
  queued: number;
}

const TurnDoc = defineDoc<TurnRecord>({
  kind: "grasp.turn",
  version: 1,
  scope: "session",
  initial: () => ({
    request: "",
    ended: true,
    answerId: null,
    captureOwed: false,
    startedAt: null,
  }),
  checkpointWhen: () => true,
});

/**
 * A settled turn's capture for the Brain, owed until it is delivered
 * (`#deliver`), by its turn's ID: a later turn never takes its place.
 */
const CaptureDoc = defineDocFamily<TurnCapture, TurnCapture>({
  kind: "grasp.capture",
  version: 1,
  scope: "session",
  family: true,
  initial: (owed) => owed,
  checkpointWhen: () => true,
});

/**
 * The turn its person stopped last, by its ID: a stop that came before
 * the turn submitted its question stops it once it has, through a restart
 * too. pi withdraws only a queued submission, and a turn's question is
 * never queued (`whenBusy: "reject"`).
 */
const StoppedDoc = defineDoc<{ turnId: string }>({
  kind: "grasp.stopped",
  version: 1,
  scope: "session",
  initial: () => ({ turnId: "" }),
  checkpointWhen: () => true,
});

/** The last entry copied to the Workspace. */
const CopiedDoc = defineDoc<{ after: EntryId | null }>({
  kind: "grasp.copied",
  version: 1,
  scope: "session",
  initial: () => ({ after: null }),
  checkpointWhen: () => true,
});

/** What a Build it shows of what core made (`QuestionBuilt`): its project stays out. */
const shownBuilt = ({ plan, app, workflow }: QuestionBuilt): ShownBuilt => ({
  plan,
  ...(app === undefined ? {} : { app }),
  ...(workflow === undefined ? {} : { workflow }),
});

/**
 * A question as pi takes it: its content for the model (`questionContent`)
 * and the entry the chat shows it by, with what that keeps besides
 * (`questionDataOf`).
 */
const questionInput = (
  question: Pick<
    TurnRequest["question"],
    "text" | "files" | "subject" | "mentions" | "make" | "built" | "followUp"
  >,
  recall?: TurnRecall
) => ({
  type: "input" as const,
  content: questionContent(question.text, question.files, recall, {
    subject: question.subject,
    mentions: question.mentions,
    make: question.make,
    built: question.built,
  }),
  entry: {
    kind: questionKind,
    data: {
      files: question.files.map(({ id }) => id),
      ...(question.followUp === true ? { followUp: true } : {}),
      // Shown with the person's Build it, as what it built.
      ...(question.built === undefined
        ? {}
        : { built: shownBuilt(question.built) }),
      ...(recall === undefined
        ? {}
        : {
            recall: {
              runId: recall.runId,
              callId: recall.callId,
              query: recall.query,
              status: recall.status,
            },
          }),
    },
  },
});

/** A question's recall's call (turn-recall.ts), as its entry keeps it. */
const questionRecallSchema = z.object({
  runId: z.string(),
  callId: z.string(),
  query: z.string(),
  status: z.string(),
});
type QuestionRecall = z.infer<typeof questionRecallSchema>;

const questionFilesSchema = z.array(z.string());

/**
 * What a question's entry keeps besides its message: the files it carries,
 * what its Build it built, its recall's call, so the chat shows the recall
 * as a step of its own, and that it is a question again for the next
 * agent addressed (`followUp`), which isn't shown. Each read on its own: one that doesn't
 * parse is left out alone, never the others with it. Only the shape this
 * code writes: nothing is released, so no older one is read.
 */
export const questionDataOf = (
  data: unknown
): {
  files: string[];
  built?: ShownBuilt;
  recall?: QuestionRecall;
  followUp?: true;
  queued?: true;
} => {
  const field = (key: string): unknown =>
    typeof data === "object" && data !== null
      ? Reflect.get(data, key)
      : undefined;
  const files = questionFilesSchema.safeParse(field("files"));
  const built = shownBuiltSchema.safeParse(field("built"));
  const recall = questionRecallSchema.safeParse(field("recall"));
  return {
    files: files.success ? files.data : [],
    ...(built.success ? { built: built.data } : {}),
    ...(recall.success ? { recall: recall.data } : {}),
    ...(field("followUp") === true ? { followUp: true as const } : {}),
    ...(field("queued") === true ? { queued: true as const } : {}),
  };
};

const noUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * A question's recall as the chat shows it: a search of the brain the
 * platform made before the first request, its call and its result, as the
 * model's own searches show. Only in the chat's copy: the model reads what
 * it found with the question.
 */
const recallStepOf = (
  recall: QuestionRecall,
  text: string,
  timestamp: number
): Omit<TurnMessage, "entryId">[] => [
  {
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: recall.callId,
          name: turnRecallTool,
          arguments: { query: recall.query },
        },
      ],
      api: coreMessageProvider,
      provider: coreMessageProvider,
      model: coreMessageProvider,
      usage: noUsage,
      stopReason: "toolUse",
      timestamp,
    },
  },
  {
    message: {
      role: "toolResult",
      toolCallId: recall.callId,
      toolName: turnRecallTool,
      content: [{ type: "text", text }],
      details: { status: recall.status, runId: recall.runId },
      isError: recall.status !== "completed",
      timestamp,
    },
  },
];

/** A turn's request, as `TurnDoc` keeps it: our own JSON, checked as an object. */
const turnRequestSchema = z.custom<TurnRequest>(
  (value) => typeof value === "object" && value !== null
);

/** The request a turn's record holds, if it holds one. */
const requestOf = (turn: Readonly<TurnRecord>): TurnRequest | undefined =>
  turn.request === ""
    ? undefined
    : turnRequestSchema.parse(JSON.parse(turn.request));

/**
 * What the chat reads of `pi.live`: pi's run, present exactly while the
 * agent is at work; and the partial answer, if there is one.
 */
const liveSchema = z.object({
  run: z.object({}).optional(),
  generation: z
    .object({
      message: z
        .custom<AssistantMessage>(
          (value) =>
            typeof value === "object" &&
            value !== null &&
            isMessage(value) &&
            value.role === "assistant"
        )
        .optional(),
    })
    .optional(),
});

/**
 * What the chat reads of `pi.inbox`: the inputs pi holds for the next
 * boundary, oldest first. A queued question (`ChatHarness.queueQuestion`) is one
 * placed as a question's entry, its content as `questionContent` made it:
 * text alone.
 */
const inboxItemSchema = z.object({
  id: z.custom<SubmissionId>((value) => typeof value === "number"),
  mode: z.string(),
  content: z
    .union([
      z.string(),
      z.array(z.object({ type: z.literal("text"), text: z.string() })),
    ])
    .optional(),
  entry: z.object({ kind: z.string(), data: z.json().optional() }).optional(),
});

/** A question pi holds queued for the turn, as `pi.inbox` has it. */
interface InboxQuestion {
  id: SubmissionId;
  content: string | { type: "text"; text: string }[];
  data: z.infer<ReturnType<typeof z.json>> | undefined;
}

/** The questions queued in `inbox` (`pi.inbox`), oldest first. */
const inboxQuestionsOf = (inbox: unknown): InboxQuestion[] => {
  const items: unknown =
    typeof inbox === "object" && inbox !== null
      ? Reflect.get(inbox, "items")
      : undefined;
  // Each on its own: an item of another shape hides none of the rest.
  const each: readonly unknown[] = Array.isArray(items) ? items : [];
  return each.flatMap((item) => {
    const parsed = inboxItemSchema.safeParse(item);
    if (!parsed.success) {
      return [];
    }
    const { id, mode, content, entry } = parsed.data;
    return mode !== "write" &&
      content !== undefined &&
      entry?.kind === questionKind
      ? [{ id, content, data: entry.data }]
      : [];
  });
};

/** A queued question as the chat shows it: its person's own words. */
const queuedOf = ({ id, content }: InboxQuestion): ChatQueued => ({
  id: String(id),
  text: questionText({ role: "user", content, timestamp: 0 }),
});

/**
 * The entry that ends a turn stopped before the model said anything: no
 * message for the model, only the chat's own end (`cancelledMessage`).
 * Written once a turn, under a request ID of its own, so a turn asked
 * again keeps one, and copied as every other entry is.
 */
const stoppedKind = "grasp.stopped";

/**
 * The kinds of entry that follow a response in a turn: another response
 * (pi asking again for one a restart cut short), a call's result, a
 * stopped turn's end, or an input.
 */
const turnKinds: ReadonlySet<string> = new Set([
  "pi.assistant",
  "pi.tool-result",
  stoppedKind,
  questionKind,
  noticeKind,
]);

/** How the chat ends a turn stopped before the model said anything: core's own. */
const cancelledMessage = (): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: coreMessageProvider,
  provider: coreMessageProvider,
  model: coreMessageProvider,
  usage: noUsage,
  stopReason: "aborted",
  timestamp: Date.now(),
});

/** What pi keeps of a tool result's diagnostics, beside the rendered block. */
const diagnosticsDataSchema = z.object({
  diagnostics: z.array(z.object({ message: z.string() })),
});

/**
 * A tool result as the person reads it: pi ends the model's copy with its
 * diagnostics rendered as a `<harness>` block, which the chat shows as
 * their plain words instead.
 */
const withPlainDiagnostics = (
  message: ToolResultMessage,
  data: unknown
): ToolResultMessage => {
  const parsed = diagnosticsDataSchema.safeParse(data);
  if (!parsed.success || parsed.data.diagnostics.length === 0) {
    return message;
  }
  return {
    ...message,
    content: [
      ...message.content.slice(0, -1),
      {
        type: "text",
        text: parsed.data.diagnostics.map((each) => each.message).join("\n"),
      },
    ],
  };
};

/**
 * The messages a committed entry shows the person: a question, then its
 * recall's step if it recalled; a response or a tool's result; a stopped
 * turn's end; or none.
 */
const shownOf = (entry: EntryRecord): TurnMessage[] => {
  const entryId = entry.id;
  if (entry.kind === stoppedKind) {
    return [{ entryId, message: cancelledMessage() }];
  }
  const [message] = entry.model ?? [];
  if (message === undefined) {
    return [];
  }
  if (entry.kind === questionKind && message.role === "user") {
    const { files, built, recall, followUp, queued } = questionDataOf(
      entry.data
    );
    // The question again for the next agent addressed in it: the person
    // sees their question once, and each agent's answer after it.
    if (followUp === true) {
      return [];
    }
    const recalled = recall === undefined ? undefined : recallTextOf(message);
    return [
      {
        message: { ...message, content: questionText(message) },
        files,
        ...(built === undefined ? {} : { built }),
        ...(queued === undefined ? {} : { queued }),
      },
      ...(recall === undefined || recalled === undefined
        ? []
        : recallStepOf(recall, recalled, message.timestamp)),
    ].map((shown) => ({ ...shown, entryId }));
  }
  if (entry.kind === "pi.tool-result" && message.role === "toolResult") {
    return [{ entryId, message: withPlainDiagnostics(message, entry.data) }];
  }
  return entry.kind === "pi.assistant" ? [{ entryId, message }] : [];
};

/**
 * Times the thinking of the response streaming in, from its partial as
 * pi's live state has it at each commit: from when its last part is a
 * thought to when it writes or calls, or ends, the parts' times added up.
 * To the grain of pi's commits of the stream; a response a restart cut
 * short has none.
 */
const thinkingClock = () => {
  let ms: number | undefined;
  let since: number | undefined;
  const stop = (): void => {
    if (since !== undefined) {
      ms = (ms ?? 0) + Date.now() - since;
      since = undefined;
    }
  };
  return {
    see: (partial: AssistantMessage): void => {
      const part = partial.content.at(-1)?.type;
      if (part === "thinking") {
        since ??= Date.now();
      } else if (part !== undefined) {
        stop();
      }
    },
    /** The response's thinking time, now it ended: none if it didn't think. */
    take: (): number | undefined => {
      stop();
      const taken = ms;
      ms = undefined;
      return taken;
    },
  };
};

/**
 * pi's `restartLimit`: its own, or fewer where tests set
 * `CHAT_RESTART_LIMIT`; never set in wrangler.jsonc.
 */
const restartLimitOf = (
  env: Pick<Env, "CHAT_RESTART_LIMIT">
): { restartLimit?: number } => {
  const set = Number(env.CHAT_RESTART_LIMIT);
  return Number.isInteger(set) && set > 0 ? { restartLimit: set } : {};
};

/** The brain as `personId` may read it now: what a step of thinking may name. */
const brainOf = async (env: Env, personId: string) => {
  const person = await memberOf(env.DB, personId);
  if (person === undefined) {
    throw permissionErrors.create("permission.person_inactive");
  }
  return await readThinkingBrain(env, person);
};

/** Why `error` stopped a turn, as the hook said it. */
const stopOf = (error: Error): TurnStop =>
  isExpectedError(error) && error.code === "agent.history_revoked"
    ? "history_revoked"
    : "unreadable";

/**
 * Whether `entry` is a response a restart cut short that pi then asked
 * for again: kept by pi as aborted, outside the model's context, and
 * never shown, as the person gets the whole answer from the attempt
 * after it. One a stop cut short ends its run, and is shown. Unknown
 * (`undefined`) while it is the newest response and pi still runs
 * (`running`, as of before the entries were read). `later` are the
 * entries committed after it.
 */
const cutAttempt = (
  entry: EntryRecord,
  later: readonly EntryRecord[],
  running: boolean
): boolean | undefined => {
  const [message] = entry.model ?? [];
  if (
    entry.kind !== "pi.assistant" ||
    message?.role !== "assistant" ||
    message.stopReason !== "aborted"
  ) {
    return false;
  }
  const next = later.find(({ kind }) => turnKinds.has(kind));
  if (next === undefined) {
    return running ? undefined : false;
  }
  return next.kind === "pi.assistant";
};

/**
 * Turn `request`'s record (turn-records.ts), as it was done at `doneAt`:
 * its times from when its question reached the Workspace (`sentAt`), as
 * its object saw them (`Pace`), none for one a restart cut short; what its
 * requests used, as the gateway charged them; and what its entries say.
 */
const recordOf = (
  { request, end, pace }: { request: TurnRequest; end: TurnEnd; pace: Pace },
  sentAt: number,
  doneAt: number,
  facts: TurnFacts | undefined
): ChatTurn => {
  const { scope, question } = request;
  // The Workspace's clock and the object's: Cloudflare's, kept in step to
  // well under the times measured, never below none.
  const since = (at: number | undefined): number | null =>
    pace.resumed || at === undefined ? null : Math.max(0, at - sentAt);
  return {
    id: request.turnId,
    chatId: scope.chatId,
    surface: scope.unattended === true ? "wake" : (scope.via ?? "web"),
    model: question.model,
    effort: question.effort ?? null,
    sentAt: new Date(sentAt),
    firstRequestMs: since(pace.firstRequestAt),
    firstTokenMs: since(pace.firstTokenAt),
    firstTextMs: since(pace.firstTextAt),
    doneMs: Math.max(0, doneAt - sentAt),
    inputTokens: pace.inputTokens,
    outputTokens: pace.outputTokens,
    cacheReadTokens: pace.cacheReadTokens,
    cacheWriteTokens: pace.cacheWriteTokens,
    cost: pace.cost,
    tools: facts?.tools ?? {},
    retries: facts?.retries ?? 0,
    fallbacks: pace.fallbacks,
    rateLimitWaits: pace.rateLimitWaits,
    rateLimitWaitMs: pace.rateLimitWaitMs,
    stopReason: facts?.stopReason ?? null,
    outcome: end.outcome,
    code: failureCodeOf(end),
    compacted: facts?.compacted ?? false,
    queued: facts?.queued ?? 0,
    resumed: pace.resumed,
  };
};

/** One chat's Harness, opened on its object's storage. */
export class ChatHarness {
  readonly #host: ChatHost;
  /** Its host's name for it, in what it logs. */
  readonly #name: string;
  readonly #env: Env;
  readonly #storage: Storage;
  readonly #harness: Harness;
  readonly #conversation: Conversation;
  readonly #registry: Registry;
  readonly #models: MutableModels;
  /** What the chat has read from, as of the last request's guard. */
  #sources: string[] = [];
  /** What a rebased context may hold, as the turn's model was set up. */
  #room: number = DEFAULT_COMPACTION_POLICY.keepRecentTokens;
  /** Why the turn under way was stopped, if it was. */
  #stopped: TurnStop | undefined;
  /** Whether this Harness has asked the model anything (`retryPolicy`). */
  readonly #asked: Asked;
  /**
   * The turn a `run` takes now, from its first step: the one question the
   * object takes at a time. A call for the same turn waits on its end.
   */
  #taking: { turnId: string; end: Promise<TurnEnd> } | undefined;
  /**
   * The chat's turn not yet settled, as its record holds it (`TurnDoc`),
   * claimed in memory at once by `run`: the chat takes no other meanwhile.
   */
  #active: string | undefined;
  /** The rebase under way (`rebase`): a note waits for it. */
  #rebasing: Promise<void> | undefined;
  /**
   * The agent's last words before the turn's question, from the context
   * as rebased for it (`#submit`): what its `remember` checks a short
   * answer against (agent-remember.ts), never what the chat may no longer
   * read. None for a turn a restart set up again.
   */
  #answering: string | undefined;
  /** Whether pi runs the agent now (`pi.live.run`). */
  #running = false;
  /**
   * The turn questions may be queued into now (`queueQuestion`): from once its own
   * question is in pi until it is about to settle.
   */
  #open: string | undefined;
  /**
   * The turn a `run` takes, and whether it opens (`#open`) or ends first:
   * what a question queued meanwhile waits on.
   */
  #opening:
    | { turnId: string; opened: PromiseWithResolvers<boolean> }
    | undefined;
  /**
   * Queued questions on their way into pi (`queueQuestion`, `sendNow`): the turn
   * waits for them, and for the runs they start, before it settles.
   */
  readonly #joining = new Set<Promise<unknown>>();
  /** The questions pi holds queued now (`pi.inbox`), oldest first. */
  #inbox: InboxQuestion[] = [];
  /** What this object saw of the turn under way, for its record. */
  #pace: Pace | undefined;
  /** A turn done whose copy failed: recorded once a sync goes through. */
  #unrecorded: SettledTurn | undefined;
  /** When pi last committed anything: what `#watchdog` measures from. */
  #progressAt = Date.now();
  /** The answer streaming in, as `pi.live` has it now. */
  #partial: AssistantMessage | null = null;
  /** What the turn's model request waits on now, as the gateway says. */
  #waiting: ModelWait | null = null;
  /** Where the response streaming in began: the chat's newest entry then. */
  #streamedAfter: EntryId | null | undefined;
  /** The thinking of the response streaming in, as `thinkingClock` times it. */
  readonly #thinking = thinkingClock();
  /** Each response's thinking time, by its entry, until it is copied. */
  readonly #thought = new Map<EntryId, number>();
  /**
   * What the Workspace was told last: the partial, what the model waits
   * on, and whether a turn runs. What the model waits on is unknown as the
   * object opens (`undefined`): a wait an earlier run of the object told
   * is cleared by its first sync.
   */
  readonly #told: {
    partial: AssistantMessage | null;
    waiting?: ModelWait | null;
    running?: boolean;
    queued?: string;
  } = { partial: null };
  /** The Workspace brought up to date (`#sync`), once at a time. */
  #syncing: Promise<void> | undefined;
  /** Whether something changed since the sync under way began. */
  #stale = false;
  /**
   * Whether the last sync failed: the Workspace may still show the chat
   * busy, so the object's alarm wakes it to sync again (`wake`).
   */
  #behind = false;

  constructor(
    host: ChatHost,
    name: string,
    env: Env,
    storage: Storage,
    harness: Harness,
    conversation: Conversation,
    registry: Registry,
    pi: MutableModels,
    asked: Asked
  ) {
    this.#asked = asked;
    this.#host = host;
    this.#name = name;
    this.#env = env;
    this.#storage = storage;
    this.#harness = harness;
    this.#conversation = conversation;
    this.#registry = registry;
    this.#models = pi;
  }

  /**
   * Opens the chat's Harness on its host's storage (`ChatHost`), `name`
   * its host's name for it. Nothing runs yet: the host sets up the turn
   * under way, if any (`setUpStored`), then resumes it (`resume`).
   */
  static async open(
    host: ChatHost,
    name: string,
    env: Env
  ): Promise<ChatHarness> {
    const storage = await host.storage();
    const registry = createRegistry();
    const pi = createModels();
    const asked: Asked = { since: false };
    const harness = await Harness.open(
      storage,
      {
        models: pi,
        registry,
        // Read at each use: tests lower the restart limit as they go, and
        // pi's retry is on only until this Harness asks the model anything.
        settings: () => ({
          // One code run at a time, as each is an isolate of its own.
          toolExecution: "sequential",
          // A question queued into a turn (`queueQuestion`) is answered after a
          // run that failed before it, as after one that answered: the
          // turn waits for it either way, and it is never left queued
          // with nothing to place it (pi keeps it by default).
          afterFailedRun: "continue",
          retry: retryPolicy(asked.since),
          ...restartLimitOf(env),
        }),
        identity: { attribution: null },
        onWake: host.arm,
        // What crashes ended: a turn's run, its request or a step, cut off
        // too often; the turn then ends with why (`#endOf`).
        onReport: (report) => {
          if (report.kind === "task_interrupted") {
            log.warn("chat.task_interrupted", {
              chatSession: name,
              task: report.task.kind,
              reason: report.reason,
              restarts: report.restarts,
            });
          }
        },
      },
      context
    );
    const conversation = await harness.root(context);
    const opened = new ChatHarness(
      host,
      name,
      env,
      storage,
      harness,
      conversation,
      registry,
      pi,
      asked
    );
    // The one watch of pi, an observer, so it sees each commit as pi
    // adopts it, partial answers included, as the object's state must
    // (`#running`). Whatever the Workspace was last told, and whatever a
    // restart kept from being copied, it is brought up to date.
    let advanced = false;
    const { value } = await harness.observeConversation(
      conversation.id,
      {
        advance: (call) => {
          if (call.kind === "value") {
            advanced = true;
            opened.#see(call.value);
          }
        },
        end: (end) => {
          // pi closed or failed: its host opens it again. An observer that
          // threw no longer sees the chat: pi is closed, so it opens again.
          if (end.kind === "listener_error") {
            log.error("chat.observer_failed", {
              chatSession: name,
              ...errorFields(end.error),
            });
            void harness.close(context);
          }
        },
      },
      context
    );
    // Its value as it attached, unless a commit came first.
    if (!advanced) {
      opened.#see(value);
    }
    return opened;
  }

  /**
   * Takes in the chat as pi's view has it now: whether pi runs the agent
   * (`pi.live.run`, whatever started the run and however it ended), the
   * answer streaming in and its thinking. Then brings the Workspace up to
   * date with it, in order.
   */
  #see(value: ConversationView): void {
    this.#progressAt = Date.now();
    const live = liveSchema.safeParse(value.docs["pi.live"] ?? {});
    const partial = live.success
      ? (live.data.generation?.message ?? null)
      : null;
    const running = live.success && live.data.run !== undefined;
    this.#running = running;
    this.#partial = partial;
    this.#inbox = inboxQuestionsOf(value.docs["pi.inbox"]);
    if (partial !== null) {
      this.#streamedAfter ??= value.entries.at(-1)?.id ?? null;
      this.#thinking.see(partial);
    } else if (this.#streamedAfter !== undefined) {
      // The response ended: kept as the newest response since it began, or
      // not at all.
      const after = this.#streamedAfter;
      this.#streamedAfter = undefined;
      const ms = this.#thinking.take();
      const kept = value.entries.findLast(
        ({ id, kind }) =>
          kind === "pi.assistant" && (after === null || id > after)
      );
      if (ms !== undefined && kept !== undefined) {
        this.#thought.set(kept.id, ms);
      }
    }
    // After pi's commit: an observer only records it.
    queueMicrotask(() => {
      this.#syncSoon();
    });
  }

  /**
   * When the object next needs to wake: when the Harness does
   * (`Harness.wake`), and, while the Workspace is behind (`#behind`), soon
   * enough to sync again, so a chat never stays shown busy.
   */
  wake(): Wake {
    const wake = this.#harness.wake();
    if (!this.#behind) {
      return wake;
    }
    const retry = Date.now() + syncRetryMs;
    return { ...wake, at: Math.min(wake.at ?? retry, retry) };
  }

  /**
   * Runs `request`'s turn to its end (`#take`): one turn at a time, a call
   * for another turn refused (`agent.busy`) while one is unsettled, here
   * or as a restart left it, before anything is touched; one for the same
   * turn, as its Workspace makes when a call breaks, waits on the same
   * end. Claimed before anything is awaited.
   */
  async run(request: TurnRequest): Promise<TurnEnd> {
    const taking = this.#taking;
    if (taking !== undefined) {
      if (taking.turnId !== request.turnId) {
        throw agentErrors.create("agent.busy");
      }
      return await taking.end;
    }
    if (this.#active !== undefined && this.#active !== request.turnId) {
      throw agentErrors.create("agent.busy");
    }
    this.#active = request.turnId;
    const opened = Promise.withResolvers<boolean>();
    this.#opening = { turnId: request.turnId, opened };
    const end = this.#take(request);
    this.#taking = { turnId: request.turnId, end };
    try {
      return await end;
    } finally {
      this.#taking = undefined;
      // However it ended: a question queued meanwhile is asked on its own.
      opened.resolve(false);
      this.#opening = undefined;
      this.#close(request.turnId);
      // A turn whose run failed after its question is settled as its runs
      // end, by the sync this asks for.
      this.#syncSoon();
    }
  }

  /**
   * Takes `request`'s turn: its question once (a retry with the same turn
   * finds it and only waits), then waits until its runs end (`#ended`),
   * settles it (`#settle`), and copies everything to the Workspace.
   */
  async #take(request: TurnRequest): Promise<TurnEnd> {
    const submission = await this.#question(request);
    // After the submit: a stop that came before it was kept, and one that
    // comes after it stops the run itself. A stopped turn takes no question
    // queued into it: one sent meanwhile is asked on its own.
    const stopped = await this.#harness.snapshot(StoppedDoc, context);
    if (stopped?.turnId === request.turnId) {
      await this.#conversation.abort(context);
    } else {
      // Its question is in pi: one sent meanwhile is queued into it
      // (`queueQuestion`).
      this.#open = request.turnId;
      this.#opening?.opened.resolve(true);
    }
    let { settled, newest } = await this.#ended(request.turnId, submission);
    // The turn's check of the drafts it wrote, each time it would answer
    // having written since the last (agent-builds.ts): what fails goes back
    // to it, to fix in this turn, until they pass or it answers without
    // writing again, and at most `maxTurnChecks` times: the third that
    // fails ends the turn, its problems left in the chat as they are. A
    // stopped or failed run ends it, as it ends the turn.
    let checked: string | undefined;
    for (let round = 1; round <= maxTurnChecks; round += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one round after another
      const answered = await this.#endOf(settled);
      const check =
        answered.outcome === "answered"
          ? // oxlint-disable-next-line no-await-in-loop -- see above
            await turnCheck(this.#env, request.scope, request.turnId, checked)
          : undefined;
      if (check?.notice === undefined || round === maxTurnChecks) {
        break;
      }
      checked = check.drafts;
      // oxlint-disable-next-line no-await-in-loop -- see above
      await this.#conversation.submit(
        {
          type: "input",
          content: check.notice,
          // Once a round, however often the turn is asked.
          requestId: `${noticeRequestPrefix(request.turnId)}check:${round}`,
          whenBusy: "steer",
          entry: { kind: noticeKind },
        },
        context
      );
      // oxlint-disable-next-line no-await-in-loop -- see above
      ({ settled, newest } = await this.#ended(request.turnId, submission));
    }
    if (await this.#wantsWords(newest)) {
      // Once a turn, by its request ID, however often it is asked.
      await this.#conversation.submit(
        {
          type: "input",
          content: wordsPlease,
          requestId: `${noticeRequestPrefix(request.turnId)}words`,
          whenBusy: "steer",
          entry: { kind: noticeKind },
        },
        context
      );
      ({ settled, newest } = await this.#ended(request.turnId, submission));
    }
    // A question queued as the turn wrapped up (its checks, its words)
    // started a run of its own in it: the turn waits for that too. Then it
    // takes no more, decided with nothing awaited between, so none slips in
    // after.
    while (this.#running || this.#joining.size > 0 || this.#inbox.length > 0) {
      // oxlint-disable-next-line no-await-in-loop -- until nothing joins it
      ({ settled, newest } = await this.#ended(request.turnId, submission));
    }
    this.#close(request.turnId);
    const end = await this.#endOf(settled);
    if (end.stopped === "history_revoked") {
      await this.#rebaseIfNeeded(request);
    }
    // A turn stopped before the model said anything ends in the chat as
    // cancelled all the same: pi keeps no response of it, so the object
    // writes its end (`stoppedKind`), once however often it is asked.
    if (end.outcome === "cancelled" && newest?.kind !== "pi.assistant") {
      const written = await this.#conversation.submit(
        {
          type: "write",
          requestId: `stopped:${request.turnId}`,
          entry: { kind: stoppedKind },
        },
        context
      );
      await written.wait(context);
    }
    const done = await this.#settle(request.turnId, end);
    // Everything copied, and told it ended, before the turn returns. Its
    // answer stands should that fail: the alarm the failed sync arms makes
    // it good.
    try {
      await this.#synced();
    } catch {
      // Logged, and tried again, by the sync itself (`#syncSoon`).
    }
    // Done once its Workspace has its end, as its person sees it: should
    // that copy have failed, once a later sync went through.
    if (done !== undefined) {
      if (this.#behind) {
        this.#unrecorded = done;
      } else {
        this.#record(done);
      }
    }
    return end;
  }

  /**
   * Turn `request`'s question in pi: submitted once (`#submit`), and found
   * by the turn's ID when it is asked again. A turn refused before its
   * question is settled with no end: nothing ran.
   */
  async #question(request: TurnRequest): Promise<Submission> {
    const placed = await this.#conversation.commit(
      async (tx) =>
        await tx.submissionByRequest(this.#conversation.id, request.turnId),
      context
    );
    try {
      const submission =
        placed === undefined
          ? await this.#submit(request)
          : await this.#harness.submission(placed.id, context);
      if (submission === undefined) {
        throw new Error(`Turn ${request.turnId} has no submission`);
      }
      return submission;
    } catch (error) {
      await this.#settle(request.turnId);
      throw error;
    }
  }

  /**
   * Settles turn `turnId`'s record, once: ended, with `end` (none for a
   * turn that never submitted its question), its request kept without
   * what it read, and its capture owed (`CaptureDoc`) for a turn that
   * settled with an outcome its guard didn't stop. Settled by the sync as
   * one nothing waits on (`unwaited`) only while no `run` takes it. The
   * chat then takes its next turn; the sync this asks for tells the
   * Workspace and delivers the capture. A turn that ran and settled here
   * with its end is recorded (`#record`): at once when nothing waits on it,
   * else by its `run` once it returns, with what that needs.
   */
  async #settle(
    turnId: string,
    end?: TurnEnd,
    unwaited = false
  ): Promise<SettledTurn | undefined> {
    // Before the commit, while every entry is the turn's: what its facts
    // read up to, later, in the background (`#record`).
    const newest = end === undefined ? undefined : await this.#newest();
    const upTo = newest?.id;
    const request = await this.#conversation.commit(async (tx) => {
      const turn = await tx.doc(TurnDoc);
      const settling = requestOf(turn);
      if (
        turn.ended ||
        settling?.turnId !== turnId ||
        (unwaited && this.#taking?.turnId === turnId)
      ) {
        return null;
      }
      turn.ended = true;
      turn.request = JSON.stringify({ ...settling, context: { skills: [] } });
      if (end !== undefined && end.stopped === undefined) {
        const owed: TurnCapture = {
          outcome: end.outcome,
          answerId: turn.answerId,
          // A request kept before it said is no one's there and then.
          attended: settling.capture.attended,
        };
        await tx.doc(CaptureDoc, turnId, owed);
        turn.captureOwed = true;
      }
      return settling;
    }, context);
    // A `run` frees its claim however its record stood; the sync only the
    // turn it settled.
    if (this.#active === turnId && (request !== null || !unwaited)) {
      this.#active = undefined;
    }
    this.#syncSoon();
    if (request === null || end === undefined) {
      return undefined;
    }
    const done = { request, end, upTo, pace: this.#paceOf(turnId) };
    // Nothing waits on a turn the sync settles: done now.
    if (unwaited) {
      this.#record(done);
      return undefined;
    }
    return done;
  }

  /**
   * Writes the record of turn `settled`, done now, once, in the background
   * (turn-records.ts): its times from when its question reached the
   * Workspace (`sentAt`), as this object saw them (`Pace`), none for one a
   * restart cut short; what its requests used, as the gateway charged
   * them; and what its entries say (`#factsOf`). A turn an earlier release
   * claimed, which says nothing of when it was sent, keeps none.
   */
  #record({ request, end, upTo, pace: seen }: SettledTurn): void {
    const { turnId, sentAt } = request;
    if (typeof sentAt !== "number") {
      return;
    }
    const doneAt = Date.now();
    this.#host.waitUntil(
      (async () => {
        const facts = await this.#factsOf(turnId, upTo);
        await recordTurn(
          this.#env,
          recordOf(
            { request, end, pace: seen ?? paceOf(turnId, true) },
            sentAt,
            doneAt,
            facts
          )
        );
      })()
    );
  }

  /**
   * What turn `turnId`'s entries, from its question on, say of it: each
   * tool's calls and their time, the requests pi sent again after a
   * restart cut them off (`cutAttempt`), the last response's stop reason,
   * and whether pi compacted the chat meanwhile. None for a turn whose
   * question isn't in the transcript.
   */
  async #factsOf(
    turnId: string,
    upTo: EntryId | undefined
  ): Promise<TurnFacts | undefined> {
    try {
      return await this.#factsRead(turnId, upTo);
    } catch (error) {
      // A record may go without them; the turn still settles.
      log.warn("chat.turn_facts_unread", {
        chatSession: this.#name,
        turnId,
        ...errorFields(error),
      });
      return undefined;
    }
  }

  /** `#factsOf`, read: throws as pi's reads do. */
  async #factsRead(
    turnId: string,
    upTo: EntryId | undefined
  ): Promise<TurnFacts | undefined> {
    const placed = await this.#conversation.commit(
      async (tx) => await tx.submissionByRequest(this.#conversation.id, turnId),
      context
    );
    const question = placed?.type === "input" ? placed.entry : undefined;
    if (question === undefined) {
      return undefined;
    }
    const entries: EntryRecord[] = [];
    let cursor: Cursor | undefined;
    do {
      // oxlint-disable-next-line no-await-in-loop -- page after page
      const page = await this.#conversation.entries(
        {
          order: "ascending",
          minEntryId: question,
          ...(upTo === undefined ? {} : { maxEntryId: upTo }),
        },
        100,
        cursor,
        context
      );
      entries.push(...page.items);
      cursor = page.next;
    } while (cursor !== undefined);
    const tools = new Map<string, { calls: number; ms: number }>();
    const facts: TurnFacts = {
      tools: {},
      retries: 0,
      stopReason: null,
      compacted: false,
      queued: 0,
    };
    // A rebase after the turn (`history_revoked`) starts a context of its
    // own: nothing from it on is the turn's.
    const reset = entries.findIndex((entry) => ResetEntry.is(entry));
    const own = reset === -1 ? entries : entries.slice(0, reset);
    for (const [index, entry] of own.entries()) {
      const [message] = entry.model ?? [];
      if (ToolResultEntry.is(entry) && message?.role === "toolResult") {
        const tool = tools.get(message.toolName) ?? { calls: 0, ms: 0 };
        tool.calls += 1;
        tool.ms += message.durationMs ?? 0;
        tools.set(message.toolName, tool);
      } else if (CompactionEntry.is(entry)) {
        facts.compacted = true;
      } else if (entry.kind === stoppedKind) {
        // Stopped before the model said anything: the chat shows it as a
        // response stopped (`cancelledMessage`).
        facts.stopReason = "aborted";
      } else if (AssistantEntry.is(entry) && message?.role === "assistant") {
        if (cutAttempt(entry, own.slice(index + 1), false) === true) {
          facts.retries += 1;
        }
        facts.stopReason = message.stopReason;
      }
    }
    facts.queued = own.filter(
      ({ kind, data }) =>
        kind === questionKind && questionDataOf(data).queued === true
    ).length;
    return { ...facts, tools: Object.fromEntries(tools) };
  }

  /**
   * Waits until pi's runs of turn `turnId` end: its question's, and those
   * that answer the notices that came meanwhile. How the turn ended is how
   * the last of its inputs settled, as pi keeps it; and the chat's newest
   * entry by then.
   */
  async #ended(
    turnId: string,
    asked: Submission
  ): Promise<{ settled: SettledSubmissionRecord; newest?: EntryRecord }> {
    await asked.wait(context);
    await this.#conversation.waitForIdle(context);
    let newest = await this.#newest();
    // And until the questions queued into it are in pi (`#joining`), and
    // placed (`#placeHeld`).
    while (this.#running || this.#joining.size > 0 || this.#inbox.length > 0) {
      // oxlint-disable-next-line no-await-in-loop -- until pi is idle
      await Promise.allSettled(this.#joining);
      // oxlint-disable-next-line no-await-in-loop -- until pi is idle
      await this.#placeHeld(turnId);
      // oxlint-disable-next-line no-await-in-loop -- until pi is idle
      await this.#conversation.waitForIdle(context);
      // oxlint-disable-next-line no-await-in-loop -- until pi is idle
      newest = await this.#newest();
    }
    const last = await this.#lastInputOf(turnId);
    const settled = await (last ?? asked).wait(context);
    return newest === undefined ? { settled } : { settled, newest };
  }

  /**
   * Whether the turn ended with `newest`, a response of no words, after it
   * showed its thinking in the brain: it is asked once for its answer
   * (`wordsPlease`), as a turn ends with what the person reads.
   */
  async #wantsWords(newest: EntryRecord | undefined): Promise<boolean> {
    const [last] = newest?.model ?? [];
    if (
      newest?.kind !== "pi.assistant" ||
      last?.role !== "assistant" ||
      last.stopReason !== "stop" ||
      textOf(last).trim() !== ""
    ) {
      return false;
    }
    let cursor: Cursor | undefined;
    do {
      // oxlint-disable-next-line no-await-in-loop -- newest first, back to the question
      const page = await this.#conversation.entries(
        { order: "descending" },
        50,
        cursor,
        context
      );
      for (const entry of page.items) {
        if (entry.kind === questionKind) {
          return false;
        }
        const [message] = entry.model ?? [];
        if (
          message?.role === "toolResult" &&
          message.toolName === showThinkingName &&
          !message.isError
        ) {
          return true;
        }
      }
      cursor = page.next;
    } while (cursor !== undefined);
    return false;
  }

  /**
   * The last input of turn `turnId` pi keeps: its question, a notice it
   * took after (`noticeRequestPrefix`), or a question queued into it
   * (`queuedRequestPrefix`), found by their request IDs.
   */
  async #lastInputOf(turnId: string): Promise<Submission | undefined> {
    let cursor: Cursor | undefined;
    let last: SubmissionRecord | undefined;
    do {
      // oxlint-disable-next-line no-await-in-loop -- page after page, newest first
      const page = await this.#storage.scanSubmissions(
        { conversationId: this.#conversation.id, order: "descending" },
        20,
        cursor,
        context
      );
      last = page.items.find(
        ({ type, requestId }) =>
          type === "input" &&
          (requestId === turnId ||
            requestId?.startsWith(noticeRequestPrefix(turnId)) === true ||
            requestId?.startsWith(queuedRequestPrefix(turnId)) === true)
      );
      cursor = page.next;
    } while (last === undefined && cursor !== undefined);
    return last === undefined
      ? undefined
      : await this.#harness.submission(last.id, context);
  }

  /**
   * Submits `request`'s question, refused while pi runs: the turn kept
   * (`TurnDoc`), its guard asked once, then its model admitted and the
   * brain recalled at once, as neither reads the other: the recall is most
   * of what the first request waits for, and it waits no longer for the
   * admission. The Workspace admitted the same model by the same rules
   * just before (workspace.ts `#turn`). A context that must be rebased is,
   * once the model is admitted (its room) and before the recall reads it.
   */
  async #submit(request: TurnRequest): Promise<Submission> {
    if (this.#running) {
      throw agentErrors.create("agent.busy");
    }
    this.#stopped = undefined;
    await this.#conversation.commit(async (tx) => {
      // The turn's record, before anything else of it: a fresh one.
      const turn = await tx.doc(TurnDoc);
      turn.request = JSON.stringify(request);
      turn.ended = false;
      turn.answerId = null;
      turn.captureOwed = false;
      turn.startedAt = Date.now();
    }, context);
    this.#pace = paceOf(request.turnId, false);
    this.#answering = undefined;
    // One guard for the turn's setup and its rebase: every request asks
    // it again (`withheld`).
    const { withheld } = await this.#setUpGuard(request.scope);
    const runs = new Set(withheld);
    const rebasing = await needsRebase(this.#conversation, runs, context);
    const turn = this.#codeTurn(request);
    let { messages } = await this.#conversation.context(context);
    const settingUp = this.#setUp(request, turn, messages);
    if (rebasing) {
      // Into the room of the turn's model, as it is admitted.
      await settingUp;
      await this.#rebase(runs);
      // The context as rebased, as the turn's model is given it.
      ({ messages } = await this.#conversation.context(context));
    }
    this.#answering = lastWordsOf(messages);
    // At least once: should the object reset before the submit below, the
    // turn asked again sets up and recalls again, a second recall run
    // audited as the first was. Who reads the answer decides what it may
    // hand over (turn-recall.ts). A refusal of the setup's is said first.
    const [, recall] = await allInOrder([
      settingUp,
      this.#recall(turn, request, messages),
    ]);
    try {
      return await this.#conversation.submit(
        {
          ...questionInput(request.question, recall),
          requestId: request.turnId,
          whenBusy: "reject",
        },
        context
      );
    } catch (error) {
      if (error instanceof ConversationBusy) {
        throw agentErrors.create("agent.busy");
      }
      throw error;
    }
  }

  /**
   * The recall before `question` (turn-recall.ts), its analysis reading
   * `history`, the context as the model reads it, once rebased: nothing
   * withheld.
   */
  async #recall(
    turn: CodeTurn,
    { question: { text }, shared, audience, personal }: TurnRequest,
    history: readonly Message[]
  ) {
    return await recallForTurn(
      {
        env: this.#env,
        turn,
        conversation: shared
          ? { outsiders: audience?.outsiders ?? null }
          : "own",
        personal,
        history,
        provenance: this.#sources,
      },
      text
    );
  }

  /**
   * Rebases the chat's context (`rebase`) when it holds a result the chat
   * may no longer read, or a rebase was cut short: only while idle.
   */
  async #rebaseIfNeeded(request: TurnRequest): Promise<void> {
    const { withheld } = await this.#guard(request.scope);
    const runs = new Set(withheld);
    if (await needsRebase(this.#conversation, runs, context)) {
      await this.#rebase(runs);
    }
  }

  /**
   * Rebases the chat's context without `runs`' results: a note that comes
   * meanwhile waits for it (`note`).
   */
  async #rebase(runs: ReadonlySet<string>): Promise<void> {
    this.#rebasing = rebase(this.#conversation, runs, this.#room, context);
    try {
      await this.#rebasing;
    } finally {
      this.#rebasing = undefined;
    }
  }

  /**
   * Sets the turn a restart cut short up again, as its request was: its
   * request admitted again first, so nothing runs for a person who left.
   * The object does this as it opens the Harness, before it serves any
   * call, and resumes after, so it only admits and aborts here: a turn
   * whose context holds what the chat may no longer read, or one that
   * can't be set up, is aborted, and ends with why (`#endOf`); the next
   * question rebases (`#submit`), the guard holding every request
   * meanwhile. A rebase can take longer than an object may block. A turn
   * restarts cut off too often pi ends itself (`#endOf`).
   * With `lost`, the host gave the turn up while pi couldn't open, and its
   * Workspace showed it failed: it is stopped and settled here, so the
   * next question is taken.
   */
  async setUpStored(lost = false): Promise<void> {
    const turn = await this.#harness.snapshot(TurnDoc, context);
    const request = turn === undefined ? undefined : requestOf(turn);
    if (lost && turn?.ended === false && request !== undefined) {
      this.#stopped = "lost";
      if (this.#running) {
        await this.#conversation.abort(context);
      }
      this.#active = request.turnId;
      await this.#settle(request.turnId, {
        outcome: "failed",
        answer: "",
        stopped: "lost",
      });
      return;
    }
    // The turn its record holds unsettled: the chat takes no other first.
    if (turn?.ended === false) {
      this.#active = request?.turnId;
    }
    // Set up while pi runs it, or holds questions queued into it that a
    // restart kept from being placed (`#placeHeld`).
    const held = this.#inbox.length > 0 && turn?.ended === false;
    if (!(this.#running || held) || request === undefined) {
      return;
    }
    this.#pace = paceOf(request.turnId, true);
    try {
      const { withheld } = await this.#setUpGuard(request.scope);
      const { messages } = await this.#conversation.context(context);
      await this.#setUp(request, this.#codeTurn(request), messages);
      if (await needsRebase(this.#conversation, new Set(withheld), context)) {
        this.#stopped = "history_revoked";
        await this.#halt();
      }
    } catch (error) {
      this.#stopped =
        isExpectedError(error) && error.code === "permission.person_inactive"
          ? "person_inactive"
          : "unreadable";
      await this.#halt();
    }
  }

  /** The chat's turn not yet settled, if there is one: what a stop ends. */
  activeTurn(): string | undefined {
    return this.#active;
  }

  /**
   * Queues `question`, sent while turn `turnId` runs, into that turn, in
   * pi's own queue (`pi.inbox`, a steer): pi places it as a question once
   * the run's current step ends, and the run goes on to answer it; sent as
   * the run answers, it starts the turn's next run. In the order sent; the
   * turn's model and setup answer it, without a recall of its own (the
   * agent searches the brain itself). Once, by its ID, however often it is
   * sent. Waits while the turn is still on its way to pi. False when the
   * turn takes no more (it ended, or settles now): its Workspace asks it as
   * a turn of its own.
   */
  async queueQuestion(
    turnId: string,
    question: QueuedQuestion
  ): Promise<boolean> {
    const requestId = `${queuedRequestPrefix(turnId)}${question.id}`;
    // Sent again, as a call that broke on its way back is: taken once.
    const known = await this.#conversation.commit(
      async (tx) =>
        await tx.submissionByRequest(this.#conversation.id, requestId),
      context
    );
    if (known !== undefined) {
      return true;
    }
    const opening = this.#opening;
    if (opening?.turnId === turnId) {
      await opening.opened.promise;
    }
    if (this.#open !== turnId) {
      return false;
    }
    const input = questionInput(question);
    const queued = this.#conversation.submit(
      {
        ...input,
        // Shown as a question like any other; its answer's capture owes
        // the one before it (`#copy`).
        entry: { ...input.entry, data: { ...input.entry.data, queued: true } },
        requestId,
        whenBusy: "steer",
        // Kept through Send now's stop, which then places it (`sendNow`);
        // every other stop withdraws it (`#halt`).
        onAbort: "keep",
      },
      context
    );
    this.#join(queued);
    await queued;
    return true;
  }

  /**
   * Has turn `turnId` take the questions queued into it now, rather than
   * once its current step ends, as Claude Code's Send now does: the run
   * stops as a stop stops it (the answer being written kept as it is),
   * pi keeps the queued questions through it (`onAbort: "keep"`), and a
   * continue places them, in order, and answers them in the same turn. A
   * restart between the two leaves them held, and the turn places them as
   * it goes on (`#placeHeld`).
   */
  async sendNow(turnId: string): Promise<void> {
    if (this.#open !== turnId || this.#inbox.length === 0) {
      return;
    }
    const sending = (async () => {
      await this.#conversation.abort(context);
      await this.#placeHeld(turnId);
    })();
    this.#join(sending);
    await sending;
  }

  /**
   * Places the questions pi holds queued while nothing runs, with a
   * continue: those Send now kept through its stop. A turn its person
   * stopped, or its guard did, drops them instead (`#withdraw`), should a
   * restart have cut that stop off before it did.
   */
  async #placeHeld(turnId: string): Promise<void> {
    if (this.#running || this.#inbox.length === 0) {
      return;
    }
    const stopped = await this.#harness.snapshot(StoppedDoc, context);
    if (stopped?.turnId === turnId || this.#stopped !== undefined) {
      await this.#withdraw();
      return;
    }
    try {
      await this.#conversation.submit({ type: "continue" }, context);
    } catch (error) {
      // A run started meanwhile, and places them itself.
      if (!(error instanceof ConversationBusy)) {
        throw error;
      }
    }
  }

  /**
   * Stops the chat's run, and drops the questions queued into it: pi keeps
   * them through a stop (`onAbort: "keep"`), for Send now alone.
   */
  async #halt(): Promise<void> {
    await this.#conversation.abort(context);
    await this.#withdraw();
  }

  /** Withdraws every question pi holds queued: settled unanswered, never asked. */
  async #withdraw(): Promise<void> {
    for (const { id } of this.#inbox) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      const queued = await this.#harness.submission(id, context);
      // oxlint-disable-next-line no-await-in-loop -- see above
      await queued?.abort(context);
    }
  }

  /** Makes `work` one the turn waits for before it settles (`#joining`). */
  #join(work: Promise<unknown>): void {
    this.#joining.add(work);
    void (async () => {
      try {
        await work;
      } catch {
        // Its caller hears how it failed.
      } finally {
        this.#joining.delete(work);
      }
    })();
  }

  /** Turn `turnId` takes no more questions queued into it (`queueQuestion`). */
  #close(turnId: string): void {
    if (this.#open === turnId) {
      this.#open = undefined;
    }
  }

  /**
   * Goes on with what pi left pending, and with what sleeps till now; and
   * stops the turn under way if it is overdue (`#watchdog`), which the
   * alarm's heartbeat checks while a turn runs.
   */
  resume(): void {
    this.#harness.resume();
    // What a restart kept from being placed, for a turn nothing waits on.
    const active = this.#active;
    if (active !== undefined && this.#taking === undefined) {
      this.#host.waitUntil(
        (async () => {
          try {
            await this.#placeHeld(active);
          } catch {
            // pi closed: placed as it opens again.
          }
        })()
      );
    }
    // An alarm armed for a sync that failed (`wake`) tries it again.
    if (this.#behind) {
      this.#syncSoon();
    }
    this.#host.waitUntil(this.#watchdog());
  }

  /**
   * Stops the turn under way once pi has committed nothing for
   * `turnIdleMs`, or it has run `turnMostMs`: it ends as overdue, as a
   * turn its guard stopped ends, rather than keeping its chat busy without
   * end. A turn waiting on a person isn't running: its holds end the turn.
   */
  async #watchdog(): Promise<void> {
    try {
      const turn = await this.#harness.snapshot(TurnDoc, context);
      // Only while pi runs it: a turn that answered and waits only for its
      // copy to reach the Workspace is never stopped.
      if (
        turn === undefined ||
        turn.ended ||
        !this.#running ||
        requestOf(turn)?.turnId !== this.#active ||
        (Date.now() - this.#progressAt < turnIdleOf(this.#env) &&
          // A turn an earlier release claimed says nothing of its start:
          // only the idle limit holds for it.
          (typeof turn.startedAt !== "number" ||
            Date.now() - turn.startedAt < turnMostMs))
      ) {
        return;
      }
      log.warn("chat.turn_overdue", {
        chatSession: this.#name,
        turnId: requestOf(turn)?.turnId,
        ms:
          typeof turn.startedAt === "number"
            ? Date.now() - turn.startedAt
            : undefined,
        idleMs: Date.now() - this.#progressAt,
      });
      this.#stop("overdue");
    } catch {
      // pi closed: the turn is checked again as it opens.
    }
  }

  /**
   * Tells the chat's agent `text`, never shown as the person's and starting
   * no turn: pi's write, which the turn under way reads before its next
   * request, and otherwise the next turn does. After a rebase under way,
   * which would otherwise leave it out or put it before older history.
   */
  async note(text: string): Promise<void> {
    while (this.#rebasing !== undefined) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- until no rebase runs
        await this.#rebasing;
      } catch {
        // A rebase that failed is done again before the next turn.
      }
    }
    await this.#conversation.submit(
      {
        type: "write",
        entry: {
          kind: noteKind,
          model: [{ role: "user", content: text, timestamp: Date.now() }],
        },
      },
      context
    );
  }

  /**
   * Stops the turn under way, if any: its request or tool call in flight
   * ends. With `turnId`, only that turn: kept, so it is stopped too if it
   * hasn't submitted its question yet, as it does; and pi's run stopped
   * only while that turn is the chat's, so a stop that comes late, or is
   * sent again, never stops the question after it.
   */
  async abort(turnId?: string): Promise<void> {
    if (turnId === undefined) {
      await this.#halt();
      return;
    }
    await this.#conversation.commit(async (tx) => {
      const stopped = await tx.doc(StoppedDoc);
      stopped.turnId = turnId;
    }, context);
    // After the commit: the turn the chat holds now. It takes no more
    // questions, and those on their way are in pi before the stop drops
    // them with what it holds queued.
    if (this.#active === turnId) {
      this.#close(turnId);
      await Promise.allSettled(this.#joining);
      await this.#halt();
    }
  }

  async close(): Promise<void> {
    await this.#harness.close(context);
  }

  /**
   * Settles once pi has closed, its storage included: after `close`, or
   * after its first failed storage call, which fails it for good. pi
   * retries nothing: the host opens it again.
   */
  get closed(): Promise<SessionEnd> {
    return this.#harness.closed;
  }

  /**
   * Calls `listener` at once as pi begins to close, by `close` or by a
   * failed storage call: no call should reach it from then on.
   */
  onClose(listener: () => void): void {
    this.#harness.subscribeClose(listener);
  }

  /** The chat's newest entry, read on pi's line. */
  async #newest(): Promise<EntryRecord | undefined> {
    const page = await this.#conversation.entries(
      { order: "descending" },
      1,
      undefined,
      context
    );
    return page.items[0];
  }

  /** The chat's Workspace. */
  #workspace(scope: TurnRequest["scope"]) {
    return workspace(this.#env, scope.workspaceId);
  }

  /**
   * What the chat's turn may send now, as its Workspace says
   * (`turnGuard`): asked again if the call breaks on its way, as it only
   * reads.
   */
  async #guard(scope: TurnRequest["scope"]) {
    return await callObject(
      async () => await this.#workspace(scope).turnGuard(scope.chatId)
    );
  }

  /** Stops the turn under way for `reason`. */
  #stop(reason: TurnStop): void {
    this.#stopped ??= reason;
    this.#open = undefined;
    // As a person's stop: the questions on their way are in pi first, so
    // the stop drops them with what it holds queued.
    this.#host.waitUntil(
      (async () => {
        await Promise.allSettled(this.#joining);
        await this.#halt();
      })()
    );
  }

  /**
   * The turn guard as a turn is set up: refused once its person is no
   * longer a member; what the chat has read from kept, which every
   * request carries, as of it.
   */
  async #setUpGuard(scope: TurnRequest["scope"]) {
    const guard = await this.#guard(scope);
    if (guard.stop !== undefined) {
      throw permissionErrors.create("permission.person_inactive");
    }
    this.#sources = guard.sources;
    return guard;
  }

  /** What the turn's code runs and dedicated tools run with. */
  #codeTurn(request: TurnRequest): CodeTurn {
    const env = this.#env;
    const { scope } = request;
    // A stub a call, never one kept for the turn: a stub to a Workspace
    // that restarted mid-turn stays broken, its calls failing or never
    // answering, where a new one reaches the Workspace as it is now.
    const host = () => this.#workspace(scope);
    /** The lines the turn's runs sent the Workspace, one after another. */
    let logged: Promise<void> = Promise.resolve();
    return {
      apis: apisFor(request.shared, request.context.builds === true),
      scope,
      runs: {
        open: async (opening) =>
          await host().openCodeRun(scope.chatId, request.turnId, opening),
        // A run's lines reach the Workspace in order, all before its end:
        // what the Workspace notices of them is ordered with the run.
        close: async (runId, status) => {
          try {
            await logged;
          } catch {
            // A line that failed to arrive is lost with its call.
          }
          return await host().endTurnRun(scope.chatId, runId, status);
        },
        output: (runId, callId, line) => {
          const before = logged;
          logged = (async () => {
            try {
              await before;
            } catch {
              // Each line on its own.
            }
            await host().codeRunOutput(scope.chatId, runId, callId, line);
          })();
          this.#host.waitUntil(logged);
        },
      },
      loader: quietLoader(env.LOADER),
      sandbox: () => sessionHost(env),
      codeTimeoutMs: codeTimeoutMs(env),
    };
  }

  /**
   * Admits the turn's model through the gateway, refused before anything
   * runs, and installs the chat's extension with what the turn runs with:
   * `turn`, and `history`, the transcript as the turn starts. After the
   * turn's guard (`#setUpGuard`).
   */
  async #setUp(
    request: TurnRequest,
    turn: CodeTurn,
    history: readonly Message[]
  ): Promise<void> {
    const env = this.#env;
    const { scope } = request;
    const host = () => this.#workspace(scope);
    const authority = chatAuthority(scope);
    // Every request carries everything the chat has read from, as of its
    // guard: the rules judge it by all of it.
    const admitted = await models(env).agent(
      {
        model: request.question.model,
        effort: request.question.effort,
        purpose: chatTurnPurpose,
        trigger: delegateActorOf(authority, scope.via),
        provenance: this.#sources,
        work: { authority, context: chatContext(scope) },
      },
      () => this.#sources,
      // Shown in the chat as it goes (`#sync`): a rate limit waited out,
      // another model answering instead. Counted in the turn's record.
      (waiting) => {
        this.#paceWait(request.turnId, waiting);
        if (waiting !== this.#waiting) {
          this.#waiting = waiting;
          this.#syncSoon();
        }
      }
    );
    // Each request, a summary's too: one that fails turns pi's retry off
    // (`retryPolicy`), seen before pi classifies it, as the first to wait
    // on its result. Each counted in the turn's record: the first's time
    // and its first token's, and what each used as the gateway charged it.
    const asking: AgentModel["stream"] = (model, sent, options) => {
      const pace = this.#paceOf(request.turnId);
      const events = admitted.stream(model, sent, options);
      void (async () => {
        const answer = await events.result();
        if (answer.stopReason === "error") {
          this.#asked.since = true;
        }
      })();
      if (pace === undefined) {
        return events;
      }
      pace.firstRequestAt ??= Date.now();
      return tapped(
        events,
        () => {
          pace.firstTokenAt ??= Date.now();
        },
        ({ usage }) => {
          pace.inputTokens += inputTokens(usage);
          pace.outputTokens += usage.output;
          pace.cacheReadTokens += usage.cacheRead;
          pace.cacheWriteTokens += usage.cacheWrite;
          pace.cost += usage.cost.total;
        }
      );
    };
    this.#models.setProvider(
      createProvider({
        id: gateway,
        auth: {
          apiKey: {
            name: "Grasp's model gateway",
            resolve: async () => await Promise.resolve({ auth: {} }),
          },
        },
        models: [{ ...admitted.model, provider: gateway }],
        api: { stream: asking, streamSimple: asking },
      })
    );
    const extension = chatAgent({
      // A turn's request starts: from now, pi retries nothing (`retryPolicy`).
      asking: () => {
        this.#asked.since = true;
      },
      ...turn,
      context:
        request.question.make === undefined
          ? request.context
          : { ...request.context, make: request.question.make },
      assets: env.ASSETS,
      history,
      // Only where the answer reaches the person alone, in a turn they
      // started (`personal`, workspace.ts `answersAlone`): their own chat
      // in Grasp's app, or their direct message on a chat app (GRA-1920),
      // each of which shows a notice of every memory with its Undo
      // (agent-remember.ts; channels/remembered.ts). What they said there
      // is the only word of theirs it may keep. Never a chat others share,
      // nor a turn nobody started (a wake), which has no word of theirs,
      // nor a next agent's turn of a question addressed to several
      // (`followUp`), which starts from core's words, never theirs.
      ...(request.personal && request.question.followUp !== true
        ? {
            remember: rememberTool(
              env,
              scope,
              async () => await this.#saidIn(request),
              () => this.#answering
            ),
          }
        : {}),
      // Only in a person's own chat.
      ...(request.shared
        ? {}
        : {
            thinking: showThinking(
              async () => await brainOf(env, scope.personId)
            ),
          }),
      // The pictures its questions carry, shown to a model that takes
      // pictures; to any other, their questions' words alone.
      ...(admitted.model.input.includes("image")
        ? {
            picture: async (fileId: string, maxBytes: number) =>
              await callObject(
                async () =>
                  await host().chatPicture(scope.chatId, fileId, maxBytes)
              ),
          }
        : {}),
      withheld: async () => {
        const checked = await this.#guard(scope);
        this.#sources = checked.sources;
        if (checked.stop !== undefined) {
          this.#stop(checked.stop);
        }
        return new Set(checked.withheld);
      },
      stop: (reason) => {
        this.#stop(stopOf(reason));
      },
    });
    this.#registry.install(extension);
    await this.#conversation.configure(
      {
        model: { provider: gateway, modelId: admitted.model.id },
        extensions: [extension],
      },
      context
    );
    // What a rebased context may hold before pi compacts it: the model's
    // window less pi's reserve for the answer.
    this.#room = Math.max(
      admitted.model.contextWindow - DEFAULT_COMPACTION_POLICY.reserveTokens,
      DEFAULT_COMPACTION_POLICY.keepRecentTokens
    );
  }

  /**
   * What the person said in turn `request`, for `remember` to check a
   * memory against: its question's words, then those of each question
   * queued into it (`queueQuestion`) that pi placed so far. The agent's
   * last words before the newest of those become what it answers
   * (`#answering`), as they were before the question for the turn's own.
   */
  async #saidIn(request: TurnRequest): Promise<string> {
    const placed = await this.#conversation.commit(
      async (tx) =>
        await tx.submissionByRequest(this.#conversation.id, request.turnId),
      context
    );
    const from = placed?.type === "input" ? placed.entry : undefined;
    const said = [request.question.text];
    if (from === undefined) {
      return request.question.text;
    }
    const seen: Message[] = [];
    let cursor: Cursor | undefined;
    do {
      // oxlint-disable-next-line no-await-in-loop -- page after page
      const page = await this.#conversation.entries(
        { order: "ascending", minEntryId: from },
        100,
        cursor,
        context
      );
      for (const { kind, data, model } of page.items) {
        const [message] = model ?? [];
        if (
          kind === questionKind &&
          message?.role === "user" &&
          questionDataOf(data).queued === true
        ) {
          said.push(questionText(message));
          this.#answering = lastWordsOf(seen);
        }
        if (message !== undefined) {
          seen.push(message);
        }
      }
      cursor = page.next;
    } while (cursor !== undefined);
    return said.join("\n\n");
  }

  /** What this object saw of turn `turnId`, if it is the one under way. */
  #paceOf(turnId: string): Pace | undefined {
    return this.#pace?.turnId === turnId ? this.#pace : undefined;
  }

  /** Counts what the gateway said turn `turnId`'s request waits on now. */
  #paceWait(turnId: string, waiting: ModelWait | null): void {
    const pace = this.#paceOf(turnId);
    if (pace === undefined) {
      return;
    }
    const now = Date.now();
    if (pace.waitingSince !== undefined) {
      pace.rateLimitWaitMs += now - pace.waitingSince;
      pace.waitingSince = undefined;
    }
    if (waiting?.kind === "rate_limited") {
      pace.rateLimitWaits += 1;
      pace.waitingSince = now;
    } else if (waiting?.kind === "fallback") {
      pace.fallbacks += 1;
    }
  }

  /** How the turn whose input settled as `settled` ended. */
  async #endOf(settled: SettledSubmissionRecord): Promise<TurnEnd> {
    const stopped = this.#stopped;
    if (stopped !== undefined) {
      return { outcome: "failed", answer: "", stopped };
    }
    if (settled.type !== "input") {
      return { outcome: "failed", answer: "" };
    }
    if (settled.status === "done") {
      const page = await this.#conversation.entries(
        { minEntryId: settled.answer, maxEntryId: settled.answer },
        1,
        undefined,
        context
      );
      const [message] = page.items[0]?.model ?? [];
      return {
        outcome: "answered",
        answer: message?.role === "assistant" ? textOf(message) : "",
      };
    }
    if (settled.reason === "aborted") {
      return { outcome: "cancelled", answer: "" };
    }
    // Restarts cut its request or a step off more often than pi tries
    // again (`retryPolicy`, `restartLimit`).
    if (
      settled.reason === "interrupted" ||
      settled.reason === "restart_limit"
    ) {
      return { outcome: "failed", answer: "", error: cutOffTooOften };
    }
    return {
      outcome: "failed",
      answer: "",
      error:
        typeof settled.detail === "string" ? settled.detail : settled.reason,
    };
  }

  /**
   * Brings the chat's Workspace up to date soon (`#sync`): once at a time,
   * and again once more if anything changed meanwhile. One that failed is
   * made good by the next change, or the object's next open.
   */
  #syncSoon(): void {
    this.#stale = true;
    if (this.#syncing !== undefined) {
      return;
    }
    const syncing = (async () => {
      try {
        while (this.#stale) {
          this.#stale = false;
          // oxlint-disable-next-line no-await-in-loop -- one sync at a time
          await this.#sync();
        }
      } finally {
        this.#syncing = undefined;
      }
    })();
    this.#syncing = syncing;
    this.#host.waitUntil(
      (async () => {
        try {
          await syncing;
          this.#behind = false;
          const unrecorded = this.#unrecorded;
          this.#unrecorded = undefined;
          if (unrecorded !== undefined) {
            this.#record(unrecorded);
          }
        } catch (error) {
          log.warn("chat.sync_failed", {
            chatSession: this.#name,
            turnId: this.#active,
            ...errorFields(error),
          });
          // Woken soon to sync again, even with nothing else to do.
          this.#behind = true;
          try {
            this.#host.arm(this.wake());
          } catch {
            // pi failed: its host opens it again, which syncs as it opens.
          }
        }
      })()
    );
  }

  /** Brings the chat's Workspace up to date with everything up to now. */
  async #synced(): Promise<void> {
    this.#syncSoon();
    await this.#syncing;
  }

  /**
   * Brings the chat's Workspace up to date from the turn's record, in this
   * order: what was committed since the last copy (`#copy`), the answer
   * streaming in, what its model waits on, whether a turn runs, and, once
   * the turn is settled, its capture for the Brain. A turn whose runs
   * ended with no `run` waiting on it (a restart left it) is settled here.
   * Each the latest, never an older one after it; each told again until
   * it is through.
   */
  async #sync(): Promise<void> {
    const before = await this.#harness.snapshot(TurnDoc, context);
    const request = before === undefined ? undefined : requestOf(before);
    if (before === undefined || request === undefined) {
      return;
    }
    const { scope, turnId } = request;
    // What holds of the turn is decided before the copy: a turn settled
    // already, or one nothing waits on whose runs are over, has every
    // entry committed, so the copy below holds its answer before the
    // Workspace is told it ended or gets its capture. One that settles
    // during this sync is told by the next, which its settling asks for.
    const left =
      !before.ended &&
      !this.#running &&
      this.#joining.size === 0 &&
      this.#inbox.length === 0 &&
      this.#taking?.turnId !== turnId;
    const owed = await this.#owed();
    if (await this.#copy(scope)) {
      this.#sawText(turnId);
    }
    await this.#showPartial(scope, turnId);
    // After the copy: a question pi just placed shows as asked before it
    // leaves the queue.
    const queued = this.#inbox.map(queuedOf);
    const queuedNow = JSON.stringify(queued);
    if (queuedNow !== this.#told.queued) {
      await callObject(async () => {
        await this.#workspace(scope).turnQueued(scope.chatId, queued);
      });
      this.#told.queued = queuedNow;
    }
    const waiting = this.#waiting;
    if (waiting !== this.#told.waiting) {
      await callObject(async () => {
        await this.#workspace(scope).turnWaiting(scope.chatId, waiting);
      });
      this.#told.waiting = waiting;
    }
    if (left) {
      const settled = await this.#endOfTurn(turnId);
      if (settled !== undefined) {
        await this.#settle(turnId, settled.end, true);
        return;
      }
    }
    const turn = (await this.#harness.snapshot(TurnDoc, context)) ?? before;
    const running = !(
      before.ended &&
      turn.ended &&
      requestOf(turn)?.turnId === turnId
    );
    if (running !== this.#told.running) {
      await callObject(async () => {
        await this.#workspace(scope).turnRunning(scope.chatId, running);
      });
      this.#told.running = running;
    }
    for (const key of owed) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      await this.#deliver(scope, key);
    }
  }

  /**
   * Shows the chat's Workspace the answer streaming in now, if it changed
   * since it was told: turn `turnId`'s.
   */
  async #showPartial(
    scope: TurnRequest["scope"],
    turnId: string
  ): Promise<void> {
    const partial = this.#partial;
    if (partial === this.#told.partial) {
      return;
    }
    await callObject(async () => {
      await this.#workspace(scope).showPartial(scope.chatId, partial);
    });
    this.#told.partial = partial;
    if (partial !== null && textOf(partial) !== "") {
      this.#sawText(turnId);
    }
  }

  /**
   * Notes that turn `turnId`'s first text reached its Workspace, which
   * shows it to the chat's watchers: the first the person could read.
   */
  #sawText(turnId: string): void {
    const pace = this.#paceOf(turnId);
    if (pace !== undefined) {
      pace.firstTextAt ??= Date.now();
    }
  }

  /** The captures settled turns owe, by their turn IDs (`CaptureDoc`). */
  async #owed(): Promise<string[]> {
    const keys: string[] = [];
    let cursor: Cursor | undefined;
    do {
      // oxlint-disable-next-line no-await-in-loop -- page after page
      const page = await this.#storage.scanDocuments(
        {
          scope: { kind: "session" },
          at: "current",
          kind: CaptureDoc.definition.kind,
        },
        20,
        cursor,
        context
      );
      for (const { key } of page.items) {
        if (key !== undefined) {
          keys.push(key);
        }
      }
      cursor = page.next;
    } while (cursor !== undefined);
    return keys;
  }

  /**
   * Delivers the capture turn `key` owes (`captureTurn`), naming its
   * answer as the copies kept it (`#copy` keeps it there), then retires
   * it: at least once, as a call retried or a retire that failed delivers
   * it again. The Workspace notes it once whatever: one event, by an ID
   * the turn's source gives it (`Workspace.captureTurn`).
   */
  async #deliver(scope: TurnRequest["scope"], key: string): Promise<void> {
    const owed = await this.#harness.snapshot(CaptureDoc, key, context);
    if (owed === undefined) {
      return;
    }
    await callObject(async () => {
      await this.#workspace(scope).captureTurn(scope.chatId, owed);
    });
    await this.#conversation.commit(async (tx) => {
      await tx.retireDoc(CaptureDoc, key);
      const turn = await tx.doc(TurnDoc);
      if (requestOf(turn)?.turnId === key) {
        turn.captureOwed = false;
      }
    }, context);
  }

  /**
   * How turn `turnId` ended, as pi settled its last input (`#endOf`): with
   * no end when it never submitted its question; none while that is in
   * flight.
   */
  async #endOfTurn(turnId: string): Promise<{ end?: TurnEnd } | undefined> {
    const last = await this.#lastInputOf(turnId);
    if (last === undefined) {
      return {};
    }
    const { status } = await last.status(context);
    return status === "done" || status === "unanswered"
      ? { end: await this.#endOf(await last.wait(context)) }
      : undefined;
  }

  /**
   * Keeps `shown` in the chat's Workspace, then marks the entries through
   * `through` copied, with the turn's answer as the Workspace kept it, for
   * its capture: in the capture it owes too once it settled, before the
   * next question can replace this record. `shown` that begins with a
   * question queued into the turn owes the capture of the answer before
   * it now, as that question's turn would have: by its own key.
   */
  async #keep(
    scope: TurnRequest["scope"],
    shown: readonly TurnMessage[],
    through: EntryId | null
  ): Promise<void> {
    const answerId =
      shown.length === 0
        ? undefined
        : await callObject(
            async () =>
              await this.#workspace(scope).keepTurnMessages(scope.chatId, [
                ...shown,
              ])
          );
    await this.#conversation.commit(async (tx) => {
      const doc = await tx.doc(CopiedDoc);
      doc.after = through;
      const turn = await tx.doc(TurnDoc);
      const request = requestOf(turn);
      if (
        shown[0]?.queued === true &&
        turn.answerId !== null &&
        request !== undefined
      ) {
        await tx.doc(CaptureDoc, `${request.turnId}:${turn.answerId}`, {
          outcome: "answered",
          answerId: turn.answerId,
          attended: request.capture.attended,
        });
        turn.answerId = null;
      }
      if (answerId === undefined) {
        return;
      }
      turn.answerId = answerId;
      if (turn.ended && turn.captureOwed && request !== undefined) {
        // Owed, so there: the seed is never used.
        const owed = await tx.doc(CaptureDoc, request.turnId, {
          outcome: "answered",
          answerId,
          // A request kept before it said is no one's there and then.
          attended: request.capture.attended,
        });
        owed.answerId = answerId;
      }
    }, context);
  }

  /**
   * Copies the entries committed since the last copy that show the person
   * something to the chat's Workspace, then marks them copied. A copy sent
   * again, as a restart between the two sends it, is kept once: the
   * Workspace knows each by its entry. Whether it copied a response with
   * words.
   */
  async #copy(scope: TurnRequest["scope"]): Promise<boolean> {
    // Before the entries are read: pi may end its run meanwhile, and an
    // entry read before then is judged as of then.
    const running = this.#running;
    const copied = await this.#harness.snapshot(CopiedDoc, context);
    const after = copied?.after ?? null;
    const entries: EntryRecord[] = [];
    let cursor;
    do {
      // oxlint-disable-next-line no-await-in-loop -- page after page
      const page = await this.#conversation.entries(
        {
          order: "ascending",
          ...(after === null ? {} : { minEntryId: after }),
        },
        100,
        cursor,
        context
      );
      entries.push(...page.items.filter(({ id }) => id !== after));
      cursor = page.next;
    } while (cursor !== undefined);
    // Kept a question queued into the turn at a time (`queueQuestion`):
    // the answer kept before one is the answer to the question before it,
    // whose capture is owed then (`#keep`).
    const parts: { shown: TurnMessage[]; through: EntryId | null }[] = [
      { shown: [], through: after },
    ];
    const seen: EntryId[] = [];
    for (const [index, entry] of entries.entries()) {
      const cut = cutAttempt(entry, entries.slice(index + 1), running);
      // Copied only once it is known whether pi went on after it.
      if (cut === undefined) {
        break;
      }
      seen.push(entry.id);
      const thinkingMs = this.#thought.get(entry.id);
      const messages = cut
        ? []
        : shownOf(entry).map((message) =>
            thinkingMs === undefined ? message : { ...message, thinkingMs }
          );
      if (messages[0]?.queued === true) {
        parts.push({ shown: [], through: entry.id });
      }
      const part = parts.at(-1);
      if (part !== undefined) {
        part.shown.push(...messages);
        part.through = entry.id;
      }
    }
    if (seen.length === 0) {
      return false;
    }
    for (const part of parts) {
      // A copy that begins with a queued question has nothing before it.
      if (part.shown.length > 0 || part.through !== after) {
        // oxlint-disable-next-line no-await-in-loop -- in order
        await this.#keep(scope, part.shown, part.through);
      }
    }
    const shown = parts.flatMap((part) => part.shown);
    for (const id of seen) {
      this.#thought.delete(id);
    }
    return shown.some(
      ({ message }) => message.role === "assistant" && textOf(message) !== ""
    );
  }
}
