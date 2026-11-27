import type {
  ChatMade,
  ChatMessage,
  ChatOutput,
  ChatOutputUpdate,
  ChatPartial,
  ChatPartialUpdate,
  ChatProvenance,
  ChatQueued,
  ChatToolEvent,
  ChatUpdate,
} from "@grasp-os/shared/chat";
import type { ModelWait } from "@grasp-os/shared/models";

import { Pushes } from "./pushes.ts";

/** Where a watcher's updates go: the frontend's callback, through core. */
export type ChatListener = Rpc.Stub<(update: ChatUpdate) => Promise<void>>;

/** A chat as the Workspace object has it now, besides its messages. */
export interface ChatState {
  /** The response being written, whole; `null` between responses. */
  partial: ChatPartial | null;
  /** The running code step's output so far; `null` while none runs. */
  output: ChatOutput | null;
  running: boolean;
  /** The questions sent meanwhile that its turn hasn't taken yet. */
  queued: ChatQueued[];
  stopped: string | null;
  held: number;
  /** Changes whenever the chat's agent writes an App's draft. */
  worked: number;
  /** Changes whenever the chat's provenance does. */
  provenanceVersion: number;
  /** Whether its turn checks the drafts it wrote now. */
  checking: boolean;
  /** What its turn's model request waits on now, if anything. */
  waiting: ModelWait | null;
}

/** A text the watcher has, and the one there is now: what it gains. */
const gained = (shown: string, now: string): { from: number; added: string } =>
  now.startsWith(shown)
    ? { from: shown.length, added: now.slice(shown.length) }
    : { from: 0, added: now };

/** What `now` adds to the response the watcher has (`shown`). */
export const partialUpdate = (
  shown: ChatPartial | null,
  now: ChatPartial | null
): ChatPartialUpdate | null => {
  if (now === null) {
    return null;
  }
  const text = gained(shown?.text ?? "", now.text);
  const reasoning = gained(shown?.reasoning ?? "", now.reasoning);
  return {
    from: text.from,
    text: text.added,
    reasoning: { from: reasoning.from, text: reasoning.added },
    code: now.code.map(({ callId, code }) => {
      const step = gained(
        shown?.code.find((before) => before.callId === callId)?.code ?? "",
        code
      );
      return { callId, from: step.from, code: step.added };
    }),
    tools: now.tools,
  };
};

/**
 * What `now` adds to the running step's output the watcher has (`shown`):
 * `undefined` when nothing changed.
 */
export const outputUpdate = (
  shown: ChatOutput | null,
  now: ChatOutput | null
): ChatOutputUpdate | null | undefined => {
  if (shown?.callId === now?.callId && shown?.text === now?.text) {
    return undefined;
  }
  if (now === null) {
    return null;
  }
  const { from, added } = gained(
    shown?.callId === now.callId ? shown.text : "",
    now.text
  );
  return { callId: now.callId, from, text: added };
};

/**
 * The update's `output` field: the whole output (`null` too) in a watch's
 * first update, which the page may apply over what an earlier watch left
 * it (after a reconnect, say); after that, there only when it changed.
 */
const outputChange = (
  shown: ChatOutput | null | undefined,
  now: ChatOutput | null
): Pick<ChatUpdate, "output"> => {
  if (shown === undefined) {
    return {
      output:
        now === null ? null : { callId: now.callId, from: 0, text: now.text },
    };
  }
  const change = outputUpdate(shown, now);
  return change === undefined ? {} : { output: change };
};

/**
 * One watcher of a chat (the Workspace object's `watch`). Each update
 * carries every stored message it hasn't had, in order, what the response
 * being written gained since (not all of it again), and the chat's
 * provenance only when it changed. So a response streaming in token by
 * token costs a slow connection a few small updates, and a message is
 * never lost or sent twice (`Pushes`).
 */
export class ChatWatch {
  readonly #pushes: Pushes<ChatUpdate>;
  readonly #state: () => ChatState;
  readonly #provenance: () => ChatProvenance;
  /** Stored messages this watcher hasn't had yet, oldest first. */
  readonly #unsent: ChatMessage[] = [];
  /** Calls of the chat's code this watcher hasn't had yet, oldest first. */
  readonly #unsentTools: ChatToolEvent[] = [];
  /** The response being written, as this watcher has it. */
  #shown: ChatPartial | null = null;
  /** The running step's output, as this watcher has it; `undefined` before its first update. */
  #shownOutput: ChatOutput | null | undefined = undefined;
  /** The provenance version this watcher has; none at first. */
  #provenanceSent: number | undefined;
  /** Where the person had read to as they began to follow it: sent once, first. */
  #seenUpTo: number | null | undefined;
  /**
   * Whether the chat has messages before the first this watcher sent, for
   * a watcher from the start: sent once, first.
   */
  #older: boolean | undefined;
  /** What the chat's answered Builds it made, for a watcher from the start: sent once, first. */
  #answeredBuilds: ChatMade[] | undefined;

  constructor(
    listener: ChatListener,
    state: () => ChatState,
    provenance: () => ChatProvenance,
    drop: () => void,
    seenUpTo: number | null,
    older: boolean | undefined,
    answeredBuilds: ChatMade[] | undefined
  ) {
    this.#pushes = new Pushes(listener, () => this.#next(), drop);
    this.#state = state;
    this.#provenance = provenance;
    this.#seenUpTo = seenUpTo;
    this.#older = older;
    this.#answeredBuilds = answeredBuilds;
  }

  /**
   * Sends the watcher `messages` and the calls of its code `tools`, and the
   * chat as it is when it goes out.
   */
  push(
    messages: readonly ChatMessage[] = [],
    tools: readonly ChatToolEvent[] = []
  ): void {
    this.#unsent.push(...messages);
    this.#unsentTools.push(...tools);
    this.#pushes.changed();
  }

  #next(): ChatUpdate {
    const {
      partial,
      output,
      running,
      queued,
      stopped,
      held,
      worked,
      provenanceVersion,
      checking,
      waiting,
    } = this.#state();
    const tools = this.#unsentTools.splice(0);
    const seenUpTo = this.#seenUpTo;
    this.#seenUpTo = undefined;
    const older = this.#older;
    this.#older = undefined;
    const answeredBuilds = this.#answeredBuilds;
    this.#answeredBuilds = undefined;
    const update: ChatUpdate = {
      messages: this.#unsent.splice(0),
      ...(seenUpTo === undefined ? {} : { seenUpTo }),
      ...(older === undefined ? {} : { older }),
      ...(answeredBuilds === undefined ? {} : { answeredBuilds }),
      partial: partialUpdate(this.#shown, partial),
      ...outputChange(this.#shownOutput, output),
      ...(tools.length === 0 ? {} : { tools }),
      running,
      ...(queued.length === 0 ? {} : { queued }),
      stopped,
      held,
      worked,
      checking,
      waiting,
      ...(provenanceVersion === this.#provenanceSent
        ? {}
        : { provenance: this.#provenance() }),
    };
    this.#shown = partial;
    this.#shownOutput = output;
    this.#provenanceSent = provenanceVersion;
    return update;
  }

  [Symbol.dispose](): void {
    this.#unsent.length = 0;
    this.#unsentTools.length = 0;
    this.#pushes[Symbol.dispose]();
  }
}
