import { log } from "@grasp-os/shared/log";

import { erasureBegun } from "../brain-hand-overs.ts";
import { eraseSource } from "../brain-next.ts";
import type { Handed, SourceRef } from "../brain-next.ts";
import { onboardingStore } from "./store.ts";
import type { OwedErasure } from "./store.ts";

// What the onboarding gives the new Brain (GRA-1790, GRA-1741), and takes
// back. The onboarding's store decides what stands, from its own records,
// and notes each new source with an audit event its outbox's drain turns
// into a hand-over (brain-hand-overs.ts). Core's hand-over reads it here,
// as the store holds it when the hand-over runs (brain-sources.ts
// `producers`), and adds it through `addSource`:
//
// - A person's interview (`interview:<id>`): the facts they approved,
//   readable by the account linked to them alone, so it is kept in their
//   own store. The id is minted by the store for one decision of it; a
//   decision that moves is a new source, and the old one is erased.
// - A team's claim (`claim:<id>`): its sentence alone (no names, no
//   quotes), readable by the people of that staff-list team who signed
//   in, only while five or more back it and seven or more of the team
//   were interviewed (counted by the store, never in the Brain).
//
// What no longer stands is erased with `eraseSource`, directly: at once
// after anything that takes an interview out (links.ts, admin-command.ts,
// interview-erasure.ts, person-erasure.ts), and on core's clock until done
// (`eraseOwedOnboardingSources`). A hand-over that runs after its source
// stopped standing adds nothing, and one whose add lands after the erasure
// is refused by the closed key.

/** An interview's source, by the store's id for it. */
export const interviewSource = (id: string): SourceRef => ({
  producer: "interview",
  id,
});

/** A team claim's source, by the store's id for it. */
export const claimSource = (id: string): SourceRef => ({
  producer: "claim",
  id,
});

const gone: Handed = { kind: "gone" };

/**
 * Interview `id` as the onboarding holds it now: its approved facts, for
 * its linked account alone; nothing once it no longer stands; erased once
 * that account's erasure began.
 */
export const interviewOf = async (env: Env, id: string): Promise<Handed> => {
  const held = await onboardingStore(env).interviewToHand(id);
  if (held === null) {
    return gone;
  }
  const readers = { kind: "owner", personId: held.account } as const;
  if (await erasureBegun(env, held.account)) {
    return { kind: "erased", readers };
  }
  return {
    kind: "source",
    // A source stands for one decision: its id is its change's key.
    change: id,
    text: held.text,
    whenTooLarge: "An interview whose approved facts were too large to keep.",
    readers,
  };
};

/** Team claim `id` as the onboarding holds it now: its sentence, for its team; nothing once it no longer stands. */
export const claimOf = async (env: Env, id: string): Promise<Handed> => {
  const held = await onboardingStore(env).claimToHand(id);
  return held === null
    ? gone
    : {
        kind: "source",
        change: id,
        text: held.text,
        whenTooLarge: "A claim of the team's too large to keep.",
        readers: { kind: "interviews", teamId: held.team },
      };
};

/** Erases one owed source from the Brain, with the readers it was added for. */
const erase = async (env: Env, owed: OwedErasure): Promise<void> => {
  if (owed.kind === "interview") {
    await eraseSource(env, {
      source: interviewSource(owed.source),
      readers: { kind: "owner", personId: owed.account },
      reason: owed.reason,
    });
    return;
  }
  await eraseSource(env, {
    source: claimSource(owed.source),
    readers: { kind: "interviews", teamId: owed.team },
    reason: "deleted",
  });
};

/**
 * Erases every source the onboarding still owes the Brain an erasure of
 * (`owedErasures`), each then forgotten there. Each failure is logged by
 * name alone and left for the next run: core's clock runs it every
 * minute, until none is owed.
 */
export const eraseOwedOnboardingSources = async (env: Env): Promise<void> => {
  const store = onboardingStore(env);
  for (const owed of await store.owedErasures()) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one erasure at a time
      await erase(env, owed);
      // oxlint-disable-next-line no-await-in-loop -- one erasure at a time
      await store.erasedFromBrain(owed.kind, owed.source);
    } catch (error) {
      log.error("onboarding.brain_erasure_failed", {
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }
};

/**
 * `eraseOwedOnboardingSources`, then throws while the Brain may still hold
 * `person`'s interview: for core's erasures and purges, which let go only
 * once it doesn't.
 */
export const eraseOnboardingInterview = async (
  env: Env,
  person: string
): Promise<void> => {
  await eraseOwedOnboardingSources(env);
  if (await onboardingStore(env).interviewOwed(person)) {
    throw new Error("The Brain still holds their interview.");
  }
};

/** `eraseOwedOnboardingSources` where a failure must not fail what ran before it. */
export const eraseOwedOnboardingSourcesQuietly = async (
  env: Env
): Promise<void> => {
  try {
    await eraseOwedOnboardingSources(env);
  } catch (error) {
    log.error("onboarding.brain_erasure_failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
  }
};
