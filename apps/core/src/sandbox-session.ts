import type { RpcAccountingLimits } from "@grasp-os/shared/rpc-accounting";
import {
  accountedTransport,
  rpcCopyNodeBounds,
} from "@grasp-os/shared/rpc-accounting";
import { boundedRpcTarget } from "@grasp-os/shared/rpc-target";
import { rpcArgumentDepth, screenLimits } from "@grasp-os/shared/screens";
import { RpcSession, WebSocketTransport } from "capnweb";

import { isolateRpcHeld } from "./rpc-target.ts";
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

/** The longest message a session takes, either way, in UTF-16 code units. */
const sessionMessageSize = 16 * 1024 * 1024;

/** What a session may spend, as a browser's connection may (rpc-target.ts). */
const sessionAccounting: RpcAccountingLimits = {
  ...rpcCopyNodeBounds,
  maxMessageBytes: sessionMessageSize,
  maxSessionBytes: 32 * 1024 * 1024,
};

/** What a forwarder's methods take: as deep and big as one message makes. */
const SessionTarget = boundedRpcTarget({
  depth: rpcArgumentDepth,
  size: sessionMessageSize,
});

/** A forwarder to `capability`: its methods, bounded, nothing else. */
const forwarderOf = ({ target, methods }: SessionCapability): object => {
  class Forwarder extends SessionTarget {}
  for (const name of methods) {
    Object.defineProperty(Forwarder.prototype, name, {
      async value(...args: unknown[]): Promise<unknown> {
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

const verdictSchema = (body: unknown): string | undefined =>
  typeof body === "object" &&
  body !== null &&
  "verdict" in body &&
  typeof body.verdict === "string" &&
  "message" in body &&
  typeof body.message === "string"
    ? body.message
    : undefined;

/** What the supervisor blamed the App for in session `id`, if anything. */
const verdictOf = async (
  host: Fetcher,
  id: string
): Promise<string | undefined> => {
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
export const runInSession = async (
  host: Fetcher,
  call: SessionCall
): Promise<unknown> => {
  const id = crypto.randomUUID();
  let response: Response;
  try {
    response = await host.fetch("http://sandbox/session", {
      headers: {
        upgrade: "websocket",
        [sandboxDeadlineHeader]: String(call.wallMs),
        [sandboxCpuHeader]: String(call.cpuMs),
        [sandboxWaitHeader]: String(sandboxWaitMs),
        [sandboxCallIdHeader]: id,
      },
    });
  } catch (error) {
    throw new SandboxUnavailableError("The sandbox host didn't answer.", {
      cause: error,
    });
  }
  const socket = response.webSocket;
  if (socket === null) {
    await response.body?.cancel();
    throw new SandboxUnavailableError(
      `The sandbox host answered ${response.status}.`
    );
  }
  let closed = false;
  socket.addEventListener("close", () => {
    closed = true;
  });
  socket.accept();
  const transport = accountedTransport(
    new WebSocketTransport(socket),
    sessionAccounting,
    () => new SandboxUnavailableError("The session sent more than it may."),
    isolateRpcHeld
  );
  const session = new RpcSession(transport, undefined, {
    limits: {
      maxDepth: screenLimits.rpc.maxDepth,
      maxBigIntDigits: screenLimits.rpc.maxBigIntDigits,
    },
  });
  // Every capability by a name of the session's own: the isolate never
  // sees these, only what the sandbox host makes of them.
  const specs: Record<string, { methods: string[] } | { function: true }> = {};
  const stubs: Record<string, object> = {};
  const named = (given: SessionCapability): string => {
    const name = `c${Object.keys(specs).length}`;
    specs[name] = given.function
      ? { function: true }
      : { methods: [...given.methods] };
    stubs[name] = forwarderOf(given);
    return name;
  };
  const args = call.args.map((arg) =>
    "capability" in arg ? { capability: named(arg.capability) } : arg
  );
  const settled = new AbortController();
  const backstop = rejectAfter(
    sandboxWaitMs + call.wallMs + backstopMs,
    new SandboxUnavailableError("The sandbox didn't end the call in time."),
    settled.signal
  );
  try {
    const remote: unknown = session.getRemoteMain();
    const run: unknown =
      typeof remote === "object" || typeof remote === "function"
        ? Reflect.get(remote ?? {}, "run")
        : undefined;
    if (typeof run !== "function") {
      throw new SandboxUnavailableError("The session has no call to run.");
    }
    const answer: unknown = Reflect.apply(run, remote, [
      {
        mainModule: call.mainModule,
        modules: call.modules,
        entrypoint: call.entrypoint,
        method: call.method,
        args,
        capabilities: specs,
      },
      stubs,
    ]);
    return await Promise.race([answer, backstop]);
  } catch (error) {
    if (error instanceof SandboxUnavailableError && !closed) {
      throw error;
    }
    if (!closed) {
      // The session's open: what failed is the isolate's entrypoint.
      throw error;
    }
    const verdict = await verdictOf(host, id);
    if (verdict !== undefined) {
      throw new Error(verdict, { cause: error });
    }
    throw new SandboxUnavailableError("The sandbox session ended.", {
      cause: error,
    });
  } finally {
    settled.abort();
    try {
      socket.close(1000, "The call is over.");
    } catch {
      // Closed already.
    }
  }
};
