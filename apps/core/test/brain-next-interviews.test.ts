import { brainOf, personalBrainOf } from "@grasp-os/brain-next/contract";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { drainAuditOutboxes } from "../src/audit-drains.ts";
import { drainObjectOutbox } from "../src/audit-outbox.ts";
import {
  addSource,
  brainExportFile,
  brainExportStatus,
  erasePerson,
  listSourcesAs,
  listVersionsAs,
  readSourceVersionAs,
  recallAs,
  recallPassagesAs,
  startBrainExport,
  workBrain,
} from "../src/brain-next.ts";
import { producersOf, relayHandOvers } from "../src/brain-sources.ts";
import sharedLinesOnly from "../src/db/onboarding/migrations/0042_team_results_from_shared_lines.sql";
import { inJurisdiction } from "../src/durable-objects.ts";
import {
  addOwedInterviews,
  eraseOwedOnboardingSources,
  settleOnboardingBrain,
} from "../src/onboarding/new-brain.ts";
import { Onboarding, onboardingStore } from "../src/onboarding/store.ts";
import { teamMayClaim } from "../src/onboarding/team-claims.ts";
import { retryErasures } from "../src/person-erasure.ts";
import { adminCommands } from "./admin-command.ts";
import { setObjectEnv } from "./agent-chat.ts";
import { ageOwnErasure } from "./brain-next-own-store.ts";
import { copyOfStore, restoreStore } from "./brain-next-store-copy.ts";
import { mockIdp } from "./idp.ts";
import {
  accountOf,
  aloneInTheStore,
  answering,
  answeringWith,
  approveAgreed,
  onLink,
  participate,
  openLinkAs,
  sentToOf,
  signedInAs,
} from "./interview-link.ts";
import {
  agree,
  anonymous,
  claimsReply,
  fact,
  intake,
  kept as standingOf,
  mapReply,
  mapped,
  openLink,
  rosterOf,
  saveAgreed,
  team,
  ticketsReply,
  told,
  zendeskClaim,
  zendeskSaid,
} from "./onboarding-team.ts";
import type { Ids, Key } from "./onboarding-team.ts";
import { acmeTenant } from "./sign-in-config.ts";
import {
  entraPerson,
  openRpc,
  outcome,
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
//   their interview: nothing of it is in that log.
// - A withdrawal, an edit, a new start or core's erasure leaving
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
 * Core's env with the Brain's stores held at each call of `method` whose
 * argument `holds` names (what `arrived` then gives): `arrived` once one is
 * in flight, which waits for `release`.
 */
const holdingCalls = (
  method: string,
  holds: (argument: unknown) => string | undefined
) => {
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
        if (name !== method) {
          return (...given: unknown[]): unknown =>
            Reflect.apply(member, target, given);
        }
        return async (argument: unknown): Promise<unknown> => {
          const named = holds(argument);
          if (named !== undefined) {
            arrived.resolve(named);
            await released.promise;
          }
          const answer: unknown = await Reflect.apply(member, target, [
            argument,
          ]);
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

/** Core's env with the Brain's stores held at each add of a source `holds` picks (`holdingCalls`). */
const holdingAdds = (holds: (source: string) => boolean) =>
  holdingCalls("addSource", (added) => {
    const { source } = z.object({ source: z.string() }).parse(added);
    return holds(source) ? source : undefined;
  });

/**
 * Core's env with the Brain's shared store held at its first search for a
 * read (`find`): the reader is decided, its statement not run yet.
 */
const holdingFinds = () => {
  let first = true;
  return holdingCalls("find", () => {
    const now = first;
    first = false;
    return now ? "find" : undefined;
  });
};

/** Most calls a link takes a minute (the store's `linkCallsPerMinute`). */
const linkCallsPerMinute = 60;

/** Restarts the onboarding's object, as a deploy does: what it held in memory is gone. */
const restartOnboarding = async (): Promise<void> => {
  await runInDurableObject(onboardingStore(env), (_, state) => {
    state.abort("Restarted by the test");
  }).catch(() => {
    // Aborting fails the call that aborted: that is the restart.
  });
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

/** Whether the onboarding's alarm is set. */
const alarmSet = async (): Promise<boolean> => {
  const at = await runInDurableObject(
    onboardingStore(env),
    async (_instance, state) => await state.storage.getAlarm()
  );
  return at !== null;
};

/** The onboarding closed (its plan ended a fortnight ago), every link out, and no alarm set: nothing would set one again by itself. */
const noAlarm = async (): Promise<void> => {
  const ended = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  await onboardingStore(env).savePlan(
    { start: ended, days: 14 },
    { type: "system" }
  );
  await runInDurableObject(onboardingStore(env), async (_instance, state) => {
    await state.storage.deleteAlarm();
  });
};

/**
 * Runs the onboarding's alarm as its timer would, each run a model
 * answering any team's claims, and hands over what it noted, until `done`
 * says so: never an intake asked for directly. Earlier tests of this file
 * leave their teams due too.
 */
const byTheAlarm = async (done: () => Promise<boolean>): Promise<void> => {
  for (let run = 0; run < teamsDueMax; run += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one run at a time, as the timer runs it
    await answeringWith(claimsReply([zendeskClaim]), async () => {
      await runInDurableObject(onboardingStore(env), async (instance) => {
        await Onboarding.prototype.alarm.call(instance);
      });
    });
    // oxlint-disable-next-line no-await-in-loop -- one run at a time
    await handOverNow();
    // oxlint-disable-next-line no-await-in-loop -- one run at a time
    if (await done()) {
      return;
    }
  }
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

/**
 * What someone who isn't a member reads of a team's claim: core refuses
 * them before anything is read (`permission.person_inactive`), so
 * `refused`; anything else they got, as recalled.
 */
const readByNonMember = async (userId: string): Promise<string[] | string> => {
  try {
    return await recalled(userId, "Zendesk", "claim");
  } catch (error) {
    if (permissionErrors.codeOf(error) === "permission.person_inactive") {
      return "refused";
    }
    throw error;
  }
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
 * Core's clock, as it runs every minute: what the onboarding owes the new
 * Brain settled (erasures, then interviews to add), and the hand-overs of
 * team claims taken to the Brain.
 */
const settled = async (): Promise<void> => {
  await settleOnboardingBrain(env);
  await handOverNow();
};

/** `person`'s account: the one their link opened under, signed in as them. */
const accountOfPerson = async (person: string): Promise<string> =>
  await accountOf(await openLink(person));

/** An interview added for `readers`, as a producer that got them wrong would: `added`, or why it was refused. */
const interviewAddedFor = async (
  readers: Parameters<typeof addSource>[1]["readers"]
): Promise<string> =>
  await addSource(env, {
    source: { producer: "interview", id: crypto.randomUUID() },
    change: crypto.randomUUID(),
    text: `Approved facts ${unique()}`,
    readers,
  }).then(() => "added", String);

/** The staff list of `ids` with the people `movers` in Billing, a team of their own. */
const movedToBilling =
  (ids: Ids, movers: readonly string[]) =>
  (roster: ReturnType<typeof rosterOf>): ReturnType<typeof rosterOf> => ({
    teams: [
      ...roster.teams,
      {
        id: `${ids.team}-b`,
        name: "Billing",
        lead: null,
        does: "",
        off: false,
      },
    ],
    people: roster.people.map((person) =>
      movers.includes(person.id) ? { ...person, team: `${ids.team}-b` } : person
    ),
  });

describe("interviews in the new Brain", { timeout: 120_000 }, () => {
  beforeEach(aloneInTheStore);

  it("are refused for any readers but their own person, so none is ever in the shared store", async () => {
    await expect(
      Promise.all([
        interviewAddedFor({ kind: "everyone" }),
        interviewAddedFor({ kind: "members" }),
        interviewAddedFor({ kind: "team", teamId: crypto.randomUUID() }),
        interviewAddedFor({ kind: "none" }),
      ])
    ).resolves.toStrictEqual(
      Array.from(
        { length: 4 },
        () => "Error: Refused: an interview is for one person alone"
      )
    );
  });

  it("are read by the account the link opened under alone, never by whoever the list's address names later", async () => {
    const marker = `marker${unique()}`;
    const ids = await team();
    // Lea opens her link, signed in as the address it went to, and agrees.
    await mapped(ids, {
      facts: [fact("l9", "rule", `Every refund needs ${marker} first.`)],
    });
    const store = onboardingStore(env);
    const lea = await accountOfPerson(ids.lea);
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
    await settled();
    // Settling again makes no second source.
    await settled();
    const key = await interviewKeyOf(lea);
    const { sources } = await listSourcesAs(env, lea);
    expect({
      lea: await recalled(lea, marker),
      admin: await recalled(admin, marker),
      max: await recalled(max, marker),
      interviews: sources.filter(
        ({ source }) => source.producer === "interview"
      ).length,
      // In her own store alone, never in the shared one.
      kept: await keptIn(key, lea),
    }).toStrictEqual({
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
    // Only what holds the word, as `recalled` reads: the company's teams,
    // readable by everyone, may come back with it (GRA-1748).
    expect(
      stillFound.map(({ text }) => text).filter((text) => text.includes(marker))
    ).toStrictEqual([expect.stringContaining(marker)]);
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

  it("are replaced at once when an edit takes an approved fact out: the old copy erased, what still stands added", async () => {
    const marker = `marker${unique()}`;
    const kept = `kept${unique()}`;
    const ids = await team();
    const taken = fact("l8", "rule", `Every refund needs ${marker} first.`);
    const left = fact("l9", "rule", `Every refund needs ${kept} first.`);
    await mapped(ids, { facts: [taken, left] });
    const lea = await accountOfPerson(ids.lea);
    await settled();
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
    await settled();
    expect({
      version,
      atOnce,
      after: {
        taken: await recalled(lea, marker),
        kept: await recalled(lea, kept),
      },
    }).toStrictEqual({
      version: 2,
      atOnce: {
        taken: [],
        kept: [expect.stringContaining(kept)],
        old: { shared: "erased", own: "erased" },
      },
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
    await settled();
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
    await settled();
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
    await settled();
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
      reopened: reopened.ok ? "open" : reopened.code,
      owed: await store.owedErasures({ person: ids.lea }),
    }).toStrictEqual({
      done: true,
      // Her own store erased whole holds nothing: its keys read `free`.
      kept: { shared: "erased", own: "free" },
      reopened: "interview.link_invalid",
      owed: [],
    });
  });

  it("go with core's erasure of their person by the account the link opened under, though the list's address was corrected since", async () => {
    const marker = `marker${unique()}`;
    const ids = await team();
    await mapped(ids, {
      facts: [fact("l9", "rule", `Every refund needs ${marker} first.`)],
    });
    const store = onboardingStore(env);
    const lea = await accountOfPerson(ids.lea);
    await settled();
    const key = await interviewKeyOf(lea);
    // The admin corrects her address on the list after her link opened.
    const { roster } = await store.view();
    await store.saveRoster(
      {
        teams: roster?.teams ?? [],
        people: (roster?.people ?? []).map((person) =>
          person.id === ids.lea
            ? { ...person, email: `corrected-${unique()}@acme.test` }
            : person
        ),
      },
      { type: "system" }
    );
    const admin = await signedInApi(idp, "admin");
    await admin.api.members.remove(lea);
    const name = await env.DB.prepare("SELECT name FROM users WHERE id = ?")
      .bind(lea)
      .first<string>("name");
    await admin.api.members.erase(lea, name ?? "");
    await ageOwnErasure(lea);
    await retryErasures(env);
    expect({
      interview: await runInDurableObject(
        store,
        (_, state) =>
          state.storage.sql
            .exec("SELECT person FROM interviews WHERE person = ?", ids.lea)
            .toArray().length
      ),
      backs: await store.sentFor(ids.lea),
      kept: await keptIn(key, lea),
    }).toStrictEqual({
      interview: 0,
      backs: [],
      kept: { shared: "erased", own: "free" },
    });
  });

  it("go with core's erasure of their person tried again, after a first try that unbound the account and failed on the Brain, though the list's address was corrected", async () => {
    const marker = `marker${unique()}`;
    const ids = await team();
    await mapped(ids, {
      facts: [fact("l9", "rule", `Every refund needs ${marker} first.`)],
    });
    const store = onboardingStore(env);
    const lea = await accountOfPerson(ids.lea);
    await settled();
    // The admin corrects her address on the list after her link opened.
    const { roster } = await store.view();
    await store.saveRoster(
      {
        teams: roster?.teams ?? [],
        people: (roster?.people ?? []).map((person) =>
          person.id === ids.lea
            ? { ...person, email: `corrected-${unique()}@acme.test` }
            : person
        ),
      },
      { type: "system" }
    );
    const admin = await signedInApi(idp, "admin");
    await admin.api.members.remove(lea);
    const name = await env.DB.prepare("SELECT name FROM users WHERE id = ?")
      .bind(lea)
      .first<string>("name");
    // The first try closes her link, which unbinds her account, and fails
    // on the Brain's erasure of her interview.
    const { core } = await openRpc(admin.session, {
      coreEnv: erasuresFailing(),
    });
    await core
      .authenticate()
      .members.erase(lea, name ?? "")
      .catch(() => null);
    const area = async () =>
      await env.DB.prepare(
        "SELECT state FROM person_erasure_areas WHERE user_id = ? AND area = 'interview'"
      )
        .bind(lea)
        .first<string>("state");
    const first = await area();
    // The clock tries again, the Brain in reach.
    await ageOwnErasure(lea);
    await retryErasures(env);
    expect({
      first,
      retried: await area(),
      owed: await store.owedErasures({ person: ids.lea }),
    }).toStrictEqual({ first: "pending", retried: "complete", owed: [] });
  });

  // What this proves: core's erasure finds an interview by the account
  // that holds its link now, never through a Brain copy still owed under
  // that account (`personOfAccount`). The guard on closing the link itself
  // (`#closeAndDeleteHeldBy`) is proved by person-erasure.test.ts, "leaves
  // the interview of whoever holds the link when the list's address was
  // corrected to theirs after it opened".
  it("go with core's erasure of the wrong recipient who opened a link, finding by the account only the link it holds now, so the right person's interview after staff's new start stays", async () => {
    const marker = `marker${unique()}`;
    const ids = await team();
    // The list had the wrong address: Lea's link went to someone else,
    // who opened it and agreed to what they said.
    await mapped(ids, {
      facts: [fact("l9", "rule", `Every refund needs ${marker} first.`)],
    });
    const store = onboardingStore(env);
    const wrong = await accountOfPerson(ids.lea);
    await settled();
    const key = await interviewKeyOf(wrong);
    // The admin corrects the address, and staff give a new start: the
    // wrong recipient's copy in the Brain is still owed its erasure.
    const right = `right-${unique()}@acme.test`;
    const { roster } = await store.view();
    await store.saveRoster(
      {
        teams: roster?.teams ?? [],
        people: (roster?.people ?? []).map((person) =>
          person.id === ids.lea ? { ...person, email: right } : person
        ),
      },
      { type: "system" }
    );
    await store.newStart(ids.lea, { type: "system" });
    // The right person opens the same link and says something of their
    // own, while the Brain fails every erasure: the wrong recipient's copy
    // is still owed one when they are erased.
    const secret = ((await store.linkOf(ids.lea)) ?? "").split("#")[1] ?? "";
    const cookie = await signedInAs(right);
    const failing = erasuresFailing();
    const first = await onLink({ action: "session", secret, cookie }, failing);
    const { version } = z
      .object({ version: z.number() })
      .parse(await first.json());
    const own = `own${unique()}`;
    // They take part before anything they say is kept, as their page has them.
    await participate({ secret, cookie });
    await onLink(
      {
        action: "save",
        secret,
        cookie,
        version,
        progress: {
          person: "progress",
          told: false,
          mode: "type",
          lines: [{ from: "person", text: `I start with ${own}.` }],
          facts: [],
          phase: "you",
          wants: "answer",
          startedAt: Date.now(),
          confirmed: 0,
          adding: false,
          addedAt: 0,
        },
      },
      failing
    );
    const owedThen = await store.owedErasures({ person: ids.lea });
    // Then the wrong recipient is erased.
    const admin = await signedInApi(idp, "admin");
    await admin.api.members.remove(wrong);
    const name = await env.DB.prepare("SELECT name FROM users WHERE id = ?")
      .bind(wrong)
      .first<string>("name");
    await admin.api.members.erase(wrong, name ?? "");
    await ageOwnErasure(wrong);
    await retryErasures(env);
    const { response: reopened } = await openLinkAs(secret, cookie);
    const { shared } = await keptIn(key, wrong);
    const kept = z
      .object({
        progress: z.object({
          lines: z.array(z.object({ text: z.string() })),
        }),
      })
      .safeParse(await reopened.json());
    expect({
      owedThen: owedThen.flatMap((owed) =>
        owed.kind === "interview" ? [owed.account] : []
      ),
      reopened: reopened.status,
      theirs: kept.data?.progress.lines.map(({ text }) => text) ?? [],
      wrongCopy: shared,
      area: await env.DB.prepare(
        "SELECT state FROM person_erasure_areas WHERE user_id = ? AND area = 'interview'"
      )
        .bind(wrong)
        .first<string>("state"),
    }).toStrictEqual({
      owedThen: [wrong],
      reopened: 200,
      theirs: [`I start with ${own}.`],
      wrongCopy: "erased",
      area: "complete",
    });
  });

  it("say a deletion is done at once, and that what the Brain kept is still being removed, when its erasure fails in the request; core's clock then erases it", async () => {
    const marker = `marker${unique()}`;
    const ids = await team();
    await mapped(ids, {
      facts: [fact("l9", "rule", `Every refund needs ${marker} first.`)],
    });
    const lea = await accountOfPerson(ids.lea);
    await settled();
    const key = await interviewKeyOf(lea);
    // She deletes her interview while the Brain fails every erasure.
    const answer = await onLink(
      { action: "delete", ...(await openLink(ids.lea)) },
      erasuresFailing()
    );
    const said = await answer.json();
    await settled();
    const { own } = await keptIn(key, lea);
    expect({
      status: answer.status,
      removing: z.object({ removing: z.literal(true) }).safeParse(said).success,
      owed: await onboardingStore(env).owedErasures({ person: ids.lea }),
      kept: own,
      recalled: await recalled(lea, marker),
    }).toStrictEqual({
      status: 200,
      removing: true,
      owed: [],
      kept: "erased",
      recalled: [],
    });
  });

  it("stay erased when the clock's add of them lands after a withdrawal erased them", async () => {
    const marker = `marker${unique()}`;
    const ids = await team();
    await mapped(ids, {
      facts: [fact("l9", "rule", `Every refund needs ${marker} first.`)],
    });
    const lea = await accountOfPerson(ids.lea);
    await settled();
    // The directory made her another member, adopted at her next sign-in
    // (auth.ts): her interview moves to that account, and its copy there
    // waits for the clock's add, which is held in flight.
    const cookie = await signedInAs(`moved-${unique()}@acme.test`);
    const moved = await accountOf({ secret: "", cookie });
    await onboardingStore(env).accountMoved(lea, moved);
    const held = holdingAdds((source) => source.startsWith("interview:"));
    const adding = addOwedInterviews(held.env);
    const key = await held.arrived;
    // She withdraws while that add is in flight, before her own store was
    // written with it: the withdrawal erases it, and the add lands after.
    const { secret } = await openLink(ids.lea);
    await onLink({ action: "withdraw", secret, cookie });
    held.release();
    await adding;
    await settled();
    const { own } = await keptIn(key, moved);
    expect({
      recalled: await recalled(moved, marker),
      owed: await onboardingStore(env).owedErasures({ person: ids.lea }),
      toAdd: await onboardingStore(env).interviewsToAdd(ids.lea),
      held: own === "held",
    }).toStrictEqual({ recalled: [], owed: [], toAdd: [], held: false });
  });

  it("are in their Brain as soon as they approve, stay the same source through a save that leaves what they approved alone, and give the company's audit log nothing", async () => {
    const from = new Date().toISOString();
    const marker = `marker${unique()}`;
    const ids = await team();
    const facts = [
      fact("l1", "work", "Max, Mia and Mo handle new tickets."),
      fact(
        "l2",
        "system",
        "The team lives in Zendesk and the lead's own rota sheet."
      ),
      fact("l9", "rule", `Every refund needs ${marker} first.`),
    ];
    // Her approval, from her link: in her Brain before the request answers.
    await mapped(ids, { facts: facts.slice(2) });
    const lea = await accountOfPerson(ids.lea);
    const atOnce = await recalled(lea, marker);
    const before = await interviewKeyOf(lea);
    // She saves again, the facts she approved as they were.
    const version = await agree(ids.lea, facts, 1);
    await settled();
    const after = await interviewKeyOf(lea);
    // A positive control: what the company's admin does is in its log.
    const admin = await signedInApi(idp, "admin");
    const { roster } = await onboardingStore(env).view();
    await admin.api.onboarding.saveRoster({
      teams: (roster?.teams ?? []).map(({ id, name, lead }) => ({
        id,
        name,
        lead,
      })),
      people: (roster?.people ?? []).map(({ id, name, team: of, email }) => ({
        id,
        name,
        team: of,
        email,
      })),
    });
    await drainAuditOutboxes(env);
    await handOverNow();
    const records = [];
    let page = await admin.api.audit.search({ from });
    records.push(...page.records);
    while (page.next !== null) {
      // oxlint-disable-next-line no-await-in-loop -- one page after another
      page = await admin.api.audit.search({ from }, page.next);
      records.push(...page.records);
    }
    const text = JSON.stringify(records);
    const actions = records.map(({ event }) => event?.action);
    expect({
      atOnce,
      version,
      same: after === before,
      kept: await keptIn(after, lea),
      control: actions.includes("onboarding.roster.saved"),
      interviews: actions.filter(
        (action) => action?.startsWith("onboarding.interview") === true
      ),
      named: [before.slice("interview:".length), lea, ids.lea, marker].filter(
        (each) => text.includes(each)
      ),
    }).toStrictEqual({
      atOnce: [expect.stringContaining(marker)],
      version: 2,
      same: true,
      kept: { shared: "free", own: "held" },
      control: true,
      interviews: [],
      named: [],
    });
  });
});

/**
 * The team's intake running again and held at its model call, inside the
 * store's Brain work (`#withBrain`), until `release`: Ada says more, so
 * the team is due, and its drawing is done first. The model then puts
 * `claims` together.
 */
const heldIntake = async (
  ids: Ids,
  claims: Parameters<typeof claimsReply>[0] = [zendeskClaim]
) => {
  const store = onboardingStore(env);
  await agree(
    ids.ada,
    [
      fact("a1", "step", "Closes the day's tickets."),
      fact("a2", "step", "Files the day's notes."),
    ],
    1
  );
  await answering([ticketsReply(ids)], async () => await store.drawNext());
  const arrived = Promise.withResolvers<null>();
  const released = Promise.withResolvers<null>();
  const reply = claimsReply(claims);
  const intaking = answeringWith(
    async (requests) => {
      arrived.resolve(null);
      await released.promise;
      return reply(requests);
    },
    async () => await store.intakeNext()
  );
  const first = await Promise.race([
    arrived.promise.then(() => "held"),
    intaking.then(({ result }) => `given ${result}`),
  ]);
  expect(first).toBe("held");
  return {
    release: async () => {
      released.resolve(null);
      await intaking;
    },
  };
};

/** Waits until `done` reads true of the onboarding's store: a request's own transaction landed. */
const landed = async (done: (sql: SqlStorage) => boolean): Promise<void> => {
  await vi.waitFor(
    async () => {
      const yes = await runInDurableObject(onboardingStore(env), (_, state) =>
        done(state.storage.sql)
      );
      if (!yes) {
        throw new Error("Not landed yet");
      }
    },
    { timeout: 10_000, interval: 10 }
  );
};

const interviewGone = (person: string) => (sql: SqlStorage) =>
  sql.exec("SELECT person FROM interviews WHERE person = ?", person).toArray()
    .length === 0;

/** A word nobody else's line holds, and a line of `tag` that holds it. */
const markedLine = (id: string, tag: Parameters<typeof fact>[1]) => {
  const word = `marked${unique().replaceAll("-", "")}`;
  return { word, line: fact(id, tag, `Checks every ticket in ${word}.`) };
};

/** Whether any of `requests` reached the model with `word` in it. */
const promptsHold = (requests: readonly { body: unknown }[], word: string) =>
  requests.some(({ body }) => JSON.stringify(body).includes(word));

/** The piece of work `person`'s interview asks them about, in their team's language. */
const askedOf = async (person: string): Promise<string | undefined> => {
  const context = await onboardingStore(env).contextOf(person);
  return context?.work;
};

/** What a turn of `person`'s interview knows already (`TurnContext.known`). */
const knownTo = async (person: string): Promise<string> => {
  const context = await onboardingStore(env).contextOf(person);
  return context?.known ?? "";
};

/** What the tickets' drawing left open, as staff read it; null without a drawing. */
const openOfTickets = async (teamId: string): Promise<string[] | null> => {
  const pieces = await onboardingStore(env).teamWorks(teamId);
  const tickets = pieces.find(({ name }) => name === "handling new tickets");
  return tickets?.drawn?.open ?? null;
};

/** The names of a team's pieces of work, as Grasp's staff read them. */
const piecesOf = async (teamId: string): Promise<string[]> => {
  const pieces = await onboardingStore(env).teamWorks(teamId);
  return pieces.map(({ name }) => name);
};

/** Sam says more and approves it, and the team's work is drawn again: the team is due for another intake. */
const dueAgain = async (ids: Ids): Promise<void> => {
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
};

describe("team claims in the new Brain", { timeout: 120_000 }, () => {
  beforeEach(aloneInTheStore);

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

  it("stand only at five backers, for every current member of the company and nobody else, and are erased for good when a withdrawal leaves four", async () => {
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
    // A member of no team on the list reads it as the team does (GRA-1748);
    // someone an admin removed, and someone who never was a member (a
    // guest, an App's visitor, an interview's own session), read nothing.
    const outsider = await signsIn(`outsider-${unique()}@acme.test`);
    const former = await signsIn(`former-${unique()}@acme.test`);
    const admin = await signedInApi(idp, "admin");
    await admin.api.members.remove(former);
    const listed = await claimsOf(max);
    const outsiderClaims = await claimsOf(outsider);
    expect({
      max: await recalled(max, "Zendesk", "claim"),
      listed: listed.map(({ versions }) => versions),
      fourCite: await recalled(max, "sends", "claim"),
      outsider: await recalled(outsider, "Zendesk", "claim"),
      outsiderListed: outsiderClaims.map(({ versions }) => versions),
      former: await readByNonMember(former),
      stranger: await readByNonMember(`stranger-${unique()}`),
    }).toStrictEqual({
      max: [zendeskClaim.text],
      listed: [[1]],
      fourCite: [],
      outsider: [zendeskClaim.text],
      outsiderListed: [[1]],
      former: "refused",
      stranger: "refused",
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

  /** Ops' eight, Sam and Ada with them, but for `left`. */
  const eightBut = (left?: Key): Key[] =>
    [...everyone, "sam" as const, "ada" as const].filter((key) => key !== left);

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

  /** What `max` can read of the team's claims now: recall and listing. */
  const readableBy = async (max: string) => ({
    recalled: await recalled(max, "Zendesk", "claim"),
    listed: await claimsOf(max),
  });

  /** A team member's read of the claim through the real read path: what they recall and list. */
  const claimRead = async (max: string) => {
    const { recalled: read, listed } = await readableBy(max);
    return { recalled: read, listed };
  };

  it("are unreadable the moment an edit leaves four behind one, while an intake holds the Brain's work", async () => {
    const { ids, max } = await drawnTeam({ eight: true });
    await intakeOf(ids, [zendeskClaim]);
    await handOverNow();
    const before = await recalled(max, "Zendesk", "claim");
    const held = await heldIntake(ids);
    // Pim takes back the fact that backed the claim, as their page does:
    // four of its backers are left, eight of the team still interviewed.
    await agree(
      ids.pim,
      [
        fact("p1", "step", "Tags the ticket."),
        { ...fact("p2", "system", "Tickets arrive in Zendesk."), out: true },
      ],
      1
    );
    const during = await claimRead(max);
    await held.release();
    await settled();
    expect({
      before,
      during,
      after: await recalled(max, "Zendesk", "claim"),
    }).toStrictEqual({
      before: [zendeskClaim.text],
      during: { recalled: [], listed: [] },
      after: [],
    });
  });

  it("stay readable through an approval and a save that only add what someone approved, and are marked when one save adds a fact and takes back the one that backed them, while an intake holds the Brain's work", async () => {
    const { ids, max } = await drawnTeam({ eight: true });
    await intakeOf(ids, [zendeskClaim]);
    await handOverNow();
    const held = await heldIntake(ids);
    // Rik, who backs none of them, says more and approves it: a gain.
    await agree(
      ids.rik,
      [
        fact("r1", "step", "Checks the queue at noon."),
        fact("r2", "step", "Checks it again at four."),
      ],
      1
    );
    const afterGain = await recalled(max, "Zendesk", "claim");
    // Pim, in one save, adds a fact and takes back the one that backed it.
    await agree(
      ids.pim,
      [
        fact("p1", "step", "Tags the ticket."),
        { ...fact("p2", "system", "Tickets arrive in Zendesk."), out: true },
        fact("p3", "step", "Closes the tag."),
      ],
      1
    );
    const afterMixed = await claimRead(max);
    await held.release();
    await settled();
    expect({
      afterGain,
      afterMixed,
      after: await recalled(max, "Zendesk", "claim"),
    }).toStrictEqual({
      afterGain: [zendeskClaim.text],
      afterMixed: { recalled: [], listed: [] },
      after: [],
    });
  });

  it("stay readable when an edit leaves all five behind one and seven interviewed, while an intake holds the Brain's work", async () => {
    const { ids, max } = await drawnTeam({ eight: true });
    await intakeOf(ids, [zendeskClaim]);
    await handOverNow();
    const held = await heldIntake(ids);
    // Rik, who backs none of them, takes back the one fact he approved:
    // seven of the team are still interviewed, five behind the claim.
    await agree(
      ids.rik,
      [{ ...fact("r1", "step", "Checks the queue at noon."), out: true }],
      1
    );
    const during = await recalled(max, "Zendesk", "claim");
    await held.release();
    await settled();
    expect({
      during,
      after: await recalled(max, "Zendesk", "claim"),
    }).toStrictEqual({
      during: [zendeskClaim.text],
      after: [zendeskClaim.text],
    });
  });

  it.each([
    ["withdraws", "withdraw"],
    ["deletes their interview", "delete"],
    ["is given a new start by staff", "new_start"],
    ["is erased by core", "erased"],
  ] as const)(
    "are unreadable the moment a backer %s and leaves four behind one, while an intake holds the Brain's work",
    async (_, change) => {
      const { ids, max } = await drawnTeam({ eight: true });
      await intakeOf(ids, [zendeskClaim]);
      await handOverNow();
      const pim = await accountOfPerson(ids.pim);
      const name = await env.DB.prepare("SELECT name FROM users WHERE id = ?")
        .bind(pim)
        .first<string>("name");
      const admin = await signedInApi(idp, "admin");
      if (change === "erased") {
        await admin.api.members.remove(pim);
      }
      const held = await heldIntake(ids);
      // Each waits on the Brain's work once its own transaction landed.
      let acting: Promise<unknown>;
      if (change === "withdraw" || change === "delete") {
        acting = onLink({ action: change, ...(await openLink(ids.pim)) });
      } else if (change === "new_start") {
        acting = adminCommands().newStart(ids.pim);
      } else {
        acting = admin.api.members.erase(pim, name ?? "");
      }
      await landed(
        change === "withdraw"
          ? (sql) =>
              sql
                .exec(
                  "SELECT person FROM participations WHERE person = ? AND withdrawn_at IS NOT NULL",
                  ids.pim
                )
                .toArray().length === 1
          : interviewGone(ids.pim)
      );
      const during = await claimRead(max);
      await held.release();
      await acting;
      await settled();
      expect({
        during,
        after: await recalled(max, "Zendesk", "claim"),
      }).toStrictEqual({
        during: { recalled: [], listed: [] },
        after: [],
      });
    }
  );

  it.each([
    // Seven still interviewed, four behind the claim: only the recount
    // hides it.
    ["a backer", ["pim"]],
    // Two in one save: everyone it takes off the list erased without a
    // recount each, then one recount for them all.
    ["two backers", ["pim", "noor"]],
  ] as const)(
    "are unreadable the moment one roster save takes %s off the list, while an intake holds the Brain's work",
    async (_, off) => {
      const { ids, max } = await drawnTeam({ eight: true });
      await intakeOf(ids, [zendeskClaim]);
      await handOverNow();
      const before = await recalled(max, "Zendesk", "claim");
      const keys = [...everyone, "sam", "ada"].filter(
        (key): key is Key => !off.some((each) => each === key)
      );
      // The save waits on the Brain's work once its own transaction landed.
      const held = await heldIntake(ids);
      const saving = onboardingStore(env).saveRoster(
        rosterWith(ids, { keys }),
        { type: "system" }
      );
      await landed(
        (sql) =>
          sql.exec("SELECT id FROM people WHERE id = ?", ids.pim).toArray()
            .length === 0
      );
      const now = await claimRead(max);
      await held.release();
      await saving;
      await settled();
      expect({
        before,
        now,
        after: await recalled(max, "Zendesk", "claim"),
      }).toStrictEqual({
        before: [zendeskClaim.text],
        now: { recalled: [], listed: [] },
        after: [],
      });
    }
  );

  it("are unreadable the moment a move leaves six interviewed, before core's clock erases them", async () => {
    const { ids, max } = await drawnTeam();
    await intakeOf(ids, [zendeskClaim]);
    await handOverNow();
    await onboardingStore(env).saveRoster(rosterWith(ids, { moved: ["rik"] }), {
      type: "system",
    });
    await expect(readableBy(max)).resolves.toStrictEqual({
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
      now: { recalled: [], listed: [] },
    });
  });

  it("are unreadable to a read already under way when a backer's withdrawal leaves four behind one: its reader decided before, its statement run after, the request's own erasures failing", async () => {
    const { ids, max } = await drawnTeam({ eight: true });
    await intakeOf(ids, [zendeskClaim]);
    await handOverNow();
    const before = await recalled(max, "Zendesk", "claim");
    // Max's read: who reads (his groups) is decided, and it is held just
    // before the shared store's statement runs.
    const held = holdingFinds();
    const reading = recallAs(held.env, max, {
      question: "Zendesk",
      budget: { tokens: 2000 },
      personal: true,
    });
    await held.arrived;
    // Pim, who backs the claim, withdraws, and the request's own erasures
    // fail: what the Brain still has of it is the store's doing alone.
    const answer = await onLink(
      { action: "withdraw", ...(await openLink(ids.pim)) },
      erasuresFailing()
    );
    held.release();
    const { items } = await reading;
    expect({
      before,
      withdrew: answer.ok,
      during: items
        .filter(({ source }) => source.producer === "claim")
        .map(({ text }) => text),
    }).toStrictEqual({
      before: [zendeskClaim.text],
      withdrew: true,
      during: [],
    });
  });

  it.each([
    [
      "backs one by four",
      () => {
        const [, ...rest] = zendeskSaid;
        return [
          {
            ...zendeskClaim,
            cites: ["Tickets arrive in Zendesk.", ...rest.slice(0, 1)],
          },
        ];
      },
    ],
    ["no longer makes one", () => []],
  ] as const)(
    "are unreadable the moment a later intake %s, before core's clock",
    async (_, claims) => {
      const { ids, max } = await drawnTeam();
      await intakeOf(ids, [zendeskClaim]);
      await handOverNow();
      const before = await recalled(max, "Zendesk", "claim");
      await dueAgain(ids);
      await intakeOf(ids, claims());
      expect({
        before,
        afterIntake: await recalled(max, "Zendesk", "claim"),
        listed: await claimsOf(max),
      }).toStrictEqual({
        before: [zendeskClaim.text],
        afterIntake: [],
        listed: [],
      });
    }
  );

  it("are unreadable the moment an intake returns that backs one by four while someone's interview moved under it, before core's clock", async () => {
    const { ids, max } = await drawnTeam({ eight: true });
    await intakeOf(ids, [zendeskClaim]);
    await handOverNow();
    const before = await recalled(max, "Zendesk", "claim");
    // The intake puts the claim together from four of its five backers.
    const [, ...rest] = zendeskSaid;
    const held = await heldIntake(ids, [
      {
        ...zendeskClaim,
        cites: ["Tickets arrive in Zendesk.", ...rest.slice(0, 1)],
      },
    ]);
    // Rik, who backs none of it, takes back what he approved while it runs:
    // his interview moved under the intake, so it notes no claims.
    await agree(
      ids.rik,
      [{ ...fact("r1", "step", "Checks the queue at noon."), out: true }],
      1
    );
    const during = await recalled(max, "Zendesk", "claim");
    await held.release();
    expect({
      before,
      during,
      afterIntake: await recalled(max, "Zendesk", "claim"),
    }).toStrictEqual({
      before: [zendeskClaim.text],
      during: [zendeskClaim.text],
      afterIntake: [],
    });
  });

  it("keep a claim a refused withdrawal would drop owed its erasure, and take it out at the next try, also after the object restarted", async () => {
    const { ids, max } = await drawnTeam({ eight: true });
    await intakeOf(ids, [zendeskClaim]);
    await handOverNow();
    const device = await openLink(ids.pim);
    const shared = inJurisdiction(env, env.BRAIN_STORE).getByName("brain");
    const restore = `restore-${unique()}`;
    await runInDurableObject(shared, (_, state) => {
      state.storage.sql.exec(
        "INSERT INTO restores (export, checked, part, restored, state, started_at) VALUES (?, 0, 0, 0, 'running', ?)",
        restore,
        Date.now()
      );
    });
    const refused = await onLink({ action: "withdraw", ...device });
    const owed = await onboardingStore(env).owedErasures({ claims: true });
    const whileRestoring = {
      ok: refused.ok,
      owed: owed.some(
        (each) => each.kind === "claim" && each.team === ids.team
      ),
      read: await recalled(max, "Zendesk", "claim"),
    };
    await restartOnboarding();
    await runInDurableObject(shared, (_, state) => {
      state.storage.sql.exec("DELETE FROM restores WHERE export = ?", restore);
    });
    const answer = await onLink({ action: "withdraw", ...device });
    expect({
      whileRestoring,
      withdrew: answer.ok,
      after: await recalled(max, "Zendesk", "claim"),
    }).toStrictEqual({
      whileRestoring: { ok: false, owed: true, read: [zendeskClaim.text] },
      withdrew: true,
      after: [],
    });
  });

  it("let a withdrawal that drops a claim through on the link's last call of the minute", async () => {
    const { ids, max } = await drawnTeam({ eight: true });
    await intakeOf(ids, [zendeskClaim]);
    await handOverNow();
    const device = await openLink(ids.pim);
    // Its calls counted from nothing, then all but the last of a minute's.
    await restartOnboarding();
    for (let call = 1; call < linkCallsPerMinute; call += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one call after another
      await onLink({ action: "session", ...device });
    }
    const answer = await onLink({ action: "withdraw", ...device });
    expect({
      withdrew: z
        .object({ withdrawn: z.literal(true) })
        .safeParse(await answer.json()).success,
      after: await recalled(max, "Zendesk", "claim"),
    }).toStrictEqual({ withdrew: true, after: [] });
  });

  it("stay unreadable after the Brain's store comes back from a copy taken before a withdrawal dropped one, the request's own erasures failing", async () => {
    const { ids, max } = await drawnTeam({ eight: true });
    await intakeOf(ids, [zendeskClaim]);
    await handOverNow();
    const before = await recalled(max, "Zendesk", "claim");
    const copy = await copyOfStore();
    const answer = await onLink(
      { action: "withdraw", ...(await openLink(ids.pim)) },
      erasuresFailing()
    );
    await restoreStore(copy);
    expect({
      before,
      withdrew: answer.ok,
      afterRestore: await recalled(max, "Zendesk", "claim"),
    }).toStrictEqual({
      before: [zendeskClaim.text],
      withdrew: true,
      afterRestore: [],
    });
  });

  it("leave a claim handed over before for its team's group alone read by nobody, and still take it out of the Brain when it falls", async () => {
    const { ids, max } = await drawnTeam({ eight: true });
    await intakeOf(ids, [zendeskClaim]);
    // Not handed over now: added as an earlier head did, for the team's
    // group (`interviews:<team>`), which no reader is given any more.
    const [held] = await runInDurableObject(onboardingStore(env), (_, state) =>
      state.storage.sql
        .exec<{ source: string; text: string }>(
          "SELECT source, text FROM brain_claims WHERE team = ? AND erase = 0",
          ids.team
        )
        .toArray()
    );
    if (held === undefined) {
      throw new Error("The intake noted no claim.");
    }
    await brainOf(inJurisdiction(env, env.BRAIN_STORE)).addSource({
      source: `claim:${held.source}`,
      change: held.source,
      text: held.text,
      access: { kind: "audience", group: `interviews:${ids.team}` },
    });
    const before = await recalled(max, "Zendesk", "claim");
    // Pim backs it, and withdraws: four are left behind it.
    const answer = await onLink({
      action: "withdraw",
      ...(await openLink(ids.pim)),
    });
    const owed = await onboardingStore(env).owedErasures({ claims: true });
    const { shared } = await keptIn(`claim:${held.source}`, max);
    expect({
      before,
      withdrew: answer.ok,
      shared,
      owed: owed.some(({ source }) => source === held.source),
    }).toStrictEqual({
      before: [],
      withdrew: true,
      shared: "erased",
      owed: false,
    });
  });

  it("are handed over for members reading as themselves: code's recall as an App or a workflow, and as a chat's code, misses one a member finds", async () => {
    const { ids, max } = await drawnTeam();
    await intakeOf(ids, [zendeskClaim]);
    await handOverNow();
    // Code's recall as brain-recall.ts asks it (`recallFor`): an App's and
    // a workflow's as the company, a chat's code as its person's teams;
    // never as the person, so never their own store. Read before that
    // module's own narrowing, so the claim's readers alone keep it out.
    const codeReads = async (company: boolean) => {
      const { items } = await recallPassagesAs(env, max, {
        question: "Zendesk",
        budget: { tokens: 2000 },
        personal: false,
        company,
        teams: [],
      });
      return items
        .filter(({ source }) => source.producer === "claim")
        .map(({ text }) => text);
    };
    expect({
      member: await recalled(max, "Zendesk", "claim"),
      appOrWorkflow: await codeReads(true),
      chatCode: await codeReads(false),
    }).toStrictEqual({
      member: [zendeskClaim.text],
      appOrWorkflow: [],
      chatCode: [],
    });
  });

  it("are read without asking the onboarding: a person's recall makes no call to it, out of reach, and finds their team's claim", async () => {
    const { ids, max } = await drawnTeam();
    await intakeOf(ids, [zendeskClaim]);
    await handOverNow();
    let calls = 0;
    const unreachable = new Proxy(env.ONBOARDING, {
      get: () => {
        calls += 1;
        throw new Error("The onboarding is out of reach.");
      },
    });
    const outOfReach: Env = { ...env, ONBOARDING: unreachable };
    const { items } = await recallAs(outOfReach, max, {
      question: "Zendesk",
      budget: { tokens: 2000 },
      personal: true,
    });
    expect({
      calls,
      recalled: items
        .filter(({ source }) => source.producer === "claim")
        .map(({ text }) => text),
    }).toStrictEqual({ calls: 0, recalled: [zendeskClaim.text] });
  });

  it("put together a team's claims and drawings from the lines shared with it alone: one only counted anonymously reaches no prompt, claim, drawing, page or recall (GRA-1987)", async () => {
    const ids = await team([...everyone, "sam"], addressOf);
    await mapped(ids);
    await told(ids);
    // Sam's second line is how he works, moved by him to only counted anonymously.
    const { word, line } = markedLine("s2", "step");
    await agree(ids.sam, [
      fact("s1", "step", "Answers the phone."),
      anonymous(line),
    ]);
    const drawn = await answering(
      [ticketsReply(ids)],
      async () => await onboardingStore(env).drawNext()
    );
    const given = await intake(ids, [zendeskClaim]);
    await handOverNow();
    const max = await accountOfPerson(ids.max);
    expect({
      gave: given.gave,
      prompts: promptsHold([...drawn.requests, ...given.requests], word),
      page: JSON.stringify(await standingOf(ids)).includes(word),
      recalled: await recalled(max, word),
      claim: await recalled(max, "Zendesk", "claim"),
    }).toStrictEqual({
      gave: `brain:${ids.team}`,
      prompts: false,
      page: false,
      recalled: [],
      claim: [zendeskClaim.text],
    });
  });

  it("take nothing from interviews approved before a line had a destination: seven who told, every line only counted anonymously, give the team nothing and ask no model for it (GRA-1987)", async () => {
    const ids = await team([...everyone, "sam"], addressOf);
    await mapped(ids);
    const { word, line } = markedLine("x1", "system");
    const tellers = [ids.max, ids.mia, ids.mo, ids.noor, ids.pim, ids.rik];
    for (const person of [...tellers, ids.sam]) {
      // oxlint-disable-next-line no-await-in-loop -- one interview after another
      await agree(person, [anonymous(line)]);
    }
    const drawn = await answering(
      [ticketsReply(ids)],
      async () => await onboardingStore(env).drawNext()
    );
    const given = await intake(ids, [zendeskClaim]);
    await handOverNow();
    // The lead, who never said it: each who did finds it in their own interview alone.
    const lea = await accountOfPerson(ids.lea);
    expect({
      gave: given.gave,
      asked: given.requests.length,
      prompts: promptsHold([...drawn.requests, ...given.requests], word),
      page: await standingOf(ids),
      recalled: await recalled(lea, word),
      tellers: await Promise.all(
        tellers.map(
          async (person) => await onboardingStore(env).drawInput(person)
        )
      ),
    }).toStrictEqual({
      gave: `brain:${ids.team}`,
      asked: 0,
      prompts: false,
      page: [],
      recalled: [],
      tellers: tellers.map(() => null),
    });
  });

  /** The map's words for the team's tickets, in English and in the team's language. */
  const ticketWords = ["handling new tickets", "nieuwe tickets afhandelen"];

  /** Whether `text` holds any of the tickets' words from the map. */
  const holdsTicketWords = (text: string): boolean =>
    ticketWords.some((word) => text.includes(word));

  /** Whether `text` holds any piece of work's words from the map: the tickets' or the rota's. */
  const holdsMapWords = (text: string): boolean =>
    holdsTicketWords(text) ||
    ["planning the rota", "het rooster plannen"].some((word) =>
      text.includes(word)
    );

  it("draw nothing and give nothing from a lead's map drawn before lines had a destination: a member's new shared line draws no piece of it, no interview is asked about it, and no team result holds its words (GRA-1987)", async () => {
    const { ids, max } = await drawnTeam();
    await intakeOf(ids, [zendeskClaim]);
    await handOverNow();
    const store = onboardingStore(env);
    const before = await askedOf(ids.mia);
    // The old drawing of the tickets, with what it left open (staff read
    // it; the next interviewer is told only what nobody said yet).
    const drawnBefore = await openOfTickets(ids.team);
    // The store as this release finds it: its map was drawn from every line
    // Lea approved, none of which had a destination.
    await runInDurableObject(store, (_, state) => {
      for (const statement of sharedLinesOnly.split(
        "--> statement-breakpoint"
      )) {
        state.storage.sql.exec(statement);
      }
    });
    await settled();
    // Max shares one more step of the tickets and approves it.
    await agree(
      ids.max,
      [
        fact("m1", "step", "Opens the ticket in Zendesk."),
        fact("m2", "system", "Tickets arrive in Zendesk."),
        fact("m3", "handoff", "Max hands billing questions to Noor."),
        fact("m4", "step", "Closes the ticket once answered."),
      ],
      1
    );
    const drawn = await answering(
      [ticketsReply(ids)],
      async () => await store.drawNext()
    );
    const given = await intake(ids, [zendeskClaim]);
    await handOverNow();
    const known = await knownTo(ids.mia);
    expect({
      before,
      drawnBefore,
      drawnAfter: await openOfTickets(ids.team),
      toldToAsk: known.includes("Nobody has said yet"),
      prompts: [...drawn.requests, ...given.requests].some(({ body }) =>
        holdsMapWords(JSON.stringify(body))
      ),
      results: holdsMapWords(JSON.stringify(await standingOf(ids))),
      asked: await askedOf(ids.mia),
      recalled: await recalled(max, "tickets", "drawing"),
    }).toStrictEqual({
      before: "nieuwe tickets afhandelen",
      drawnBefore: ["Why do some ask Noor?"],
      drawnAfter: null,
      toldToAsk: false,
      prompts: false,
      results: false,
      asked: "",
      recalled: [],
    });
  });

  it("take a lead's map out before the save that moves the line it came from to only counted anonymously commits, and draw it again from their shared lines alone, keeping no piece of the old one (GRA-1987)", async () => {
    const { ids, max } = await drawnTeam();
    await intakeOf(ids, [zendeskClaim]);
    await handOverNow();
    const store = onboardingStore(env);
    const before = {
      page: holdsTicketWords(JSON.stringify(await standingOf(ids))),
      asked: await askedOf(ids.mia),
    };
    // Lea moves the line her map's tickets came from to only counted anonymously.
    const line = "Max, Mia and Mo handle new tickets.";
    await agree(
      ids.lea,
      [
        anonymous(fact("l1", "work", line)),
        fact(
          "l2",
          "system",
          "The team lives in Zendesk and the lead's own rota sheet."
        ),
      ],
      1
    );
    const atCommit = {
      page: holdsTicketWords(JSON.stringify(await standingOf(ids))),
      asked: await askedOf(ids.mia),
      recalled: await recalled(max, "tickets", "drawing"),
    };
    // Her map, drawn again from the line she still shares, names the rota alone.
    const rotaOnly = mapReply(ids);
    const redrawn = await answering(
      [
        {
          ...rotaOnly,
          text: JSON.stringify({
            does: "Plans the rota",
            works: [
              {
                name: "planning the rota",
                local: "het rooster plannen",
                one: "rota",
                many: "rotas",
                doers: [ids.lea],
                share: 1,
              },
            ],
          }),
        },
      ],
      async () => await store.drawNext()
    );
    expect({
      before,
      atCommit,
      prompt: redrawn.requests.some(({ body }) =>
        JSON.stringify(body).includes(line)
      ),
      pieces: await piecesOf(ids.team),
    }).toStrictEqual({
      before: { page: true, asked: "nieuwe tickets afhandelen" },
      atCommit: { page: false, asked: "", recalled: [] },
      prompt: false,
      pieces: ["planning the rota"],
    });
  });

  it("use nothing of a map once its team has no lead: a former lead's map, its line moved to only counted anonymously, reaches no interview, drawing or review (GRA-1987)", async () => {
    const { ids } = await drawnTeam();
    await intakeOf(ids, [zendeskClaim]);
    await handOverNow();
    const store = onboardingStore(env);
    // Lea moves the line her map's tickets came from to only counted anonymously.
    await agree(
      ids.lea,
      [
        anonymous(fact("l1", "work", "Max, Mia and Mo handle new tickets.")),
        fact(
          "l2",
          "system",
          "The team lives in Zendesk and the lead's own rota sheet."
        ),
      ],
      1
    );
    // Then the admin saves the team with no lead.
    const keys: Key[] = [...everyone, "sam"];
    const roster = rosterOf(
      ids,
      keys,
      Object.fromEntries(keys.map((key) => [key, addressOf(ids[key])]))
    );
    await store.saveRoster(
      {
        ...roster,
        teams: roster.teams.map((each) => ({ ...each, lead: null })),
      },
      { type: "system" }
    );
    // Max shares one more step of the tickets.
    await agree(
      ids.max,
      [
        fact("m1", "step", "Opens the ticket in Zendesk."),
        fact("m2", "system", "Tickets arrive in Zendesk."),
        fact("m3", "handoff", "Max hands billing questions to Noor."),
        fact("m4", "step", "Closes the ticket once answered."),
      ],
      1
    );
    const drawn = await answering(
      [ticketsReply(ids)],
      async () => await store.drawNext()
    );
    const review = await store.review();
    expect({
      asked: await askedOf(ids.mia),
      prompts: drawn.requests.some(({ body }) =>
        holdsMapWords(JSON.stringify(body))
      ),
      review: holdsMapWords(JSON.stringify(review)),
      mapped: review.mapped,
    }).toStrictEqual({ asked: "", prompts: false, review: false, mapped: 0 });
  });

  it("take a claim out before the save that moves a backer's line to only counted anonymously commits, refuse that save whole while the Brain can't, and show it again from the line moved back only at the next intake (GRA-1987)", async () => {
    const { ids, max } = await drawnTeam({ eight: true });
    await intakeOf(ids, [zendeskClaim]);
    await handOverNow();
    const before = await recalled(max, "Zendesk", "claim");
    const zendesk = fact("p2", "system", "Tickets arrive in Zendesk.");
    const moved = [fact("p1", "step", "Tags the ticket."), anonymous(zendesk)];
    // The shared store refuses removals while a restore runs.
    const shared = inJurisdiction(env, env.BRAIN_STORE).getByName("brain");
    const restore = `restore-${unique()}`;
    await runInDurableObject(shared, (_, state) => {
      state.storage.sql.exec(
        "INSERT INTO restores (export, checked, part, restored, state, started_at) VALUES (?, 0, 0, 0, 'running', ?)",
        restore,
        Date.now()
      );
    });
    const refused = await saveAgreed(ids.pim, moved, 1);
    const stillTold = await onboardingStore(env).drawInput(ids.pim);
    const whileRestoring = {
      ok: refused.ok,
      told: stillTold?.facts,
      read: await recalled(max, "Zendesk", "claim"),
    };
    await runInDurableObject(shared, (_, state) => {
      state.storage.sql.exec("DELETE FROM restores WHERE export = ?", restore);
    });
    // Read the moment the save is kept, before it is approved or core's clock runs.
    const saved = await saveAgreed(ids.pim, moved, 1);
    const atCommit = await claimRead(max);
    await approveAgreed(await openLink(ids.pim), moved);
    await settled();
    const afterApproval = await recalled(max, "Zendesk", "claim");
    // Moved back and approved: it counts again, but shows only once the team's next intake puts it together.
    await agree(ids.pim, [fact("p1", "step", "Tags the ticket."), zendesk], 2);
    await settled();
    const beforeIntake = await recalled(max, "Zendesk", "claim");
    await answering(
      [ticketsReply(ids)],
      async () => await onboardingStore(env).drawNext()
    );
    await intakeOf(ids, [zendeskClaim]);
    await handOverNow();
    expect({
      before,
      whileRestoring,
      saved: saved.ok,
      atCommit,
      afterApproval,
      beforeIntake,
      afterIntake: await recalled(max, "Zendesk", "claim"),
    }).toStrictEqual({
      before: [zendeskClaim.text],
      whileRestoring: {
        ok: false,
        told: [
          { tag: "step", record: "Tags the ticket." },
          { tag: "system", record: "Tickets arrive in Zendesk." },
        ],
        read: [zendeskClaim.text],
      },
      saved: true,
      atCommit: { recalled: [], listed: [] },
      afterApproval: [],
      beforeIntake: [],
      afterIntake: [zendeskClaim.text],
    });
  });

  it("hold a backer's withdrawal back, made of nothing, while the Brain can't take the claim it drops out of use, and let it through once it can", async () => {
    const { ids, max } = await drawnTeam({ eight: true });
    await intakeOf(ids, [zendeskClaim]);
    await handOverNow();
    const device = await openLink(ids.pim);
    // The shared store refuses removals while a restore runs.
    const shared = inJurisdiction(env, env.BRAIN_STORE).getByName("brain");
    const restore = `restore-${unique()}`;
    await runInDurableObject(shared, (_, state) => {
      state.storage.sql.exec(
        "INSERT INTO restores (export, checked, part, restored, state, started_at) VALUES (?, 0, 0, 0, 'running', ?)",
        restore,
        Date.now()
      );
    });
    const refused = await onLink({ action: "withdraw", ...device });
    const whileRestoring = {
      ok: refused.ok,
      withdrawn: await runInDurableObject(
        onboardingStore(env),
        (_, state) =>
          state.storage.sql
            .exec(
              "SELECT 1 FROM participations WHERE person = ? AND withdrawn_at IS NOT NULL",
              ids.pim
            )
            .toArray().length
      ),
      read: await recalled(max, "Zendesk", "claim"),
    };
    await runInDurableObject(shared, (_, state) => {
      state.storage.sql.exec("DELETE FROM restores WHERE export = ?", restore);
    });
    const answer = await onLink({ action: "withdraw", ...device });
    expect({
      whileRestoring,
      withdrew: answer.ok,
      after: await recalled(max, "Zendesk", "claim"),
    }).toStrictEqual({
      whileRestoring: {
        ok: false,
        withdrawn: 0,
        read: [zendeskClaim.text],
      },
      withdrew: true,
      after: [],
    });
  });

  it("say a withdrawal is final at once, and that what the Brain kept is still being removed, when its erasures fail in the request; core's clock then erases them", async () => {
    const { ids, max } = await drawnTeam({ eight: true });
    await intakeOf(ids, [zendeskClaim]);
    await handOverNow();
    const pim = await accountOfPerson(ids.pim);
    const key = await interviewKeyOf(pim);
    // Pim backs the claim, and withdraws while the request's own erasures
    // all fail: four are left behind it. The claim was erased by the
    // withdrawal itself, before it committed; their interview is owed.
    const answer = await onLink(
      { action: "withdraw", ...(await openLink(ids.pim)) },
      erasuresFailing()
    );
    const said = await answer.json();
    const store = onboardingStore(env);
    const owedThen = await store.owedErasures({
      person: ids.pim,
      teams: [ids.team],
    });
    // Opened again, as a reload does: still being removed, until it is.
    const removingOf = async () => {
      const opened = await onLink({
        action: "session",
        ...(await openLink(ids.pim)),
      });
      const { removing } = z
        .object({ removing: z.boolean() })
        .parse(await opened.json());
      return removing;
    };
    const reopened = await removingOf();
    await settled();
    const { own } = await keptIn(key, pim);
    expect({
      status: answer.status,
      removing: z.object({ removing: z.literal(true) }).safeParse(said).success,
      reopened,
      reopenedAfter: await removingOf(),
      owedThen: owedThen.map(({ kind }) => kind).toSorted(),
      owed: await store.owedErasures({ person: ids.pim, teams: [ids.team] }),
      kept: own,
      claims: await recalled(max, "Zendesk", "claim"),
    }).toStrictEqual({
      status: 200,
      removing: true,
      reopened: true,
      reopenedAfter: false,
      owedThen: ["interview"],
      owed: [],
      kept: "erased",
      claims: [],
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
      oldKey: listed.some(({ source }) => source.id === first?.source.id),
      recalled: await recalled(max, "Zendesk", "claim"),
    }).toStrictEqual({
      first: false,
      oldKey: false,
      recalled: [],
    });
  });

  it("are erased by the roster save itself that takes a backer off, in a team still of seven, though core's clock fails every erasure", async () => {
    const { ids, max } = await drawnTeam({ eight: true });
    await intakeOf(ids, [zendeskClaim]);
    await handOverNow();
    const before = await recalled(max, "Zendesk", "claim");
    const [claim] = await claimsOf(max);
    // Pim, who backs the claim, is taken off the list: four left behind it,
    // seven still interviewed. Core's clock fails every erasure: the save
    // took it out of the Brain and erased it itself, before it committed.
    await onboardingStore(env).saveRoster(
      rosterWith(ids, { keys: eightBut("pim") }),
      {
        type: "system",
      }
    );
    await eraseOwedOnboardingSources(erasuresFailing());
    const owed = await onboardingStore(env).owedErasures();
    const { shared } = await keptIn(`claim:${claim?.source.id ?? ""}`, max);
    expect({
      before,
      owed: owed.some(
        (each) => each.kind === "claim" && each.team === ids.team
      ),
      shared,
      now: await readableBy(max),
    }).toStrictEqual({
      before: [zendeskClaim.text],
      owed: false,
      shared: "erased",
      now: { recalled: [], listed: [] },
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
      now: { recalled: [], listed: [] },
    });
  });

  it("no longer count one moved to another team among their backers: the move erases them in the same save", async () => {
    const { ids, max } = await drawnTeam({ eight: true });
    await intakeOf(ids, [zendeskClaim]);
    await handOverNow();
    const [claim] = await claimsOf(max);
    // Pim, who backs the claim, moves to Billing: Ops still has seven
    // interviewed, but four of its people now back the claim.
    await onboardingStore(env).saveRoster(
      rosterWith(ids, { keys: eightBut(), moved: ["pim"] }),
      {
        type: "system",
      }
    );
    const owed = await onboardingStore(env).owedErasures();
    const { shared } = await keptIn(`claim:${claim?.source.id ?? ""}`, max);
    expect({
      owed: owed.some(
        (each) => each.kind === "claim" && each.team === ids.team
      ),
      shared,
      now: await readableBy(max),
    }).toStrictEqual({
      owed: false,
      shared: "erased",
      now: { recalled: [], listed: [] },
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
      now: { recalled: [], listed: [] },
    });
  });

  /** Each of the team's pieces of work on the Brain page, as an admin reads it: its name and how many drawings it shows. */
  const workOnPage = async (ids: { team: string }) => {
    const admin = await signedInApi(idp, "admin");
    const { workflows } = await admin.api.brain.read();
    return workflows
      .filter(({ teamId }) => teamId === `team-${ids.team}`)
      .map(({ name, drawings }) => [name, drawings?.length ?? 0]);
  };

  it("give every member each piece of work's drawing, and take it out as a lead's withdrawal commits, every erasure failing, before core's clock", async () => {
    const { ids, max } = await drawnTeam({ eight: true });
    await intakeOf(ids, [zendeskClaim]);
    await handOverNow();
    const before = {
      recalled: await recalled(max, "ticket", "drawing"),
      page: await workOnPage(ids),
    };
    // Lea, whose map the work was drawn on, withdraws, and every erasure
    // fails, the onboarding's own too: the drawing is out of use in the
    // Brain, and off the page, before her withdrawal commits (GRA-1748).
    const restore = await setObjectEnv(onboardingStore(env), {
      BRAIN_STORE: erasuresFailing().BRAIN_STORE,
    });
    let withdrew: boolean;
    try {
      const answer = await onLink(
        { action: "withdraw", ...(await openLink(ids.lea)) },
        erasuresFailing()
      );
      withdrew = answer.ok;
    } finally {
      await restore();
    }
    const owed = await onboardingStore(env).owedErasures({ claims: true });
    expect({
      before: { found: before.recalled.length > 0, page: before.page },
      withdrew,
      owed: owed.filter(({ kind }) => kind === "drawing").length,
      after: {
        recalled: await recalled(max, "ticket", "drawing"),
        page: await workOnPage(ids),
      },
    }).toStrictEqual({
      before: { found: true, page: [["handling new tickets", 1]] },
      withdrew: true,
      owed: 1,
      after: { recalled: [], page: [] },
    });
  });

  /** The staff list of `ids` with `keys` on it, at their own addresses, as `change` makes it. */
  const savedRoster = async (
    ids: Ids,
    keys: readonly Key[],
    change: (roster: ReturnType<typeof rosterOf>) => ReturnType<typeof rosterOf>
  ): Promise<void> => {
    const roster = rosterOf(
      ids,
      keys,
      Object.fromEntries(keys.map((key) => [key, addressOf(ids[key])]))
    );
    await onboardingStore(env).saveRoster(change(roster), { type: "system" });
  };

  it("give code's recall, as an App or a workflow and as a chat's code, no drawing a member finds", async () => {
    const { ids, max } = await drawnTeam({ eight: true });
    await intakeOf(ids, [zendeskClaim]);
    await handOverNow();
    // As brain-recall.ts asks it (`recallFor`), before its own narrowing,
    // so the drawing's readers alone keep it out.
    const codeReads = async (company: boolean) => {
      const { items } = await recallPassagesAs(env, max, {
        question: "ticket",
        budget: { tokens: 2000 },
        personal: false,
        company,
        teams: [],
      });
      const drawings = items.filter(
        ({ source }) => source.producer === "drawing"
      );
      return drawings.length;
    };
    const found = await recalled(max, "ticket", "drawing");
    expect({
      member: found.length > 0,
      appOrWorkflow: await codeReads(true),
      chatCode: await codeReads(false),
    }).toStrictEqual({ member: true, appOrWorkflow: 0, chatCode: 0 });
  });

  it("give no drawing of a team with fewer than seven who tell their own work, as for its claims", async () => {
    const { ids, max } = await drawnTeam({ small: true });
    await intakeOf(ids, [zendeskClaim]);
    await handOverNow();
    expect({
      claims: await recalled(max, "Zendesk", "claim"),
      drawings: await recalled(max, "ticket", "drawing"),
      page: await workOnPage(ids),
    }).toStrictEqual({ claims: [], drawings: [], page: [] });
  });

  it("take a drawing out as a move leaves its team six who tell, though everyone it rests on still agrees", async () => {
    const { ids, max } = await drawnTeam();
    await intakeOf(ids, [zendeskClaim]);
    await handOverNow();
    const before = await workOnPage(ids);
    // Rik moves to another team: he still agrees to what he told.
    await savedRoster(ids, [...everyone, "sam"], (roster) => ({
      teams: [
        ...roster.teams,
        {
          id: `${ids.team}-b`,
          name: "Billing",
          lead: null,
          does: "",
          off: false,
        },
      ],
      people: roster.people.map((person) =>
        person.id === ids.rik ? { ...person, team: `${ids.team}-b` } : person
      ),
    }));
    expect({
      before,
      drawings: await recalled(max, "ticket", "drawing"),
      page: await workOnPage(ids),
    }).toStrictEqual({
      before: [["handling new tickets", 1]],
      drawings: [],
      page: [],
    });
  });

  it("take a team's drawing and claim out as someone they rest on moves to another team, though seven still tell, and leave nothing of it to their later withdrawal", async () => {
    const { ids, max } = await drawnTeam({ eight: true });
    await intakeOf(ids, [zendeskClaim]);
    await handOverNow();
    const readNow = async () => {
      const drawings = await recalled(max, "ticket", "drawing");
      return {
        claims: await recalled(max, "Zendesk", "claim"),
        drawings: drawings.length,
        page: await workOnPage(ids),
      };
    };
    const before = await readNow();
    // Max, whom the drawing was drawn from and who backs the claim, moves
    // to Billing: Ops still has seven who tell. What rests on him in Ops
    // rests on him no more (GRA-1748).
    await savedRoster(ids, [...everyone, "sam", "ada"], (roster) => ({
      teams: [
        ...roster.teams,
        {
          id: `${ids.team}-b`,
          name: "Billing",
          lead: null,
          does: "",
          off: false,
        },
      ],
      people: roster.people.map((person) =>
        person.id === ids.max ? { ...person, team: `${ids.team}-b` } : person
      ),
    }));
    const moved = await readNow();
    await onLink({ action: "withdraw", ...(await openLink(ids.max)) });
    expect({ before, moved, withdrawn: await readNow() }).toStrictEqual({
      before: {
        claims: [zendeskClaim.text],
        drawings: 1,
        page: [["handling new tickets", 1]],
      },
      moved: { claims: [], drawings: 0, page: [] },
      withdrawn: { claims: [], drawings: 0, page: [] },
    });
  });

  it("draw a team's work again without someone who moved away, and give its drawing back once it stands without them, nobody agreeing anew", async () => {
    const { ids, max } = await drawnTeam({ eight: true });
    await intakeOf(ids, [zendeskClaim]);
    await handOverNow();
    const keys: Key[] = [...everyone, "sam", "ada"];
    // Max moves to Billing, and stays: Ops still has seven who tell.
    await savedRoster(ids, keys, movedToBilling(ids, [ids.max]));
    const moved = await workOnPage(ids);
    // The work is due to be drawn again, without him; then the team's
    // next intake.
    for (let round = 0; round < 4; round += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one drawing at a time, as the alarm draws
      const { result } = await answering(
        [ticketsReply(ids)],
        async () => await onboardingStore(env).drawNext()
      );
      if (result === null) {
        break;
      }
    }
    await intakeOf(ids, [zendeskClaim]);
    await handOverNow();
    const drawings = await recalled(max, "ticket", "drawing");
    const [drawn] = await onboardingStore(env).standingDrawings();
    const restingOnMax = await onboardingStore(env).sentFor(ids.max);
    expect({
      moved,
      drawings: drawings.length,
      page: await workOnPage(ids),
      // Drawn from those in Ops now: never Max.
      fromMax: JSON.stringify(drawn?.drawing ?? {}).includes(ids.max),
      restsOnMax: restingOnMax.length,
    }).toStrictEqual({
      moved: [],
      drawings: 1,
      page: [["handling new tickets", 1]],
      fromMax: false,
      restsOnMax: 0,
    });
  });

  it("give a team's claims and drawing back at its next intake when someone they rest on moves back, nobody agreeing anew", async () => {
    const { ids, max } = await drawnTeam({ eight: true });
    await intakeOf(ids, [zendeskClaim]);
    await handOverNow();
    const keys: Key[] = [...everyone, "sam", "ada"];
    await savedRoster(ids, keys, movedToBilling(ids, [ids.max]));
    await noAlarm();
    await savedRoster(ids, keys, movedToBilling(ids, []));
    const armed = await alarmSet();
    await byTheAlarm(async () => {
      const drawn = await recalled(max, "ticket", "drawing");
      return drawn.length > 0;
    });
    const drawings = await recalled(max, "ticket", "drawing");
    expect({
      armed,
      claims: await recalled(max, "Zendesk", "claim"),
      drawings: drawings.length,
      page: await workOnPage(ids),
    }).toStrictEqual({
      armed: true,
      claims: [zendeskClaim.text],
      drawings: 1,
      page: [["handling new tickets", 1]],
    });
  });

  it("take a drawing out as its team's lead is replaced on the list: its map was the old lead's", async () => {
    const { ids, max } = await drawnTeam({ eight: true });
    await intakeOf(ids, [zendeskClaim]);
    await handOverNow();
    const before = await workOnPage(ids);
    await savedRoster(ids, [...everyone, "sam", "ada"], (roster) => ({
      ...roster,
      teams: roster.teams.map((each) => ({ ...each, lead: ids.max })),
    }));
    expect({
      before,
      drawings: await recalled(max, "ticket", "drawing"),
      page: await workOnPage(ids),
    }).toStrictEqual({
      before: [["handling new tickets", 1]],
      drawings: [],
      page: [],
    });
  });

  it("take a switched-off team's claims and drawings out as the save commits, and note them again at its next intake once it takes part again, nobody agreeing anew", async () => {
    const { ids, max } = await drawnTeam({ eight: true });
    await intakeOf(ids, [zendeskClaim]);
    await handOverNow();
    const keys: Key[] = [...everyone, "sam", "ada"];
    const readNow = async () => {
      const drawings = await recalled(max, "ticket", "drawing");
      return {
        claims: await recalled(max, "Zendesk", "claim"),
        drawings: drawings.length,
        page: await workOnPage(ids),
      };
    };
    const before = await readNow();
    await savedRoster(ids, keys, (roster) => ({
      ...roster,
      teams: roster.teams.map((each) => ({ ...each, off: true })),
    }));
    const off = await readNow();
    // Taking part again, confirmed, and nobody agreeing anew: the next
    // intake.
    await noAlarm();
    await savedRoster(ids, keys, (roster) => roster);
    const armed = await alarmSet();
    await byTheAlarm(async () => {
      const drawn = await recalled(max, "ticket", "drawing");
      return drawn.length > 0;
    });
    const again = await readNow();
    expect({ before, off, armed, again }).toStrictEqual({
      before: {
        claims: [zendeskClaim.text],
        drawings: 1,
        page: [["handling new tickets", 1]],
      },
      off: { claims: [], drawings: 0, page: [] },
      armed: true,
      again: {
        claims: [zendeskClaim.text],
        drawings: 1,
        page: [["handling new tickets", 1]],
      },
    });
  });

  it("bring nothing of a switched-off team back while switching it on again waits for the admin's confirmation, and show it at the next intake once confirmed, with nothing else changed", async () => {
    const { ids, max } = await drawnTeam({ eight: true });
    await intakeOf(ids, [zendeskClaim]);
    await handOverNow();
    const keys: Key[] = [...everyone, "sam", "ada"];
    const listOf = () =>
      rosterOf(
        ids,
        keys,
        Object.fromEntries(keys.map((key) => [key, addressOf(ids[key])]))
      );
    const readNow = async () => {
      const drawings = await recalled(max, "ticket", "drawing");
      return {
        claims: await recalled(max, "Zendesk", "claim"),
        drawings: drawings.length,
        page: await workOnPage(ids),
      };
    };
    /** Sam agrees to more, the work is drawn again, and the team's next intake runs. */
    const nextIntake = async (version: number) => {
      await agree(
        ids.sam,
        [
          fact("s1", "step", "Answers the phone."),
          fact("s2", "step", "Logs the call."),
        ],
        version
      );
      await answering(
        [ticketsReply(ids)],
        async () => await onboardingStore(env).drawNext()
      );
      await intakeOf(ids, [zendeskClaim]);
      await handOverNow();
    };
    // Confirmed off; then switched on again in a save not confirmed.
    await savedRoster(ids, keys, (roster) => ({
      ...roster,
      teams: roster.teams.map((each) => ({ ...each, off: true })),
    }));
    await onboardingStore(env).saveRoster(
      listOf(),
      { type: "system" },
      { confirmed: false }
    );
    await nextIntake(1);
    const unconfirmed = await readNow();
    // The admin confirms it, and nothing else changes: the clock's next
    // intake notes the team's results.
    await noAlarm();
    await onboardingStore(env).saveRoster(listOf(), { type: "system" });
    const armed = await alarmSet();
    await byTheAlarm(async () => {
      const drawn = await recalled(max, "ticket", "drawing");
      return drawn.length > 0;
    });
    expect({ unconfirmed, armed, confirmed: await readNow() }).toStrictEqual({
      unconfirmed: { claims: [], drawings: 0, page: [] },
      armed: true,
      confirmed: {
        claims: [zendeskClaim.text],
        drawings: 1,
        page: [["handling new tickets", 1]],
      },
    });
  });

  it("give a team's results back at the clock's next intake when the Brain refused its switch-off, with nothing else changed", async () => {
    const { ids, max } = await drawnTeam({ eight: true });
    await intakeOf(ids, [zendeskClaim]);
    await handOverNow();
    const keys: Key[] = [...everyone, "sam", "ada"];
    const readNow = async () => {
      const drawings = await recalled(max, "ticket", "drawing");
      return {
        claims: await recalled(max, "Zendesk", "claim"),
        drawings: drawings.length,
        page: await workOnPage(ids),
      };
    };
    // The Brain's store restores, so it takes nothing out of use: the
    // switch-off is refused whole, its team's results already marked.
    const shared = inJurisdiction(env, env.BRAIN_STORE).getByName("brain");
    const restore = `restore-${unique()}`;
    await runInDurableObject(shared, (_, state) => {
      state.storage.sql.exec(
        "INSERT INTO restores (export, checked, part, restored, state, started_at) VALUES (?, 0, 0, 0, 'running', ?)",
        restore,
        Date.now()
      );
    });
    await noAlarm();
    const refused = await outcome(
      savedRoster(ids, keys, (roster) => ({
        ...roster,
        teams: roster.teams.map((each) => ({ ...each, off: true })),
      }))
    );
    const armed = await alarmSet();
    const { roster } = await onboardingStore(env).view();
    const off = roster?.teams.find(({ id }) => id === ids.team)?.off;
    await runInDurableObject(shared, (_, state) => {
      state.storage.sql.exec("DELETE FROM restores WHERE export = ?", restore);
    });
    await byTheAlarm(async () => {
      const drawn = await recalled(max, "ticket", "drawing");
      return drawn.length > 0;
    });
    expect({
      refused: refused === "ok" ? "saved" : "refused",
      armed,
      off,
      again: await readNow(),
    }).toStrictEqual({
      refused: "refused",
      armed: true,
      off: false,
      again: {
        claims: [zendeskClaim.text],
        drawings: 1,
        page: [["handling new tickets", 1]],
      },
    });
  });

  it("take a drawing out as a backer's withdrawal commits, for the Brain and the page alike", async () => {
    const { ids, max } = await drawnTeam({ eight: true });
    await intakeOf(ids, [zendeskClaim]);
    await handOverNow();
    const before = await recalled(max, "ticket", "drawing");
    await onLink({ action: "withdraw", ...(await openLink(ids.pim)) });
    expect({
      before: before.length > 0,
      recalled: await recalled(max, "ticket", "drawing"),
      page: await workOnPage(ids),
    }).toStrictEqual({ before: true, recalled: [], page: [] });
  });
});
