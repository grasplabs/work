import { brainSourceErrors } from "@grasp-os/shared/brain-sources";
import { log } from "@grasp-os/shared/log";

import { erasureBegun } from "../brain-hand-overs.ts";
import { addSource, eraseSource } from "../brain-next.ts";
import type { Handed, SourceRef } from "../brain-next.ts";
import { onboardingStore } from "./store.ts";
import type { OwedErasure } from "./store.ts";

// What the onboarding gives the new Brain (GRA-1790, GRA-1741, GRA-1748), and takes
// back. The onboarding's store decides what stands, from its own records:
//
// - A person's interview (`interview:<id>`): the facts they approved,
//   readable by the account it belongs to alone, so it is kept in their
//   own store. The id is minted by the store for one decision of it; a
//   decision that moves is a new source, and the old one is erased. Core
//   adds it here itself (`addOwedInterviews`), right after the person's
//   request and on its clock, never through the hand-over: a hand-over is
//   noted and ended by audit events, which the company reads, and nothing
//   of anyone's interview may reach that log, not even that it is in their
//   Brain. Only the onboarding's own log, which staff read, notes it.
// - A team's claim (`claim:<id>`): its sentence alone (no names, no
//   quotes), readable by the people of that staff-list team, only while
//   five or more back it and seven or more of the team were interviewed
//   (counted by the store, never in the Brain). Noted by an audit event
//   for the hand-over (brain-hand-overs.ts), which reads it here
//   (`claimOf`) when it runs: a team's, never a person's.
// - The kickoff (`kickoff:<id>`, GRA-1748): what every member reads of it
//   (kickoff-company.ts), readable by everyone, a new version at each save
//   and answer, under an id minted for each kickoff. Noted for the
//   hand-over like a claim, and read here when it runs (`kickoffOf`).
//   The admin's delete erases it (`eraseOwedKickoffs`), every version.
//
// What no longer stands is erased with `eraseSource`, directly: at once
// after anything that takes an interview out (links.ts, admin-command.ts,
// person-erasure.ts), and on core's clock until done
// (`settleOnboardingBrain`). An add that lands after the erasure is
// refused by the closed key.

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

const gone: Handed = { kind: "gone", skipped: "deleted" };

/**
 * Adds to the new Brain each interview the onboarding decided stands and
 * core hasn't added yet (`interviewsToAdd`), only `person`'s when given,
 * each in the own store of the account it belongs to, then forgets it
 * there. One whose account's erasure began is left to that erasure. Each
 * failure is logged by name alone and left for the next run: core's clock
 * runs this every minute.
 */
export const addOwedInterviews = async (
  env: Env,
  person?: string
): Promise<void> => {
  const store = onboardingStore(env);
  for (const owed of await store.interviewsToAdd(person)) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one add at a time
      if (await erasureBegun(env, owed.account)) {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- one add at a time
      await addSource(env, {
        source: interviewSource(owed.source),
        // A source stands for one decision: its id is its change's key.
        change: owed.source,
        text: owed.text,
        readers: { kind: "owner", personId: owed.account },
      });
      // oxlint-disable-next-line no-await-in-loop -- one add at a time
      await store.addedToBrain(owed.source);
    } catch (error) {
      // Erased meanwhile: its key is closed, and its erasure is owed, so
      // there is nothing more to add.
      if (brainSourceErrors.codeOf(error) === "brain.source_erased") {
        // oxlint-disable-next-line no-await-in-loop -- one add at a time
        await store.addedToBrain(owed.source);
        continue;
      }
      log.error("onboarding.brain_add_failed", {
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }
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

/** The kickoff's source, by the store's id for it (`kickoffBrainId`). */
export const kickoffSource = (id: string): SourceRef => ({
  producer: "kickoff",
  id,
});

/** The kickoff `id` as the onboarding holds it now: what every member reads of it; nothing once it was deleted. */
export const kickoffOf = async (env: Env, id: string): Promise<Handed> => {
  const held = await onboardingStore(env).kickoffToHand(id);
  return held === null
    ? gone
    : {
        kind: "source",
        change: held.change,
        text: held.text,
        whenTooLarge: "The company's vision too large to keep.",
        readers: { kind: "everyone" },
      };
};

/**
 * Erases from the Brain every kickoff the admin deleted that it may still
 * hold (`kickoffErasuresOwed`), each then forgotten there: right after the
 * delete, and on core's clock until none is owed. Each failure is logged
 * by name alone and left owed. Whether none is owed any more.
 */
export const eraseOwedKickoffs = async (env: Env): Promise<boolean> => {
  const store = onboardingStore(env);
  for (const id of await store.kickoffErasuresOwed()) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one erasure at a time
      await eraseSource(env, {
        source: kickoffSource(id),
        readers: { kind: "everyone" },
        reason: "deleted",
      });
      // oxlint-disable-next-line no-await-in-loop -- one erasure at a time
      await store.kickoffErased(id);
    } catch (error) {
      log.error("onboarding.brain_erasure_failed", {
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }
  const owed = await store.kickoffErasuresOwed();
  return owed.length === 0;
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
 * (`owedErasures`), or only those `scope` names, each then forgotten
 * there. Each failure is logged by name alone and left for
 * the next run: core's clock runs it every minute, for every owed source,
 * until none is owed. One that fails for ever is retried every minute and
 * logged each time, never parked: the store keeps it owed until
 * `eraseSource` returns.
 */
export const eraseOwedOnboardingSources = async (
  env: Env,
  scope?:
    | { person: string; teams?: readonly string[] }
    | { claims: true }
    | { account: string }
): Promise<void> => {
  const store = onboardingStore(env);
  for (const owed of await store.owedErasures(scope)) {
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
 * Settles what the onboarding owes the new Brain: every erasure owed
 * first (a deleted kickoff's, then the interviews' and claims'), then
 * every interview to add (`addOwedInterviews`). Core's clock runs it
 * every minute.
 */
export const settleOnboardingBrain = async (env: Env): Promise<void> => {
  await eraseOwedKickoffs(env);
  await eraseOwedOnboardingSources(env);
  await addOwedInterviews(env);
};

/**
 * Erases every interview the Brain holds under `account` that no longer
 * stands, whoever's link it came from, then throws while any is still
 * owed: for core's erasure of that account, which lets go only once none
 * is (person-erasure.ts). Keyed by the account alone, so it never reaches
 * the interview of whoever holds that link now.
 */
export const eraseOnboardingAccount = async (
  env: Env,
  account: string
): Promise<void> => {
  await eraseOwedOnboardingSources(env, { account });
  const owed = await onboardingStore(env).owedErasures({ account });
  if (owed.length > 0) {
    throw new Error("The Brain still holds their interview.");
  }
};

/**
 * Settles what the onboarding owes the Brain because of `person`'s request,
 * where a failure must not fail what ran before it: erases their interview
 * and their team's claims it took out, then adds their interview as it
 * stands now, so they find it in their Brain as soon as they approve. The
 * rest, and any failure, is core's clock's. Whether every erasure it owed
 * landed: nothing of theirs, nor of those teams' claims, is still owed one.
 */
export const eraseOwedOfPersonQuietly = async (
  env: Env,
  person: string | null,
  /** The teams whose claims they backed before the request (`claimTeamsOf`). */
  teams: readonly string[] = []
): Promise<boolean> => {
  if (person === null) {
    return true;
  }
  try {
    await eraseOwedOnboardingSources(env, { person, teams });
    await addOwedInterviews(env, person);
    const owed = await onboardingStore(env).owedErasures({ person, teams });
    return owed.length === 0;
  } catch (error) {
    log.error("onboarding.brain_erasure_failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return false;
  }
};

/**
 * Erases the claims the onboarding owes the Brain, after a roster save
 * that may take any team under seven, where a failure must not fail the
 * save. Any failure is core's clock's.
 */
export const eraseOwedClaimsQuietly = async (env: Env): Promise<void> => {
  try {
    await eraseOwedOnboardingSources(env, { claims: true });
  } catch (error) {
    log.error("onboarding.brain_erasure_failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
  }
};
