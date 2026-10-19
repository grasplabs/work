import { errorFields, log } from "@grasp-os/shared/log";
import { drizzle } from "drizzle-orm/d1";

import { anyQueued, queueFronts, sharesOf } from "./admission.ts";
import { runEngine } from "./engine.ts";
import { quotaPolicy } from "./quotas.ts";
import type { AttemptAdmission } from "./quotas.ts";

// Waking a step that waits for a share when one is given back: an attempt
// settles, or the engine fenced it (run-object.ts). A waiting step sleeps
// its backoff, five seconds doubling to a minute (admission.ts,
// `askAgainMs`), so its journal stays bounded; while it sleeps, its place
// holds back the share it would take (`servedInOrder`), which could sit
// idle until it asked again. A wake tells it to ask now. Threat model:
//
// - Jumping the queue with a wake: only the places serving the queue in
//   order would admit now are woken (`queueFronts`), and a wake carries
//   nothing: the step only asks again, and admission decides as it would
//   have at its next ask. One woken that a newer lease beat finds the
//   share full, and waits its next round.
// - A wake that unbounds the journal again: each wake ends one round, and
//   a place is woken once per round at most (the delivery's key names the
//   attempt that wrote it, `share:<run>:<step>:<deadline>`, which the
//   engine takes once), and only when a share was given back. So rounds
//   stay bounded by the backoff plus the shares given back to it.
// - A forged, stray, late or doubled wake: an event of a share wake's type
//   costs one ask, as an early end of one round, and moves no one up the
//   queue. One taken after the step stopped waiting stays in its run's
//   inbox, bounded by the engine, and ends a later round of the same step
//   early: one ask more.
// - A lost wake: never stored nor sent again; the step asks at the end of
//   its round, as it did without wakes. A wake that can't be sent is
//   logged, never thrown, so settling an attempt or fencing a run never
//   fails for it.
// - A wake storm overloading core's database or the engine: one read of
//   the queue per share given back (by its indexes, as an admission reads
//   it), and as many wakes as the client's share at most. With no one
//   queued, as most settles find it, one indexed read and nothing else.

/** The prefix of the event type that wakes a step waiting for a share. */
const shareWakePrefix = "grasp-share-";

/**
 * The event type that wakes a run's step waiting for a share, by the
 * SHA-256 of its name, as its place in the queue keeps it (`stepHash`).
 */
export const shareWakeType = (stepHash: string): string =>
  `${shareWakePrefix}${stepHash.slice(0, 16)}`;

/**
 * Wakes the steps a share given back may leave waiting for nothing but
 * their next ask (`queueFronts`). With no one queued, it reads the queue
 * once, by its index, and nothing more: no policy, no order. Never
 * throws: a wake not sent leaves its step to ask at the end of its round.
 */
export const wakeQueueFronts = async (env: Env): Promise<void> => {
  try {
    const db = drizzle(env.DB);
    const now = Date.now();
    if (!(await anyQueued(db, now))) {
      return;
    }
    const fronts = await queueFronts(db, now, sharesOf(await quotaPolicy(env)));
    const engine = runEngine(env);
    await Promise.all(
      fronts.map(async ({ runId, stepHash, deadline }) => {
        await engine.sendEvent(
          runId,
          shareWakeType(stepHash),
          `share:${runId}:${stepHash}:${String(deadline)}`
        );
      })
    );
  } catch (error) {
    log.warn("workflow.share_wake_failed", errorFields(error));
  }
};

/** `admission`, whose settling wakes the steps its share may let in. */
export const wakingOnSettle = (
  env: Env,
  admission: AttemptAdmission
): AttemptAdmission => ({
  ...admission,
  settle: async () => {
    await admission.settle();
    await wakeQueueFronts(env);
  },
});
