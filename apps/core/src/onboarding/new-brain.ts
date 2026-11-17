import { brainSourceErrors } from "@grasp-os/shared/brain-sources";
import { log } from "@grasp-os/shared/log";

import { erasureBegun } from "../brain-hand-overs.ts";
import { addSource, eraseSource } from "../brain-next.ts";
import type { Filed, Handed, SourceReaders, SourceRef } from "../brain-next.ts";
import { drawingText, routineFacts } from "./routine.ts";
import { onboardingStore } from "./store.ts";
import type { OwedErasure, StandingDrawing } from "./store.ts";
import { claimSource } from "./team-claims.ts";

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
//   quotes), readable by every member of the company reading as themselves
//   (GRA-1748, decided on 16 November; `members`: never code, an App or a
//   workflow, which could keep a copy past its fall, until the owner says
//   whether code may copy claims), only while everyone it rests on still
//   counts and its team's work may show: from the first person who told
//   it (GRA-1987; counted by the store, never in the Brain). Noted by an audit event
//   for the hand-over (brain-hand-overs.ts), which reads it here
//   (`claimOf`) when it runs: a team's, never a person's.
// - A drawing of a team's piece of work (`drawing:<id>`, GRA-1748): only
//   the parts its people are checked to have told, never who told what
//   or how many, readable by every member reading as themselves
//   (`members`, as a claim), only while everyone it rests on still counts,
//   its team's work may show, and its map stands on its lead's facts
//   (counted by the store). Noted and read like a claim
//   (`drawingOf`); one drawn anew is a new source. Its routine (GRA-1749,
//   routine.ts) is filed on its version as it is handed over, resting on
//   it: it falls with the drawing.
// - The kickoff (`kickoff:<id>`, GRA-1748): what every member reads of it
//   (kickoff-company.ts), readable by everyone, under an id minted for
//   each kickoff. Noted for the hand-over like a claim, and read here
//   when it runs (`kickoffOf`): a version is what it reads then, so saves
//   and answers between two hand-overs are one version, and nothing
//   anyone could read is lost.
//   The admin's delete erases it (`eraseOwedKickoffs`), every version.
// - The company's teams (`roster:teams-<n>`, GRA-1748): each confirmed
//   team taking part, as the admin described it, and its head count, never
//   what a lead's map says it does nor who is in it (company-teams.ts),
//   readable by everyone. Noted and read like the kickoff (`rosterOf`): a
//   version is what a hand-over reads, so confirmed changes between two
//   hand-overs are one version, and nothing anyone could read is lost. The admin may erase it, every
//   version (`eraseOwedRosters`); the next confirmed save gives it afresh
//   under a new id.
//
// A claim or a drawing that stops standing is out of use in the shared
// store before the change that drops it commits (the store's
// `#fallenFirst`), so no read after that change finds it (GRA-1946); its
// erasure follows.
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
        readers: { kind: "members" },
      };
};

/** A drawing's source, by the store's id for it (`brain_drawings.source`). */
export const drawingSource = (id: string): SourceRef => ({
  producer: "drawing",
  id,
});

/**
 * The routine a drawing makes (routine.ts, GRA-1749), filed on the
 * drawing's version as it is handed over: the routine and its team, each
 * found again by an exact identifier of the onboarding's own, so every
 * drawing of the same piece of work is the same routine. Only from what
 * the drawing's row holds, never the staff list as it is now: every
 * attempt files the same. Nothing when no step of it stands.
 */
const routineFiled = (held: StandingDrawing): { filed?: Filed } => {
  const facts = routineFacts(held);
  if (facts.length === 0) {
    return {};
  }
  return {
    filed: {
      entities: [
        {
          key: "routine",
          kind: "routine",
          names:
            held.local === undefined ? [held.name] : [held.name, held.local],
          identifiers: [
            { type: "ref", value: `grasp:routine:${held.workflow}` },
          ],
        },
        // By its identifier alone: a name would be the staff list's at the
        // moment of each attempt, and a retry after a rename would file
        // other memories under the same change.
        {
          key: "team",
          kind: "team",
          identifiers: [{ type: "ref", value: `grasp:team:${held.team}` }],
        },
      ],
      memories: facts.map(({ attribute, value, statement, line }) => ({
        about: "routine",
        attribute,
        ...(attribute === "team" ? { object: "team" } : { value }),
        type: "fact",
        statement,
        quote: line,
      })),
    },
  };
};

/** Drawing `id` as the onboarding holds it now: what its people told of the piece of work; nothing once it no longer stands. */
export const drawingOf = async (env: Env, id: string): Promise<Handed> => {
  const held = await onboardingStore(env).drawingToHand(id);
  return held === null
    ? gone
    : {
        kind: "source",
        change: id,
        text: drawingText(held),
        whenTooLarge: "A drawing of the team's work too large to keep.",
        readers: { kind: "members" },
        ...routineFiled(held),
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

/** The company's teams' source, by the store's id for it. */
export const rosterSource = (id: string): SourceRef => ({
  producer: "roster",
  id,
});

/** Who reads the company's teams in the Brain: everyone in the company (the owner, 17 November). */
const rosterReaders: SourceReaders = { kind: "everyone" };

/** The company's teams as the admin last confirmed them (`rosterToHand`), for everyone in the company. */
export const rosterOf = async (env: Env, id: string): Promise<Handed> => {
  const held = await onboardingStore(env).rosterToHand(id);
  return held === null
    ? gone
    : {
        kind: "source",
        change: held.change,
        text: held.text,
        whenTooLarge: "The company's teams too many to keep.",
        readers: rosterReaders,
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

/**
 * Erases from the Brain every id of the company's teams the admin erased
 * that it may still hold (`rosterErasuresOwed`), each then forgotten
 * there: right after the erase, and on core's clock until none is owed.
 * Each failure is logged by name alone and left owed. Whether none is
 * owed any more.
 */
export const eraseOwedRosters = async (env: Env): Promise<boolean> => {
  const store = onboardingStore(env);
  for (const id of await store.rosterErasuresOwed()) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one erasure at a time
      await eraseSource(env, {
        source: rosterSource(id),
        readers: rosterReaders,
        reason: "deleted",
      });
      // oxlint-disable-next-line no-await-in-loop -- one erasure at a time
      await store.rosterErased(id);
    } catch (error) {
      log.error("onboarding.brain_erasure_failed", {
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }
  const owed = await store.rosterErasuresOwed();
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
    source:
      owed.kind === "claim"
        ? claimSource(owed.source)
        : drawingSource(owed.source),
    readers: { kind: "members" },
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
  await eraseOwedRosters(env);
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
