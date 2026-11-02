import type { OperationChannel } from "@grasp-os/sdk/runner";
import { internalErrors, isExpectedError } from "@grasp-os/shared/errors";
import type { CodedError } from "@grasp-os/shared/errors";
import type { Json } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { isAppErrorCode } from "@grasp-os/shared/operation-limits";
import { jsonOf, operationErrors } from "@grasp-os/shared/operations";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import { boundedRpcTarget } from "@grasp-os/shared/rpc-target";
import {
  isolateArgumentDepth,
  commitMaxInputBytes,
} from "@grasp-os/shared/stores";

// The one authority an App's code is handed for one invocation of one of
// its server functions (operations.ts): a read, a staged write, a call of
// another of its functions, a resource, a streaming action's progress
// (`emit`), each decided here, by the host, for the invocation's kind. App
// code can hold on to the channel, or pass it on, so:
// - what it may do is fixed by the invocation that made it: a query's has
//   no write, call or resource, a mutation's no resource, only a streaming
//   action's has `emit`, and asking
//   anyway is refused whatever the App code says (`operation.read_only`,
//   `operation.no_resources`, ...);
// - it stops working once its invocation ends (`operation.ended`), so a
//   channel kept from an earlier call acts for no one;
// - it answers at most `platformLimits.invocationHostCalls` reads, calls
//   and resource requests (100), counted as each reaches it, refused or
//   not, and none after that (`operation.call_limit`): a loop of them ends
//   there, and a function's nested calls, each an invocation of its own
//   with its own channel, are bounded by the call's budget (operations.ts).
//   Staged writes aren't counted: a commit bounds them
//   (`commitMaxWrites`), and counting them would leave a mutation that
//   reads anything short of a whole commit. Nor are a streaming action's
//   progress snapshots (`emit`), which have a budget of their own
//   (`streamMaxEmits`, operations.ts): a run that streams 1000 of them
//   still has its 100 calls. This holds an App's functions (queries,
//   mutations, actions); Code Mode counts its own;
// - its methods take only what a request is (no scope, principal, role,
//   schema hash or receipt): who the invocation is for was resolved by
//   core before the channel existed;
// - what goes wrong in core reaches App code as an expected error, never
//   as an unexpected one's message (SQL, a provider's text, a stack),
//   which App code could otherwise copy into its own error and hand its
//   caller: anything unexpected becomes `internal.unexpected`, its cause
//   logged under the request ID.
// It remembers the expected errors it raised, so the host can tell one
// App code rethrew from a code it made up (`raised`). A domain failure of
// a function this one called passes through as the `AppError` it was.

/** What a channel can be asked to do. */
type CapabilityName = "read" | "write" | "call" | "resource" | "emit";

/** One capability of a channel: how the host answers it. */
type Capability = (...args: unknown[]) => Promise<unknown>;

/** What a channel can do, and why it refuses what it can't. */
export interface ChannelCapabilities {
  readonly requestId: string;
  /** The registered path of the function it runs, for the logs. */
  readonly path: string;
  readonly read?: Capability;
  readonly write?: Capability;
  readonly call?: Capability;
  readonly resource?: Capability;
  /** A streaming action's progress snapshot (operations.ts `runAction`). */
  readonly emit?: Capability;
  /** Brands an expected error the channel raised as the host's. */
  readonly trust: (error: Error) => void;
  /**
   * Told of every use the channel refused or that failed, wherever it
   * failed (its arguments refused at the boundary included), with the
   * host's own copy of the error.
   */
  readonly refused?: (name: CapabilityName, error: CodedError) => void;
  /**
   * The refusal for each capability it hasn't (`operation.not_found` for
   * one without its own).
   */
  readonly refusals: Readonly<
    Partial<
      Record<CapabilityName, Parameters<typeof operationErrors.create>[0]>
    >
  >;
}

/**
 * What App code passed, as plain JSON copies: read once, here, so no
 * capability ever runs a getter of App code's (whose error would pass for
 * the host's), and a value that isn't JSON is refused as it arrives.
 */
const plainArgs = (args: readonly unknown[]): unknown[] =>
  args.map((arg) => {
    let copy: Json | undefined;
    try {
      // As deep as the channel takes it: a write's request around a field
      // as deep as a record keeps (`isolateArgumentDepth`).
      copy = jsonOf(arg, 1, isolateArgumentDepth);
    } catch {
      copy = undefined;
    }
    if (copy === undefined) {
      throw operationErrors.create("contract.invalid_request");
    }
    return copy;
  });

/**
 * A fresh copy of expected error `error`: its code, message and details
 * (as a JSON copy), without a stack to send.
 */
const copyOf = (error: CodedError): CodedError => {
  const copy: CodedError = Object.assign(
    new Error(error.message),
    error.details === undefined
      ? { code: error.code }
      : { code: error.code, details: structuredClone(error.details) }
  );
  copy.stack = undefined;
  return copy;
};

/** An `AppError` as the host rebuilt it for App code (operations.ts). */
const isAppFailure = (error: unknown): boolean =>
  error instanceof Error &&
  error.name === "AppError" &&
  isAppErrorCode(Reflect.get(error, "code"));

/** What a channel and the host that made it share. */
interface ChannelState {
  ended: boolean;
  /** Its reads, calls and resource requests so far, refused ones included. */
  uses: number;
  readonly raised: Map<string, CodedError>;
}

/**
 * The channel App code holds: its methods and nothing else, so over
 * RPC nothing but them can be called (ending it and reading what it raised
 * are the host's, on `OpenChannel`).
 */
/**
 * What a channel's methods take, bounded as each call arrives, before any
 * of its own code runs: as deep as any value, and no larger than one
 * commit, more than any request App code has reason to send.
 */
const ChannelTarget = boundedRpcTarget({
  depth: isolateArgumentDepth,
  size: commitMaxInputBytes,
});

class Channel extends ChannelTarget implements OperationChannel {
  readonly #capabilities: ChannelCapabilities;
  readonly #state: ChannelState;

  constructor(capabilities: ChannelCapabilities, state: ChannelState) {
    super();
    this.#capabilities = capabilities;
    this.#state = state;
  }

  async read(request: unknown): Promise<unknown> {
    return await this.#use("read", [request]);
  }

  async write(request: unknown): Promise<unknown> {
    return await this.#use("write", [request]);
  }

  async call(kind: unknown, path: unknown, args: unknown): Promise<unknown> {
    return await this.#use("call", [kind, path, args]);
  }

  async resource(
    alias: unknown,
    method: unknown,
    args: unknown
  ): Promise<unknown> {
    return await this.#use("resource", [alias, method, args]);
  }

  async emit(progress: unknown): Promise<unknown> {
    return await this.#use("emit", [progress]);
  }

  async #use(name: CapabilityName, args: unknown[]): Promise<unknown> {
    const capability = this.#capabilities[name];
    try {
      const counted = name !== "write" && name !== "emit";
      if (counted) {
        this.#state.uses += 1;
      }
      if (this.#state.ended) {
        throw operationErrors.create("operation.ended");
      }
      // A write is never refused for the reads and calls before it.
      if (counted && this.#state.uses > platformLimits.invocationHostCalls) {
        throw operationErrors.create("operation.call_limit", {
          maxHostCalls: platformLimits.invocationHostCalls,
        });
      }
      if (capability === undefined) {
        throw operationErrors.create(
          this.#capabilities.refusals[name] ?? "operation.not_found"
        );
      }
      return await capability(...plainArgs(args));
    } catch (error) {
      if (isExpectedError(error)) {
        throw this.#raise(name, error);
      }
      // A domain failure of a function this one called, as the host
      // rebuilt it: App code may handle it, or throw it on.
      if (isAppFailure(error)) {
        throw error;
      }
      const { requestId, path } = this.#capabilities;
      log.error("operation.channel_failed", {
        requestId,
        path,
        capability: name,
        ...errorFields(error),
      });
      throw this.#raise(
        name,
        internalErrors.create("internal.unexpected", { requestId })
      );
    }
  }

  /**
   * Raises expected error `error` to App code: the host keeps a copy of
   * its own (`raised`, branded with `trust`), and App code gets another,
   * so whatever App code does to the error it caught (its message, code or
   * details, now or after a later await) changes nothing the host answers.
   */
  #raise(name: CapabilityName, error: CodedError): Error {
    const kept = copyOf(error);
    this.#capabilities.trust(kept);
    this.#state.raised.set(kept.code, kept);
    this.#capabilities.refused?.(name, kept);
    return copyOf(error);
  }
}

/** A channel, as the host that made it holds it. */
export interface OpenChannel {
  /** What App code is handed. */
  readonly channel: OperationChannel;
  /** Ends the channel: every later use is `operation.ended`. */
  readonly end: () => void;
  /**
   * The expected error of `code` the channel raised to App code, if it
   * raised one: the host's own copy, never what App code passed back.
   */
  readonly raised: (code: string) => CodedError | undefined;
}

/** A new channel with `capabilities`, for one invocation. */
export const openChannel = (capabilities: ChannelCapabilities): OpenChannel => {
  const state: ChannelState = { ended: false, uses: 0, raised: new Map() };
  return {
    channel: new Channel(capabilities, state),
    end: () => {
      state.ended = true;
    },
    raised: (code) => state.raised.get(code),
  };
};
