import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { eraseOwedOnboardingSources } from "../src/onboarding/new-brain.ts";
import { onboardingStore } from "../src/onboarding/store.ts";
import { proposerOf } from "../src/opportunities.ts";
import { consentCode } from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import {
  aloneInTheStore,
  answering,
  answeringWith,
  onLink,
} from "./interview-link.ts";
import {
  agree,
  fact,
  fiveToldReply,
  intake,
  mapped,
  openLink,
  team,
  told,
  zendeskClaim,
} from "./onboarding-team.ts";
import type { Ids, Key } from "./onboarding-team.ts";
import type { ProviderReply } from "./provider-streams.ts";
import { acmeTenant } from "./sign-in-config.ts";
import { outcome, routed, signedInApi } from "./sign-in.ts";

// Opportunities (GRA-1750): each of a team's routines (GRA-1749) as an
// admin reads it, ranked by the hours a week it takes, with its evidence
// and what Grasp proposes for it. The ways it can fail, tried here:
//
// - Anyone but an admin reading the list or dismissing one.
// - A model's answer taken on trust: an App it wasn't given, a system the
//   routine never names (or names only as part of a word), a step it hasn't.
// - A page's request that waits for a model: listing asks nothing, also
//   two lists at once; a proposal is asked when the routine is noted, once,
//   and a failing model is tried again later, never by the list; one owed
//   and forgotten (given up, or never asked) is asked once an admin lists.
// - A back-off counted from when a call began, not when it failed.
// - A proposal written for a drawing that fell while the model answered,
//   kept when its erasure fails or the store stops after the write.
// - A system a shared connection covers listed as setup, because the
//   routine names its product (Gmail) and not the suite.
// - A dismissal that outlives the evidence it was made at, or one that
//   lets go before.

const idp = mockIdp();

/** Seven who tell their own work besides Lea, the lead. */
const seven: readonly Key[] = [
  "lea",
  "max",
  "mia",
  "mo",
  "noor",
  "pim",
  "rik",
  "sam",
];

/** A drawing's answer as the fake model gives it: its numbers, and the rest as is. */
const drawnSchema = z.looseObject({
  numbers: z.array(z.record(z.string(), z.unknown())),
});

/**
 * The tickets as five told them (`fiveToldReply`), each count of how
 * many come in given as the whole team's: 30 to 34 in a quiet week and 50
 * to 54 in a busy one, so 32 and 52, and 42 in the middle; one takes 3 to
 * 45 minutes, 24 in the middle: 16.8 hours a week. With `last`, its last
 * step in other words: new evidence.
 */
const ticketsAsTheTeamCounts = (
  ids: Ids,
  last = "Send the answer."
): ProviderReply => {
  const reply = fiveToldReply(ids, last);
  const drawn = drawnSchema.parse(
    JSON.parse("text" in reply ? reply.text : "{}")
  );
  return {
    ...reply,
    text: JSON.stringify({
      ...drawn,
      numbers: drawn.numbers.map((each) => ({ ...each, of: "team" })),
    }),
  };
};

/** What the model proposes for the tickets: `answer`, as JSON. */
const proposing = (answer: unknown): ProviderReply => ({
  text: JSON.stringify(answer),
  inputTokens: 1000,
  outputTokens: 100,
});

/** The tickets drawn again, `last` their last step, and the team's intake given. */
const drawTickets = async (ids: Ids, last?: string) => {
  await answering(
    [ticketsAsTheTeamCounts(ids, last)],
    async () => await onboardingStore(env).drawNext()
  );
  const { gave } = await intake(ids, [zendeskClaim]);
  if (gave !== `brain:${ids.team}`) {
    throw new Error("The team's intake was never given.");
  }
};

/** A team through the onboarding, its tickets drawn (`last` their last step) and its intake given; and the version of Sam's interview. */
const drawnTeam = async (last?: string) => {
  const ids = await team(seven);
  await mapped(ids);
  await told(ids);
  const sam = await agree(ids.sam, [fact("s1", "step", "Answers the phone.")]);
  await drawTickets(ids, last);
  return { ids, sam };
};

/** The tickets' opportunity, as `api` lists it; and how many model calls the list made (none, ever). */
const ticketsOf = async (
  api: Awaited<ReturnType<typeof signedInApi>>["api"],
  ids: Ids
) => {
  const { requests, result } = await answering(
    [],
    async () => await api.opportunities.list()
  );
  return {
    asked: requests.length,
    tickets: result.find(
      ({ team: of, name }) => of === ids.team && name === "handling new tickets"
    ),
  };
};

/** What Grasp proposes for each routine owed one, as the onboarding's alarm asks it, while the model answers `replies` (from `now`, when given). */
const proposed = async (replies: ProviderReply[], now?: number) => {
  const { requests, result } = await answering(
    replies,
    async () => await onboardingStore(env).proposeNext(now)
  );
  return { calls: requests.length, asked: result };
};

/**
 * An admin lists, with nothing else to wake the store (no alarm set), and
 * then the store's own alarm runs, while the model answers `replies`:
 * whether the list set it, how many calls it made, and the tickets' form.
 */
const listedThenAlarmed = async (
  api: Awaited<ReturnType<typeof signedInApi>>["api"],
  ids: Ids,
  replies: ProviderReply[]
) => {
  const store = onboardingStore(env);
  await runInDurableObject(store, async (instance, state) => {
    await state.storage.deleteAlarm();
    // The fixture holds the alarm with a spy on it: taken off, so the
    // store's own alarm runs.
    vi.spyOn(instance, "alarm").mockRestore();
  });
  const { requests, result: alarmed } = await answering(replies, async () => {
    await api.opportunities.list();
    return await runDurableObjectAlarm(store);
  });
  const { tickets } = await ticketsOf(api, ids);
  return { alarmed, asked: requests.length, form: tickets?.form };
};

/**
 * `provider`'s account `subject`, as an admin connects it for everyone,
 * with every right it asks for.
 */
const connectedForEveryone = async (
  admin: Awaited<ReturnType<typeof signedInApi>>,
  provider: "google" | "microsoft",
  subject: string
) => {
  const { url } = await admin.api.connections.start({
    provider,
    scope: "shared",
  });
  const authorization = new URL(url);
  const query = new URLSearchParams({
    code: consentCode(
      authorization,
      provider === "google" ? "acme.test" : acmeTenant,
      subject,
      authorization.searchParams.get("scope") ?? undefined
    ),
    state: authorization.searchParams.get("state") ?? "",
  });
  await routed(`/api/connections/callback?${query.toString()}`, {
    headers: { cookie: admin.session },
  });
  const listed = await admin.api.connections.list();
  if (
    !listed.some(
      ({ accountName, status }) =>
        status === "active" && accountName?.startsWith(`${subject}@`) === true
    )
  ) {
    throw new Error(`Expected ${provider}'s shared connection`);
  }
};

/** Kept proposals at `evidence`, as core's database holds them. */
const keptAt = async (evidence: string): Promise<number> => {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS kept FROM opportunity_proposals WHERE evidence = ?"
  )
    .bind(evidence)
    .first<{ kept: number }>();
  return row?.kept ?? 0;
};

/** Past the claim on a proposal being asked (five minutes). */
const proposeClaimPastMs = 5 * 60_000 + 1000;

/** Past the first back-off of a proposal that failed (a minute). */
const pastFirstRetryMs = 61_000;

describe("opportunities", { timeout: 120_000 }, () => {
  beforeEach(aloneInTheStore);

  it("give an admin each routine with its figures and the form proposed, asked once when the routine is noted and held to what the model was given, and never asked by the list", async () => {
    const { ids } = await drawnTeam();
    const { api } = await signedInApi(idp, "admin");
    const first = await proposed([
      proposing({
        form: "workflow",
        // An App it was never given, a system the routine never names, one
        // it names only inside a word, and a step it hasn't: all left out.
        covers: "app-it-was-never-given",
        systems: ["Zendesk", "Salesforce", "e"],
        personApproves: [3, 9],
      }),
    ]);
    const again = await proposed([]);
    const listed = await ticketsOf(api, ids);
    expect({
      first,
      again,
      listed: listed.tickets,
      listCalls: listed.asked,
    }).toMatchObject({
      first: { calls: 1, asked: 1 },
      again: { calls: 0, asked: 0 },
      listed: {
        casesPerWeek: 42,
        hoursPerWeek: 16.8,
        basis: "described",
        form: "workflow",
        covers: null,
        // Named whole in what starts one, and not connected: a setup step.
        setup: ["Zendesk"],
        personApproves: [3],
        steps: [
          "Open the ticket.",
          "Ask someone when the customer number is missing.",
          "Send the answer.",
        ],
      },
      listCalls: 0,
    });
  });

  it("list a routine at once with no form proposed yet, two lists at once asking nothing", async () => {
    const { ids } = await drawnTeam();
    const [one, other] = await Promise.all([
      signedInApi(idp, "admin"),
      signedInApi(idp, "admin"),
    ]);
    const { requests, result } = await answering(
      [],
      async () =>
        await Promise.all([
          one.api.opportunities.list(),
          other.api.opportunities.list(),
        ])
    );
    const forms = result.map((listed) => {
      const found = listed.find(({ team: of }) => of === ids.team);
      return found === undefined ? "missing" : found.form;
    });
    expect({ calls: requests.length, forms }).toStrictEqual({
      calls: 0,
      forms: [null, null],
    });
  });

  it("try a failing model again after its back-off, never sooner, while the list shows the routine at once", async () => {
    const { ids } = await drawnTeam();
    const { api } = await signedInApi(idp, "admin");
    const now = Date.now();
    // No answer: the call fails.
    const failed = await proposed([], now);
    const listed = await ticketsOf(api, ids);
    const tooSoon = await proposed([proposing({ form: "skill" })], now + 1000);
    const later = await proposed(
      [proposing({ form: "skill", systems: [] })],
      now + pastFirstRetryMs
    );
    const after = await ticketsOf(api, ids);
    expect({
      failed: failed.asked,
      listed: { form: listed.tickets?.form, calls: listed.asked },
      tooSoon: tooSoon.calls,
      later: later.asked,
      form: after.tickets?.form,
    }).toStrictEqual({
      failed: 1,
      listed: { form: null, calls: 0 },
      tooSoon: 0,
      later: 1,
      form: "skill",
    });
  });

  it("ask a proposal given up again once an admin lists, by the alarm and not the list", async () => {
    const { ids } = await drawnTeam();
    const { api } = await signedInApi(idp, "admin");
    // The model fails through every retry: a minute, five and thirty.
    let tried = Date.now();
    for (const wait of [0, 61_000, 301_000, 1_801_000]) {
      tried += wait;
      // oxlint-disable-next-line no-await-in-loop -- one try after another
      await proposed([], tried);
    }
    const givenUp = await proposed(
      [proposing({ form: "skill", systems: [] })],
      tried + 24 * 60 * 60 * 1000
    );
    const listed = await listedThenAlarmed(api, ids, [
      proposing({ form: "skill", systems: [] }),
    ]);
    expect({ givenUp: givenUp.calls, listed }).toStrictEqual({
      givenUp: 0,
      listed: { alarmed: true, asked: 1, form: "skill" },
    });
  });

  it("ask a routine never proposed once an admin lists, when nothing else wakes the store", async () => {
    const { ids } = await drawnTeam();
    const { api } = await signedInApi(idp, "admin");
    // Noted while the store's alarm was held: never asked, and no row of
    // asking it, no alarm set.
    const listed = await listedThenAlarmed(api, ids, [
      proposing({ form: "workflow", systems: [] }),
    ]);
    expect(listed).toStrictEqual({
      alarmed: true,
      asked: 1,
      form: "workflow",
    });
  });

  it("wait a failed proposal's back-off from when its call failed, not from when it began", async () => {
    const { ids } = await drawnTeam();
    const { api } = await signedInApi(idp, "admin");
    const start = Date.now();
    // The model holds the call three minutes, then fails it.
    const failedAt = start + 3 * 60_000;
    try {
      await answeringWith(
        () => {
          vi.useFakeTimers({ toFake: ["Date"], now: failedAt });
        },
        async () => await onboardingStore(env).proposeNext(start)
      );
    } finally {
      vi.useRealTimers();
    }
    const soon = await proposed(
      [proposing({ form: "skill", systems: [] })],
      failedAt + 30_000
    );
    const later = await proposed(
      [proposing({ form: "skill", systems: [] })],
      failedAt + pastFirstRetryMs
    );
    const { tickets } = await ticketsOf(api, ids);
    expect({
      soon: soon.calls,
      later: later.calls,
      form: tickets?.form,
    }).toStrictEqual({ soon: 0, later: 1, form: "skill" });
  });

  it("neither ask a proposal twice at once nor lose it when the store stops mid-call", async () => {
    const { ids } = await drawnTeam();
    const { api } = await signedInApi(idp, "admin");
    const store = onboardingStore(env);
    const gate = Promise.withResolvers<boolean>();
    const reached = Promise.withResolvers<boolean>();
    // The model is asked and holds its answer; the store stops meanwhile.
    const held = answeringWith(
      async () => {
        reached.resolve(true);
        await gate.promise;
        return proposing({ form: "workflow", systems: [] });
      },
      async () => await store.proposeNext()
    ).catch(() => "stopped");
    await reached.promise;
    await runInDurableObject(store, (_instance, state) => {
      state.abort("Stopped by the test");
    }).catch(() => {
      // Aborting fails the call that aborted: that is the stop.
    });
    gate.resolve(true);
    await held;
    // Started again: still claimed, so nothing is asked now.
    const again = await proposed([proposing({ form: "app", systems: [] })]);
    // Past the claim, it is asked, and kept.
    const later = await proposed(
      [proposing({ form: "app", systems: [] })],
      Date.now() + proposeClaimPastMs
    );
    const { tickets } = await ticketsOf(api, ids);
    expect({
      again: again.calls,
      later: later.calls,
      form: tickets?.form,
    }).toStrictEqual({ again: 0, later: 1, form: "app" });
  });

  it("ask which routines are owed a proposal in one bound value, however many there are", async () => {
    const sources = Array.from({ length: 150 }, () => crypto.randomUUID());
    const bound: number[] = [];
    const db = new Proxy(env.DB, {
      get: (target, name): unknown => {
        const member: unknown = Reflect.get(target, name);
        if (name !== "prepare" || typeof member !== "function") {
          return typeof member === "function" ? member.bind(target) : member;
        }
        return (query: string) => {
          const statement = target.prepare(query);
          return new Proxy(statement, {
            get: (inner, key): unknown => {
              const value: unknown = Reflect.get(inner, key);
              if (key === "bind" && typeof value === "function") {
                return (...values: unknown[]) => {
                  bound.push(values.length);
                  return inner.bind(...values);
                };
              }
              return typeof value === "function" ? value.bind(inner) : value;
            },
          });
        };
      },
    });
    const owed = await proposerOf({ ...env, DB: db }).owed(sources);
    expect({ owed: owed.length, mostBound: Math.max(...bound) }).toStrictEqual({
      owed: 150,
      mostBound: 1,
    });
  });

  it("point a routine an existing App covers at that App, as a change to it", async () => {
    const { ids } = await drawnTeam();
    const { api } = await signedInApi(idp, "admin");
    const { id: app } = await api.apps.create({ name: "Ticket desk" });
    await proposed([
      proposing({ form: "app", covers: app, systems: [], personApproves: [] }),
    ]);
    const { tickets } = await ticketsOf(api, ids);
    expect({ form: tickets?.form, covers: tickets?.covers }).toStrictEqual({
      form: "change",
      covers: { app, name: "Ticket desk" },
    });
  });

  it("hide a dismissed opportunity from every admin until its evidence changes", async () => {
    const { ids, sam } = await drawnTeam();
    const { api } = await signedInApi(idp, "admin");
    const other = await signedInApi(idp, "admin");
    const { tickets } = await ticketsOf(api, ids);
    if (tickets === undefined) {
      throw new Error("The tickets were never listed.");
    }
    await api.opportunities.dismiss({
      routine: tickets.routine,
      evidence: tickets.evidence,
    });
    const dismissed = await ticketsOf(other.api, ids);
    // Sam adds to his interview, and the tickets are drawn anew, their
    // last step told otherwise: new evidence.
    await agree(
      ids.sam,
      [
        fact("s1", "step", "Answers the phone."),
        fact("s2", "step", "Closes the ticket once answered."),
      ],
      sam
    );
    await drawTickets(ids, "Close the ticket once answered.");
    const redrawn = await ticketsOf(api, ids);
    expect({
      dismissed: dismissed.tickets,
      back: redrawn.tickets !== undefined,
      newEvidence: redrawn.tickets?.evidence !== tickets.evidence,
    }).toStrictEqual({ dismissed: undefined, back: true, newEvidence: true });
  });

  it("drop a routine's opportunity as a withdrawal takes its drawing down, and keep nothing of it once the drawing is erased", async () => {
    const { ids } = await drawnTeam();
    const { api } = await signedInApi(idp, "admin");
    await proposed([proposing({ form: "workflow", systems: ["Zendesk"] })]);
    const { tickets } = await ticketsOf(api, ids);
    if (tickets === undefined) {
      throw new Error("The tickets were never listed.");
    }
    await onLink({ action: "withdraw", ...(await openLink(ids.pim)) });
    const withdrawn = await ticketsOf(api, ids);
    await eraseOwedOnboardingSources(env);
    expect({
      withdrawn: withdrawn.tickets,
      kept: await keptAt(tickets.evidence),
    }).toStrictEqual({ withdrawn: undefined, kept: 0 });
  });

  it("keep no proposal for a drawing a withdrawal took down while the model answered", async () => {
    const { ids } = await drawnTeam();
    const before = await onboardingStore(env).standingDrawings();
    const drawing = before.find(({ team: of }) => of === ids.team);
    let withdrew = false;
    await answeringWith(
      async () => {
        // Pim withdraws while the model answers, and the drawing's erasure
        // runs before the answer is kept.
        if (!withdrew) {
          withdrew = true;
          await onLink({ action: "withdraw", ...(await openLink(ids.pim)) });
          await eraseOwedOnboardingSources(env);
        }
        return proposing({ form: "workflow", systems: ["Zendesk"] });
      },
      async () => await onboardingStore(env).proposeNext()
    );
    expect({
      withdrew,
      kept: await keptAt(drawing?.source ?? ""),
    }).toStrictEqual({ withdrew: true, kept: 0 });
  });

  it("erase a proposal written for a drawing that fell while the model answered, though the store stopped right after the write", async () => {
    const { ids } = await drawnTeam();
    const store = onboardingStore(env);
    const standing = await store.standingDrawings();
    const evidence =
      standing.find(({ team: of }) => of === ids.team)?.source ?? "";
    let stop: DurableObjectState | undefined;
    await runInDurableObject(store, (_instance, state) => {
      stop = state;
    });
    // D1's statements as every Worker of this isolate prepares them, the
    // store's included (as d1-calls.ts wraps them).
    const database = Reflect.getPrototypeOf(env.DB);
    const prepare: unknown =
      database === null ? undefined : Reflect.get(database, "prepare");
    if (database === null || typeof prepare !== "function") {
      throw new Error("Expected D1's class in the env");
    }
    try {
      await answeringWith(
        async () => {
          // Pim withdraws while the model answers, and the drawing's
          // erasure runs before the answer is written; then the store
          // stops as it goes to erase what it wrote.
          await onLink({ action: "withdraw", ...(await openLink(ids.pim)) });
          await eraseOwedOnboardingSources(env);
          Reflect.set(
            database,
            "prepare",
            function stopped(this: unknown, ...args: unknown[]): unknown {
              const [query] = args;
              if (
                typeof query === "string" &&
                query.startsWith('delete from "opportunity_proposals"')
              ) {
                stop?.abort("Stopped by the test after the write");
                throw new Error("Stopped by the test after the write");
              }
              const statement: unknown = Reflect.apply(prepare, this, args);
              return statement;
            }
          );
          return proposing({ form: "workflow", systems: ["Zendesk"] });
        },
        async () => await store.proposeNext()
      ).catch(() => "stopped");
    } finally {
      Reflect.set(database, "prepare", prepare);
    }
    const written = await keptAt(evidence);
    // Started again, once the call's claim runs out: erased, no model asked.
    const swept = await proposed([], Date.now() + proposeClaimPastMs);
    expect({
      written,
      swept: swept.calls,
      kept: await keptAt(evidence),
    }).toStrictEqual({ written: 1, swept: 0, kept: 0 });
  });

  it("ask no setup for a system a connection for everyone covers, as the catalog describes it", async () => {
    const { ids } = await drawnTeam(
      "Send the answer by Gmail or Outlook, with the file from Google Drive, OneDrive or SharePoint."
    );
    const admin = await signedInApi(idp, "admin");
    await proposed([
      proposing({
        form: "workflow",
        systems: [
          "Gmail",
          "Google Drive",
          "Outlook",
          "OneDrive",
          "SharePoint",
          "Zendesk",
        ],
      }),
    ]);
    const before = await ticketsOf(admin.api, ids);
    await connectedForEveryone(admin, "google", `team-${crypto.randomUUID()}`);
    const google = await ticketsOf(admin.api, ids);
    await connectedForEveryone(
      admin,
      "microsoft",
      `team-${crypto.randomUUID()}`
    );
    const both = await ticketsOf(admin.api, ids);
    expect({
      before: before.tickets?.setup,
      google: google.tickets?.setup,
      both: both.tickets?.setup,
    }).toStrictEqual({
      before: [
        "Gmail",
        "Google Drive",
        "Outlook",
        "OneDrive",
        "SharePoint",
        "Zendesk",
      ],
      google: ["Outlook", "OneDrive", "SharePoint", "Zendesk"],
      both: ["Zendesk"],
    });
  });

  it("refuse anyone but an admin, listing or dismissing", async () => {
    const { api } = await signedInApi(idp, "user");
    expect({
      list: await outcome(api.opportunities.list()),
      dismiss: await outcome(
        api.opportunities.dismiss({ routine: "a", evidence: "b" })
      ),
    }).toStrictEqual({
      list: "role.forbidden",
      dismiss: "role.forbidden",
    });
  });
});
