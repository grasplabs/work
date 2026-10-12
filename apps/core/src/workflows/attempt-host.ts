import { RpcTarget } from "cloudflare:workers";

import type { DecisionRecipient } from "../decisions/decisions.ts";
import type { Settled } from "./code.ts";

/** What an attempt's host does, each call as its attempt (`AttemptHost`). */
export interface AttemptCalls {
  callModel: (request: unknown) => Promise<Settled<unknown>>;
  callCollection: (
    binding: unknown,
    method: unknown,
    args: unknown
  ) => Promise<Settled<unknown>>;
  callConnection: (
    binding: unknown,
    call: unknown
  ) => Promise<Settled<unknown>>;
  callApp: (method: unknown, args: unknown) => Promise<Settled<unknown>>;
  callExport: (
    binding: unknown,
    method: unknown,
    input: unknown
  ) => Promise<Settled<unknown>>;
  openDecision: (
    request: unknown
  ) => Promise<Settled<{ decision: string; deadline: number }>>;
  decisionRecipients: (
    decision: unknown,
    reminder: unknown
  ) => Promise<Settled<DecisionRecipient[]>>;
  readAttachment: (
    stored: unknown,
    index: unknown
  ) => Promise<Settled<Uint8Array>>;
}

/**
 * The one check every call of an attempt passes (`AttemptHost`): the
 * refusal to answer, as `Settled`, when the attempt no longer holds its
 * lease (it timed out, the run was cancelled or paused, another
 * activation took over), or nothing while it holds.
 */
export type AttemptFenceCheck = (
  call: string
) => Promise<Settled<never> | undefined>;

/**
 * `calls`, each fenced: refused before it runs once its attempt no longer
 * holds, and again as it returns, so what it read or got never leaves the
 * host for an attempt the engine let go of meanwhile, whatever the call
 * awaited on the way. Every entry of `calls` is wrapped, so a call added
 * to `AttemptCalls` is fenced without anyone remembering to.
 */
const fenced = (
  calls: AttemptCalls,
  check: AttemptFenceCheck
): AttemptCalls => {
  const wrap =
    <Args extends unknown[], T>(
      name: string,
      call: (...args: Args) => Promise<Settled<T>>
    ) =>
    async (...args: Args): Promise<Settled<T>> => {
      const before = await check(name);
      if (before !== undefined) {
        return before;
      }
      const result = await call(...args);
      return (await check(name)) ?? result;
    };
  return {
    callModel: wrap("model", calls.callModel),
    callCollection: wrap("collection", calls.callCollection),
    callConnection: wrap("connection", calls.callConnection),
    callApp: wrap("APP", calls.callApp),
    callExport: wrap("export", calls.callExport),
    openDecision: wrap("decision", calls.openDecision),
    decisionRecipients: wrap("decision", calls.decisionRecipients),
    readAttachment: wrap("attachment", calls.readAttachment),
  } satisfies { [Name in keyof AttemptCalls]: AttemptCalls[Name] };
};

/**
 * The host of one attempt of a step, minted when the engine claims it and
 * handed to that attempt's code alone: what the code does inside a step
 * (its bindings, a model call, a decision) goes through it, each call as
 * that attempt, with that attempt's identity whenever the call lands. So
 * a call made late, by an attempt the engine gave up on, can never act
 * with a newer attempt's authority: it is checked against its own
 * attempt's lease, refused as stale once that no longer holds, and has no
 * other attempt to borrow from. Every method answers `Settled`.
 */
export class AttemptHost extends RpcTarget {
  readonly #calls: AttemptCalls;

  constructor(calls: AttemptCalls, check: AttemptFenceCheck) {
    super();
    this.#calls = fenced(calls, check);
  }

  async callModel(request: unknown): Promise<Settled<unknown>> {
    return await this.#calls.callModel(request);
  }

  async callCollection(
    binding: unknown,
    method: unknown,
    args: unknown
  ): Promise<Settled<unknown>> {
    return await this.#calls.callCollection(binding, method, args);
  }

  async callConnection(
    binding: unknown,
    call: unknown
  ): Promise<Settled<unknown>> {
    return await this.#calls.callConnection(binding, call);
  }

  async callApp(method: unknown, args: unknown): Promise<Settled<unknown>> {
    return await this.#calls.callApp(method, args);
  }

  async callExport(
    binding: unknown,
    method: unknown,
    input: unknown
  ): Promise<Settled<unknown>> {
    return await this.#calls.callExport(binding, method, input);
  }

  async openDecision(
    request: unknown
  ): Promise<Settled<{ decision: string; deadline: number }>> {
    return await this.#calls.openDecision(request);
  }

  async decisionRecipients(
    decision: unknown,
    reminder: unknown
  ): Promise<Settled<DecisionRecipient[]>> {
    return await this.#calls.decisionRecipients(decision, reminder);
  }

  async readAttachment(
    stored: unknown,
    index: unknown
  ): Promise<Settled<Uint8Array>> {
    return await this.#calls.readAttachment(stored, index);
  }
}
