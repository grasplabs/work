import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";

import { journalOf, pastTime, runObject, until, workflow } from "./helpers.ts";
import {
  effectsOf,
  handled,
  handledAt,
  fencesOf,
  hold,
  notifiedOf,
  notifyFailures,
  warningsDuring,
} from "./outside.ts";
import { budgetedHandlerMs } from "./worker.ts";

// What notifications*.test.ts share: how they read what the host was told
// and the alarms a run object set.

export const statusesOf = (id: string): string[] =>
  notifiedOf(id).map((notification) => notification.status);

/** Waits until the host has taken `status` of the run. */
export const notifiedWith = async (
  id: string,
  status: string
): Promise<void> => {
  await until(`the host to take ${status} of ${id}`, () =>
    statusesOf(id).includes(status) ? true : undefined
  );
};

/** Waits until the run's outbox is empty, and returns its journal then. */
export const outboxEmpty = async (
  definition: string,
  id: string
): Promise<Awaited<ReturnType<typeof journalOf>>> =>
  await until(`the outbox of ${id} to empty`, async () => {
    const journal = await journalOf(definition, id);
    return journal.run.notify_at === null ? journal : undefined;
  });

/** The fence the host was told with the last batch of `id`'s ending in `status`. */
export const lastOver = (id: string, status: string): number | undefined =>
  fencesOf(id).findLast(({ statuses }) => statuses.at(-1) === status)?.over;

/** How many times the run's object's alarm handler ran, so far. */
export const alarmsOf = (definition: string, id: string): number => {
  const object = runObject(definition, id).id.toString();
  return handled.filter((handler) => handler === object).length;
};

/**
 * That the attempt at `step` ran in an activation of an alarm of its own,
 * taken after the release (`releasedAt`, its place in `tick`'s order):
 * some alarm handler of the run's object ended between the release and
 * the attempt's effect, and the attempt's deadline
 * fit the activation's wall time.
 */
export const ranInFreshAlarm = async (
  definition: string,
  id: string,
  step: string,
  releasedAt: number,
  occurrence = 0
): Promise<{ separateAlarm: boolean; fits: boolean }> => {
  const object = runObject(definition, id, env.BUDGETED_RUNS).id.toString();
  const effectAt = effectsOf(id, step)[occurrence]?.order ?? 0;
  const journal = await journalOf(definition, id, env.BUDGETED_RUNS);
  const ordinal = journal.steps.find((row) => row.name === step)?.ordinal;
  const attempt = journal.attempts.find((row) => row.ordinal === ordinal);
  const activation = journal.activations.find(
    (row) => row.generation === attempt?.generation
  );
  return {
    separateAlarm: handledAt.some(
      (handler) =>
        handler.object === object &&
        handler.order > releasedAt &&
        handler.order < effectAt
    ),
    fits:
      attempt !== undefined &&
      activation !== undefined &&
      attempt.deadline <= activation.started_at + budgetedHandlerMs,
  };
};

/**
 * The nap of the run whose wake passes while a delivery is held. Its first
 * delivery fails as the nap starts, give or take how slow the host is,
 * and is retried a second later (`notifyRetryMs`): that retry, held, must
 * come before the wake, and the hold, ending just past the wake, within
 * the delivery's timeout (`notifyTimeoutMs`, two seconds for these runs),
 * or the alarm runs the run itself. With a nap of 2.5 s the first failure
 * may come up to 1.5 s late and the hold still lasts under 1.6 s.
 */
export const napMs = 2500;

/** How far past the run's wake its held delivery is let go. */
export const pastWakeMs = 100;

/**
 * Holds the second delivery of a budget-napper run past its wake (the
 * first fails), then lets it go with the next `failures` alarm writes of
 * its object failing. Returns the warnings meanwhile, once `settled` says.
 */
export const dueWithFailingAlarms = async (
  id: string,
  failures: number,
  settled: () => Promise<unknown>
): Promise<{ warnings: unknown[]; failuresLeft: number }> => {
  notifyFailures.set(id, 1);
  const delivery = hold(id, "notify", 2);
  await warningsDuring(async () => {
    await workflow("budget-napper", env.BUDGETED_RUNS).create({
      id,
      params: { duration: 1500 },
    });
    await delivery.held;
  });
  const journal = await journalOf("budget-napper", id, env.BUDGETED_RUNS);
  await pastTime((journal.run.wake_at ?? 0) + 300);
  const failing = { left: failures };
  await runInDurableObject(
    runObject("budget-napper", id, env.BUDGETED_RUNS),
    (_, state) => {
      const { storage } = state;
      const set: unknown = Reflect.get(storage, "setAlarm");
      if (typeof set !== "function") {
        throw new TypeError("storage has no setAlarm");
      }
      Reflect.set(storage, "setAlarm", async (time: number) => {
        if (failing.left > 0) {
          failing.left -= 1;
          throw new Error("injected storage failure");
        }
        await Reflect.apply(set, storage, [time]);
      });
    }
  );
  const warnings = await warningsDuring(async () => {
    delivery.release();
    await settled();
  });
  await runInDurableObject(
    runObject("budget-napper", id, env.BUDGETED_RUNS),
    (_, state) => {
      Reflect.deleteProperty(state.storage, "setAlarm");
    }
  );
  return { warnings, failuresLeft: failing.left };
};
