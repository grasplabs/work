import { brainOf, personalBrainOf } from "@grasp-os/brain-next/contract";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { drainObjectOutbox } from "../src/audit-outbox.ts";
import {
  brainExportFile,
  brainExportStatus,
  erasePerson,
  listSourcesAs,
  listVersionsAs,
  readSourceVersionAs,
  recallAs,
  startBrainExport,
  workBrain,
} from "../src/brain-next.ts";
import { producersOf, relayHandOvers } from "../src/brain-sources.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { interviewErasure } from "../src/onboarding/interview-erasure.ts";
import { eraseOwedOnboardingSources } from "../src/onboarding/new-brain.ts";
import { onboardingStore } from "../src/onboarding/store.ts";
import { teamMayClaim } from "../src/onboarding/team-claims.ts";
import { retryErasures } from "../src/person-erasure.ts";
import { ageOwnErasure } from "./brain-next-own-store.ts";
import { mockIdp } from "./idp.ts";
import {
  accountOf,
  answering,
  answeringWith,
  holdAlarm,
  onLink,
  openLinkAs,
  sentToOf,
  signedInAs,
} from "./interview-link.ts";
import {
  agree,
  claimsReply,
  fact,
  intake,
  mapped,
  openLink,
  rosterOf,
  team,
  ticketsReply,
  told,
  zendeskClaim,
  zendeskSaid,
} from "./onboarding-team.ts";
import type { Key } from "./onboarding-team.ts";
import { acmeTenant } from "./sign-in-config.ts";
import {
  auditedDuring,
  entraPerson,
  signedInApi,
  signedIn,
  unique,
  whoami,
  withSignIn,
} from "./sign-in.ts";

// Each interview in the new Brain, readable by the person interviewed
// alone (GRA-1790), and the team claims five or more of them back,
// readable by their team (GRA-1741): from the threat model on GRA-1790.
// The ways it can fail, tried here:
//
// - An admin edits someone's address on the list after their link went
//   out, signs in with it, and reads their interview.
// - Anyone but the person (a team-mate, an admin) recalls a word of it.
// - The company's audit log telling the moment someone finished or changed
//   their interview: a source is noted only once the day turned.
// - A withdrawal, an edit, a new start, a purge or core's erasure leaving
//   their words in the Brain.
// - The same interview handed over twice, as two sources, also when a
//   drain is cut off and runs again.
// - A link that went to a wrong address first, and was opened there:
//   after staff's new start, that account reads nothing of what came
//   after, and the link opens for the address the list has now.
// - A claim four people back reaching the Brain at all; a claim the fifth
//   backer's withdrawal leaves at four still readable, as history or
//   otherwise; claims in a team so small its readers know who said them.
// - A race: an intake whose backers change meanwhile, a claim dropped or
//   an interview withdrawn while its add is in flight.

const idp = mockIdp();

/** Everyone on the team's list. */
const everyone: readonly Key[] = [
  "lea",
  "max",
  "mia",
  "mo",
  "noor",
  "pim",
  "rik",
];

/** An address on the list, from a person's id. */
const addressOf = (person: string): string => `${person}@acme.test`;

/** Signs in with `email` as a member; answers their user id. */
const signsIn = async (
  email: string,
  role: "admin" | "user" = "user"
): Promise<string> => {
  const session = await signedIn(
    idp,
    "microsoft",
    entraPerson(acmeTenant, "acme.test", { email }),
    { coreEnv: withSignIn({ admins: [email] }) }
  );
  const { userId } = await whoami(session);
  if (role !== "admin") {
    await env.DB.prepare("UPDATE members SET role = ? WHERE user_id = ?")
      .bind(role, userId)
      .run();
  }
  return userId;
};

/**
 * Core's env with the Brain's store held at each add of a source `holds`
 * picks: `arrived` once one is in flight, which waits for `release`.
 */
const holdingAdds = (holds: (source: string) => boolean) => {
  const released = Promise.withResolvers<boolean>();
  const arrived = Promise.withResolvers<string>();
  const stubOf = <T extends object>(stub: T): T =>
    new Proxy(stub, {
      get: (target, name): unknown => {
        const member: unknown = Reflect.get(target, name);
        if (typeof member !== "function") {
          return member;
        }
        // An RPC stub's members are its own: called with Reflect, never
        // through `call` or `bind`, which it would take for methods.
        if (name !== "addSource") {
          return (...given: unknown[]): unknown =>
            Reflect.apply(member, target, given);
        }
        return async (added: { source: string }): Promise<unknown> => {
          if (holds(added.source)) {
            arrived.resolve(added.source);
            await released.promise;
          }
          const answer: unknown = await Reflect.apply(member, target, [added]);
          return answer;
        };
      },
    });
  const namespaceOf = <T extends object>(namespace: T): T =>
    new Proxy(namespace, {
      get: (target, name): unknown => {
        const member: unknown = Reflect.get(target, name);
        if (typeof member !== "function") {
          return member;
        }
        if (name !== "jurisdiction" && name !== "getByName") {
          return (...given: unknown[]): unknown =>
            Reflect.apply(member, target, given);
        }
        return (argument: unknown): unknown => {
          const made: unknown = Reflect.apply(member, target, [argument]);
          if (typeof made !== "object" || made === null) {
            return made;
          }
          return name === "jurisdiction" ? namespaceOf(made) : stubOf(made);
        };
      },
    });
  const held: Env = { ...env, BRAIN_STORE: namespaceOf(env.BRAIN_STORE) };
  return {
    env: held,
    arrived: arrived.promise,
    release: () => {
      released.resolve(true);
    },
  };
};

/**
 * Core's env with every erasure in the Brain's stores failing, as when the
 * Brain is out of reach: what an inline erasure, or the clock's, leaves.
 */
/** A store's stub whose every erasure fails. */
const failingErasuresOf = <T extends object>(stub: T): T =>
  new Proxy(stub, {
    get: (target, name): unknown => {
      const member: unknown = Reflect.get(target, name);
      if (typeof member !== "function") {
        return member;
      }
      if (name === "eraseSource") {
        return async (): Promise<never> => {
          await Promise.resolve();
          throw new Error("The Brain is out of reach.");
        };
      }
      return (...given: unknown[]): unknown =>
        Reflect.apply(member, target, given);
    },
  });

const erasuresFailing = (): Env => {
  const namespaceOf = <T extends object>(namespace: T): T =>
    new Proxy(namespace, {
      get: (target, name): unknown => {
        const member: unknown = Reflect.get(target, name);
        if (typeof member !== "function") {
          return member;
        }
        if (name !== "jurisdiction" && name !== "getByName") {
          return (...given: unknown[]): unknown =>
            Reflect.apply(member, target, given);
        }
        return (argument: unknown): unknown => {
          const made: unknown = Reflect.apply(member, target, [argument]);
          if (typeof made !== "object" || made === null) {
            return made;
          }
          return name === "jurisdiction"
            ? namespaceOf(made)
            : failingErasuresOf(made);
        };
      },
    });
  return { ...env, BRAIN_STORE: namespaceOf(env.BRAIN_STORE) };
};

/** The queue's clock across this file: only forward, as core's clock goes. */
const clock = { at: Date.now() };

/**
 * Hands over what the onboarding noted, as core does: its outbox drained
 * (which notes each hand-over), the hand-overs relayed to the Brain's
 * queue, and the Brain ticked with core's producers, through `into`.
 */
const handOverNow = async (into: Env = env): Promise<void> => {
  await runInDurableObject(onboardingStore(env), async (_, state) => {
    await drainObjectOutbox(env, state.storage.sql, 0);
  });
  await relayHandOvers(env);
  clock.at = Math.max(clock.at, Date.now()) + 1;
  await workBrain(into, new Date(clock.at), producersOf(into));
};

/** Where the Brain keeps the source `key`: its state in the shared store and in `person`'s own. */
const keptIn = async (key: string, person: string) => {
  const stores = inJurisdiction(env, env.BRAIN_STORE);
  const [shared, own] = await Promise.all([
    brainOf(stores).keyState(key),
    personalBrainOf(stores, person).keyState(key),
  ]);
  return { shared, own };
};

/** The key of `userId`'s own interview in the Brain, as they list it. */
const interviewKeyOf = async (userId: string): Promise<string> => {
  const { sources } = await listSourcesAs(env, userId);
  const interview = sources.find(
    ({ source }) => source.producer === "interview"
  );
  if (interview === undefined) {
    throw new Error("No interview is listed.");
  }
  return `interview:${interview.source.id}`;
};

/** Most teams an earlier test of this file can leave due before a claim test's own. */
const teamsDueMax = 20;

/**
 * Gives the Brain each team due until `ids`' team, with the model putting
 * `claims` together: earlier tests of this file leave their teams due.
 */
const intakeOf = async (
  ids: { team: string },
  claims: Parameters<typeof intake>[1]
): Promise<void> => {
  for (let round = 0; round < teamsDueMax; round += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one team at a time, as the alarm gives them
    const { gave } = await intake(ids, claims);
    if (gave === `brain:${ids.team}`) {
      return;
    }
    if (gave === null) {
      throw new Error("The team was never due.");
    }
  }
  throw new Error(`The team wasn't given within ${teamsDueMax} teams due.`);
};

/** What `userId` recalls of `word`, of sources of `producer` or any: the texts found. */
const recalled = async (
  userId: string,
  word: string,
  producer?: string
): Promise<string[]> => {
  const { items } = await recallAs(env, userId, {
    question: word,
    budget: { tokens: 2000 },
    personal: true,
  });
  return items
    .filter(
      ({ source }) => producer === undefined || source.producer === producer
    )
    .map(({ text }) => text)
    .filter((text) => text.includes(word));
};

/** The team claims `userId` may read: listed, each with every version of it they may read. */
const claimsOf = async (userId: string) => {
  const { sources } = await listSourcesAs(env, userId);
  const claims = sources.filter(({ source }) => source.producer === "claim");
  return await Promise.all(
    claims.map(async ({ source }) => {
      const { versions } = await listVersionsAs(env, userId, { source });
      return { source, versions: versions.map(({ version }) => version) };
    })
  );
};

/**
 * A day passes for `person`'s interview: what they saved and approved is
 * from yesterday, as the store reads it, and core's clock runs, as it does
 * every minute: an interview is noted for the Brain only once nothing they
 * did in it is from today (the store's `#decideInterview`).
 */
const aDayPassesFor = async (person: string): Promise<void> => {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  await runInDurableObject(onboardingStore(env), (_, state) => {
    state.storage.sql.exec(
      "UPDATE interviews SET updated_at = ? WHERE person = ?",
      yesterday,
      person
    );
    state.storage.sql.exec(
      "UPDATE approvals SET at = ? WHERE person = ?",
      yesterday,
      person
    );
  });
  await eraseOwedOnboardingSources(env);
};

/** `person`'s account: the one their link opened under, signed in as them. */
const accountOfPerson = async (person: string): Promise<string> =>
  await accountOf(await openLink(person));

describe("interviews in the new Brain", { timeout: 120_000 }, () => {
  beforeEach(holdAlarm);

  it("are read by the account the link opened under alone, never by whoever the list's address names later, and wait a day before the company's audit log names one", async () => {
    const marker = `marker${unique()}`;
    const ids = await team();
    // Lea opens her link, signed in as the address it went to, and agrees.
    await mapped(ids, {
      facts: [fact("l9", "rule", `Every refund needs ${marker} first.`)],
    });
    const store = onboardingStore(env);
    const lea = await accountOfPerson(ids.lea);
    // The day she agreed, nothing of it is noted: the audit log the
    // company reads would tell the moment she finished.
    const sameDay = await auditedDuring(async () => {
      await eraseOwedOnboardingSources(env);
      await handOverNow();
    });
    const notedSameDay = sameDay.filter(
      ({ action }) => action === "onboarding.interview.brain_source"
    ).length;
    const beforeTheDayTurns = await recalled(lea, marker);
    // An admin puts their own address on Lea's entry after her link went
    // out, and signs in with it; a team-mate signs in as themselves.
    const taken = `admin-${unique()}@acme.test`;
    const { roster } = await store.view();
    await store.saveRoster(
      {
        teams: roster?.teams ?? [],
        people: (roster?.people ?? []).map((person) =>
          person.id === ids.lea ? { ...person, email: taken } : person
        ),
      },
      { type: "system" }
    );
    const admin = await signsIn(taken, "admin");
    const max = await signsIn(`mate-${unique()}@acme.test`);
    await aDayPassesFor(ids.lea);
    await handOverNow();
    // Handing it over again makes no second source.
    await handOverNow();
    const key = await interviewKeyOf(lea);
    const { sources } = await listSourcesAs(env, lea);
    expect({
      notedSameDay,
      beforeTheDayTurns,
      lea: await recalled(lea, marker),
      admin: await recalled(admin, marker),
      max: await recalled(max, marker),
      interviews: sources.filter(
        ({ source }) => source.producer === "interview"
      ).length,
      // In her own store alone, never in the shared one.
      kept: await keptIn(key, lea),
    }).toStrictEqual({
      notedSameDay: 0,
      beforeTheDayTurns: [],
      lea: [expect.stringContaining(marker)],
      admin: [],
      max: [],
      interviews: 1,
      kept: { shared: "free", own: "held" },
    });
    // The onboarding's object failing takes only the team's claims away
    // from a read, never the read itself.
    const failing = {
      ...env,
      ONBOARDING: new Proxy(env.ONBOARDING, {
        get: (target, name, receiver): unknown => {
          if (name === "getByName" || name === "jurisdiction") {
            return () => {
              throw new Error("The onboarding is out of reach.");
            };
          }
          const value: unknown = Reflect.get(target, name, receiver);
          return value;
        },
      }),
    };
    const { items: stillFound } = await recallAs(failing, lea, {
      question: marker,
      budget: { tokens: 2000 },
      personal: true,
    });
    expect(stillFound.map(({ text }) => text)).toStrictEqual([
      expect.stringContaining(marker),
    ]);
    // She withdraws: her interview is gone from the Brain as the
    // withdrawal answers.
    await onLink({ action: "withdraw", ...(await openLink(ids.lea)) });
    expect({
      recalled: await recalled(lea, marker),
      owed: await store.owedErasures({ person: ids.lea }),
      kept: await keptIn(key, lea),
    }).toStrictEqual({
      recalled: [],
      owed: [],
      kept: { shared: "erased", own: "erased" },
    });
  });

  it("are taken out at once when an edit takes an approved fact out, and the rest comes back the day after", async () => {
    const marker = `marker${unique()}`;
    const kept = `kept${unique()}`;
    const ids = await team();
    const taken = fact("l8", "rule", `Every refund needs ${marker} first.`);
    const left = fact("l9", "rule", `Every refund needs ${kept} first.`);
    await mapped(ids, { facts: [taken, left] });
    const lea = await accountOfPerson(ids.lea);
    await aDayPassesFor(ids.lea);
    await handOverNow();
    const before = await interviewKeyOf(lea);
    // She takes one fact out and approves the rest, as her page does.
    const version = await agree(
      ids.lea,
      [
        fact("l1", "work", "Max, Mia and Mo handle new tickets."),
        fact(
          "l2",
          "system",
          "The team lives in Zendesk and the lead's own rota sheet."
        ),
        { ...taken, out: true },
        left,
      ],
      1
    );
    const atOnce = {
      taken: await recalled(lea, marker),
      kept: await recalled(lea, kept),
      old: await keptIn(before, lea),
    };
    await aDayPassesFor(ids.lea);
    await handOverNow();
    expect({
      version,
      atOnce,
      after: {
        taken: await recalled(lea, marker),
        kept: await recalled(lea, kept),
      },
    }).toStrictEqual({
      version: 2,
      atOnce: { taken: [], kept: [], old: { shared: "erased", own: "erased" } },
      after: { taken: [], kept: [expect.stringContaining(kept)] },
    });
  });

  it("leave nothing owed when their person's own store was erased whole first", async () => {
    const marker = `marker${unique()}`;
    const ids = await team();
    await mapped(ids, {
      facts: [fact("l9", "rule", `Every refund needs ${marker} first.`)],
    });
    const lea = await accountOfPerson(ids.lea);
    await aDayPassesFor(ids.lea);
    await handOverNow();
    const key = await interviewKeyOf(lea);
    // Her own store goes whole (core's erasure of her), then she withdraws:
    // erasing her interview in a store erased whole returns at once.
    // Recorded, then past the grace an add under way may still land in:
    // gone whole, as `erasePerson` answers once it is.
    await erasePerson(env, { personId: lea, reason: "person_erased" });
    await ageOwnErasure(lea);
    const erased = await erasePerson(env, {
      personId: lea,
      reason: "person_erased",
    });
    await onLink({ action: "withdraw", ...(await openLink(ids.lea)) });
    expect({
      erased,
      owed: await onboardingStore(env).owedErasures({ person: ids.lea }),
      kept: await keptIn(key, lea),
    }).toStrictEqual({
      erased: "erased",
      owed: [],
      kept: { shared: "erased", own: "free" },
    });
  });

  it("go with a new start from staff, and the link opens again for the address the list has now, never for the account that had it", async () => {
    const marker = `marker${unique()}`;
    const store = onboardingStore(env);
    const ids = await team();
    // Max's link goes to a colleague's address first, by the admin's
    // mistake, and the colleague opens it and talks.
    const wrong = `colleague-${unique()}@acme.test`;
    const { roster } = await store.view();
    const listed = (email: (person: string, was: string) => string) => ({
      teams: roster?.teams ?? [],
      people: (roster?.people ?? []).map((person) => ({
        ...person,
        email: email(person.id, person.email),
      })),
    });
    await store.saveRoster(
      listed((person, was) => (person === ids.max ? wrong : was)),
      { type: "system" }
    );
    await mapped(ids);
    await agree(ids.max, [
      fact("m9", "rule", `Every refund needs ${marker} first.`),
    ]);
    const colleague = await accountOfPerson(ids.max);
    await aDayPassesFor(ids.max);
    await handOverNow();
    const theirs = await recalled(colleague, marker);
    // Max asks: staff give a new start once the list has his own address.
    const own = `max-${unique()}@acme.test`;
    await store.saveRoster(
      listed((person, was) => (person === ids.max ? own : was)),
      { type: "system" }
    );
    await store.newStart(ids.max, { type: "system" });
    await eraseOwedOnboardingSources(env);
    const secret = ((await store.linkOf(ids.max)) ?? "").split("#")[1] ?? "";
    const { response: again } = await openLinkAs(
      secret,
      await signedInAs(wrong)
    );
    const { response: his } = await openLinkAs(secret, await signedInAs(own));
    expect({
      theirs,
      after: await recalled(colleague, marker),
      again: again.status,
      his: his.status,
    }).toStrictEqual({
      theirs: [expect.stringContaining(marker)],
      after: [],
      again: 404,
      his: 200,
    });
  });

  it("go with core's erasure of their person: erased in the Brain, and their link opens for nobody again", async () => {
    const marker = `marker${unique()}`;
    const ids = await team();
    await mapped(ids, {
      facts: [fact("l9", "rule", `Every refund needs ${marker} first.`)],
    });
    const store = onboardingStore(env);
    const address = await sentToOf(ids.lea);
    const lea = await accountOfPerson(ids.lea);
    await aDayPassesFor(ids.lea);
    await handOverNow();
    const key = await interviewKeyOf(lea);
    // Core's erasure of her (person-erasure.ts): an admin removes her,
    // then erases her, which takes her interview out of the Brain before
    // its area is done.
    const admin = await signedInApi(idp, "admin");
    await admin.api.members.remove(lea);
    const name = await env.DB.prepare("SELECT name FROM users WHERE id = ?")
      .bind(lea)
      .first<string>("name");
    await admin.api.members.erase(lea, name ?? "");
    // Her own store goes whole, done once the time an add under way has to
    // land in it has passed, as core's clock retries it.
    await ageOwnErasure(lea);
    await retryErasures(env);
    const completed = await env.DB.prepare(
      "SELECT completed_at FROM person_erasures WHERE user_id = ?"
    )
      .bind(lea)
      .first<number | null>("completed_at");
    const secret = ((await store.linkOf(ids.lea)) ?? "").split("#")[1] ?? "";
    const reopened = await store.openLink(await sha256Hex(secret), {
      account: `other-${unique()}`,
      address,
    });
    expect({
      done: completed !== null,
      kept: await keptIn(key, lea),
      team: await store.interviewTeamOf(lea),
      reopened: reopened.ok ? "open" : reopened.code,
      owed: await store.owedErasures({ person: ids.lea }),
    }).toStrictEqual({
      done: true,
      // Her own store erased whole holds nothing: its keys read `free`.
      kept: { shared: "erased", own: "free" },
      team: null,
      reopened: "interview.link_invalid",
      owed: [],
    });
  });

  it("are replaced in the Brain when a content purge rewrites them", async () => {
    const marker = `marker${unique()}`;
    const ids = await team();
    await mapped(ids, {
      facts: [fact("l9", "rule", `Every refund needs ${marker} first.`)],
    });
    const lea = await accountOfPerson(ids.lea);
    await aDayPassesFor(ids.lea);
    await handOverNow();
    const before = await interviewKeyOf(lea);
    // The purge rewrites her interview, and lets go only once the Brain's
    // copy with the purged word is erased.
    await interviewErasure(env).rewrite(
      { actor: { type: "system" }, userId: "system" },
      (text) => text.replaceAll(marker, "(removed)")
    );
    await handOverNow();
    expect({
      purged: await recalled(lea, marker),
      rewritten: await recalled(lea, "(removed)", "interview"),
      old: await keptIn(before, lea),
      owed: await onboardingStore(env).owedErasures({ person: ids.lea }),
    }).toStrictEqual({
      purged: [],
      rewritten: [
        expect.stringContaining("Every refund needs (removed) first."),
      ],
      old: { shared: "erased", own: "erased" },
      owed: [],
    });
  });

  it("stay erased when an add of them lands after a withdrawal erased them", async () => {
    const marker = `marker${unique()}`;
    const ids = await team();
    await mapped(ids, {
      facts: [fact("l9", "rule", `Every refund needs ${marker} first.`)],
    });
    const lea = await accountOfPerson(ids.lea);
    await aDayPassesFor(ids.lea);
    const held = holdingAdds((source) => source.startsWith("interview:"));
    const handing = handOverNow(held.env);
    const key = await held.arrived;
    // She withdraws while her interview's add is in flight, before her own
    // store was ever written: the withdrawal erases it, and the add lands
    // after.
    await onLink({ action: "withdraw", ...(await openLink(ids.lea)) });
    held.release();
    await handing;
    const { own } = await keptIn(key, lea);
    expect({
      recalled: await recalled(lea, marker),
      owed: await onboardingStore(env).owedErasures({ person: ids.lea }),
      held: own === "held",
    }).toStrictEqual({ recalled: [], owed: [], held: false });
  });

  it("are noted once whatever a drain cut off before the object dropped its events: one source, the same event each time", async () => {
    const marker = `marker${unique()}`;
    const ids = await team();
    await mapped(ids, {
      facts: [fact("l9", "rule", `Every refund needs ${marker} first.`)],
    });
    const lea = await accountOfPerson(ids.lea);
    await aDayPassesFor(ids.lea);
    // Cut off after the log took the events and their hand-overs were
    // noted, before the object dropped them: as a crash between the two.
    await runInDurableObject(onboardingStore(env), async (_, state) => {
      const { sql } = state.storage;
      const cutOff = new Proxy(sql, {
        get: (target, name): unknown => {
          const member: unknown = Reflect.get(target, name);
          if (name !== "exec" || typeof member !== "function") {
            return typeof member === "function" ? member.bind(target) : member;
          }
          return (query: string, ...bindings: unknown[]): unknown => {
            if (query.startsWith("DELETE FROM audit_outbox")) {
              throw new Error("The object went away");
            }
            return Reflect.apply(member, target, [query, ...bindings]);
          };
        },
      });
      await drainObjectOutbox(env, cutOff, 0).catch(() => 0);
    });
    await handOverNow();
    await handOverNow();
    const { sources } = await listSourcesAs(env, lea);
    expect({
      interviews: sources.filter(
        ({ source }) => source.producer === "interview"
      ).length,
      found: await recalled(lea, marker),
    }).toStrictEqual({
      interviews: 1,
      found: [expect.stringContaining(marker)],
    });
  });
});

describe("team claims in the new Brain", { timeout: 120_000 }, () => {
  beforeEach(holdAlarm);

  /**
   * A team through the onboarding, its tickets drawn, Max signed in to his
   * account: seven who told their own work (Sam too, a step of his own)
   * unless `small`, and then six.
   */
  const drawnTeam = async ({
    small = false,
    drained = false,
    eight = false,
  } = {}) => {
    const seven: Key[] = [...everyone, "sam"];
    const larger: Key[] = eight ? [...seven, "ada"] : seven;
    const keys: readonly Key[] = small ? everyone : larger;
    const ids = await team(keys, addressOf);
    await mapped(ids);
    await told(ids);
    if (!small) {
      await agree(ids.sam, [fact("s1", "step", "Answers the phone.")]);
    }
    if (eight) {
      await agree(ids.ada, [fact("a1", "step", "Closes the day's tickets.")]);
    }
    // With `drained`, every other team due is given first, before this
    // one's work is drawn: the next intake is this team's.
    const rounds = drained ? teamsDueMax : 0;
    for (let round = 0; round < rounds; round += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one team at a time
      const { result } = await answeringWith(
        claimsReply([zendeskClaim]),
        async () => await onboardingStore(env).intakeNext()
      );
      if (result === null) {
        break;
      }
    }
    await answering(
      [ticketsReply(ids)],
      async () => await onboardingStore(env).drawNext()
    );
    const max = await accountOfPerson(ids.max);
    return { ids, max };
  };

  it("stand only at five backers, for the team alone, and are erased for good when a withdrawal leaves four", async () => {
    const { ids, max } = await drawnTeam();
    const [, ...fourOfThem] = zendeskSaid;
    const fourCite = "Zendesk sends the tickets on.";
    await intakeOf(ids, [
      zendeskClaim,
      {
        kind: "tool",
        text: fourCite,
        cites: ["Tickets arrive in Zendesk.", ...fourOfThem.slice(0, 1)],
      },
    ]);
    await handOverNow();
    const outsider = await signsIn(`outsider-${unique()}@acme.test`);
    const listed = await claimsOf(max);
    expect({
      team: await onboardingStore(env).interviewTeamOf(max),
      max: await recalled(max, "Zendesk", "claim"),
      listed: listed.map(({ versions }) => versions),
      fourCite: await recalled(max, "sends", "claim"),
      outsider: await recalled(outsider, "Zendesk", "claim"),
      outsiderListed: await claimsOf(outsider),
    }).toStrictEqual({
      team: ids.team,
      max: [zendeskClaim.text],
      listed: [[1]],
      fourCite: [],
      outsider: [],
      outsiderListed: [],
    });
    // Pim withdraws: the claim rests on four now. Core's clock erases it:
    // no recall, no listing, no version of it, as history or otherwise.
    await onLink({ action: "withdraw", ...(await openLink(ids.pim)) });
    await eraseOwedOnboardingSources(env);
    const [claim] = listed;
    if (claim === undefined) {
      throw new Error("The claim was never listed.");
    }
    const { source } = claim;
    const { versions } = await listVersionsAs(env, max, { source });
    expect({
      max: await recalled(max, "Zendesk", "claim"),
      listed: await claimsOf(max),
      version: await readSourceVersionAs(env, max, { source, version: 1 }),
      versions,
      owed: await onboardingStore(env).owedErasures(),
    }).toStrictEqual({
      max: [],
      listed: [],
      version: null,
      versions: [],
      owed: [],
    });
  });

  it("are none in a team of fewer than two more interviewed than the floor, whatever backs them", async () => {
    const { ids, max } = await drawnTeam({ small: true });
    await intakeOf(ids, [zendeskClaim]);
    await handOverNow();
    expect({
      max: await recalled(max, "Zendesk", "claim"),
      listed: await claimsOf(max),
    }).toStrictEqual({ max: [], listed: [] });
  });

  it("follow the one floor: two more interviewed than it", () => {
    expect({
      atFive: [6, 7].map((interviewed) => teamMayClaim(interviewed, 5)),
      atThree: [4, 5].map((interviewed) => teamMayClaim(interviewed, 3)),
    }).toStrictEqual({ atFive: [false, true], atThree: [false, true] });
  });

  it("are not noted from an intake whose backers changed while it ran", async () => {
    const { ids, max } = await drawnTeam({ drained: true });
    let edited = false;
    const reply = claimsReply([zendeskClaim]);
    const { result: gave } = await answeringWith(
      async (requests) => {
        // Pim takes back what he said while the claims are put together.
        if (!edited) {
          edited = true;
          await agree(
            ids.pim,
            [
              fact("p1", "step", "Tags the ticket."),
              fact("p2", "system", "Tickets arrive in Zendesk, mostly."),
            ],
            1
          );
        }
        return reply(requests);
      },
      async () => await onboardingStore(env).intakeNext()
    );
    // Nothing of a claim was noted: none handed over, none to erase.
    await handOverNow();
    const owed = await onboardingStore(env).owedErasures();
    expect({
      gave,
      edited,
      listed: await claimsOf(max),
      claims: owed.filter(
        (each) => each.kind === "claim" && each.team === ids.team
      ),
    }).toStrictEqual({
      gave: `brain:${ids.team}`,
      edited: true,
      listed: [],
      claims: [],
    });
  });

  it("stay erased when the recount drops them while their add is in flight", async () => {
    const { ids, max } = await drawnTeam();
    await intakeOf(ids, [zendeskClaim]);
    const held = holdingAdds((source) => source.startsWith("claim:"));
    const handing = handOverNow(held.env);
    await held.arrived;
    // Pim leaves the list while the claim's add is in flight: the recount
    // drops it below five.
    const all: Key[] = [...everyone, "sam"];
    const keys = all.filter((key) => key !== "pim");
    await onboardingStore(env).saveRoster(
      rosterOf(
        ids,
        keys,
        Object.fromEntries(keys.map((key) => [key, addressOf(ids[key])]))
      ),
      { type: "system" }
    );
    // Core erases it as it still owes the Brain that, while the add waits.
    await eraseOwedOnboardingSources(env);
    held.release();
    await handing;
    expect({
      max: await recalled(max, "Zendesk", "claim"),
      listed: await claimsOf(max),
      owed: await onboardingStore(env).owedErasures(),
    }).toStrictEqual({ max: [], listed: [], owed: [] });
  });

  /**
   * Ops' list, with Sam: `moved` in a team of their own, Billing, and
   * `lead` leading Ops (Lea when none is given).
   */
  const rosterWith = (
    ids: Awaited<ReturnType<typeof team>>,
    {
      moved = [],
      lead,
      keys = [...everyone, "sam"],
    }: { moved?: readonly Key[]; lead?: Key; keys?: readonly Key[] } = {}
  ) => {
    const base = rosterOf(
      ids,
      keys,
      Object.fromEntries(keys.map((key) => [key, addressOf(ids[key])]))
    );
    const billing = `${ids.team}-billing`;
    return {
      teams: [
        ...base.teams.map((each) => ({
          ...each,
          lead: lead === undefined ? each.lead : ids[lead],
        })),
        { id: billing, name: "Billing", lead: null, does: "", off: false },
      ],
      people: base.people.map((person) =>
        moved.some((key) => ids[key] === person.id)
          ? { ...person, team: billing }
          : person
      ),
    };
  };

  it("are erased when someone moving to another team leaves six interviewed, and form anew under a new key when seven are back", async () => {
    const { ids, max } = await drawnTeam();
    await intakeOf(ids, [zendeskClaim]);
    await handOverNow();
    const [first] = await claimsOf(max);
    const store = onboardingStore(env);
    // Rik, who backs no claim, moves to Billing: Ops has six who told.
    await store.saveRoster(rosterWith(ids, { moved: ["rik"] }), {
      type: "system",
    });
    await eraseOwedOnboardingSources(env);
    const whileSix = {
      recalled: await recalled(max, "Zendesk", "claim"),
      listed: await claimsOf(max),
    };
    // Back in Ops: seven again. The next intake (Sam agreeing to more,
    // the work drawn again) puts the claim together anew.
    await store.saveRoster(rosterWith(ids), { type: "system" });
    await agree(
      ids.sam,
      [
        fact("s1", "step", "Answers the phone."),
        fact("s2", "step", "Logs the call."),
      ],
      1
    );
    await answering(
      [ticketsReply(ids)],
      async () => await onboardingStore(env).drawNext()
    );
    await intakeOf(ids, [zendeskClaim]);
    await handOverNow();
    const [again] = await claimsOf(max);
    expect({
      first: first === undefined,
      whileSix,
      again: await recalled(max, "Zendesk", "claim"),
      newKey: again !== undefined && again.source.id !== first?.source.id,
    }).toStrictEqual({
      first: false,
      whileSix: { recalled: [], listed: [] },
      again: [zendeskClaim.text],
      newKey: true,
    });
  });

  it("are erased when one who told becomes the team's lead and leaves six", async () => {
    const { ids, max } = await drawnTeam();
    await intakeOf(ids, [zendeskClaim]);
    await handOverNow();
    const before = await recalled(max, "Zendesk", "claim");
    // Rik leads Ops now: a lead's own work isn't told, so six told.
    await onboardingStore(env).saveRoster(rosterWith(ids, { lead: "rik" }), {
      type: "system",
    });
    await eraseOwedOnboardingSources(env);
    expect({
      before,
      after: await recalled(max, "Zendesk", "claim"),
      listed: await claimsOf(max),
    }).toStrictEqual({
      before: [zendeskClaim.text],
      after: [],
      listed: [],
    });
  });

  /** What `max` can read of the team's claims now: the group core gives them, recall and listing. */
  const readableBy = async (max: string) => ({
    group: await onboardingStore(env).interviewTeamOf(max),
    recalled: await recalled(max, "Zendesk", "claim"),
    listed: await claimsOf(max),
  });

  it("are unreadable the moment a move leaves six interviewed, before core's clock erases them", async () => {
    const { ids, max } = await drawnTeam();
    await intakeOf(ids, [zendeskClaim]);
    await handOverNow();
    await onboardingStore(env).saveRoster(rosterWith(ids, { moved: ["rik"] }), {
      type: "system",
    });
    await expect(readableBy(max)).resolves.toStrictEqual({
      group: null,
      recalled: [],
      listed: [],
    });
  });

  it("are unreadable the moment one who backs none of them withdraws and leaves six, before core's clock", async () => {
    const { ids, max } = await drawnTeam();
    await intakeOf(ids, [zendeskClaim]);
    await handOverNow();
    await onLink({ action: "withdraw", ...(await openLink(ids.rik)) });
    await expect(readableBy(max)).resolves.toStrictEqual({
      group: null,
      recalled: [],
      listed: [],
    });
  });

  it("are unreadable the moment a backer withdraws and leaves four behind one, in a team still of seven, before core's clock", async () => {
    const { ids, max } = await drawnTeam({ eight: true });
    await intakeOf(ids, [zendeskClaim]);
    await handOverNow();
    const before = await recalled(max, "Zendesk", "claim");
    // Pim backs the claim: four are left behind it, seven still told.
    await onLink({ action: "withdraw", ...(await openLink(ids.pim)) });
    expect({ before, now: await readableBy(max) }).toStrictEqual({
      before: [zendeskClaim.text],
      now: { group: ids.team, recalled: [], listed: [] },
    });
  });

  it("are never shown again under their old key when the team goes under seven and back before core's clock", async () => {
    const { ids, max } = await drawnTeam();
    await intakeOf(ids, [zendeskClaim]);
    await handOverNow();
    const [first] = await claimsOf(max);
    // The company's admin moves Rik out and back, as two saves.
    const admin = await signedInApi(idp, "admin");
    await admin.api.onboarding.confirmRoster(
      rosterWith(ids, { moved: ["rik"] })
    );
    await admin.api.onboarding.confirmRoster(rosterWith(ids));
    await handOverNow();
    const listed = await claimsOf(max);
    expect({
      first: first === undefined,
      group: await onboardingStore(env).interviewTeamOf(max),
      oldKey: listed.some(({ source }) => source.id === first?.source.id),
      recalled: await recalled(max, "Zendesk", "claim"),
    }).toStrictEqual({
      first: false,
      group: ids.team,
      oldKey: false,
      recalled: [],
    });
  });

  /** Ops' eight, Sam and Ada with them, but for `left`. */
  const eightBut = (left?: Key): Key[] =>
    [...everyone, "sam" as const, "ada" as const].filter((key) => key !== left);

  it("stay unreadable while their erasure is owed, the Brain failing, in a team still of seven", async () => {
    const { ids, max } = await drawnTeam({ eight: true });
    await intakeOf(ids, [zendeskClaim]);
    await handOverNow();
    const before = await recalled(max, "Zendesk", "claim");
    // Pim, who backs the claim, is taken off the list: four left behind it,
    // seven still interviewed. The Brain fails every erasure.
    await onboardingStore(env).saveRoster(
      rosterWith(ids, { keys: eightBut("pim") }),
      {
        type: "system",
      }
    );
    await eraseOwedOnboardingSources(erasuresFailing());
    const owed = await onboardingStore(env).owedErasures();
    expect({
      before,
      owed: owed.some(
        (each) => each.kind === "claim" && each.team === ids.team
      ),
      now: await readableBy(max),
    }).toStrictEqual({
      before: [zendeskClaim.text],
      owed: true,
      now: { group: null, recalled: [], listed: [] },
    });
  });

  it("are never readable again under their old key when the team goes under seven and back while their erasure fails", async () => {
    const { ids, max } = await drawnTeam();
    await intakeOf(ids, [zendeskClaim]);
    await handOverNow();
    const [first] = await claimsOf(max);
    const store = onboardingStore(env);
    await store.saveRoster(rosterWith(ids, { moved: ["rik"] }), {
      type: "system",
    });
    await eraseOwedOnboardingSources(erasuresFailing());
    await store.saveRoster(rosterWith(ids), { type: "system" });
    await eraseOwedOnboardingSources(erasuresFailing());
    const listed = await claimsOf(max);
    expect({
      first: first === undefined,
      oldKey: listed.some(({ source }) => source.id === first?.source.id),
      now: await readableBy(max),
    }).toStrictEqual({
      first: false,
      oldKey: false,
      now: { group: null, recalled: [], listed: [] },
    });
  });

  it("no longer count one moved to another team among their backers: the move owes their erasure in the same save", async () => {
    const { ids, max } = await drawnTeam({ eight: true });
    await intakeOf(ids, [zendeskClaim]);
    await handOverNow();
    // Pim, who backs the claim, moves to Billing: Ops still has seven
    // interviewed, but four of its people now back the claim.
    await onboardingStore(env).saveRoster(
      rosterWith(ids, { keys: eightBut(), moved: ["pim"] }),
      {
        type: "system",
      }
    );
    const owed = await onboardingStore(env).owedErasures();
    expect({
      owed: owed.some(
        (each) => each.kind === "claim" && each.team === ids.team
      ),
      now: await readableBy(max),
    }).toStrictEqual({
      owed: true,
      now: { group: null, recalled: [], listed: [] },
    });
  });

  it("are erased by the withdrawal itself of a backer who moved to another team, before core's clock", async () => {
    const { ids, max } = await drawnTeam({ eight: true });
    await intakeOf(ids, [zendeskClaim]);
    await handOverNow();
    // Pim moves to Billing, with the erasure his move owes failing; then
    // he withdraws: his request erases the claims of every team he backed.
    await onboardingStore(env).saveRoster(
      rosterWith(ids, { keys: eightBut(), moved: ["pim"] }),
      {
        type: "system",
      }
    );
    await eraseOwedOnboardingSources(erasuresFailing());
    await onLink({ action: "withdraw", ...(await openLink(ids.pim)) });
    const owed = await onboardingStore(env).owedErasures();
    expect({
      owed: owed.some(
        (each) => each.kind === "claim" && each.team === ids.team
      ),
      recalled: await recalled(max, "Zendesk", "claim"),
      listed: await claimsOf(max),
    }).toStrictEqual({ owed: false, recalled: [], listed: [] });
  });

  it("are in the company's export while they stand, never a person's interview, and an export holding one is never served once it is erased", async () => {
    const { ids, max } = await drawnTeam();
    await intakeOf(ids, [zendeskClaim]);
    await handOverNow();
    const { id } = await startBrainExport(env);
    for (let tick = 0; tick < 20; tick += 1) {
      // oxlint-disable-next-line no-await-in-loop -- until the export is written
      const status = await brainExportStatus(env, { id });
      if (status?.state !== "writing") {
        break;
      }
      clock.at = Math.max(clock.at, Date.now()) + 1;
      // oxlint-disable-next-line no-await-in-loop -- one tick at a time
      await workBrain(env, new Date(clock.at), producersOf(env));
    }
    const written = await brainExportStatus(env, { id });
    const files = await Promise.all(
      (written?.files ?? []).map(
        async (file) => (await brainExportFile(env, { id, file })) ?? ""
      )
    );
    // The team goes under seven: the claim is erased.
    await onboardingStore(env).saveRoster(rosterWith(ids, { moved: ["rik"] }), {
      type: "system",
    });
    await eraseOwedOnboardingSources(env);
    const [firstFile = ""] = written?.files ?? [];
    const erasedStatus = await brainExportStatus(env, { id });
    expect({
      state: written?.state,
      claim: files.some((text) => text.includes(zendeskClaim.text)),
      interview: files.some((text) =>
        text.includes("Opens the ticket in Zendesk.")
      ),
      max: max.length > 0,
      after: erasedStatus?.state,
      file: await brainExportFile(env, { id, file: firstFile }),
    }).toStrictEqual({
      state: "done",
      claim: true,
      interview: false,
      max: true,
      after: "erased",
      file: null,
    });
  });

  it("are hidden at once and erased when a content purge rewrites the interview of one who backs them, and never come back with the purged word", async () => {
    const { ids, max } = await drawnTeam();
    await intakeOf(ids, [zendeskClaim]);
    await handOverNow();
    const before = await recalled(max, "Zendesk", "claim");
    // The purge takes "Zendesk" out of every interview.
    await interviewErasure(env).rewrite(
      { actor: { type: "system" }, userId: "system" },
      (text) => text.replaceAll("Zendesk", "(removed)")
    );
    await handOverNow();
    const owedAfter = await onboardingStore(env).owedErasures();
    expect({
      before,
      now: await readableBy(max),
      owed: owedAfter.filter(
        (each) => each.kind === "claim" && each.team === ids.team
      ),
    }).toStrictEqual({
      before: [zendeskClaim.text],
      now: { group: ids.team, recalled: [], listed: [] },
      owed: [],
    });
  });

  it("are not noted from an intake during which a backer moved to another team, leaving four of its people behind the claim", async () => {
    const { ids, max } = await drawnTeam({ eight: true, drained: true });
    let moved = false;
    const reply = claimsReply([zendeskClaim]);
    const { result: gave } = await answeringWith(
      async (requests) => {
        // Pim moves to Billing while the claims are put together.
        if (!moved) {
          moved = true;
          await onboardingStore(env).saveRoster(
            rosterWith(ids, { keys: eightBut(), moved: ["pim"] }),
            { type: "system" }
          );
        }
        return reply(requests);
      },
      async () => await onboardingStore(env).intakeNext()
    );
    await handOverNow();
    expect({
      gave,
      moved,
      now: await readableBy(max),
    }).toStrictEqual({
      gave: `brain:${ids.team}`,
      moved: true,
      now: { group: ids.team, recalled: [], listed: [] },
    });
  });

  it("are erased by a content purge whose term is in their own sentence, from one who backs none of them, before the purge reports done", async () => {
    const { ids, max } = await drawnTeam();
    // The model puts Rik's "noon" into the claim, though Rik backs none.
    const noonClaim = {
      kind: "tool",
      text: "Tickets come in through Zendesk by noon.",
      cites: zendeskSaid,
    };
    await intakeOf(ids, [noonClaim]);
    await handOverNow();
    const before = await recalled(max, "noon", "claim");
    await interviewErasure(env).rewrite(
      { actor: { type: "system" }, userId: "system" },
      (text) => text.replaceAll("noon", "(removed)")
    );
    const owedAfter = await onboardingStore(env).owedErasures({ claims: true });
    expect({
      before,
      now: await readableBy(max),
      owed: owedAfter,
    }).toStrictEqual({
      before: [noonClaim.text],
      now: { group: ids.team, recalled: [], listed: [] },
      owed: [],
    });
  });
});
