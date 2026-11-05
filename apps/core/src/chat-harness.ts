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
  Harness,
} from "@earendil-works/pi-durable";
import type {
  Conversation,
  ConversationView,
  Cursor,
  EntryId,
  EntryRecord,
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
import { isExpectedError } from "@grasp-os/shared/errors";
import { errorFields, log } from "@grasp-os/shared/log";
import type { ModelEffort } from "@grasp-os/shared/models";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { quietLoader } from "@grasp-os/shared/quiet-loader";
import { z } from "zod";

import { apisFor } from "./agent-apis.ts";
import { isMessage } from "./agent-messages.ts";
import { chatAuthority, chatContext } from "./agent-scope.ts";
import type { AgentScope } from "./agent-scope.ts";
import { showThinking } from "./agent-thinking.ts";
import { recallFor, textOf } from "./agent.ts";
import type { CodeTurn, TurnContext, TurnOutcome } from "./agent.ts";
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
import { coreMessageProvider } from "./chat-messages.ts";
import { codeTimeoutMs } from "./code-mode.ts";
import { callObject, workspace } from "./durable-objects.ts";
import { models } from "./models.ts";
import { sessionHost } from "./sandboxed.ts";

// A chat's turns on pi-durable (GRA-1529), in the chat's own object
// (chat-session.ts): one Harness on the object's SQLite, its root
// conversation the chat's. Each turn installs the chat agent's extension
// (chat-agent.ts) with what that turn runs with, behind the model gateway:
// one provider, the turn's admitted model, through which every request
// goes, summaries included, metered and audited as the chat's. pi stores
// the transcript, compacts it, and picks a turn cut short up again; the
// turn's request is kept with it (`TurnDoc`), so a resumed turn is set up
// and admitted again as it was. What it commits is copied to the chat's
// Workspace (`keepTurnMessages`), which shows the chat; the code runs, their
// leases and what the chat may no longer read stay the Workspace's. Once
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
  };
  /** A chat others share, which reads only what they all may. */
  shared: boolean;
  /** Whether the chat's agent holds the brain permission. */
  readsBrain: boolean;
  context: TurnContext;
}

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
  /**
   * The chat's entry it shows, so a copy sent again is kept once; none for
   * a message no entry holds (`cancelledMessage`).
   */
  entryId?: number;
  message: Message;
  files?: string[];
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

/** How soon the object wakes to sync again after a sync failed. */
const syncRetryMs = 15_000;

/** The turn under way, or the last, as its Workspace asked it. */
const TurnDoc = defineDoc<{ request: string }>({
  kind: "grasp.turn",
  version: 1,
  scope: "session",
  initial: () => ({ request: "" }),
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

/**
 * What a question's entry keeps besides its message: the files it carries,
 * and its recall's call, so the chat shows the recall as a step of its own.
 */
const questionDataSchema = z.object({
  files: z.array(z.string()),
  recall: z
    .object({
      runId: z.string(),
      callId: z.string(),
      code: z.string(),
      status: z.string(),
    })
    .optional(),
});

const noUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * A question's recall as the chat shows it: a code step the platform ran
 * before the first request, its call and its result, as the model's own
 * code steps show. Only in the chat's copy: the model reads what it found
 * with the question.
 */
const recallStepOf = (
  recall: NonNullable<z.infer<typeof questionDataSchema>["recall"]>,
  text: string,
  timestamp: number
): TurnMessage[] => [
  {
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: recall.callId,
          name: "executeCode",
          arguments: { code: recall.code },
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
      toolName: "executeCode",
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
    const data = questionDataSchema.safeParse(entry.data);
    const recall = data.success ? data.data.recall : undefined;
    const recalled = recall === undefined ? undefined : recallTextOf(message);
    return [
      {
        message: { ...message, content: questionText(message) },
        files: data.success ? data.data.files : [],
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
  /** The turn whose notices are taken now: while its `run` waits on pi. */
  #noticesFor: string | undefined;
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
  /** What the Workspace was told last: whether the agent is at work, its partial. */
  readonly #told: { running?: boolean; partial: AssistantMessage | null } = {
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
    // A turn a restart left, with no `run` waiting on it, takes no notice
    // once its runs end; a `run` that waits stops taking them itself.
    if (this.#running && !running && this.#taking === undefined) {
      this.#noticesFor = undefined;
    }
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
   * for another turn refused (`agent.busy`) before anything is touched,
   * one for the same turn, as its Workspace makes when a call breaks,
   * waiting on the same end. Checked before anything is awaited.
   */
  async run(request: TurnRequest): Promise<TurnEnd> {
    const taking = this.#taking;
    if (taking !== undefined) {
      if (taking.turnId !== request.turnId) {
        throw agentErrors.create("agent.busy");
      }
      return await taking.end;
    }
    // A turn a restart left takes no notice once another is asked.
    if (this.#noticesFor !== request.turnId) {
      this.#noticesFor = undefined;
    }
    const end = this.#take(request);
    this.#taking = { turnId: request.turnId, end };
    try {
      return await end;
    } finally {
      this.#taking = undefined;
    }
  }

  /**
   * Takes `request`'s turn: its question once (a retry with the same turn
   * finds it and only waits), then waits until its runs end (`#ended`),
   * every entry copied.
   */
  async #take(request: TurnRequest): Promise<TurnEnd> {
    const placed = await this.#conversation.commit(
      async (tx) =>
        await tx.submissionByRequest(this.#conversation.id, request.turnId),
      context
    );
    const submission =
      placed === undefined
        ? await this.#submit(request)
        : await this.#harness.submission(placed.id, context);
    if (submission === undefined) {
      throw new Error(`Turn ${request.turnId} has no submission`);
    }
    this.#noticesFor = request.turnId;
    // After the submit: a stop that came before it was kept, and one that
    // comes after it stops the run itself.
    const stopped = await this.#harness.snapshot(StoppedDoc, context);
    if (stopped?.turnId === request.turnId) {
      await this.#conversation.abort(context);
    }
    const { settled, newest } = await this.#ended(request.turnId, submission);
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
    // Everything copied, and told it ended, before the turn returns.
    await this.#synced();
    return end;
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
    // No notice of this turn is taken from here on. One taken before had
    // its commit on pi's line already (`notify`), so a read on the line
    // comes after it, and after the run it started, if it started one:
    // that run is the turn's too.
    this.#noticesFor = undefined;
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
   * The last input of turn `turnId` pi keeps: its question, or a notice it
   * took after (`notify`), found by their request IDs.
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
      const kept = await tx.doc(TurnDoc);
      kept.request = JSON.stringify(request);
    }, context);
    const turn = await this.#setUp(request);
    await this.#rebaseIfNeeded(request);
    // At least once: should the object reset before the submit below, the
    // turn asked again sets up and recalls again, a second recall run
    // audited as the first was.
    const recall = request.readsBrain
      ? await recallFor(turn, request.question.text)
      : undefined;
    try {
      return await this.#conversation.submit(
        {
          type: "input",
          content: questionContent(
            request.question.text,
            request.question.files,
            recall
          ),
          requestId: request.turnId,
          whenBusy: "reject",
          entry: {
            kind: questionKind,
            data: {
              files: request.question.files.map(({ id }) => id),
              ...(recall === undefined
                ? {}
                : {
                    recall: {
                      runId: recall.runId,
                      callId: recall.callId,
                      code: recall.code,
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
   * parked it and reset before it ended the turn. The turn takes its
   * notices again, as its run did.
   */
  async setUpStored(): Promise<void> {
    const request = await this.#request();
    if (!this.#running || request === undefined) {
      return;
    }
    this.#noticesFor = request.turnId;
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

  /** Goes on with what pi left pending, and with what sleeps till now. */
  resume(): void {
    this.#harness.resume();
    // An alarm armed for a sync that failed (`wake`) tries it again.
    if (this.#behind) {
      this.#syncSoon();
    }
  }

  /**
   * Tells turn `turnId` `text` for it to answer, never shown as the
   * person's: pi's steer, placed after the tool round under way, or as the
   * run answers, when it starts a run that answers it; on an idle chat it
   * starts that run at once. Once per `key`, however often it is sent,
   * under a request ID of the turn's (`noticeRequestPrefix`). None once
   * that turn's `run` stopped taking them. Checked with nothing awaited
   * before the submit, which puts its commit on pi's line at once.
   */
  async notify(turnId: string, key: string, text: string): Promise<void> {
    if (this.#noticesFor !== turnId) {
      return;
    }
    await this.#conversation.submit(
      {
        type: "input",
        content: text,
        requestId: `${noticeRequestPrefix(turnId)}${key}`,
        whenBusy: "steer",
        entry: { kind: noticeKind },
      },
      context
    );
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
   * ends. With `turnId`, kept, so that turn is stopped too if it hasn't
   * submitted its question yet, as it does.
   */
  async abort(turnId?: string): Promise<void> {
    if (turnId !== undefined) {
      await this.#conversation.commit(async (tx) => {
        const stopped = await tx.doc(StoppedDoc);
        stopped.turnId = turnId;
      }, context);
    }
    await this.#conversation.abort(context);
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

  /** The turn under way, or the last, as `TurnDoc` keeps it. */
  async #request(): Promise<TurnRequest | undefined> {
    const kept = await this.#harness.snapshot(TurnDoc, context);
    return kept === undefined || kept.request === ""
      ? undefined
      : turnRequestSchema.parse(JSON.parse(kept.request));
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
          await host().openCodeRun(scope.chatId, opening),
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
      context: request.context,
      assets: env.ASSETS,
      history: transcript.messages,
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
   * Brings the chat's Workspace up to date, in this order: what was
   * committed since the last copy (`#copy`), the answer streaming in, and
   * whether the agent is at work. Each the latest, never an older one
   * after it; each told again until it is through.
   */
  async #sync(): Promise<void> {
    const request = await this.#request();
    if (request === undefined) {
      return;
    }
    const { scope } = request;
    await this.#copy(scope);
    const partial = this.#partial;
    if (partial !== this.#told.partial) {
      await callObject(async () => {
        await this.#host(scope).showPartial(scope.chatId, partial);
      });
      this.#told.partial = partial;
    }
    const running = this.#running;
    if (running !== this.#told.running) {
      await callObject(async () => {
        await this.#host(scope).turnRunning(scope.chatId, running);
      });
      this.#told.running = running;
    }
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
    const shown: TurnMessage[] = [];
    const seen: EntryId[] = [];
    let last: EntryId | undefined;
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
      for (const entry of page.items) {
        if (entry.id !== after) {
          last = entry.id;
          seen.push(entry.id);
          const thinkingMs = this.#thought.get(entry.id);
          for (const message of shownOf(entry)) {
            shown.push(
              thinkingMs === undefined ? message : { ...message, thinkingMs }
            );
          }
        }
      }
      cursor = page.next;
    } while (cursor !== undefined);
    if (last === undefined) {
      return;
    }
    if (shown.length > 0) {
      await callObject(async () => {
        await this.#host(scope).keepTurnMessages(scope.chatId, shown);
      });
    }
    const through = last;
    await this.#conversation.commit(async (tx) => {
      const doc = await tx.doc(CopiedDoc);
      doc.after = through;
    }, context);
    for (const id of seen) {
      this.#thought.delete(id);
    }
  }
}
