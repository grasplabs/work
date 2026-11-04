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
  LiveDoc,
  watchEvents,
} from "@earendil-works/pi-durable";
import type {
  AgentEvent,
  Conversation,
  EntryId,
  EntryRecord,
  Registry,
  SettledSubmissionRecord,
  Wake,
} from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { agentErrors } from "@grasp-os/shared/agent";
import { delegateActorOf } from "@grasp-os/shared/audit";
import { isExpectedError } from "@grasp-os/shared/errors";
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
  noticeKind,
  questionContent,
  questionKind,
  questionText,
  rebase,
  recallTextOf,
} from "./chat-agent.ts";
import { coreMessageProvider } from "./chat-messages.ts";
import { codeTimeoutMs } from "./code-mode.ts";
import { workspace } from "./durable-objects.ts";
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
  message: Message;
  files?: string[];
  /** How long a response thought, as its stream showed it. */
  thinkingMs?: number;
}

const context = BACKGROUND_CONTEXT;

/** The provider every request of the chat goes through: the model gateway. */
const gateway = "grasp";

/** The turn under way, or the last, as its Workspace asked it. */
const TurnDoc = defineDoc<{ request: string }>({
  kind: "grasp.turn",
  version: 1,
  scope: "session",
  initial: () => ({ request: "" }),
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

/** The partial answer `pi.live` shows, if there is one. */
const liveSchema = z.object({
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
 * Whether the agent is still at work once `message` is the chat's latest:
 * after a question, a call or a tool's result, it goes on; after a
 * response that calls nothing, its turn is over. The chat's own copy, so
 * it holds through a restart of either object.
 */
const atWorkAfter = (message: Message): boolean =>
  message.role !== "assistant" || message.stopReason === "toolUse";

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
 * recall's step if it recalled; a response or a tool's result; or none.
 */
const shownOf = (entry: EntryRecord): TurnMessage[] => {
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
    ];
  }
  if (entry.kind === "pi.tool-result" && message.role === "toolResult") {
    return [{ message: withPlainDiagnostics(message, entry.data) }];
  }
  return entry.kind === "pi.assistant" ? [{ message }] : [];
};

/**
 * Times the thinking of the response streaming in, from the partial
 * answer pi keeps live (`pi.live`): from when its latest part is thinking
 * to when another part follows, or the response ends, the parts' times
 * added up. pi's events carry no stream changes, so the partial is what
 * there is: to the grain of its updates; a response a restart cut short
 * has none.
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
      const thinking = partial.content.at(-1)?.type === "thinking";
      if (thinking) {
        since ??= Date.now();
      } else {
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
  readonly #harness: Harness;
  readonly #conversation: Conversation;
  readonly #registry: Registry;
  readonly #models: MutableModels;
  /** What the chat has read from, as of the last request's guard. */
  #sources: string[] = [];
  /** Why the turn under way was stopped, if it was. */
  #stopped: TurnStop | undefined;
  /** The copies to the Workspace under way, one after another. */
  #copying: Promise<void> = Promise.resolve();
  /** The partial answer the Workspace was shown last. */
  #shown = "null";
  /** Whether the Workspace was told the agent is at work. */
  #told: boolean | undefined;
  /** Turns stopped before they started (`abort`), by turn ID. */
  readonly #cancelled = new Set<string>();
  /** The latest telling under way (`#tell`). */
  #telling: Promise<void> = Promise.resolve();
  /** The thinking of the response streaming in, as `thinkingClock` times it. */
  readonly #thinking = thinkingClock();
  /** Each response's thinking time, by its entry, until it is copied. */
  readonly #thought = new Map<EntryId, number>();

  constructor(
    ctx: DurableObjectState,
    env: Env,
    harness: Harness,
    conversation: Conversation,
    registry: Registry,
    pi: MutableModels
  ) {
    this.#ctx = ctx;
    this.#env = env;
    this.#harness = harness;
    this.#conversation = conversation;
    this.#registry = registry;
    this.#models = pi;
  }

  /**
   * Opens the chat's Harness on its object's SQLite (tables prefixed
   * `pi_`), in the EU as the object is. `onWake` arms the object's alarm.
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
        settings: {
          // One code run at a time, as each is an isolate of its own.
          toolExecution: "sequential",
          // The model gateway's provider SDKs retry a request already, and
          // the gateway says why one failed in the end (`model.rate_limited`
          // and so on): pi retrying on top would multiply the attempts.
          retry: { enabled: false },
        },
        identity: { attribution: null },
        onWake,
      },
      context
    );
    const conversation = await harness.root(context);
    const opened = new ChatHarness(
      ctx,
      env,
      harness,
      conversation,
      registry,
      pi
    );
    const view = await conversation.viewState(context);
    view.subscribe((value) => {
      opened.#showPartial(value.docs["pi.live"]);
    });
    // The agent's own events: its thinking as it streams.
    const events = await watchEvents(harness, conversation.id, context);
    events.start(async (batch) => {
      for (const event of batch) {
        opened.#see(event);
      }
      // One batch a commit: copied once its events are seen, so a
      // response goes with its thinking time.
      opened.#copySoon();
      await Promise.resolve();
    });
    return opened;
  }

  /** Whether the agent is at work, as the chat's latest message says. */
  async #latestShown(): Promise<Message | undefined> {
    const page = await this.#conversation.entries(
      { order: "descending" },
      8,
      undefined,
      context
    );
    for (const entry of page.items) {
      const latest = shownOf(entry).at(-1);
      if (latest !== undefined) {
        return latest.message;
      }
    }
    return undefined;
  }

  /** Takes in one of the agent's events (`watchEvents`). */
  #see(event: AgentEvent): void {
    if (event.type === "message_end") {
      const ms = this.#thinking.take();
      if (ms !== undefined && event.entry.kind === "pi.assistant") {
        this.#thought.set(event.entry.id, ms);
      }
    }
  }

  /**
   * Tells the chat's Workspace whether its agent is at work, as the chat's
   * transcript here says, once each time that changes: through a restart of
   * either object, the chat shows its turn running until it ends. Settles
   * once the Workspace was told, the same value told already included.
   */
  async #tell(running: boolean): Promise<void> {
    if (this.#told === running) {
      await this.#telling;
      return;
    }
    this.#told = running;
    this.#telling = (async () => {
      const request = await this.#request();
      if (request === undefined) {
        return;
      }
      try {
        await this.#host(request.scope).turnRunning(
          request.scope.chatId,
          running
        );
      } catch (error) {
        // Told again at the next change, or as the object wakes.
        this.#told = undefined;
        throw error;
      }
    })();
    this.#ctx.waitUntil(this.#telling);
    await this.#telling;
  }

  /** When the Harness next needs the object (`Harness.wake`). */
  wake(): Wake {
    return this.#harness.wake();
  }

  /**
   * Runs `request`'s turn to its end: its question once (a retry with the
   * same turn finds it), then waits for its answer, every entry copied.
   */
  async run(request: TurnRequest): Promise<TurnEnd> {
    this.#stopped = undefined;
    await this.#conversation.commit(async (tx) => {
      const kept = await tx.doc(TurnDoc);
      kept.request = JSON.stringify(request);
    }, context);
    const { turn, room } = await this.#setUp(request);
    await this.#rebaseIfNeeded(request, room);
    const placed = await this.#conversation.commit(
      async (tx) =>
        await tx.submissionByRequest(this.#conversation.id, request.turnId),
      context
    );
    const recall =
      placed === undefined && request.readsBrain
        ? await recallFor(turn, request.question.text)
        : undefined;
    let submitted;
    try {
      submitted = await this.#conversation.submit(
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
    console.log("DEBUGSUBMITTED", this.#cancelled.has(request.turnId));
    if (this.#cancelled.delete(request.turnId)) {
      await this.#conversation.abort(context);
    }
    const settled = await submitted.wait(context);
    console.log("DEBUGSETTLED", JSON.stringify(settled));
    this.#copySoon();
    await this.#copying;
    const end = await this.#endOf(settled);
    if (end.stopped === "history_revoked") {
      await this.#conversation.waitForIdle(context);
      await this.#rebaseIfNeeded(request, room);
    }
    const latest = await this.#latestShown();
    // A turn stopped before the model said anything ends in the chat as
    // cancelled all the same: pi keeps no response of it.
    if (end.outcome === "cancelled" && latest?.role !== "assistant") {
      await this.#host(request.scope).keepTurnMessages(request.scope.chatId, [
        { message: cancelledMessage() },
      ]);
    }
    // A turn that ended without a last word of the model's (cancelled,
    // failed, stopped) is over too. Told before the turn returns, so its
    // Workspace shows it ended.
    await this.#tell(
      end.outcome === "answered" && latest !== undefined && atWorkAfter(latest)
    );
    return end;
  }

  /**
   * Rebases the chat's context (`rebase`) when it holds a result the chat
   * may no longer read, or a rebase was cut short: only while idle.
   */
  async #rebaseIfNeeded(request: TurnRequest, room: number): Promise<void> {
    const { withheld } = await this.#host(request.scope).turnGuard(
      request.scope
    );
    const runs = new Set(withheld);
    if (await needsRebase(this.#conversation, runs, context)) {
      await rebase(this.#conversation, runs, room, context);
    }
  }

  /**
   * Goes on with the turn a restart cut short, as it was set up: its
   * request admitted again first, so nothing runs for a person who left.
   */
  async resume(): Promise<void> {
    const live = await this.#harness.snapshot(
      LiveDoc,
      this.#conversation.id,
      context
    );
    const request = await this.#request();
    if (live?.run !== undefined && request !== undefined) {
      try {
        const { room } = await this.#setUp(request);
        const { withheld } = await this.#host(request.scope).turnGuard(
          request.scope
        );
        if (await needsRebase(this.#conversation, new Set(withheld), context)) {
          await this.#conversation.abort(context);
          await this.#rebaseIfNeeded(request, room);
        }
      } catch {
        await this.#conversation.abort(context);
        return;
      }
    }
    this.#harness.resume();
  }

  /**
   * Tells the turn under way `text` before its next request, never shown
   * as the person's: dropped once no turn runs.
   */
  async steer(text: string): Promise<void> {
    const live = await this.#harness.snapshot(
      LiveDoc,
      this.#conversation.id,
      context
    );
    if (live?.run === undefined) {
      return;
    }
    await this.#conversation.submit(
      {
        type: "input",
        content: text,
        whenBusy: "steer",
        entry: { kind: noticeKind },
      },
      context
    );
  }

  /**
   * Tells the chat's agent `text`, never shown as the person's and starting
   * no turn: the turn under way reads it before its next request, and
   * otherwise the next turn does, as an entry of the context.
   */
  async note(text: string): Promise<void> {
    const live = await this.#harness.snapshot(
      LiveDoc,
      this.#conversation.id,
      context
    );
    if (live?.run !== undefined) {
      await this.steer(text);
      return;
    }
    await this.#conversation.commit(async (tx) => {
      await tx.appendEntry(this.#conversation.id, {
        kind: noticeKind,
        model: [{ role: "user", content: text, timestamp: Date.now() }],
      });
    }, context);
  }

  /**
   * Stops the turn under way, if any: its request or tool call in flight
   * ends. With `turnId`, that turn's too if it hasn't started yet: a stop
   * that came first stops it as it starts.
   */
  async abort(turnId?: string): Promise<void> {
    if (turnId !== undefined) {
      this.#cancelled.add(turnId);
      console.log("DEBUGCANCEL", turnId);
    }
    await this.#conversation.abort(context);
  }

  async close(): Promise<void> {
    await this.#harness.close(context);
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

  /** Stops the turn under way for `reason`. */
  #stop(reason: TurnStop): void {
    this.#stopped ??= reason;
    this.#ctx.waitUntil(this.#conversation.abort(context));
  }

  /**
   * Admits the turn's model through the gateway, refused before anything
   * runs, and installs the chat's extension with what the turn runs with.
   */
  async #setUp(
    request: TurnRequest
  ): Promise<{ turn: CodeTurn; room: number }> {
    const env = this.#env;
    const { scope } = request;
    const host = this.#host(scope);
    const authority = chatAuthority(scope);
    const guard = await host.turnGuard(scope);
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
    const turn: CodeTurn = {
      apis: apisFor(request.shared, request.readsBrain),
      scope,
      runs: {
        open: async (opening) => await host.openCodeRun(scope.chatId, opening),
        close: async (runId, status) =>
          await host.endTurnRun(scope, runId, status),
        output: (runId, callId, line) => {
          this.#ctx.waitUntil(
            host.codeRunOutput(scope.chatId, runId, callId, line)
          );
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
        const checked = await host.turnGuard(scope);
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
    const room = Math.max(
      admitted.model.contextWindow - DEFAULT_COMPACTION_POLICY.reserveTokens,
      DEFAULT_COMPACTION_POLICY.keepRecentTokens
    );
    return { turn, room };
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
    return {
      outcome: "failed",
      answer: "",
      error:
        typeof settled.detail === "string" ? settled.detail : settled.reason,
    };
  }

  /** Copies what was committed since the last copy, after the copies under way. */
  #copySoon(): void {
    const before = this.#copying;
    this.#copying = (async () => {
      try {
        await before;
      } catch {
        // A copy that failed is done again by this one.
      }
      await this.#copy();
    })();
    this.#ctx.waitUntil(this.#copying);
  }

  /**
   * Copies the entries committed since the last copy that show the person
   * something to the chat's Workspace, then marks them copied: at least
   * once each, a failed copy tried again at the next commit.
   */
  async #copy(): Promise<void> {
    const request = await this.#request();
    if (request === undefined) {
      return;
    }
    const { scope } = request;
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
      await this.#host(scope).keepTurnMessages(scope.chatId, shown);
      const latest = shown.at(-1);
      await this.#tell(latest !== undefined && atWorkAfter(latest.message));
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

  /** Shows the Workspace the answer streaming in, as `pi.live` has it. */
  #showPartial(live: unknown): void {
    const parsed = liveSchema.safeParse(live ?? {});
    const partial = parsed.success
      ? (parsed.data.generation?.message ?? null)
      : null;
    const json = JSON.stringify(partial);
    if (json === this.#shown) {
      return;
    }
    this.#shown = json;
    if (partial !== null) {
      this.#thinking.see(partial);
    }
    this.#ctx.waitUntil(this.#showing(partial));
  }

  async #showing(partial: AssistantMessage | null): Promise<void> {
    const request = await this.#request();
    if (request !== undefined) {
      await this.#host(request.scope).showPartial(
        request.scope.chatId,
        partial
      );
    }
  }
}
