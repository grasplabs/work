import { sha256Hex } from "@grasp-os/shared/encoding";
import type { AppId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import {
  actionInvocationWallMs,
  actionMaxRunning,
  streamIdleCancelMs,
  streamMaxRunning,
  streamRetentionMs,
  streamTombstoneMs,
} from "@grasp-os/shared/operation-limits";
import { jsonOf, operationErrors } from "@grasp-os/shared/operations";
import type {
  AppErrorPayload,
  ErrorCategory,
  OperationResult,
} from "@grasp-os/shared/operations";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import type { Identity } from "@grasp-os/shared/rpc";
import { submissionErrors } from "@grasp-os/shared/submissions";
import { DurableObject } from "cloudflare:workers";

import { operationRoles } from "./app-access.ts";
import { invokeAppAction, refusalOf } from "./app-functions.ts";
import type { FunctionRequest } from "./app-functions.ts";
import { appHost, inJurisdiction } from "./durable-objects.ts";
import { requireNotRevoked } from "./release-runner.ts";

// One foreground action's invocation, in a Durable Object of its own,
// named by who runs it, which App, version and contract, and the caller's
// key (`invocationName`): the one place its progress and its terminal
// receipt live, so a caller that lost its connection attaches to the same
// invocation instead of running it again. A streaming action (spec
// 10.7.6) is one with progress (`streaming`); an action that answers once
// is one without, through the same start, join, attach and receipt.
// Threat model, and how each is closed:
//
// - Progress or a result reaches another person: the object's name holds
//   the person it runs for, so no one else's request can even address it,
//   and it refuses a request of anyone but the person it recorded.
// - It reaches the same person under access they no longer have: the
//   route fingerprints, as it admits each request, the person's
//   organization role, teams and role in the App (`accessOf`); the object
//   records the one it started under and refuses an attach or a join
//   under any other (`operation.access_changed`), and the route's relay
//   compares it again as it goes.
// - Two starts under one key both run, or one with other input slips past
//   the first: deciding to start, holding a place and recording the run
//   happen one request at a time (`#serially`), so a later request finds
//   the record and joins it (same input) or is refused
//   (`submission.key_conflict`).
// - Reconnecting runs the action again: an attach (`attach: true`) only
//   ever reads; one whose receipt expired is refused
//   (`submission.expired`) while its tombstone is kept. Past the
//   tombstone the key is new (see `streamTombstoneMs`).
// - A screen starts invocations without end: one person runs at most
//   `streamMaxRunning` streaming and `actionMaxRunning` plain ones at once
//   per App (held in the App's object, which keeps the holds through a
//   restart; a start past them records nothing), a plain one for at most
//   `actionInvocationWallMs`, and what each object keeps is bounded: a
//   hash of the input, the result (no larger than an operation's), never
//   the input or a progress log. A refusal that ran nothing of the App's
//   (`keepsReceipt`) keeps no receipt, so the same key may run again.
// - A receipt outlives the release that made it: before answering one, or
//   joining a run, the object refuses a caller whose release was revoked
//   since. Its name holds the contract, not the version, so a receipt
//   outlives a publish that keeps the contract, as a mutation's does; a
//   plain call and a stream never share an object.
// - A slow reader makes the host hold more and more: each snapshot is
//   whole, so the object keeps only the latest, and each reader is sent
//   the latest it hasn't seen, when it asks for more (`highWaterMark: 0`).
//   A gap in sequence numbers is snapshots it was too slow for.
// - A cancel claims more than it knows: cancellation stops the run as its
//   deadline does (operations.ts), and the result is `operation.cancelled`
//   only when nothing the run started was still under way, and the
//   uncertain `operation.outcome_unknown` otherwise. Cancelling answers
//   only that it was asked while the run was going (`requested`).
// - It outlives whoever follows it: the route cancels it at once when the
//   person or the build loses access, and the object cancels it once no
//   one has followed it for `streamIdleCancelMs` (`reason: "unfollowed"`).
//   Only a streaming action: a plain one's caller went with its lost
//   answer, and comes back for its receipt by its key, so it runs to its
//   deadline, which ends it whoever follows it.
// - The answer is lost: the terminal receipt is kept for
//   `streamRetentionMs`, then a tombstone for `streamTombstoneMs`. An
//   object that lost a run under way (restarted while it ran), or whose run
//   is still going past its deadline and a margin, settles it as the
//   uncertain `operation.outcome_unknown`, never a made-up outcome, and
//   whoever waits on it hears so.

/** What a start or an attach names, besides the call itself. */
export interface InvocationOpen {
  /** Who runs it, as core identified them: never from the request. */
  readonly by: Pick<Identity, "userId" | "role" | "teams">;
  /** The fingerprint of `by`'s access as core admitted it (`accessOf`). */
  readonly access: string;
  readonly app: AppId;
  /** The object's own name (`invocationName`), which the App's object holds. */
  readonly name: string;
  readonly call: FunctionRequest;
  /** Whether the action streams its progress (spec 10.7.6). */
  readonly streaming: boolean;
  /** Only read what already runs or ran; never start it. */
  readonly attach: boolean;
}

/** Where an invocation stands (`ActionInvocation.standing`), never its result. */
export type InvocationStanding =
  | { readonly state: "running" }
  | { readonly state: "succeeded" }
  | { readonly state: "failed"; readonly category: ErrorCategory }
  | { readonly state: "expired" }
  | { readonly state: "none" };

/** What a reader is sent, one JSON line each. */
export type InvocationFrame =
  | { readonly type: "progress"; readonly seq: number; readonly value: Json }
  | {
      readonly type: "result";
      readonly seq: number;
      readonly result: OperationResult;
    }
  /** The route's: the person or the build no longer gets what follows. */
  | { readonly type: "refused"; readonly error: AppErrorPayload };

/** The latest snapshot, numbered from 1. */
interface Snapshot {
  readonly seq: number;
  readonly value: Json;
}

/** What the object keeps of who started it, under which access, with what. */
interface Started {
  readonly owner: string;
  /** The SHA-256 of the input's canonical JSON: all a key conflict needs. */
  readonly inputHash: string;
  /** The access it started under (`accessOf`). */
  readonly access: string;
  /**
   * The release version that ran it. The name is shared across versions
   * of one contract, so a receipt is handed over only while this version,
   * and the caller's, aren't revoked.
   */
  readonly version: number;
}

/**
 * What the object stores of its invocation: the one state it is in, which
 * only `#serially` changes. `absent` (no record) → `running` → `settled`
 * → `expired` → `absent`; `running` → `absent` again only for a refusal
 * that ran nothing (`keepsReceipt`).
 */
type Record =
  | (Started & {
      readonly state: "running";
      /** Which run it is: only that run may settle it. */
      readonly runId: string;
      /** When its run must end, past which a margin settles it as unknown. */
      readonly deadline: number;
    })
  | (Started & {
      readonly state: "settled";
      readonly settledAt: number;
      readonly result: OperationResult;
    })
  | (Started & { readonly state: "expired" });

/** An invocation this object runs now, or ran since it last woke. */
export interface Live {
  /** Which run it is (`Record`'s `runId`). */
  readonly runId: string;
  progress: Snapshot | null;
  result: OperationResult | undefined;
  readers: number;
  readonly stop: AbortController;
  /** Set once it was cancelled because no one followed it. */
  unfollowed: boolean;
  /** Whether it is cancelled once no one follows it: a streaming action only. */
  readonly needsFollowers: boolean;
  idle: ReturnType<typeof setTimeout> | undefined;
  changed: PromiseWithResolvers<null>;
}

const recordKey = "invocation";

/** How long past its deadline a run may still be settling before the alarm looks. */
const settleMarginMs = 60_000;

const encoder = new TextEncoder();

const line = (frame: InvocationFrame): Uint8Array =>
  encoder.encode(`${JSON.stringify(frame)}\n`);

/** `error` as a result its reader gets, the request ID its own. */
export const refused = (error: unknown): OperationResult => ({
  ok: false,
  error: refusalOf(error, crypto.randomUUID()),
});

/** A stream of the one result `result`. */
export const resultOf = (result: OperationResult): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start: (controller) => {
      controller.enqueue(line({ type: "result", seq: 1, result }));
      controller.close();
    },
  });

/**
 * The fingerprint of the access `by` has in `app` now: their organization
 * role, their teams and their role in the App (`operationRoles`, which
 * refuses someone with none), whatever of it the run's reads depend on.
 */
export const accessOf = async (
  env: Env,
  by: Pick<Identity, "userId" | "role" | "teams">,
  app: AppId
): Promise<string> => {
  const roles = await operationRoles(env, by, app);
  return await sha256Hex(
    canonicalJson({
      role: by.role,
      teams: by.teams
        .map(({ id }) => id)
        .toSorted((one, other) => one.localeCompare(other)),
      appBuilder: roles.appBuilder,
    })
  );
};

/** Wakes every reader of `live` waiting for something new. */
export const wake = (live: Live): void => {
  const { changed: waiting } = live;
  live.changed = Promise.withResolvers();
  waiting.resolve(null);
};

/**
 * One reader of `live`: sent the latest snapshot it hasn't seen when it
 * asks for more, then the result. Once it goes, and no one else reads,
 * the run is cancelled after `streamIdleCancelMs` unless someone
 * attaches again first.
 */
export const readerOf = (live: Live): ReadableStream<Uint8Array> => {
  live.readers += 1;
  clearTimeout(live.idle);
  live.idle = undefined;
  let seen = 0;
  let gone = false;
  const leave = (): void => {
    if (gone) {
      return;
    }
    gone = true;
    live.readers -= 1;
    if (live.readers > 0 || live.result !== undefined || !live.needsFollowers) {
      return;
    }
    live.idle = setTimeout(() => {
      live.idle = undefined;
      if (live.readers === 0 && live.result === undefined) {
        live.unfollowed = true;
        live.stop.abort();
      }
    }, streamIdleCancelMs);
  };
  return new ReadableStream(
    {
      pull: async (controller) => {
        for (;;) {
          const { progress, result, changed } = live;
          if (progress !== null && progress.seq > seen) {
            seen = progress.seq;
            controller.enqueue(
              line({
                type: "progress",
                seq: progress.seq,
                value: progress.value,
              })
            );
            return;
          }
          if (result !== undefined) {
            controller.enqueue(
              line({ type: "result", seq: (progress?.seq ?? 0) + 1, result })
            );
            controller.close();
            leave();
            return;
          }
          // oxlint-disable-next-line no-await-in-loop -- until there is something to send
          await changed.promise;
        }
      },
      cancel: () => {
        leave();
      },
    },
    { highWaterMark: 0 }
  );
};

/**
 * `result`, saying why when a cancel was the object's own, because no one
 * followed it: a screen that comes back sees that, not its own cancel.
 */
export const withReason = (
  result: OperationResult,
  unfollowed: boolean
): OperationResult =>
  unfollowed && !result.ok && result.error.code === "operation.cancelled"
    ? {
        ok: false,
        error: { ...result.error, details: { reason: "unfollowed" } },
      }
    : result;

/**
 * The refusals of a run that ran nothing of the App's, when it made no
 * effect (`effects`): a function the caller can't call this way
 * (`mode_mismatch`), a sandbox busy or not there, a model budget held by
 * requests under way. Kept as a receipt, each would answer a retryable
 * refusal to the same key for 15 minutes; once the run made an effect
 * the receipt is kept whatever the code, since running it again would
 * act on what that effect changed.
 */
const nothingRanCodes: ReadonlySet<string> = new Set([
  "operation.mode_mismatch",
  "operation.sandbox_busy",
  "operation.sandbox_unavailable",
  "resource.budget_busy",
]);

/** How a run ended, as `invokeAppAction` answers it. */
interface Outcome {
  readonly result: OperationResult;
  readonly reached: boolean;
  readonly effects: number;
}

/**
 * Whether `outcome` is kept as the receipt: anything but a refusal before
 * the operation host was reached, or one of `nothingRanCodes` from a run
 * that made no effect.
 */
export const keepsReceipt = (outcome: Outcome): boolean =>
  outcome.result.ok ||
  (outcome.reached &&
    (outcome.effects > 0 || !nothingRanCodes.has(outcome.result.error.code)));

export class ActionInvocation extends DurableObject<Env> {
  #live: Live | undefined;
  /** The record's changes, one after another (`#serially`). */
  #queue: Promise<null> = Promise.resolve(null);

  /**
   * Starts the invocation, joins it, or attaches to it (see the header),
   * and answers what its reader is sent: JSON lines of `InvocationFrame`,
   * the last its result. A refusal is that result.
   */
  async open(spec: InvocationOpen): Promise<ReadableStream<Uint8Array>> {
    // Input past what reads as a value (`jsonOf`) is refused here, recording
    // nothing: hashed as none, two such inputs would share a key's run, the
    // second joining the first or reading its receipt instead of being
    // refused (`submission.key_conflict`).
    const input = jsonOf(spec.call.input);
    if (input === undefined && spec.call.input !== undefined) {
      return resultOf(
        refused(operationErrors.create("contract.invalid_request"))
      );
    }
    // In line from the first await on: a cancel sent after this open is
    // decided after it.
    return await this.#serially(async () => {
      const inputHash = await sha256Hex(canonicalJson(input ?? null));
      return await this.#decide(spec, inputHash);
    });
  }

  /**
   * The release version the invocation of `userId` runs or ran under,
   * which a relay of it keeps checking isn't revoked; undefined for
   * anyone else, or when there is no invocation.
   */
  async version(userId: string): Promise<number | undefined> {
    await Promise.resolve();
    const record = this.#record();
    return record?.owner === userId ? record.version : undefined;
  }

  /**
   * Where the invocation of `userId` stands, its result left out (spec
   * 10.7.8): a look that starts nothing and changes nothing. A settled
   * one says only whether it succeeded, and a failure's category, never
   * what it answered; anyone but the person it runs for gets `none`, as
   * for no invocation.
   */
  async standing(userId: string): Promise<InvocationStanding> {
    await Promise.resolve();
    const record = this.#record();
    if (record?.owner !== userId) {
      return { state: "none" };
    }
    if (record.state === "running") {
      return { state: "running" };
    }
    if (record.state === "expired") {
      return { state: "expired" };
    }
    return record.result.ok
      ? { state: "succeeded" }
      : { state: "failed", category: record.result.error.category };
  }

  /**
   * Asks for the invocation of `userId`, the person it runs for, to stop:
   * its run stops as at its deadline, and its result says what is known
   * (see the header). Decided after any start, join or attach before it,
   * so a cancel sent while a start is being decided reaches the run it
   * starts. Answers whether it was still running when asked, never what
   * that did.
   */
  async cancel(userId: string): Promise<boolean> {
    return await this.#serially(async () => {
      await Promise.resolve();
      const record = this.#record();
      const live = this.#live;
      if (
        record?.owner !== userId ||
        record.state !== "running" ||
        live === undefined ||
        live.runId !== record.runId
      ) {
        return false;
      }
      live.stop.abort();
      return true;
    });
  }

  /**
   * Keeps the receipt only as long as it is kept: a run lost under way, or
   * one still running past its deadline and a margin (stuck on something
   * that ignores its cancel), is settled as unknown; a receipt past its
   * time becomes a tombstone, and a tombstone past its time goes.
   */
  override async alarm(): Promise<void> {
    await this.#serially(async () => {
      const record = this.#record();
      const now = Date.now();
      if (record === undefined) {
        return;
      }
      if (record.state === "running") {
        const live = this.#ownLive(record);
        if (live !== undefined && now < record.deadline + settleMarginMs) {
          await this.ctx.storage.setAlarm(record.deadline + settleMarginMs);
          return;
        }
        live?.stop.abort();
        await this.#settle(
          record,
          refused(operationErrors.create("operation.outcome_unknown"))
        );
        return;
      }
      if (record.state === "settled") {
        if (now < record.settledAt + streamRetentionMs) {
          await this.ctx.storage.setAlarm(record.settledAt + streamRetentionMs);
          return;
        }
        const { owner, inputHash, access, version } = record;
        this.ctx.storage.kv.put<Record>(recordKey, {
          owner,
          inputHash,
          access,
          version,
          state: "expired",
        });
        await this.ctx.storage.setAlarm(now + streamTombstoneMs);
        return;
      }
      await this.ctx.storage.deleteAll();
    });
  }

  /**
   * Runs `work` after every change of the record before it: open, cancel,
   * the alarm and a run's end all go through here, so each reads the
   * state the one before left.
   */
  async #serially<Answer>(work: () => Promise<Answer>): Promise<Answer> {
    const before = this.#queue;
    const { promise, resolve } = Promise.withResolvers<null>();
    this.#queue = promise;
    try {
      await before;
      return await work();
    } finally {
      // The next goes on whatever this one did; its caller hears of it.
      resolve(null);
    }
  }

  /** The run under way of `record`, if this object holds it. */
  #ownLive(record: Record & { readonly state: "running" }): Live | undefined {
    const live = this.#live;
    return live?.runId === record.runId ? live : undefined;
  }

  /** What `open` answers: decided against the record, one at a time. */
  async #decide(
    spec: InvocationOpen,
    inputHash: string
  ): Promise<ReadableStream<Uint8Array>> {
    const record = this.#record();
    if (record === undefined) {
      if (spec.attach) {
        return resultOf(refused(submissionErrors.create("submission.expired")));
      }
      return await this.#start(spec, inputHash);
    }
    if (record.owner !== spec.by.userId) {
      return resultOf(refused(operationErrors.create("operation.not_found")));
    }
    if (record.access !== spec.access) {
      return resultOf(
        refused(operationErrors.create("operation.access_changed"))
      );
    }
    if (record.inputHash !== inputHash) {
      return resultOf(
        refused(submissionErrors.create("submission.key_conflict"))
      );
    }
    // Nothing of what ran under a release revoked since is handed over,
    // nor to a caller whose own release was revoked, as a new call of
    // either would be refused.
    try {
      for (const version of new Set([
        record.version,
        spec.call.reference.resourceVersion,
      ])) {
        // oxlint-disable-next-line no-await-in-loop -- one or two, in turn
        await requireNotRevoked(this.env, spec.app, version);
      }
    } catch (error) {
      return resultOf(refused(error));
    }
    if (record.state === "expired") {
      return resultOf(refused(submissionErrors.create("submission.expired")));
    }
    if (record.state === "settled") {
      return resultOf(record.result);
    }
    const live = this.#ownLive(record);
    if (live === undefined) {
      // It ran in an earlier life of this object, which ended before it
      // settled: whether it finished is unknown.
      const result = refused(
        operationErrors.create("operation.outcome_unknown")
      );
      await this.#settle(record, result);
      return resultOf(result);
    }
    return readerOf(live);
  }

  #record(): Record | undefined {
    return this.ctx.storage.kv.get<Record>(recordKey);
  }

  /**
   * Holds one of the person's places for a running invocation of its kind
   * (`holdInvocation`), records the run and starts it, not waiting for it;
   * refused with `operation.stream_limit` or `operation.action_limit` when
   * the person has none left, recording nothing, so the same key may start
   * later.
   */
  async #start(
    spec: InvocationOpen,
    inputHash: string
  ): Promise<ReadableStream<Uint8Array>> {
    const deadline =
      Date.now() +
      (spec.streaming
        ? platformLimits.serverInvocationWallMs
        : actionInvocationWallMs);
    const host = appHost(this.env, spec.app);
    const held = await host.holdInvocation(
      spec.by.userId,
      spec.name,
      deadline + settleMarginMs,
      spec.streaming
    );
    if (!held) {
      return resultOf(
        refused(
          spec.streaming
            ? operationErrors.create("operation.stream_limit", {
                maxRunning: streamMaxRunning,
              })
            : operationErrors.create("operation.action_limit", {
                maxRunning: actionMaxRunning,
              })
        )
      );
    }
    const runId = crypto.randomUUID();
    const record: Record = {
      owner: spec.by.userId,
      inputHash,
      access: spec.access,
      version: spec.call.reference.resourceVersion,
      state: "running",
      runId,
      deadline,
    };
    this.ctx.storage.kv.put<Record>(recordKey, record);
    const live: Live = {
      runId,
      progress: null,
      result: undefined,
      readers: 0,
      stop: new AbortController(),
      unfollowed: false,
      needsFollowers: spec.streaming,
      idle: undefined,
      changed: Promise.withResolvers(),
    };
    this.#live = live;
    await this.ctx.storage.setAlarm(deadline + settleMarginMs);
    const run = async (): Promise<void> => {
      let outcome: Outcome;
      try {
        outcome = await invokeAppAction(
          this.env,
          spec.by,
          spec.app,
          spec.call,
          {
            ...(spec.streaming
              ? {
                  progress: {
                    publish: (value: Json) => {
                      live.progress = {
                        seq: (live.progress?.seq ?? 0) + 1,
                        value,
                      };
                      wake(live);
                    },
                  },
                }
              : {}),
            cancelled: live.stop.signal,
            deadline,
          }
        );
      } catch (error) {
        outcome = { result: refused(error), reached: false, effects: 0 };
      }
      try {
        await host.releaseInvocation(spec.by.userId, spec.name, spec.streaming);
      } catch {
        // Its hold runs out by itself, by the run's deadline.
      }
      await this.#serially(async () => {
        await this.#finish(live, outcome);
      });
    };
    this.ctx.waitUntil(run());
    return readerOf(live);
  }

  /**
   * Ends the run `live`: its outcome becomes the receipt, or none is kept
   * (`keepsReceipt`). Only while the record is still that run: one the
   * alarm settled as stuck keeps what it said, and `live`'s readers have
   * heard it already.
   */
  async #finish(live: Live, outcome: Outcome): Promise<void> {
    const record = this.#record();
    if (record?.state !== "running" || record.runId !== live.runId) {
      return;
    }
    if (!keepsReceipt(outcome)) {
      this.ctx.storage.kv.delete(recordKey);
      await this.ctx.storage.deleteAlarm();
      this.#live = undefined;
      clearTimeout(live.idle);
      live.idle = undefined;
      live.result = outcome.result;
      wake(live);
      return;
    }
    await this.#settle(record, withReason(outcome.result, live.unfollowed));
  }

  /**
   * Stores `result` as the receipt of the running `record`, keeps it for
   * `streamRetentionMs` and tells the readers of its run.
   */
  async #settle(
    record: Record & { readonly state: "running" },
    result: OperationResult
  ): Promise<void> {
    const settledAt = Date.now();
    const { owner, inputHash, access, version } = record;
    this.ctx.storage.kv.put<Record>(recordKey, {
      owner,
      inputHash,
      access,
      version,
      state: "settled",
      settledAt,
      result,
    });
    const live = this.#ownLive(record);
    if (live !== undefined) {
      clearTimeout(live.idle);
      live.idle = undefined;
      live.result = result;
      wake(live);
    }
    await this.ctx.storage.setAlarm(settledAt + streamRetentionMs);
  }
}

/**
 * The name of the invocation `call` starts, for `userId` in `app`, as a
 * streaming action's or a plain one's: never both, so a plain call and a
 * stream under one key never share an object. Not the App's version:
 * like a mutation's receipt, an action's outlives a publish that keeps its
 * contract (`fingerprint`); other input is refused by its input's hash.
 */
export const invocationName = async (
  userId: string,
  app: string,
  call: {
    readonly reference: Pick<
      FunctionRequest["reference"],
      "contractId" | "fingerprint"
    >;
  },
  key: string,
  streaming: boolean
): Promise<string> => {
  const { contractId, fingerprint } = call.reference;
  return await sha256Hex(
    canonicalJson([
      streaming ? "stream" : "action",
      userId,
      app,
      contractId,
      fingerprint,
      key,
    ])
  );
};

/** The object that holds the invocation named `name`. */
export const actionInvocation = (
  env: Pick<Env, "ACTION_INVOCATIONS" | "DURABLE_OBJECT_JURISDICTION">,
  name: string
) => inJurisdiction(env, env.ACTION_INVOCATIONS).getByName(name);
