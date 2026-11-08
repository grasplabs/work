import type { LinkTransport } from "./client-links.ts";
import type { FileTransport } from "./file-transport.ts";

/**
 * How the client reaches the host: one call of the App `app`, its
 * request as JSON text, answered with core's `{ result }` (spec 32.6), or
 * rejected with a coded refusal; a rejection without a code is a lost
 * response.
 */
export interface ClientTransport {
  call: (request: string) => Promise<unknown>;
  /**
   * Follows the query `request` names (spec 11): `onSnapshot` gets each
   * push of core's (`{ revision, result }`), and `onLost` is called once
   * core, or the connection to it, let go of the subscription. Resolves
   * with what releases it, or rejects as `call` does.
   */
  watch: (
    request: string,
    onSnapshot: (push: unknown) => void,
    onLost: () => void
  ) => Promise<{ release: () => void }>;
  /**
   * Follows one of a streaming action's invocations: `start` starts it
   * (or joins it under the same key and input), `attach` only reads it
   * again. `onFrame` gets each frame core sent, as data, then
   * `{ type: "closed" }` once the connection ends; the promise resolves
   * once it is open, with how to let go of it, or rejects as `call` does.
   * A transport without it runs no streaming action.
   */
  stream?: (
    what: "stream" | "attach",
    request: string,
    onFrame: (frame: unknown) => void
  ) => Promise<StreamLink>;
  /** Cancels the invocation `request` names, for everyone following it. */
  cancelStream?: (request: string) => Promise<unknown>;
  /** How files move (client-files.ts); a client without it moves none. */
  files?: FileTransport;
  /** How links open (client-links.ts); a client without it opens none. */
  links?: LinkTransport;
  /**
   * Tells the trusted host whether a form holds unsaved edits or a
   * submission whose outcome isn't known yet, so it confirms once before
   * leaving the App (`guardLeave`).
   */
  leaveGuard?: (guarded: boolean) => void;
  /**
   * How the client asks the trusted host to answer a decision, after the
   * person confirms it in the host's own UI (the page, for a frame); a
   * client without it answers none.
   */
  decisions?: DecisionTransport;
}

/**
 * How a client reaches the trusted host to answer a person's decision
 * (spec 10.7.2). The host shows the decision's review context and the
 * answer as it will be recorded, asks the person to confirm it there,
 * and only then records it with a one-use confirmation of its own: the
 * client never sees nor holds that confirmation.
 */
export interface DecisionTransport {
  /**
   * Answers decision `decision` of run `run` with `answer`: resolves once
   * it is the recorded decision, rejects with the host's refusal
   * (`decision.cancelled` when the person cancels the confirmation).
   */
  readonly respond: (
    run: string,
    decision: string,
    answer: { readonly approved: boolean; readonly payload: unknown }
  ) => Promise<unknown>;
}

/** A connection to a streaming action's invocation, as the transport opened it. */
export interface StreamLink {
  /** Lets go of it: the invocation goes on for anyone else following it. */
  readonly release: () => unknown;
}
