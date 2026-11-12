import { brainOf, personalBrainOf } from "@grasp-os/brain-next/contract";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { drainObjectOutbox } from "../src/audit-outbox.ts";
import {
  erasePerson,
  listSourcesAs,
  listVersionsAs,
  readSourceVersionAs,
  recallAs,
  workBrain,
} from "../src/brain-next.ts";
import { producersOf, relayHandOvers } from "../src/brain-sources.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { eraseOwedOnboardingSources } from "../src/onboarding/new-brain.ts";
import { onboardingStore } from "../src/onboarding/store.ts";
import { teamMayClaim } from "../src/onboarding/team-claims.ts";
import { ageOwnErasure } from "./brain-next-own-store.ts";
import { mockIdp } from "./idp.ts";
import {
  answering,
  answeringWith,
  holdAlarm,
  onLink,
} from "./interview-link.ts";
import { captureMail } from "./mail-capture.ts";
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
// - Someone's interview readable before they have an account.
// - A withdrawal leaving their words in the Brain.
// - The same interview handed over twice, as two sources.
// - Someone at an earlier, wrong address holding the link (it went to
//   them first, or a reminder or a send-again went elsewhere) and being
//   linked to the interview.
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

/** The queue's clock across this file: only forward, as core's clock goes. */
const clock = { at: Date.now() };

/**
 * Hands over what the onboarding noted, as core does: its outbox drained
 * (which notes each hand-over), the hand-overs relayed to the Brain's
 * queue, and the Brain ticked with core's producers, through `into`.
 */
const handOverNow = async (into: Env = env): Promise<void> => {
  await runInDurableObject(onboardingStore(env), async (_, state) => {
    await drainObjectOutbox(env, state.storage.sql);
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

describe("interviews in the new Brain", { timeout: 120_000 }, () => {
  beforeEach(holdAlarm);

  it("are read by the person alone, from their verified sign-in, never by whoever the list's address names later", async () => {
    const marker = `marker${unique()}`;
    const ids = await team(undefined, addressOf);
    await mapped(ids, {
      facts: [fact("l9", "rule", `Every refund needs ${marker} first.`)],
    });
    // Nobody has an account yet: nothing is handed over.
    const store = onboardingStore(env);
    await handOverNow();
    // An admin puts their own address on Lea's entry after her link went
    // out, and signs in with it.
    const taken = `admin-${unique()}@acme.test`;
    await store.saveRoster(
      rosterOf(ids, everyone, {
        ...Object.fromEntries(
          everyone.map((key) => [key, addressOf(ids[key])])
        ),
        lea: taken,
      }),
      { type: "system" }
    );
    let admin = "";
    let lea = "";
    const audited = await auditedDuring(async () => {
      admin = await signsIn(taken, "admin");
      lea = await signsIn(addressOf(ids.lea));
    });
    // One event for the one link made, naming the account alone.
    expect(
      audited
        .filter(
          ({ action }) => action === "onboarding.interview.account_linked"
        )
        .map(({ actor, detail }) => ({ actor, detail }))
    ).toStrictEqual([{ actor: { type: "person", userId: lea }, detail: {} }]);
    const max = await signsIn(addressOf(ids.max));
    await handOverNow();
    // Handing it over again makes no second source.
    await handOverNow();
    const key = await interviewKeyOf(lea);
    expect({
      lea: await recalled(lea, marker),
      admin: await recalled(admin, marker),
      max: await recalled(max, marker),
      // In her own store alone, never in the shared one.
      kept: await keptIn(key, lea),
    }).toStrictEqual({
      lea: [expect.stringContaining(marker)],
      admin: [],
      max: [],
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
      owed: await store.owedErasures(),
      kept: await keptIn(key, lea),
    }).toStrictEqual({
      recalled: [],
      owed: [],
      kept: { shared: "erased", own: "erased" },
    });
  });

  it("leave nothing owed when their person's own store was erased whole first", async () => {
    const marker = `marker${unique()}`;
    const ids = await team(undefined, addressOf);
    await mapped(ids, {
      facts: [fact("l9", "rule", `Every refund needs ${marker} first.`)],
    });
    const lea = await signsIn(addressOf(ids.lea));
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
      owed: await onboardingStore(env).owedErasures(),
      kept: await keptIn(key, lea),
    }).toStrictEqual({
      erased: "erased",
      owed: [],
      kept: { shared: "erased", own: "free" },
    });
  });

  it("are linked to nobody once the link was sent again to another address", async () => {
    const store = onboardingStore(env);
    const mail = await captureMail(
      store,
      ...Array.from({ length: 40 }, () => "E_RECIPIENT_SUPPRESSED")
    );
    const marker = `marker${unique()}`;
    // The admin first put a colleague's address on Lea's entry: her link
    // goes there, and fails.
    const wrong = `colleague-${unique()}@acme.test`;
    const ids = await team(undefined, addressOf);
    const emails = Object.fromEntries(
      everyone.map((key) => [key, addressOf(ids[key])])
    );
    await store.saveRoster(rosterOf(ids, everyone, { ...emails, lea: wrong }), {
      type: "system",
    });
    await mapped(ids, {
      facts: [fact("l9", "rule", `Every refund needs ${marker} first.`)],
    });
    await store.deliverMail(Date.now() + 60_000);
    // Corrected, and sent again to Lea: the link went to two addresses.
    await store.saveRoster(rosterOf(ids, everyone, emails), { type: "system" });
    mail.plan.length = 0;
    const again = await store.sendAgain(ids.lea, { type: "system" });
    const colleague = await signsIn(wrong);
    const lea = await signsIn(addressOf(ids.lea));
    await handOverNow();
    expect({
      again,
      colleague: await recalled(colleague, marker),
      lea: await recalled(lea, marker),
    }).toStrictEqual({ again: "sent", colleague: [], lea: [] });
  });

  it("are linked to nobody once a reminder carrying the link went to another address", async () => {
    const store = onboardingStore(env);
    const marker = `marker${unique()}`;
    const wrong = `colleague-${unique()}@acme.test`;
    const ids = await team(undefined, addressOf);
    const emails = Object.fromEntries(
      everyone.map((key) => [key, addressOf(ids[key])])
    );
    await store.saveRoster(rosterOf(ids, everyone, { ...emails, max: wrong }), {
      type: "system",
    });
    // Max's link goes to the wrong address with the others'; corrected,
    // his reminder goes to his own.
    await mapped(ids);
    await store.saveRoster(rosterOf(ids, everyone, emails), { type: "system" });
    const later = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000);
    const reminded = await store.remindDue(later.toISOString());
    await agree(ids.max, [
      fact("m9", "rule", `Every refund needs ${marker} first.`),
    ]);
    const colleague = await signsIn(wrong);
    const max = await signsIn(addressOf(ids.max));
    await handOverNow();
    expect({
      reminded: reminded.includes(ids.max),
      colleague: await recalled(colleague, marker),
      max: await recalled(max, marker),
    }).toStrictEqual({ reminded: true, colleague: [], max: [] });
  });

  it("stay erased when an add of them lands after a withdrawal erased them", async () => {
    const marker = `marker${unique()}`;
    const ids = await team(undefined, addressOf);
    await mapped(ids, {
      facts: [fact("l9", "rule", `Every refund needs ${marker} first.`)],
    });
    const lea = await signsIn(addressOf(ids.lea));
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
      owed: await onboardingStore(env).owedErasures(),
      held: own === "held",
    }).toStrictEqual({ recalled: [], owed: [], held: false });
  });
});

describe("team claims in the new Brain", { timeout: 120_000 }, () => {
  beforeEach(holdAlarm);

  /**
   * A team through the onboarding, its tickets drawn, Max linked to his
   * account: seven who told their own work (Sam too, a step of his own)
   * unless `small`, and then six.
   */
  const drawnTeam = async ({ small = false, drained = false } = {}) => {
    const keys: readonly Key[] = small ? everyone : [...everyone, "sam"];
    const ids = await team(keys, addressOf);
    await mapped(ids);
    await told(ids);
    if (!small) {
      await agree(ids.sam, [fact("s1", "step", "Answers the phone.")]);
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
    const max = await signsIn(addressOf(ids.max));
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
    // Pim withdraws: the claim rests on four now. It is erased: no
    // recall, no listing, no version of it, as history or otherwise.
    await onLink({ action: "withdraw", ...(await openLink(ids.pim)) });
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
      claims: owed.filter(({ kind }) => kind === "claim"),
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
});
