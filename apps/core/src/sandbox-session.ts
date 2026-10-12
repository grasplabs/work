import { whenAborted } from "@grasp-os/shared/deadline";
import type {
  HeldPool,
  RpcAccountingLimits,
} from "@grasp-os/shared/rpc-accounting";
import {
  accountedTransport,
  heldPool,
  rpcCopyNodeBounds,
} from "@grasp-os/shared/rpc-accounting";
import { boundedRpcTarget } from "@grasp-os/shared/rpc-target";
import { rpcArgumentDepth, screenLimits } from "@grasp-os/shared/screens";
import { RpcSession, WebSocketTransport } from "capnweb";

import { sessionMaxRuns } from "./call-limits.ts";
import { browserMessageSize } from "./rpc-target.ts";
import {
  sandboxCpuHeader,
  sandboxDeadlineHeader,
  sandboxWaitHeader,
  sandboxWaitMs,
  SandboxUnavailableError,
} from "./sandboxed.ts";

// One call of an isolate that reaches back into core, on the on-prem
// sandbox host (on-prem/sandbox-session.ts): an App function's operation
// channel, a workflow run's host, Code Mode's APIs. workerd can't send a
// stub to another process, so core opens a WebSocket per call through the
// sandbox supervisor (scripts/workerd-sandbox.ts) and passes the call's
// capabilities over Cap'n Web. Threat model, and how each is closed:
// - A capability outlives its call, or reaches another call's resources.
//   It exists only in this call's session, which core closes when the call
//   settles; the process is killed after its one call; each capability is
//   the call's own object (an invocation's channel, a run's host).
// - App code forges a capability. It holds only the sandbox host's
//   forwarders, each with the methods core named here; Cap'n Web's export
//   IDs never reach it. Each forwarder here bounds what arrives before the
//   capability's own checks run, and the session is accounted as a
//   browser's is (rpc.ts): deep, big, many.
// - App code runs too long or too much. The supervisor kills its process
//   past its CPU-time budget, memory or wall-clock cap; core gives up on
//   its own clock a little later still. Which of those it was, or a crash,
//   core reads from the supervisor's verdict on the call's ID: the App's
//   failure. A closed session without one is the sandbox being unavailable.

/** A capability passed into a session: an object's methods, or a function. */
export interface SessionCapability {
  readonly target: object;
  readonly methods: readonly string[];
  /** Passed to the isolate as a function, called through `call`. */
  readonly function: boolean;
}

/** One argument of a session's call: a JSON value, or a capability. */
export type SessionArgument =
  | { readonly value: unknown }
  | { readonly capability: SessionCapability };

/** One call in a session. */
export interface SessionCall {
  readonly mainModule: string;
  readonly modules: Readonly<Record<string, string>>;
  readonly entrypoint: string;
  readonly method: string;
  readonly args: readonly SessionArgument[];
  /** CPU time the call may use: the runtime's limit on Cloudflare. */
  readonly cpuMs: number;
  /** Wall-clock time the call may take, waits included. */
  readonly wallMs: number;
  /**
   * Whose call it is (an App, a person's Code Mode): the supervisor lets
   * one owner hold at most part of its pool at once.
   */
  readonly owner: string;
  /**
   * Tests only: how long the session stays open once the call settled, to
   * show its capabilities refuse once the call is over, open or not.
   */
  readonly lingerMs?: number;
}

/** A call made in a session already open, in its process. */
export type NestedCall = Pick<
  SessionCall,
  "mainModule" | "modules" | "entrypoint" | "method" | "args"
>;

/**
 * Runs `call` in the open session it was given for, as the session's own
 * call waits; `signal` gives up on it (its process is the session's).
 */
export type NestedRun = (
  call: NestedCall,
  signal?: AbortSignal
) => Promise<unknown>;

/** How a call in a session is followed, besides the call itself. */
export interface SessionOptions {
  /** Ends the call and frees its process: a cancel, or a deadline core keeps. */
  readonly signal?: AbortSignal;
  /**
   * What every session of the isolate holds together; `sessionsHeld`
   * unless a test gives a pool of its own.
   */
  readonly held?: HeldPool;
  /**
   * Lets more calls run in the session while it's open (`open` gets how),
   * and keeps it open, once its own call settled, until they have
   * (`drain`): an App function's nested calls, which run in the process of
   * the call they're nested in, idle while it waits for them, rather than
   * each take one of the owner's share.
   */
  readonly nesting?: {
    readonly open: (run: NestedRun) => void;
    /** Gets the session's own call's answer as it comes, before draining. */
    readonly answered: (answer: unknown) => void;
    readonly drain: () => Promise<void>;
  };
}

/** The methods `target`'s class and those above it declare, by name. */
const methodsOf = (target: object): string[] => {
  const names = new Set<string>();
  for (
    let current: object | null = Reflect.getPrototypeOf(target);
    current !== null && current !== Object.prototype;
    current = Reflect.getPrototypeOf(current)
  ) {
    for (const name of Reflect.ownKeys(current)) {
      const value: unknown = Reflect.getOwnPropertyDescriptor(
        current,
        name
      )?.value;
      if (
        typeof name === "string" &&
        name !== "constructor" &&
        typeof value === "function"
      ) {
        names.add(name);
      }
    }
  }
  return [...names];
};

/** `target` as a capability: its class's methods, or the ones named. */
export const capability = (
  target: object,
  methods: readonly string[] = methodsOf(target)
): SessionCapability => ({ target, methods, function: false });

/** `fn` as a capability the isolate gets as a function. */
export const functionCapability = (
  fn: (...args: never[]) => unknown
): SessionCapability => ({
  target: { call: fn },
  methods: ["call"],
  function: true,
});

/**
 * The longest message a session takes, either way, in UTF-16 code units: a
 * browser connection's (rpc-target.ts), which a core isolate is sized for.
 */
const sessionMessageSize = browserMessageSize;

/**
 * What one session may hold: a message of the largest size at one byte a
 * character, and some room besides. A session past it is the App's fault.
 */
const sessionHeldBytes = 16 * 1024 * 1024;

/** What a session may spend: a browser's message size (rpc-target.ts). */
const sessionAccounting: RpcAccountingLimits = {
  ...rpcCopyNodeBounds,
  maxMessageBytes: sessionMessageSize,
  maxSessionBytes: sessionHeldBytes,
};

/**
 * What every session of this isolate may hold together: a pool of their
 * own, apart from the browsers' (`isolateRpcHeld`), so App code reaching
 * back through sessions can't end people's browser connections. Room for
 * the supervisor's default four processes each at their own limit; past
 * that (a larger pool of processes), a full pool ends the session that
 * crosses it as `busy`, never as the App's fault.
 */
const sessionsHeld = heldPool(4 * sessionHeldBytes);

/** What a forwarder's methods take: as deep and big as one message makes. */
const SessionTarget = boundedRpcTarget({
  depth: rpcArgumentDepth,
  size: sessionMessageSize,
});

/**
 * A forwarder to `capability`: its methods, bounded, nothing else, and only
 * while `live` says the call is open: one used after the call is refused,
 * whether or not its session is still there.
 */
export const sessionForwarder = (
  { target, methods }: SessionCapability,
  live: () => boolean
): object => {
  class Forwarder extends SessionTarget {}
  for (const name of methods) {
    // Writable and configurable, as a class's own methods are: the
    // bounded base wraps it on first construction (rpc-target.ts).
    Object.defineProperty(Forwarder.prototype, name, {
      writable: true,
      configurable: true,
      async value(...args: unknown[]): Promise<unknown> {
        if (!live()) {
          throw new Error("The call this capability was passed for is over.");
        }
        const method: unknown = Reflect.get(target, name);
        if (typeof method !== "function") {
          throw new TypeError(`That capability has no method ${name}.`);
        }
        return await Reflect.apply(method, target, args);
      },
    });
  }
  return new Forwarder();
};

/** How much longer than the supervisor may take core waits for a session. */
const backstopMs = 2000;

/** The header core gives a session's ID in, which its verdict is asked by. */
export const sandboxCallIdHeader = "x-grasp-sandbox-call";

/** The header core says whose session it is in, for the per-owner cap. */
export const sandboxOwnerHeader = "x-grasp-sandbox-owner";

/** A verdict as the supervisor gives it. */
interface Verdict {
  verdict: string;
  message: string;
}

const verdictSchema = (body: unknown): Verdict | undefined =>
  typeof body === "object" &&
  body !== null &&
  "verdict" in body &&
  typeof body.verdict === "string" &&
  "message" in body &&
  typeof body.message === "string"
    ? { verdict: body.verdict, message: body.message }
    : undefined;

/**
 * The verdicts of errors core made, by error: never a property of the
 * error itself, which App code could set on one it throws.
 */
const verdicts = new WeakMap<Error, string>();

/** An error saying the sandbox ended the call for the App's code, and why. */
const verdictError = (verdict: Verdict, cause?: unknown): Error => {
  const error = new Error(verdict.message, { cause });
  verdicts.set(error, verdict.verdict);
  return error;
};

/**
 * Why the sandbox ended a session's call, for an error `runInSession`
 * threw: `deadline`, `cpu`, `memory` or `crashed` (the supervisor's),
 * `refused` (the App's code sent what a session doesn't take), `busy` (its
 * owner holds as many sessions as it may); undefined otherwise.
 */
export const sandboxVerdictOf = (error: unknown): string | undefined =>
  error instanceof Error ? verdicts.get(error) : undefined;

/** What the supervisor blamed the App for in session `id`, if anything. */
const verdictOf = async (
  host: Fetcher,
  id: string
): Promise<Verdict | undefined> => {
  try {
    const response = await host.fetch(`http://sandbox/verdict/${id}`, {
      signal: AbortSignal.timeout(backstopMs),
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      return undefined;
    }
    return verdictSchema(await response.json());
  } catch {
    return undefined;
  }
};

/**
 * Tells the supervisor session `id` is over: `cancel` for a call core gave
 * up on, `end` for one that settled. Never throws.
 */
const endSession = async (
  host: Fetcher,
  id: string,
  how: "cancel" | "end"
): Promise<void> => {
  const tell = async (): Promise<boolean> => {
    try {
      const response = await host.fetch(`http://sandbox/${how}/${id}`, {
        method: "POST",
        signal: AbortSignal.timeout(backstopMs),
      });
      await response.body?.cancel();
      // Taken, or the session is over already (404): either way, done.
      return response.status < 500;
    } catch {
      return false;
    }
  };
  // Tried twice: one lost costs the session's process until the supervisor
  // sees core's close frame, or its wall-clock cap.
  if (!(await tell())) {
    await tell();
  }
};
/**
 * Rejects with `error` after `ms`, unless `signal` aborts first: then it
 * resolves, with no rejection left for anyone to handle.
 */
const rejectAfter = async (
  ms: number,
  error: Error,
  signal: AbortSignal
): Promise<undefined> => {
  try {
    await scheduler.wait(ms, { signal });
  } catch {
    // Cleared: the call settled first, and nothing waits on this.
    return undefined;
  }
  throw error;
};

/**
 * What `call` answers, run on the sandbox host in a session of its own.
 * Throws what the isolate's entrypoint threw, an error saying why the
 * sandbox ended it (the App's), or {@link SandboxUnavailableError}.
 */
/**
 * The session's socket, accepted: once the supervisor took the call and
 * says it bounds its CPU time as asked. Refused otherwise: `busy` for an
 * owner at its cap, unavailable for anything else.
 */
const openSession = async (
  host: Fetcher,
  call: SessionCall,
  id: string,
  signal: AbortSignal | undefined
): Promise<WebSocket> => {
  // The supervisor answers within its waits for the owner's room and a
  // process: one that never does is unavailable, never waited on for good.
  // Only until it answers: the request's signal goes on to end its socket.
  const unanswered = new AbortController();
  const answerBy = setTimeout(
    () => {
      unanswered.abort(new Error("The sandbox host didn't answer in time."));
    },
    2 * sandboxWaitMs + backstopMs
  );
  let response: Response;
  try {
    response = await host.fetch("http://sandbox/session", {
      headers: {
        upgrade: "websocket",
        [sandboxDeadlineHeader]: String(call.wallMs),
        [sandboxCpuHeader]: String(call.cpuMs),
        [sandboxWaitHeader]: String(sandboxWaitMs),
        [sandboxCallIdHeader]: id,
        [sandboxOwnerHeader]: call.owner,
      },
      signal:
        signal === undefined
          ? unanswered.signal
          : AbortSignal.any([signal, unanswered.signal]),
    });
  } catch (error) {
    // It may have taken the session, and hold a process for it.
    await endSession(host, id, "cancel");
    signal?.throwIfAborted();
    throw new SandboxUnavailableError("The sandbox host didn't answer.", {
      cause: error,
    });
  } finally {
    clearTimeout(answerBy);
  }
  const socket = response.webSocket;
  if (socket === null) {
    await response.body?.cancel();
    if (response.status === 429) {
      throw verdictError({
        verdict: "busy",
        message: "It already runs as many calls in the sandbox as it may.",
      });
    }
    throw new SandboxUnavailableError(
      `The sandbox host answered ${response.status}.`
    );
  }
  socket.accept();
  // The supervisor says the CPU time it bounds the call to: no session runs
  // App code on a sandbox that doesn't (a code run then claims no limit).
  if (response.headers.get(sandboxCpuHeader) !== String(call.cpuMs)) {
    socket.close(1011, "The sandbox doesn't bound the call's CPU time.");
    // It holds a process for the session all the same.
    await endSession(host, id, "end");
    throw new SandboxUnavailableError(
      "The sandbox doesn't bound the call's CPU time."
    );
  }
  return socket;
};

/**
 * What a session's call ended with, as `runInSession` throws it: the
 * cancel, the App's failure (what it threw or sent, or the supervisor's
 * verdict), or the sandbox being unavailable.
 */
const failureOf = async (
  error: unknown,
  {
    host,
    id,
    closed,
    signal,
  }: {
    host: Fetcher;
    id: string;
    closed: boolean;
    signal: AbortSignal | undefined;
  }
): Promise<unknown> => {
  if (signal?.aborted === true) {
    // Cancelled, or past a deadline core keeps: the socket closes, and with
    // it the call's process.
    return signal.reason;
  }
  if (sandboxVerdictOf(error) !== undefined || !closed) {
    // The App's: what its isolate's entrypoint threw, or what it sent.
    return error;
  }
  const verdict = await verdictOf(host, id);
  return verdict === undefined
    ? new SandboxUnavailableError("The sandbox session ended.", {
        cause: error,
      })
    : verdictError(verdict, error);
};

export const runInSession = async (
  host: Fetcher,
  call: SessionCall,
  { signal, held = sessionsHeld, nesting }: SessionOptions = {}
): Promise<unknown> => {
  signal?.throwIfAborted();
  const id = crypto.randomUUID();
  const socket = await openSession(host, call, id, signal);
  let closed = false;
  socket.addEventListener("close", () => {
    closed = true;
  });
  // What the App's code sends that a session doesn't take (too much, too
  // deep, a value of no kind a call takes) is its own failure.
  // A refusal ends the session whichever way the message went: one of
  // core's own answers (or the call itself) past a bound is refused as it's
  // sent, which no pending call hears of, so the call waits on this too.
  const { promise: refusedWith, resolve: refused } =
    Promise.withResolvers<Error>();
  // Raced with the call below from its start, so its rejection is handled.
  const whenRefused = (async (): Promise<never> => {
    throw await refusedWith;
  })();
  const transport = accountedTransport(
    new WebSocketTransport(socket),
    sessionAccounting,
    (refusal) => {
      // Every session's holdings together past the isolate's pool: the
      // session crossing it is ended, but the App may hold little; it's
      // busy, as an owner at its cap is, never the App's fault.
      const error =
        refusal === "isolate"
          ? verdictError({
              verdict: "busy",
              message:
                "Core holds as much for calls in the sandbox as it may. Try again shortly.",
            })
          : verdictError({
              verdict: "refused",
              message:
                "The App's code sent more than a call in the sandbox takes.",
            });
      refused(error);
      return error;
    },
    held
  );
  const session = new RpcSession(transport, undefined, {
    limits: {
      maxDepth: screenLimits.rpc.maxDepth,
      maxBigIntDigits: screenLimits.rpc.maxBigIntDigits,
    },
  });
  // Every capability by a name of the session's own: the isolate never
  // sees these, only what the sandbox host makes of them.
  let live = true;
  // Given up on: its capabilities refuse from now, not once the supervisor
  // has been asked to end the call.
  const giveUp = (): void => {
    live = false;
  };
  // Whether the supervisor was told the session is over already.
  let told = false;
  signal?.addEventListener("abort", giveUp, { once: true });
  // A call in the session: each capability by a name of the call's own,
  // its forwarder live while `isLive` says; the isolate never sees these,
  // only what the sandbox host makes of them.
  const callIn = (given: NestedCall, isCallLive: () => boolean): unknown => {
    const specs: Record<string, { methods: string[] } | { function: true }> =
      {};
    const stubs: Record<string, object> = {};
    const named = (passed: SessionCapability): string => {
      const name = `c${Object.keys(specs).length}`;
      specs[name] = passed.function
        ? { function: true }
        : { methods: [...passed.methods] };
      stubs[name] = sessionForwarder(passed, isCallLive);
      return name;
    };
    const args = given.args.map((arg) =>
      "capability" in arg ? { capability: named(arg.capability) } : arg
    );
    const remote: unknown = session.getRemoteMain();
    const run: unknown =
      typeof remote === "object" || typeof remote === "function"
        ? Reflect.get(remote ?? {}, "run")
        : undefined;
    if (typeof run !== "function") {
      throw new SandboxUnavailableError("The session has no call to run.");
    }
    return Reflect.apply(run, remote, [
      {
        mainModule: given.mainModule,
        modules: given.modules,
        entrypoint: given.entrypoint,
        method: given.method,
        args,
        capabilities: specs,
      },
      stubs,
    ]);
  };
  const settled = new AbortController();
  const overdue = new SandboxUnavailableError(
    "The sandbox didn't end the call in time."
  );
  const backstop = rejectAfter(
    sandboxWaitMs + call.wallMs + backstopMs,
    overdue,
    settled.signal
  );
  const bounds = [
    whenRefused,
    backstop,
    ...(signal === undefined ? [] : [whenAborted(signal)]),
  ];
  // A nested call ends as its own call does, its capabilities with it, or
  // as the session does.
  // Runs of App code in the session: past what one call makes, refused
  // here, never reaching the sandbox host's own bound.
  let runs = 1;
  nesting?.open(async (given, nestedSignal) => {
    if (runs >= sessionMaxRuns) {
      throw verdictError({
        verdict: "call_limit",
        message: "This call ran more functions than one call may.",
      });
    }
    runs += 1;
    let nestedLive = true;
    try {
      return await Promise.race([
        callIn(given, () => nestedLive && live),
        ...bounds,
        ...(nestedSignal === undefined ? [] : [whenAborted(nestedSignal)]),
      ]);
    } catch (error) {
      nestedLive = false;
      if (signal?.aborted === true && nestedSignal?.aborted !== true) {
        // The call it runs in was given up on, at its deadline or by its
        // caller: so is this one, never through a fault of its own.
        throw verdictError({
          verdict: "deadline",
          message: "The call this function was called in was stopped.",
        });
      }
      throw await failureOf(error, { host, id, closed, signal: nestedSignal });
    } finally {
      nestedLive = false;
    }
  });
  // The session's own call: its capabilities refuse once it answered, as a
  // nested call's do, though the session stays open for those it started.
  let topLive = true;
  try {
    const answer = await Promise.race([
      callIn(call, () => topLive && live),
      ...bounds,
    ]);
    topLive = false;
    if (nesting !== undefined) {
      nesting.answered(answer);
      await Promise.race([nesting.drain(), ...bounds]);
    }
    return answer;
  } catch (error) {
    topLive = false;
    giveUp();
    if (signal?.aborted === true || error === overdue) {
      // Given up on: the supervisor ends the call and frees its process at
      // once, whatever the sandbox host does with the closing socket.
      told = true;
      await endSession(host, id, "cancel");
    }
    throw await failureOf(error, { host, id, closed, signal });
  } finally {
    giveUp();
    signal?.removeEventListener("abort", giveUp);
    settled.abort();
    if (call.lingerMs !== undefined && !closed) {
      await scheduler.wait(call.lingerMs);
    }
    try {
      socket.close(1000, "The call is over.");
    } catch {
      // Closed already.
    }
    // Its close alone may never reach the supervisor (the handshake waits
    // on the sandbox host): it frees the process when told.
    if (!told && !closed) {
      await endSession(host, id, "end");
    }
  }
};
