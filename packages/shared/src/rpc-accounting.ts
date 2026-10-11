// What a Cap'n Web session may spend expanding the references in the
// messages a peer sends, bounded at the transport, before any target runs.
//
// Cap'n Web (0.12.0) resolves each `["pipeline", n]` or `["import", n]`
// that refers to a settled value a peer pushed by walking it with
// `ValueStubHook.get` and `RpcPayload.deepCopyFrom`: a full copy of the
// referred value, made while the message is read, before the method it is
// an argument to runs. A push can refer to earlier pushes, and refer to
// one twice, so a chain of tiny messages (`["push", [[p, p]]]` each
// referring to the one before) doubles the copy each step. About 17
// messages under 50 bytes each put hundreds of MB on the heap, and a
// `["pull", id]` resolves one the same way with no call. A core isolate
// has 128 MB and `CoreRpc` is reachable signed out, so this is an
// unauthenticated crash; the screen bridge has it in the browser too.
//
// Cap'n Web gives no hook on what it expands, so the bound is held at the
// transport, which sees every message as text: the one source of truth for
// its references. The wrapper parses each message once and hands the parsed
// value on (`encodingLevel: "jsonCompatible"`), so Cap'n Web doesn't parse
// it again. The cost charged is in *copied nodes*: the arrays, objects and
// leaves a deep copy of a message's references would allocate, each a node
// in the heap. Inline content a message carries directly isn't charged as
// copies, since it has a size on the wire, but its node count is bounded
// too, so one message can't flood the isolate with millions of tiny nodes.
//
// Counting nodes, not bytes, is what tells a reference bomb from a large
// but honest value. A megabyte of flat data copies nothing (it is inline);
// a reference that copies it once costs its node count; a reference bomb
// doubles that count every message, so it crosses the limit within a dozen
// tiny messages while real traffic — values sent inline, call results
// followed once — stays far below it. The node counts are the same for a
// 128 MB core isolate and a browser tab; only the byte limit differs.

/** What a session may spend expanding the references the peer's messages carry. */
export interface RpcAccountingLimits {
  /** The longest message, in UTF-16 code units of its JSON text. */
  readonly maxMessageBytes: number;
  /** How many nodes one message may hold, inline and copied together. */
  readonly maxMessageNodes: number;
  /** How many nodes one message's references may copy. */
  readonly maxMessageCopyNodes: number;
  /** How many copied nodes the live exports may hold together. */
  readonly maxSessionCopyNodes: number;
  /** How many of the peer's exports may be live at once. */
  readonly maxLiveExports: number;
  /**
   * What a reference to a value a call will answer counts as until the
   * answer settles: unknown when the reference is read, so a fixed number
   * of nodes. Once the answer is sent or received, the reference is priced
   * at its real node count instead.
   */
  readonly answerNodes: number;
}

/**
 * The node bounds a Cap'n Web session holds a peer to, for core's
 * connection and the screen bridge alike. A node is a node whatever the
 * transport, so the same counts fit a 128 MB core isolate and a browser
 * tab; each transport adds its own `maxMessageBytes`.
 *
 * - a message whose references copy more than `maxMessageCopyNodes` nodes
 *   is refused: a reference bomb reaches it within a dozen tiny messages,
 *   while a call that follows one earlier value copies far fewer;
 * - a message holding more than `maxMessageNodes` nodes is refused, so one
 *   message can't flood the isolate with millions of tiny inline nodes;
 * - the live exports hold no more than `maxSessionCopyNodes` copied nodes;
 * - no more than `maxLiveExports` of the peer's exports are live at once;
 * - a reference to a call's answer counts as `answerNodes` until the
 *   answer's real size is known.
 */
export const rpcCopyNodeBounds = {
  maxMessageNodes: 300_000,
  maxMessageCopyNodes: 4096,
  maxSessionCopyNodes: 49_152,
  maxLiveExports: 8192,
  answerNodes: 1024,
} as const;

/** Whether `value` is a Cap'n Web special: an array led by a string tag. */
const isSpecialArray = (value: unknown[]): value is [string, ...unknown[]] =>
  typeof value[0] === "string";

/** Whether a special refers to a value, by export ID: a pipeline or import. */
const isReferenceTag = (tag: string): boolean =>
  tag === "pipeline" || tag === "import";

/** What a copy of the message built so far holds and costs. */
interface WalkState {
  /** Nodes a copy of the value allocates: inline nodes and copies. */
  nodeCount: number;
  /** Nodes this value's references pull in from earlier messages. */
  copyCost: number;
  /** Whether the value holds a `remap`, which the peer may not send. */
  banned: boolean;
  /**
   * Whether the value holds a stub or promise the peer gave us (directly,
   * or by copying an export that holds one): a call made through it later
   * is answered by the peer, with a value of any size.
   */
  holdsPeerStub: boolean;
  /**
   * Whether the value holds a promise the peer gave us: the peer settles it
   * in place with a value of any size, which every later copy of this
   * export would then copy too.
   */
  holdsPeerPromise: boolean;
}

/** What the walk needs to know of the exports a value refers to. */
interface Exports {
  /** The nodes a copy of the export allocates. */
  nodesOf: (id: unknown) => number;
  /** Whether a call through the export is answered by the peer. */
  isPeerHeld: (id: unknown) => boolean;
}

/** A level of the walk: the array of children still to visit, by index. */
interface WalkFrame {
  items: readonly unknown[];
  index: number;
}

/**
 * Walks `root` without recursion, counting the nodes a copy of it allocates
 * and the nodes its references copy from earlier exports. The frame stack is
 * as deep as the value nests, never as wide, and only objects' values are
 * gathered into an array (an object can't be made huge cheaply, since JSON
 * keeps only the last of duplicate keys); arrays are indexed in place. The
 * walk stops once it is past any limit or hits a `remap`, so measuring a
 * bomb costs no more than the limits.
 */
const walk = (
  root: unknown,
  limits: RpcAccountingLimits,
  { nodesOf, isPeerHeld }: Exports
): WalkState => {
  const state: WalkState = {
    nodeCount: 0,
    copyCost: 0,
    banned: false,
    holdsPeerStub: false,
    holdsPeerPromise: false,
  };
  // What a call answered by the peer counts as: the whole budget, so a copy
  // of its answer (a nested call is put in place, copied) is refused.
  const peerAnswer = limits.maxSessionCopyNodes + 1;
  const frames: WalkFrame[] = [];
  const { maxMessageNodes, maxMessageCopyNodes } = limits;

  const visitSpecial = (value: readonly [string, ...unknown[]]): void => {
    const [tag] = value;
    if (isReferenceTag(tag)) {
      if (value.length >= 4) {
        // A call nested in a value: its answer is put in place, a copy. Ours
        // is unknown now, so `answerNodes`; the peer's, through a stub it
        // gave us, could be any size, so the whole budget.
        const answer = isPeerHeld(value[1]) ? peerAnswer : limits.answerNodes;
        state.copyCost += answer;
        state.nodeCount += answer;
        if (Array.isArray(value[3])) {
          frames.push({ items: value[3], index: 0 });
        }
      } else {
        const nodes = nodesOf(value[1]);
        state.copyCost += nodes;
        state.nodeCount += nodes + 1;
        if (isPeerHeld(value[1])) {
          state.holdsPeerStub = true;
        }
      }
    } else if (tag === "remap") {
      // Nothing we serve calls `.map()` on a stub, so the peer never sends
      // one; it would deep-copy its captures and run its instructions.
      state.banned = true;
    } else if (tag === "export" || tag === "promise") {
      // A stub or promise the peer gave us (a page's callback among them):
      // one node now. What the peer may later answer through it is priced
      // where it would be copied (`holdsPeerStub`, `holdsPeerPromise`).
      state.nodeCount += 1;
      state.holdsPeerStub = true;
      if (tag === "promise") {
        state.holdsPeerPromise = true;
      }
    } else if (tag === "bytes") {
      // One byte string: one node, nothing copied.
      state.nodeCount += 1;
    } else {
      // A date, an error, a URL and such: one node, measured by its members.
      state.nodeCount += 1;
      frames.push({ items: value.slice(1), index: 0 });
    }
  };

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      if (value.length === 1 && Array.isArray(value[0])) {
        // A literal array, as Cap'n Web wraps one: `[[a, b]]` is `[a, b]`.
        state.nodeCount += 1;
        frames.push({ items: value[0], index: 0 });
      } else if (isSpecialArray(value)) {
        visitSpecial(value);
      } else {
        state.nodeCount += 1;
        frames.push({ items: value, index: 0 });
      }
    } else if (value !== null && typeof value === "object") {
      state.nodeCount += 1;
      frames.push({ items: Object.values(value), index: 0 });
    } else {
      state.nodeCount += 1;
    }
  };

  visit(root);
  while (
    frames.length > 0 &&
    !state.banned &&
    state.nodeCount <= maxMessageNodes &&
    state.copyCost <= maxMessageCopyNodes
  ) {
    const frame = frames.at(-1);
    if (frame === undefined || frame.index >= frame.items.length) {
      frames.pop();
      continue;
    }
    visit(frame.items[frame.index]);
    frame.index += 1;
  }
  return state;
};

/** Why a session is ended: which bound the peer passed. */
export type AccountingRefusal =
  | "message"
  | "nodes"
  | "copy"
  | "session"
  | "exports"
  | "remap"
  | "release"
  | "unknown-export"
  | "bad-message"
  | "non-text";

/**
 * Accounts the peer's messages, one session's worth. `account` reads one
 * parsed message and returns why the session must end, or undefined to let
 * it through; `recordSent` reads a message we send, to price the answers we
 * give. It mirrors how Cap'n Web numbers the peer's exports (a push, a
 * stream or a pipe takes the next ID, in order), tracks their refcounts the
 * way Cap'n Web does, and what each refers to, so the nodes it counts are
 * the nodes Cap'n Web is about to copy. State is the session's own: it must
 * not be shared between sessions.
 */
export const messageAccountant = (
  limits: RpcAccountingLimits
): {
  account: (message: unknown) => AccountingRefusal | undefined;
  recordSent: (message: unknown) => void;
} => {
  const {
    maxMessageNodes,
    maxMessageCopyNodes,
    maxSessionCopyNodes,
    maxLiveExports,
    answerNodes,
  } = limits;
  // An export's node count: what a later reference to it copies.
  const recorded = new Map<number, number>();
  // An export's copy cost: the copied nodes it holds live, to let go on release.
  const held = new Map<number, number>();
  // An export's refcount, mirrored from Cap'n Web, so a release frees it
  // exactly when Cap'n Web does and no sooner.
  const refcount = new Map<number, number>();
  let liveCopyNodes = 0;
  let liveCount = 0;
  // The next export ID, as Cap'n Web assigns them: the main export is 0, so
  // the peer's first push, stream or pipe is 1.
  let nextExport = 1;

  // A reference to an export the accountant tracks copies its recorded
  // nodes; to an unknown positive export, the session's whole budget, so an
  // id that was freed (or never made) fails closed rather than costing
  // nothing while Cap'n Web still copies it; to the main export or one of
  // ours (id <= 0), a stub's worth, since those are capabilities, not data.
  const nodesOf = (id: unknown): number => {
    if (typeof id !== "number") {
      return 0;
    }
    const known = recorded.get(id);
    if (known !== undefined) {
      return known;
    }
    return id > 0 ? maxSessionCopyNodes + 1 : answerNodes;
  };

  // The peer's exports a call through goes to the peer: a value holding a
  // stub or promise it gave us, a copy of one, or a call whose target or
  // arguments hold one (a method may hand the stub back). What such a call
  // answers is the peer's to choose, so it is priced where it is copied.
  const peerHeld = new Set<number>();
  const isPeerHeld = (id: unknown): boolean =>
    typeof id === "number" && peerHeld.has(id);

  const walkValue = (value: unknown): WalkState =>
    walk(value, limits, { nodesOf, isPeerHeld });

  const overWalk = (state: WalkState): AccountingRefusal | undefined => {
    if (state.banned) {
      return "remap";
    }
    if (state.nodeCount > maxMessageNodes) {
      return "nodes";
    }
    if (state.copyCost > maxMessageCopyNodes) {
      return "copy";
    }
    return undefined;
  };

  // Stream exports, which Cap'n Web auto-releases right after it sends their
  // answer (`autoRelease` in 0.12.0): they take an ID and can be referred to
  // like any other while pending, but they don't count against the live
  // budget. Their entries are dropped when the answer is sent
  // (`recordSent`), as Cap'n Web frees them, so a peer that streams without
  // ever releasing can't grow these maps; and no more than
  // `maxLiveExports` may be pending at once. (A pipe is not auto-released:
  // Cap'n Web frees it only on the peer's release, so it counts as live.)
  const pendingStreams = new Set<number>();

  const addExport = (
    recordedNodes: number,
    copyCost: number,
    { counted = true, peer = false }: { counted?: boolean; peer?: boolean } = {}
  ): AccountingRefusal | undefined => {
    const id = nextExport;
    nextExport += 1;
    recorded.set(id, Math.min(recordedNodes, maxSessionCopyNodes + 1));
    held.set(id, copyCost);
    refcount.set(id, 1);
    if (peer) {
      peerHeld.add(id);
    }
    if (!counted) {
      pendingStreams.add(id);
      return pendingStreams.size > maxLiveExports ? "exports" : undefined;
    }
    liveCopyNodes += copyCost;
    liveCount += 1;
    if (liveCopyNodes > maxSessionCopyNodes) {
      return "session";
    }
    if (liveCount > maxLiveExports) {
      return "exports";
    }
    return undefined;
  };

  // A push or a stream makes an export, priced by what a later copy of it
  // would allocate:
  // - a call through one of the peer's stubs is answered by the peer, with
  //   a value of any size: the whole budget;
  // - any other call is answered by us: `answerNodes` until our answer is
  //   sent and measured (`recordSent`);
  // - a value holding a promise the peer gave us is settled by the peer in
  //   place: the whole budget;
  // - any other value: the nodes a copy of it allocates.
  // A page passing its own callback as an argument is none of these: the
  // call's answer is ours, and the subscription it gets back is pulled,
  // called and released as usual. What this message copies now is its
  // references' nodes, checked against one message's budget.
  const peerAnswer = maxSessionCopyNodes + 1;

  const accountPush = (
    expression: unknown,
    counted: boolean
  ): AccountingRefusal | undefined => {
    const isCall =
      Array.isArray(expression) &&
      isSpecialArray(expression) &&
      isReferenceTag(expression[0]) &&
      expression.length >= 4;
    const state = walkValue(isCall ? expression[3] : expression);
    const over = overWalk(state);
    if (over !== undefined) {
      return over;
    }
    if (isCall) {
      const throughPeer = isPeerHeld(expression[1]);
      return addExport(throughPeer ? peerAnswer : answerNodes, state.copyCost, {
        counted,
        peer: throughPeer || state.holdsPeerStub,
      });
    }
    return addExport(
      state.holdsPeerPromise ? peerAnswer : state.nodeCount,
      state.copyCost,
      { counted, peer: state.holdsPeerStub }
    );
  };

  // A release frees an export only when its refcount reaches zero, as Cap'n
  // Web does; a count that isn't a whole number from one to the refcount is
  // a shape Cap'n Web wouldn't accept, so the session ends. A negative or
  // main id is one of ours; the accountant doesn't price those, so it only
  // checks the shape and leaves them be.
  const accountRelease = (
    id: unknown,
    count: unknown
  ): AccountingRefusal | undefined => {
    if (typeof id !== "number" || typeof count !== "number") {
      return "bad-message";
    }
    if (id <= 0) {
      return undefined;
    }
    const current = refcount.get(id);
    if (current === undefined) {
      return "unknown-export";
    }
    if (!Number.isInteger(count) || count < 1 || count > current) {
      return "release";
    }
    const left = current - count;
    if (left > 0) {
      refcount.set(id, left);
      return undefined;
    }
    if (pendingStreams.has(id)) {
      pendingStreams.delete(id);
    } else {
      liveCopyNodes -= held.get(id) ?? 0;
      liveCount -= 1;
    }
    recorded.delete(id);
    held.delete(id);
    refcount.delete(id);
    peerHeld.delete(id);
    return undefined;
  };

  // A pull resolves an export and copies it once; its value was bounded
  // when the export was made or settled, so a pull adds no session cost. A
  // pull of an unknown positive export fails closed, as a reference does.
  const accountPull = (id: unknown): AccountingRefusal | undefined => {
    if (typeof id === "number" && id > 0 && !recorded.has(id)) {
      return "unknown-export";
    }
    return undefined;
  };

  const account = (message: unknown): AccountingRefusal | undefined => {
    if (!Array.isArray(message)) {
      return "bad-message";
    }
    const parts: unknown[] = message;
    const [kind, arg1, arg2] = parts;
    if (kind === "push") {
      return parts.length < 2 ? "bad-message" : accountPush(arg1, true);
    }
    if (kind === "stream") {
      // A stream's value is deep-copied like a push's, but Cap'n Web
      // auto-releases the export once it answers, so it doesn't count.
      return parts.length < 2 ? "bad-message" : accountPush(arg1, false);
    }
    if (kind === "pipe") {
      // A writable the peer pipes into: freed only on the peer's release.
      return addExport(answerNodes, 0);
    }
    if (kind === "resolve" || kind === "reject" || kind === "abort") {
      // These carry a value the peer sends, copied too, but make no export.
      return overWalk(walkValue(kind === "abort" ? arg1 : arg2));
    }
    if (kind === "release") {
      return accountRelease(arg1, arg2);
    }
    if (kind === "pull") {
      return accountPull(arg1);
    }
    return "bad-message";
  };

  // What we answer the peer: a resolve or reject settles an export, so the
  // peer's later references to it copy its real value, not the `answerNodes`
  // it was priced at. Recording its node count here closes the gap where a
  // large answer, referred to again, would be copied for far less than it
  // costs. We produce these values, so measuring them is bounded by what we
  // already serialized. Only a still-live export is recorded: one already
  // released (or auto-released after a stream answers) must stay unknown, so
  // a later reference to it fails closed rather than being priced.
  const recordSent = (message: unknown): void => {
    if (!Array.isArray(message)) {
      return;
    }
    const parts: unknown[] = message;
    const [kind, id, value] = parts;
    if (
      (kind !== "resolve" && kind !== "reject") ||
      typeof id !== "number" ||
      !refcount.has(id)
    ) {
      return;
    }
    if (pendingStreams.has(id)) {
      // Cap'n Web auto-releases a stream export as soon as its answer is
      // sent, so it is gone now: drop it, and a later reference fails closed.
      pendingStreams.delete(id);
      recorded.delete(id);
      held.delete(id);
      refcount.delete(id);
      peerHeld.delete(id);
      return;
    }
    const { nodeCount } = walkValue(value);
    recorded.set(id, Math.min(nodeCount, maxSessionCopyNodes + 1));
  };

  return { account, recordSent };
};

// Character codes the structural scan watches for.
const QUOTE = 34;
const BACKSLASH = 92;
const OPEN_BRACKET = 91;
const CLOSE_BRACKET = 93;
const OPEN_BRACE = 123;
const CLOSE_BRACE = 125;
const COMMA = 44;
const COLON = 58;
const SPACE = 32;
const TAB = 9;
const NEWLINE = 10;
const RETURN = 13;

/** Whether a character outside a string neither starts nor holds a value. */
const isJsonSeparator = (code: number | undefined): boolean =>
  code === OPEN_BRACKET ||
  code === CLOSE_BRACKET ||
  code === OPEN_BRACE ||
  code === CLOSE_BRACE ||
  code === COMMA ||
  code === COLON ||
  code === SPACE ||
  code === TAB ||
  code === NEWLINE ||
  code === RETURN;

/**
 * At least how many nodes `raw` would parse into, counted from its text
 * alone, stopping once past `limit`. JSON.parse of a message full of tiny
 * nodes allocates them all before anything can bound it (a 14 MiB message of
 * them is hundreds of MB), so this scans the text first — no allocation, one
 * pass — and a message that would parse into more than the limit is refused
 * before it is parsed. It counts a node wherever a value begins: each array
 * or object (a bracket or brace), each string (a quote, then it skips to the
 * close, past escapes), and each run of characters that spells a number,
 * `true`, `false` or `null`. Characters inside a string, a base64 upload
 * among them, are skipped. Duplicate object keys make JSON.parse keep fewer
 * nodes than this counts, so the count is never below the parsed node count.
 */
export const scanStructuralNodes = (raw: string, limit: number): number => {
  let count = 0;
  let inString = false;
  let escaped = false;
  let inPrimitive = false;
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.codePointAt(index);
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (code === BACKSLASH) {
        escaped = true;
      } else if (code === QUOTE) {
        inString = false;
      }
      continue;
    }
    if (code === QUOTE) {
      inString = true;
      inPrimitive = false;
      count += 1;
    } else if (code === OPEN_BRACKET || code === OPEN_BRACE) {
      inPrimitive = false;
      count += 1;
    } else if (isJsonSeparator(code)) {
      inPrimitive = false;
    } else if (!inPrimitive) {
      // The first character of a number, `true`, `false` or `null`.
      inPrimitive = true;
      count += 1;
    }
    if (count > limit) {
      return count;
    }
  }
  return count;
};

/** A transport that carries Cap'n Web's messages as text. */
export interface TextRpcTransport {
  send: (message: string) => void | Promise<void>;
  receive: () => Promise<unknown>;
  abort?: (reason: unknown) => void;
}

/**
 * Wraps `inner` so each message the peer sends is parsed once, accounted
 * (`messageAccountant`), and handed to Cap'n Web as a parsed value, which it
 * doesn't parse again (`encodingLevel: "jsonCompatible"`). Cap'n Web then
 * skips its own size check, so this enforces `maxMessageBytes` on the raw
 * text first. A message past the limits, one that isn't text, and one that
 * isn't JSON or isn't an array all end the session with `onRefused`'s error,
 * before any value is expanded. The answers we send back are measured too,
 * so the peer's later references to them are priced at their real size.
 */
export const accountedTransport = (
  inner: TextRpcTransport,
  limits: RpcAccountingLimits,
  onRefused: (refusal: AccountingRefusal) => Error
): {
  encodingLevel: "jsonCompatible";
  send: (message: unknown) => void;
  receive: () => Promise<unknown>;
  abort: (reason: unknown) => void;
} => {
  const { account, recordSent } = messageAccountant(limits);
  const refuse = (refusal: AccountingRefusal): never => {
    const error = onRefused(refusal);
    inner.abort?.(error);
    throw error;
  };
  return {
    encodingLevel: "jsonCompatible",
    send: (message: unknown): void => {
      recordSent(message);
      // Cap'n Web's custom-encoding transport sends synchronously; our inner
      // string transports (WebSocket, port) do too.
      void inner.send(JSON.stringify(message));
    },
    receive: async (): Promise<unknown> => {
      const raw = await inner.receive();
      if (typeof raw !== "string") {
        return refuse("non-text");
      }
      if (raw.length > limits.maxMessageBytes) {
        return refuse("message");
      }
      // Bound the node count from the text before parsing it, so a flood of
      // tiny nodes can't exhaust the isolate inside JSON.parse itself.
      if (
        scanStructuralNodes(raw, limits.maxMessageNodes) >
        limits.maxMessageNodes
      ) {
        return refuse("nodes");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return refuse("bad-message");
      }
      const refusal = account(parsed);
      if (refusal !== undefined) {
        return refuse(refusal);
      }
      return parsed;
    },
    abort: (reason) => inner.abort?.(reason),
  };
};
