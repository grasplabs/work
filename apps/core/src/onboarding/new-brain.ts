import { log } from "@grasp-os/shared/log";

import { addSource, eraseSource } from "../brain-next.ts";
import { onboardingStore } from "./store.ts";
import type { NewBrainItem } from "./store.ts";

// What the onboarding gives the new Brain (GRA-1790, GRA-1741), and takes
// back. The onboarding's store decides what and when, from its own
// records (`newBrainWork`); core does it here, since the store can't reach
// the Brain itself, and tells the store what was done (`newBrainDone`):
//
// - A person's interview: the facts they approved, as a source
//   `interview:<id>` only the account linked to them reads. The id is
//   minted by the store for one text; a changed text is a new source and
//   the old one is erased.
// - A team's claim: a source `claim:<id>` holding the claim's sentence
//   alone (no names, no quotes), readable by the people of that staff-list
//   team who signed in, added only once five or more back it (counted by
//   the store, never in the Brain) and erased for good once fewer do. The
//   id is minted by the store each time the claim stands: an erased key is
//   closed, so a claim backed again later is a new source.
//
// Run on core's clock every minute, and at once after anything that takes
// an interview out (links.ts, admin-command.ts, interview-erasure.ts,
// person-erasure.ts). Two runs at once do no harm: every add is keyed,
// every erasure can be repeated, and an erased key takes no add again.

type Done = Parameters<ReturnType<typeof onboardingStore>["newBrainDone"]>[0];

/** Does one item; answers what was done. */
const doItem = async (env: Env, item: NewBrainItem): Promise<Done | null> => {
  switch (item.kind) {
    case "eraseInterview": {
      await eraseSource(env, {
        source: { producer: "interview", id: item.source },
        readers: { kind: "owner", personId: item.account },
        reason: item.reason,
      });
      return { kind: "interviewErased", source: item.source };
    }
    case "keepInterview": {
      await addSource(env, {
        source: { producer: "interview", id: item.source },
        // A source stands for one text: its id is its change's key.
        change: item.source,
        text: item.text,
        readers: { kind: "owner", personId: item.account },
      });
      return { kind: "interviewKept", source: item.source };
    }
    case "eraseClaim": {
      await eraseSource(env, {
        source: { producer: "claim", id: item.source },
        readers: { kind: "interviews", teamId: item.team },
        reason: "deleted",
      });
      return { kind: "claimErased", source: item.source };
    }
    case "keepClaim": {
      await addSource(env, {
        source: { producer: "claim", id: item.source },
        change: item.source,
        text: item.text,
        readers: { kind: "interviews", teamId: item.team },
      });
      // Dropped meanwhile: erased now, before anyone reads it as standing.
      if (
        await onboardingStore(env).newBrainDone({
          kind: "claimKept",
          source: item.source,
        })
      ) {
        await eraseSource(env, {
          source: { producer: "claim", id: item.source },
          readers: { kind: "interviews", teamId: item.team },
          reason: "deleted",
        });
        return { kind: "claimErased", source: item.source };
      }
      return null;
    }
    default: {
      return item satisfies never;
    }
  }
};

/**
 * Gives the new Brain what the onboarding owes it, in the order the store
 * answers (erasures first). Each failure is logged by
 * name alone and left for the next run.
 */
export const keepOnboardingBrain = async (env: Env): Promise<void> => {
  const store = onboardingStore(env);
  for (const item of await store.newBrainWork()) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- in order, one at a time
      const done = await doItem(env, item);
      if (done !== null) {
        // oxlint-disable-next-line no-await-in-loop -- in order, one at a time
        await store.newBrainDone(done);
      }
    } catch (error) {
      log.error("onboarding.new_brain_failed", {
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }
};

/**
 * `keepOnboardingBrain`, then throws while the new Brain may still hold
 * `person`'s interview: for core's erasures, which let go only once it
 * doesn't.
 */
export const eraseOnboardingInterview = async (
  env: Env,
  person: string
): Promise<void> => {
  await keepOnboardingBrain(env);
  if (await onboardingStore(env).interviewOwed(person)) {
    throw new Error("The Brain still holds their interview.");
  }
};

/** `keepOnboardingBrain` where a failure must not fail what ran before it. */
export const keepOnboardingBrainQuietly = async (env: Env): Promise<void> => {
  try {
    await keepOnboardingBrain(env);
  } catch (error) {
    log.error("onboarding.new_brain_failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
  }
};
