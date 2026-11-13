import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  AssistantMessage,
  Message,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import {
  ConversationBusy,
  createRegistry,
  DEFAULT_COMPACTION_POLICY,
  defineDoc,
  defineDocFamily,
  Harness,
} from "@earendil-works/pi-durable";
import type {
  Conversation,
  ConversationView,
  Cursor,
  EntryId,
  EntryRecord,
  JsonObject,
  Registry,
  SettledSubmissionRecord,
  Storage,
  Submission,
  SubmissionRecord,
  Wake,
} from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { agentErrors } from "@grasp-os/shared/agent";
import { delegateActorOf } from "@grasp-os/shared/audit";
import type { ChatMake } from "@grasp-os/shared/chat";
import { isExpectedError } from "@grasp-os/shared/errors";
import { errorFields, log } from "@grasp-os/shared/log";
import type { ModelEffort } from "@grasp-os/shared/models";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { quietLoader } from "@grasp-os/shared/quiet-loader";
import { z } from "zod";

import { apisFor } from "./agent-apis.ts";
import { turnCheck } from "./agent-builds.ts";
import { isMessage, showThinkingName } from "./agent-messages.ts";
import { rememberTool } from "./agent-remember.ts";
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
import type { TurnFacts } from "./brain-capture.ts";
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
import { coreMessageProvider, shownBuiltSchema } from "./chat-messages.ts";
import type { ShownBuilt } from "./chat-messages.ts";
import { codeTimeoutMs } from "./code-mode.ts";
import { callObject, workspace } from "./durable-objects.ts";
import { models } from "./models.ts";
import { sessionHost } from "./sandboxed.ts";
import { recallForTurn, turnRecallTool } from "./turn-recall.ts";

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

/** One question of a chat, as its Workspace hands it over. */
export interface TurnRequest {
  /** The turn's ID: the request ID of its input, so a retry finds it. */
  turnId: string;
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
   * Whether the answer reaches the person alone, so the recall before the
   * question may hold what only they may read (their own store,
   * turn-recall.ts): their own chat in Grasp, in a turn they started
   * (workspace.ts, `answersAlone`).
   */
  personal: boolean;
  /** Whether the chat's agent holds the brain permission. */
  readsBrain: boolean;
  context: TurnContext;
  /** What the turn's capture for the Brain records besides how it ended. */
  capture: {
    /** The model the Workspace admitted. */
    model: string;
    /** A shared chat's members as the turn read for them; null for one's own. */
    audience: string[] | null;
  };
}

/** What a turn's capture for the Brain holds, as its ChatSession delivers it. */
export type TurnCapture = Pick<
  TurnFacts,
  "turnId" | "outcome" | "answerId" | "model" | "audience"
>;

/** Why a turn stopped before it answered, when no model said so. */
export type TurnStop = "history_revoked" | "person_inactive" | "unreadable";

/** How a turn ended, as its Workspace reads it. */
export interface TurnEnd {
  outcome: TurnOutcome;
  /** The model's last words: its answer, or where it stopped. */
  answer: string;
  /** Why it failed, in the gateway's words. */
  error?: string;
  stopped?: TurnStop;
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
 * Most checks of a turn's drafts (`turnCheck`, agent-builds.ts): as the
 * agent's instructions stop it once the same error comes back three
 * times, so a turn that can't fix its drafts spends no more on trying.
 */
const maxTurnChecks = 3;

/** What a turn that only showed its thinking is asked, once, before it ends. */
const wordsPlease =
  "You showed your thinking in the brain, but wrote no answer. Now write your answer to the person in words.";

/** How soon the object wakes to sync again after a sync failed. */
const syncRetryMs = 15_000;

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
    const { files, built, recall, followUp } = questionDataOf(entry.data);
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

/** One chat's Harness, opened on its object's storage. */
export class ChatHarness {
  readonly #ctx: DurableObjectState;
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
  /** Whether pi held the turn's work parked as the Harness opened. */
  #parked = false;
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
  /** Whether pi runs the agent now (`pi.live.run`). */
  #running = false;
  /** The answer streaming in, as `pi.live` has it now. */
  #partial: AssistantMessage | null = null;
  /** Where the response streaming in began: the chat's newest entry then. */
  #streamedAfter: EntryId | null | undefined;
  /** The thinking of the response streaming in, as `thinkingClock` times it. */
  readonly #thinking = thinkingClock();
  /** Each response's thinking time, by its entry, until it is copied. */
  readonly #thought = new Map<EntryId, number>();
  /** What the Workspace was told last: the partial, and whether a turn runs. */
  readonly #told: { partial: AssistantMessage | null; running?: boolean } = {
    partial: null,
  };
  /** The Workspace brought up to date (`#sync`), once at a time. */
  #syncing: Promise<void> | undefined;
  /** Whether something changed since the sync under way began. */
  #stale = false;
  /**
   * Whether the last sync failed: the Workspace may still show the chat
   * busy, so the object's alarm wakes it to sync again (`wake`).
   */
  #behind = false;
  /** Arms the object's alarm for what `wake` says. */
  readonly #onWake: (wake: Wake) => void;

  constructor(
    ctx: DurableObjectState,
    env: Env,
    storage: Storage,
    harness: Harness,
    conversation: Conversation,
    registry: Registry,
    pi: MutableModels,
    onWake: (wake: Wake) => void
  ) {
    this.#ctx = ctx;
    this.#env = env;
    this.#storage = storage;
    this.#harness = harness;
    this.#conversation = conversation;
    this.#registry = registry;
    this.#models = pi;
    this.#onWake = onWake;
  }

  /**
   * Opens the chat's Harness on its object's SQLite, in the EU as the
   * object is. `onWake` arms the object's alarm. Nothing runs yet: the
   * object sets up the turn under way, if any (`setUpStored`), then
   * resumes it (`resume`).
   */
  static async open(
    ctx: DurableObjectState,
    env: Env,
    onWake: (wake: Wake) => void
  ): Promise<ChatHarness> {
    const storage = await openDurableObjectSqliteStorage(ctx.storage, {
      prefix: "pi_",
    });
    const registry = createRegistry();
    const pi = createModels();
    const harness = await Harness.open(
      storage,
      {
        models: pi,
        registry,
        // Read at each use: tests lower the restart limit as they go.
        settings: () => ({
          // One code run at a time, as each is an isolate of its own.
          toolExecution: "sequential",
          // The model gateway's provider SDKs retry a request already, and
          // the gateway says why one failed in the end (`model.rate_limited`
          // and so on): pi retrying on top would multiply the attempts.
          retry: { enabled: false },
          ...restartLimitOf(env),
        }),
        identity: { attribution: null },
        onWake,
        // Said once, as the open that parks a task: what the object does
        // of it reads pi's state (`setUpStored`), at every open.
        onReport: (error, info) => {
          if (info.type === "task_parked") {
            log.warn("chat.task_parked", {
              chatSession: ctx.id.name,
              task: info.task.kind,
              ...errorFields(error),
            });
          }
        },
      },
      context
    );
    const conversation = await harness.root(context);
    const opened = new ChatHarness(
      ctx,
      env,
      storage,
      harness,
      conversation,
      registry,
      pi,
      onWake
    );
    // The one watch of pi: called at once with the view as it is, then at
    // each commit. Whatever the Workspace was last told, and whatever a
    // restart kept from being copied, it is brought up to date.
    const view = await conversation.viewState(context);
    view.subscribe((value) => {
      opened.#see(value);
    });
    return opened;
  }

  /**
   * Takes in the chat as pi's view has it now: whether pi runs the agent
   * (`pi.live.run`, whatever started the run and however it ended), the
   * answer streaming in and its thinking. Then brings the Workspace up to
   * date with it, in order.
   */
  #see(value: ConversationView): void {
    const live = liveSchema.safeParse(value.docs["pi.live"] ?? {});
    const partial = live.success
      ? (live.data.generation?.message ?? null)
      : null;
    const running = live.success && live.data.run !== undefined;
    this.#running = running;
    this.#partial = partial;
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
    this.#syncSoon();
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
    const end = this.#take(request);
    this.#taking = { turnId: request.turnId, end };
    try {
      return await end;
    } finally {
      this.#taking = undefined;
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
    const placed = await this.#conversation.commit(
      async (tx) =>
        await tx.submissionByRequest(this.#conversation.id, request.turnId),
      context
    );
    let submission: Submission | undefined;
    try {
      submission =
        placed === undefined
          ? await this.#submit(request)
          : await this.#harness.submission(placed.id, context);
      if (submission === undefined) {
        throw new Error(`Turn ${request.turnId} has no submission`);
      }
    } catch (error) {
      // Refused before its question: settled with no end, nothing ran.
      await this.#settle(request.turnId);
      throw error;
    }
    // After the submit: a stop that came before it was kept, and one that
    // comes after it stops the run itself.
    const stopped = await this.#harness.snapshot(StoppedDoc, context);
    if (stopped?.turnId === request.turnId) {
      await this.#conversation.abort(context);
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
    await this.#settle(request.turnId, end);
    // Everything copied, and told it ended, before the turn returns. Its
    // answer stands should that fail: the alarm the failed sync arms makes
    // it good.
    try {
      await this.#synced();
    } catch {
      // Logged, and tried again, by the sync itself (`#syncSoon`).
    }
    return end;
  }

  /**
   * Settles turn `turnId`'s record, once: ended, with `end` (none for a
   * turn that never submitted its question), its request kept without
   * what it read, and its capture owed (`CaptureDoc`) for a turn that
   * settled with an outcome its guard didn't stop. Settled by the sync as
   * one nothing waits on (`unwaited`) only while no `run` takes it. The
   * chat then takes its next turn; the sync this asks for tells the
   * Workspace and delivers the capture.
   */
  async #settle(
    turnId: string,
    end?: TurnEnd,
    unwaited = false
  ): Promise<void> {
    const settled = await this.#conversation.commit(async (tx) => {
      const turn = await tx.doc(TurnDoc);
      const request = requestOf(turn);
      if (
        turn.ended ||
        request?.turnId !== turnId ||
        (unwaited && this.#taking?.turnId === turnId)
      ) {
        return false;
      }
      turn.ended = true;
      turn.request = JSON.stringify({ ...request, context: { skills: [] } });
      if (end !== undefined && end.stopped === undefined) {
        const owed: TurnCapture = {
          turnId,
          outcome: end.outcome,
          answerId: turn.answerId,
          model: request.capture.model,
          audience: request.capture.audience,
        };
        await tx.doc(CaptureDoc, turnId, owed);
        turn.captureOwed = true;
      }
      return true;
    }, context);
    // A `run` frees its claim however its record stood; the sync only the
    // turn it settled.
    if (this.#active === turnId && (settled || !unwaited)) {
      this.#active = undefined;
    }
    this.#syncSoon();
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
    while (this.#running) {
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
   * The last input of turn `turnId` pi keeps: its question, or a notice it
   * took after (`noticeRequestPrefix`), found by their request IDs.
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
            requestId?.startsWith(noticeRequestPrefix(turnId)) === true)
      );
      cursor = page.next;
    } while (last === undefined && cursor !== undefined);
    return last === undefined
      ? undefined
      : await this.#harness.submission(last.id, context);
  }

  /**
   * Submits `request`'s question, refused while pi runs: the turn kept
   * (`TurnDoc`), its model admitted, the context rebased if it must be,
   * and the brain recalled, in that order.
   */
  async #submit(request: TurnRequest): Promise<Submission> {
    if (this.#running) {
      throw agentErrors.create("agent.busy");
    }
    this.#stopped = undefined;
    this.#parked = false;
    await this.#conversation.commit(async (tx) => {
      // The turn's record, before anything else of it: a fresh one.
      const turn = await tx.doc(TurnDoc);
      turn.request = JSON.stringify(request);
      turn.ended = false;
      turn.answerId = null;
      turn.captureOwed = false;
    }, context);
    const turn = await this.#setUp(request);
    await this.#rebaseIfNeeded(request);
    // At least once: should the object reset before the submit below, the
    // turn asked again sets up and recalls again, a second recall run
    // audited as the first was. Who reads the answer decides what it may
    // hand over (turn-recall.ts).
    const recall = request.readsBrain
      ? await this.#recall(turn, request)
      : undefined;
    try {
      return await this.#conversation.submit(
        {
          type: "input",
          content: questionContent(
            request.question.text,
            request.question.files,
            recall,
            {
              subject: request.question.subject,
              mentions: request.question.mentions,
              make: request.question.make,
              built: request.question.built,
            }
          ),
          requestId: request.turnId,
          whenBusy: "reject",
          entry: {
            kind: questionKind,
            data: {
              files: request.question.files.map(({ id }) => id),
              ...(request.question.followUp === true ? { followUp: true } : {}),
              // Shown with the person's Build it, as what it built.
              ...(request.question.built === undefined
                ? {}
                : { built: shownBuilt(request.question.built) }),
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
   * the context as the model would, once rebased: nothing withheld.
   */
  async #recall(
    turn: CodeTurn,
    { question: { text }, shared, personal }: TurnRequest
  ) {
    const { messages } = await this.#conversation.context(context);
    return await recallForTurn(
      {
        env: this.#env,
        turn,
        conversation: shared ? "shared" : "own",
        personal,
        history: messages,
        provenance: this.#sources,
      },
      text
    );
  }

  /**
   * Rebases the chat's context (`rebase`) when it holds a result the chat
   * may no longer read, or a rebase was cut short: only while idle. A note
   * that comes meanwhile waits for it (`note`).
   */
  async #rebaseIfNeeded(request: TurnRequest): Promise<void> {
    const { withheld } = await this.#guard(request.scope);
    const runs = new Set(withheld);
    if (!(await needsRebase(this.#conversation, runs, context))) {
      return;
    }
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
   * pi parked, one whose context holds what the chat may no longer read,
   * or one that can't be set up is aborted, and ends with why (`#endOf`);
   * the next question rebases (`#submit`), the guard holding every request
   * meanwhile. A rebase can take longer than an object may block. A
   * parked task is read from pi's state, as an earlier open may have
   * parked it and reset before it ended the turn.
   */
  async setUpStored(): Promise<void> {
    const turn = await this.#harness.snapshot(TurnDoc, context);
    const request = turn === undefined ? undefined : requestOf(turn);
    // The turn its record holds unsettled: the chat takes no other first.
    if (turn?.ended === false) {
      this.#active = request?.turnId;
    }
    if (!this.#running || request === undefined) {
      return;
    }
    const { tasks } = await this.#harness.inspect(context);
    this.#parked = tasks.some(
      ({ state }) =>
        state.kind === "blocked" && state.reason === "restart_limit"
    );
    try {
      await this.#setUp(request);
      const { withheld } = await this.#guard(request.scope);
      if (this.#parked) {
        await this.#conversation.abort(context);
      } else if (
        await needsRebase(this.#conversation, new Set(withheld), context)
      ) {
        this.#stopped = "history_revoked";
        await this.#conversation.abort(context);
      }
    } catch (error) {
      this.#stopped =
        isExpectedError(error) && error.code === "permission.person_inactive"
          ? "person_inactive"
          : "unreadable";
      await this.#conversation.abort(context);
    }
  }

  /** The chat's turn not yet settled, if there is one: what a stop ends. */
  activeTurn(): string | undefined {
    return this.#active;
  }

  /** Goes on with what pi left pending, and with what sleeps till now. */
  resume(): void {
    this.#harness.resume();
    // An alarm armed for a sync that failed (`wake`) tries it again.
    if (this.#behind) {
      this.#syncSoon();
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
      await this.#conversation.abort(context);
      return;
    }
    await this.#conversation.commit(async (tx) => {
      const stopped = await tx.doc(StoppedDoc);
      stopped.turnId = turnId;
    }, context);
    // After the commit: the turn the chat holds now.
    if (this.#active === turnId) {
      await this.#conversation.abort(context);
    }
  }

  async close(): Promise<void> {
    await this.#harness.close(context);
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
  #host(scope: TurnRequest["scope"]) {
    return workspace(this.#env, scope.workspaceId);
  }

  /**
   * What the chat's turn may send now, as its Workspace says
   * (`turnGuard`): asked again if the call breaks on its way, as it only
   * reads.
   */
  async #guard(scope: TurnRequest["scope"]) {
    return await callObject(
      async () => await this.#host(scope).turnGuard(scope.chatId)
    );
  }

  /** Stops the turn under way for `reason`. */
  #stop(reason: TurnStop): void {
    this.#stopped ??= reason;
    this.#ctx.waitUntil(this.#conversation.abort(context));
  }

  /**
   * Admits the turn's model through the gateway, refused before anything
   * runs, and installs the chat's extension with what the turn runs with.
   */
  async #setUp(request: TurnRequest): Promise<CodeTurn> {
    const env = this.#env;
    const { scope } = request;
    // A stub a call, never one kept for the turn: a stub to a Workspace
    // that restarted mid-turn stays broken, its calls failing or never
    // answering, where a new one reaches the Workspace as it is now.
    const host = () => this.#host(scope);
    const authority = chatAuthority(scope);
    const guard = await this.#guard(scope);
    if (guard.stop !== undefined) {
      throw permissionErrors.create("permission.person_inactive");
    }
    this.#sources = guard.sources;
    // Every request carries everything the chat has read from, as of its
    // guard: the rules judge it by all of it.
    const admitted = await models(env).agent(
      {
        model: request.question.model,
        effort: request.question.effort,
        purpose: "chat.turn",
        trigger: delegateActorOf(authority, scope.via),
        provenance: this.#sources,
        work: { authority, context: chatContext(scope) },
      },
      () => this.#sources
    );
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
        api: { stream: admitted.stream, streamSimple: admitted.stream },
      })
    );
    /** The lines the turn's runs sent the Workspace, one after another. */
    let logged: Promise<void> = Promise.resolve();
    const turn: CodeTurn = {
      apis: apisFor(request.shared, request.readsBrain),
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
          this.#ctx.waitUntil(logged);
        },
      },
      loader: quietLoader(env.LOADER),
      sandbox: () => sessionHost(env),
      codeTimeoutMs: codeTimeoutMs(env),
    };
    const transcript = await this.#conversation.context(context);
    const extension = chatAgent({
      ...turn,
      context:
        request.question.make === undefined
          ? request.context
          : { ...request.context, make: request.question.make },
      assets: env.ASSETS,
      history: transcript.messages,
      // Only in a person's own chat in Grasp's app, in a turn they started:
      // what they said there is the only word of theirs it may keep, and
      // only Grasp's app shows the notice and its Undo (agent-remember.ts).
      // A turn nobody started (a wake) has no word of theirs.
      ...(!request.shared && scope.unattended !== true && scope.via === "web"
        ? { remember: rememberTool(env, scope, request.question.text) }
        : {}),
      // Only in a person's own chat, by an agent that may read the brain.
      ...(request.readsBrain && !request.shared
        ? {
            thinking: showThinking(
              async () => await brainOf(env, scope.personId)
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
    return turn;
  }

  /** How the turn whose input settled as `settled` ended. */
  async #endOf(settled: SettledSubmissionRecord): Promise<TurnEnd> {
    const stopped = this.#stopped;
    if (stopped !== undefined) {
      return { outcome: "failed", answer: "", stopped };
    }
    if (this.#parked) {
      return {
        outcome: "failed",
        answer: "",
        error: "Restarts cut the turn off too often for it to go on.",
      };
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
    this.#ctx.waitUntil(
      (async () => {
        try {
          await syncing;
          this.#behind = false;
        } catch (error) {
          log.warn("chat.sync_failed", {
            chatSession: this.#ctx.id.name,
            ...errorFields(error),
          });
          // Woken soon to sync again, even with nothing else to do.
          this.#behind = true;
          this.#onWake(this.wake());
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
   * streaming in, whether a turn runs, and, once the turn is settled, its
   * capture for the Brain. A turn whose runs ended with no `run` waiting
   * on it (a restart left it) is settled here. Each the latest, never an
   * older one after it; each told again until it is through.
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
      !before.ended && !this.#running && this.#taking?.turnId !== turnId;
    const owed = await this.#owed();
    await this.#copy(scope);
    const partial = this.#partial;
    if (partial !== this.#told.partial) {
      await callObject(async () => {
        await this.#host(scope).showPartial(scope.chatId, partial);
      });
      this.#told.partial = partial;
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
        await this.#host(scope).turnRunning(scope.chatId, running);
      });
      this.#told.running = running;
    }
    for (const key of owed) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      await this.#deliver(scope, key);
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
   * it: at least once, kept once by its event ID.
   */
  async #deliver(scope: TurnRequest["scope"], key: string): Promise<void> {
    const owed = await this.#harness.snapshot(CaptureDoc, key, context);
    if (owed === undefined) {
      return;
    }
    await callObject(async () => {
      await this.#host(scope).captureTurn(scope.chatId, owed);
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
   * Copies the entries committed since the last copy that show the person
   * something to the chat's Workspace, then marks them copied. A copy sent
   * again, as a restart between the two sends it, is kept once: the
   * Workspace knows each by its entry.
   */
  async #copy(scope: TurnRequest["scope"]): Promise<void> {
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
    const shown: TurnMessage[] = [];
    const seen: EntryId[] = [];
    let last: EntryId | undefined;
    for (const [index, entry] of entries.entries()) {
      const cut = this.#cutAttempt(entry, entries.slice(index + 1));
      // Copied only once it is known whether pi went on after it.
      if (cut === undefined) {
        break;
      }
      last = entry.id;
      seen.push(entry.id);
      if (!cut) {
        const thinkingMs = this.#thought.get(entry.id);
        for (const message of shownOf(entry)) {
          shown.push(
            thinkingMs === undefined ? message : { ...message, thinkingMs }
          );
        }
      }
    }
    if (last === undefined) {
      return;
    }
    const answerId =
      shown.length === 0
        ? undefined
        : await callObject(
            async () =>
              await this.#host(scope).keepTurnMessages(scope.chatId, shown)
          );
    const through = last;
    await this.#conversation.commit(async (tx) => {
      const doc = await tx.doc(CopiedDoc);
      doc.after = through;
      // The turn's answer, as the Workspace kept it, for its capture: in
      // the capture it owes too once it settled, before the next question
      // can replace this record.
      const turn = await tx.doc(TurnDoc);
      const request = requestOf(turn);
      if (answerId === undefined) {
        return;
      }
      turn.answerId = answerId;
      if (turn.ended && turn.captureOwed && request !== undefined) {
        // Owed, so there: the seed is never used.
        const owed = await tx.doc(CaptureDoc, request.turnId, {
          turnId: request.turnId,
          outcome: "answered",
          answerId,
          model: request.capture.model,
          audience: request.capture.audience,
        });
        owed.answerId = answerId;
      }
    }, context);
    for (const id of seen) {
      this.#thought.delete(id);
    }
  }

  /**
   * Whether `entry` is a response a restart cut short that pi then asked
   * for again: kept by pi as aborted, outside the model's context, and
   * never shown, as the person gets the whole answer from the attempt
   * after it. One a stop cut short ends its run, and is shown. Unknown
   * (`undefined`) while it is the newest response and pi still runs.
   * `later` are the entries committed after it.
   */
  #cutAttempt(
    entry: EntryRecord,
    later: readonly EntryRecord[]
  ): boolean | undefined {
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
      return this.#running ? undefined : false;
    }
    return next.kind === "pi.assistant";
  }
}
