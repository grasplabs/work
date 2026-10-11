import type { OperationChannel } from "@grasp-os/sdk/runner";
import { internalErrors, isExpectedError } from "@grasp-os/shared/errors";
import type { CodedError } from "@grasp-os/shared/errors";
import { errorFields, log } from "@grasp-os/shared/log";
import { operationErrors } from "@grasp-os/shared/operations";
import { RpcTarget } from "cloudflare:workers";

// The one authority an App's code is handed for one invocation of one of
// its server functions (operations.ts): a read, a staged write, a call of
// another of its functions, a resource, each decided here, by the host,
// for the invocation's kind. App code can hold on to the channel, or pass
// it on, so:
// - what it may do is fixed by the invocation that made it: a query's has
//   no write, call or resource, a mutation's no resource, and asking
//   anyway is refused whatever the App code says (`operation.read_only`,
//   `operation.no_resources`, ...);
// - it stops working once its invocation ends (`operation.ended`), so a
//   channel kept from an earlier call acts for no one;
// - its methods take only what a request is (no scope, principal, role,
//   schema hash or receipt): who the invocation is for was resolved by
//   core before the channel existed;
// - what goes wrong in core reaches App code as an expected error, never
//   as an unexpected one's message (SQL, a provider's text, a stack),
//   which App code could otherwise copy into its own error and hand its
//   caller: anything unexpected becomes `internal.unexpected`, its cause
//   logged under the request ID.
// It remembers the expected errors it raised, so the host can tell one
// App code rethrew from a code it made up (`raised`).

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
  /** The refusal for each capability it hasn't. */
  readonly refusals: Readonly<
    Record<
      "read" | "write" | "call" | "resource",
      Parameters<typeof operationErrors.create>[0]
    >
  >;
}

/** What a channel and the host that made it share. */
interface ChannelState {
  ended: boolean;
  readonly raised: Map<string, CodedError>;
}

/**
 * The channel App code holds: its four methods and nothing else, so over
 * RPC nothing but them can be called (ending it and reading what it raised
 * are the host's, on `OpenChannel`).
 */
class Channel extends RpcTarget implements OperationChannel {
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

  async call(path: unknown, args: unknown): Promise<unknown> {
    return await this.#use("call", [path, args]);
  }

  async resource(
    alias: unknown,
    method: unknown,
    args: unknown
  ): Promise<unknown> {
    return await this.#use("resource", [alias, method, args]);
  }

  async #use(
    name: keyof ChannelCapabilities["refusals"],
    args: unknown[]
  ): Promise<unknown> {
    const capability = this.#capabilities[name];
    try {
      if (this.#state.ended) {
        throw operationErrors.create("operation.ended");
      }
      if (capability === undefined) {
        throw operationErrors.create(this.#capabilities.refusals[name]);
      }
      return await capability(...args);
    } catch (error) {
      if (isExpectedError(error)) {
        this.#state.raised.set(error.code, error);
        throw error;
      }
      const { requestId, path } = this.#capabilities;
      log.error("operation.channel_failed", {
        requestId,
        path,
        capability: name,
        ...errorFields(error),
      });
      const opaque = internalErrors.create("internal.unexpected", {
        requestId,
      });
      // Cap'n Web and Workers RPC send a stack; this one has none to send.
      opaque.stack = undefined;
      this.#state.raised.set(opaque.code, opaque);
      throw opaque;
    }
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
  const state: ChannelState = { ended: false, raised: new Map() };
  return {
    channel: new Channel(capabilities, state),
    end: () => {
      state.ended = true;
    },
    raised: (code) => state.raised.get(code),
  };
};
