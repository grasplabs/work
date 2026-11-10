import { AppError, v } from "@grasp-os/runtime/app";
import type { AppManifest, FunctionChannel } from "@grasp-os/runtime/host";
import { jsonOf, operationErrors } from "@grasp-os/shared/operations";
import type { OperationResult } from "@grasp-os/shared/operations";
import {
  readRequestSchema,
  writeRequestSchema,
} from "@grasp-os/shared/store-queries";

import { refusalOf } from "./app-functions.ts";
import { callOperation } from "./operations.ts";
import type { Invocation, Runner } from "./operations.ts";

// A test's own transaction (`t.run`, app-tests.ts): the test reads and
// writes the App's tables directly, as convex-test's `t.run` does, for
// what to seed and what to inspect. It runs as a mutation does, through
// the operation host (operations.ts), so its reads see its own writes and
// it commits once, whole, when the test's function returns, or not at all;
// only its "handler" is the test isolate's function, which drives the
// mutation's channel from outside through this module. Threat model, and
// how each is closed:
//
// - Reaching past the App's access rules anywhere but a test's store: the
//   transaction is `unrestricted` (operations.ts), which only this module
//   sets, for the test session's own invocation (app-tests.ts), and the
//   store takes it only on a fixture store core recorded and no inventory
//   lists (data-store.ts, `#admitScope`), so a business store refuses it
//   whoever asks (app-tests.test.ts tries it).
// - Running App code: none runs. The mutation it is has no handler of the
//   App's; it is a path no App function can have (`testRunPath`: App
//   functions are named by their modules and exports), added to the
//   release's manifest only for this call, never to the release.
// - Writing what the schema refuses: each write is staged and checked as
//   any mutation's (`stagingFor`), and the store checks the commit again.
// - A transaction left open: it is the operation's own, so it ends at the
//   invocation's deadline, as a mutation does, its writes dropped; and as
//   its test's session closes (`end`).

/**
 * The path of the mutation a test's transaction is: one no App function
 * can have.
 */
const testRunPath = "~test.run";

/** Each release's manifest with the test's mutation added. */
const manifests = new WeakMap<AppManifest, AppManifest>();

/** `app`'s manifest, with the test's mutation (`testRunPath`). */
const withTestRun = (app: AppManifest): AppManifest => {
  const known = manifests.get(app);
  if (known !== undefined) {
    return known;
  }
  const made: AppManifest = {
    ...app,
    operations: {
      ...app.operations,
      [testRunPath]: {
        path: testRunPath,
        kind: "mutation",
        visibility: "public",
        args: v.object({}).descriptor,
        // What the test's function answers stays in its isolate.
        returns: null,
        stream: null,
      },
    },
  };
  manifests.set(app, made);
  return made;
};

/** One transaction a test holds open. */
export interface TestTransaction {
  /** One read, as a mutation's: it sees the transaction's writes. */
  readonly read: (request: unknown) => Promise<OperationResult>;
  /** One write, staged: an insert answers its minted ID. */
  readonly write: (request: unknown) => Promise<OperationResult>;
  /**
   * Commits what it staged (`commit`), or drops it, and answers how: once;
   * any read or write after it is refused.
   */
  readonly end: (commit: boolean) => Promise<OperationResult>;
}

/**
 * What a dropped transaction's "handler" fails with, as App code fails a
 * mutation on purpose: nothing it staged commits.
 */
const dropped = (): AppError =>
  new AppError("test.dropped", "The test's function threw: nothing commits.");

/** A read or write of a transaction that has ended. */
const ended = (): Error => operationErrors.create("function.ended");

/** What `work` answers, or its refusal, as a result. */
const resultOf = async (
  work: () => Promise<unknown>
): Promise<OperationResult> => {
  const requestId = crypto.randomUUID();
  try {
    return { ok: true, value: jsonOf(await work()) ?? null };
  } catch (error) {
    return { ok: false, error: refusalOf(error, requestId) };
  }
};

/**
 * Opens a transaction on `app` (the release's manifest) for `invocation`,
 * which the test's session built: unrestricted, so the App's access rules
 * don't hold it back. Answers it, or why the operation host refused it
 * before it opened.
 */
export const openTestTransaction = async (
  app: AppManifest,
  invocation: Invocation
): Promise<
  | { readonly transaction: TestTransaction }
  | { readonly refused: OperationResult }
> => {
  const entered = Promise.withResolvers<FunctionChannel>();
  const done = Promise.withResolvers<null>();
  // The mutation's "handler": it lends the test its channel, and returns
  // once the test ends the transaction, which then commits.
  const run: Runner = async (_path, _args, channel) => {
    entered.resolve(channel);
    return await done.promise;
  };
  const outcome = callOperation(
    { manifest: withTestRun(app), run },
    { ...invocation, unrestricted: true },
    { path: testRunPath, kind: "mutation" },
    {}
  );
  const lent = async (): Promise<{ channel: FunctionChannel }> => ({
    channel: await entered.promise,
  });
  const refused = async (): Promise<{ result: OperationResult }> => ({
    result: await outcome,
  });
  const opened = await Promise.race([lent(), refused()]);
  if ("result" in opened) {
    return { refused: opened.result };
  }
  const { channel } = opened;
  let over = false;
  const open = (): void => {
    if (over) {
      throw ended();
    }
  };
  return {
    transaction: {
      read: async (request) =>
        await resultOf(async () => {
          open();
          return await channel.read(
            operationErrors.parse(
              "contract.invalid_request",
              readRequestSchema,
              request
            )
          );
        }),
      write: async (request) =>
        await resultOf(async () => {
          open();
          return await channel.write(
            operationErrors.parse(
              "contract.invalid_write",
              writeRequestSchema,
              request
            )
          );
        }),
      end: async (commit) => {
        if (over) {
          return await resultOf(async () => {
            await Promise.reject(ended());
          });
        }
        over = true;
        if (commit) {
          done.resolve(null);
        } else {
          done.reject(dropped());
        }
        const result = await outcome;
        // Dropped on purpose: nothing committed, as asked.
        return commit || result.ok ? result : { ok: true, value: null };
      },
    },
  };
};
