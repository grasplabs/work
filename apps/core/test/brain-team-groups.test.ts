import type { RosterInput } from "@grasp-os/shared/onboarding";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { brainTeams } from "../src/brain-rpc.ts";
import { arrangeTeams } from "../src/brain-team-groups.ts";
import { onboardingStore } from "../src/onboarding/store.ts";
import { mockIdp } from "./idp.ts";
import { aloneInTheStore, answering, holdAlarm } from "./interview-link.ts";
import { teamsMade } from "./members-teams.ts";
import { arrangementCalls, arrangementReplies } from "./model-provider.ts";
import type { ProviderReply } from "./model-provider.ts";
import { auditedDuring, outcome, signedInApi, unique } from "./sign-in.ts";

// The company's own groups of teams, the brain's regions (core's
// brain-team-groups.ts). What can go wrong, tried here: someone who isn't
// an admin regrouping the company; a group naming a team the brain
// doesn't have, or one team in two groups; a change kept without its
// audit event, or an earlier set lost to it. And as Grasp arranges the
// teams in no region by itself (GRA-1993): a team an admin placed moved;
// more regions than the map's four lobes; the model given more than the
// teams' names, or trusted when it invents a team; the staff list's save
// held up or failed by the model, or a read asking it; a failure that
// is never tried again, or tried forever.

const idp = mockIdp();

/** A staff list with three teams, under ids no other test uses. */
const rosterOf = (tag: string): RosterInput => ({
  teams: [
    { id: `finance-${tag}`, name: "Finance", lead: null },
    { id: `sales-${tag}`, name: "Sales", lead: null },
    { id: `support-${tag}`, name: "Support", lead: null },
  ],
  people: [
    {
      id: `ann-${tag}`,
      name: "Ann Example",
      team: `finance-${tag}`,
      title: "Accountant",
    },
  ],
});

/** A staff list with a team for each of `names`, under ids no other test uses. */
const sixTeams = (tag: string, names: readonly string[]): RosterInput => ({
  teams: names.map((name) => ({
    id: `${name.toLowerCase()}-${tag}`,
    name,
    lead: null,
  })),
  people: [
    {
      id: `ann-${tag}`,
      name: "Ann Example",
      team: `finance-${tag}`,
      title: "Accountant",
    },
  ],
});

/** The model's arrangement `answer`, as JSON. */
const arranging = (answer: unknown): ProviderReply => ({
  text: JSON.stringify(answer),
  inputTokens: 40,
  outputTokens: 20,
});

/** A minute, the first wait before arranging is tried again. */
const minute = 60_000;

/** A reply to the arrangement, or a call made as its request comes (model-provider.ts). */
type Arranging = ProviderReply | (() => Promise<ProviderReply>);

/** No answer: refused, as a provider that failed. */
const refused: ProviderReply = {
  status: 500,
  body: { error: "Refused by the test" },
};

/**
 * What `run` returns while the organization's provider answers Grasp's
 * arrangements with `replies` (`arrangementReplies`, apart from any other
 * call's script; then arranging nothing), and what each arrangement sent
 * the model meanwhile.
 */
const arrangingWith = async <T>(
  replies: Arranging[],
  run: () => Promise<T>
) => {
  arrangementReplies.length = 0;
  arrangementReplies.push(...replies);
  const from = arrangementCalls.length;
  try {
    const { result } = await answering([], run);
    return { result, requests: arrangementCalls.slice(from) };
  } finally {
    arrangementReplies.length = 0;
  }
};

/**
 * `save` (of the staff list), with no alarm set before it, and then the
 * onboarding store's own alarm, as the save set it, while the model
 * answers `replies`; then the alarm is held again. Whether the save set
 * it, and the requests the model got.
 */
const alarmed = async (replies: Arranging[], save: () => Promise<unknown>) => {
  const store = onboardingStore(env);
  await runInDurableObject(store, async (instance, state) => {
    await state.storage.deleteAlarm();
    // The fixture holds the alarm with a spy on it: taken off, so the
    // store's own alarm runs.
    vi.spyOn(instance, "alarm").mockRestore();
  });
  try {
    const { requests, result } = await arrangingWith(replies, async () => {
      await save();
      return await runDurableObjectAlarm(store);
    });
    return { ran: result, requests };
  } finally {
    await holdAlarm();
  }
};

/** Arranging the Brain's teams as the store notes it owed, or null. */
const regionsRow = async () =>
  await runInDurableObject(onboardingStore(env), (_instance, state) => {
    const [row] = state.storage.sql
      .exec<{ tries: number; after: string }>(
        "SELECT tries, after FROM draw_failures WHERE item = 'regions'"
      )
      .toArray();
    return row ?? null;
  });

/** How many times the groups were kept (`brain_team_group_saves`). */
const keptSets = async (): Promise<number> => {
  const row = await env.DB.prepare(
    "SELECT count(*) AS saves FROM brain_team_group_saves"
  ).first<{ saves: number }>();
  return row?.saves ?? 0;
};

describe("the company's groups of teams", { timeout: 120_000 }, () => {
  beforeEach(aloneInTheStore);

  it("are confirmed by an admin, read by every member and audited", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    const tag = unique();
    await admin.api.onboarding.confirmRoster(await teamsMade(rosterOf(tag)));

    let saved: unknown;
    const events = await auditedDuring(async () => {
      saved = await admin.api.brain.saveTeamGroups([
        {
          id: "front",
          name: "Front office",
          teamIds: [`sales-${tag}`, `support-${tag}`],
        },
        { id: "back", name: "Back office", teamIds: [`finance-${tag}`] },
      ]);
    });
    const { teamGroups } = await admin.api.brain.read();
    const forMember = await member.api.brain.read();

    expect({
      saved,
      read: teamGroups,
      events: events
        .filter(({ action }) => action === "brain.team_groups.saved")
        .map(({ actor, provenance, detail }) => ({
          actor: actor.type,
          provenance,
          // The save that keeps the groups before and after, by its id.
          detail: {
            ...detail,
            before: typeof detail?.before,
            save: typeof detail?.save,
          },
        })),
      // A member reads the groups as they read the teams: the confirmed
      // roster's teams are every member's (GRA-1748), so its groups are too.
      member: forMember.teamGroups,
    }).toStrictEqual({
      saved: [
        {
          id: "front",
          name: "Front office",
          teamIds: [`sales-${tag}`, `support-${tag}`],
          confirmed: true,
        },
        {
          id: "back",
          name: "Back office",
          teamIds: [`finance-${tag}`],
          confirmed: true,
        },
      ],
      read: saved,
      events: [
        {
          actor: "person",
          provenance: ["front", "back"],
          detail: { groups: 2, before: "number", save: "string" },
        },
      ],
      member: saved,
    });
  });

  it("keep each confirmed set whole, before and after, so an earlier one can be put back", async () => {
    const admin = await signedInApi(idp, "admin");
    const tag = unique();
    await admin.api.onboarding.saveRoster(await teamsMade(rosterOf(tag)));
    const finance = `finance-${tag}`;
    const sales = `sales-${tag}`;
    const support = `support-${tag}`;
    const first = [
      { id: "front", name: "Front office", teamIds: [sales, support] },
      { id: "back", name: "Back office", teamIds: [finance] },
    ];
    await admin.api.brain.saveTeamGroups(first);
    const events = await auditedDuring(async () => {
      await admin.api.brain.saveTeamGroups([
        { id: "all", name: "Everyone", teamIds: [finance, sales, support] },
      ]);
    });
    const saved = events.find(
      ({ action }) => action === "brain.team_groups.saved"
    );
    const kept = await env.DB.prepare(
      "SELECT before, after FROM brain_team_group_saves WHERE id = ?"
    )
      .bind(saved?.detail?.save ?? "")
      .first<{ before: string; after: string }>();

    expect(kept).toStrictEqual({
      before: JSON.stringify(
        first.map((group) => ({ ...group, confirmed: true }))
      ),
      after: JSON.stringify([
        {
          id: "all",
          name: "Everyone",
          teamIds: [finance, sales, support],
          confirmed: true,
        },
      ]),
    });
  });

  it("are refused to anyone but an admin, and when they don't group the brain's teams", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    const tag = unique();
    await admin.api.onboarding.saveRoster(await teamsMade(rosterOf(tag)));
    const finance = `finance-${tag}`;
    await admin.api.brain.saveTeamGroups([
      { id: "kept", name: "Kept", teamIds: [finance] },
    ]);

    const outcomes = {
      member: await outcome(
        member.api.brain.saveTeamGroups([
          { id: "mine", name: "Mine", teamIds: [finance] },
        ])
      ),
      unknownTeam: await outcome(
        admin.api.brain.saveTeamGroups([
          { id: "ghost", name: "Ghosts", teamIds: [`ghost-${tag}`] },
        ])
      ),
      twice: await outcome(
        admin.api.brain.saveTeamGroups([
          { id: "one", name: "One", teamIds: [finance] },
          { id: "two", name: "Two", teamIds: [finance] },
        ])
      ),
      empty: await outcome(
        admin.api.brain.saveTeamGroups([
          { id: "none", name: "None", teamIds: [] },
        ])
      ),
    };
    const { teamGroups } = await admin.api.brain.read();

    expect({ outcomes, kept: teamGroups.map(({ id }) => id) }).toStrictEqual({
      outcomes: {
        member: "role.forbidden",
        unknownTeam: "brain.team_groups_invalid",
        twice: "brain.team_groups_invalid",
        empty: "brain.team_groups_invalid",
      },
      kept: ["kept"],
    });
  });

  it("are arranged by Grasp, from the onboarding's alarm after the staff list is saved, into at most four regions that count at once, audited once without a name", async () => {
    const admin = await signedInApi(idp, "admin");
    const tag = unique();
    const names = ["Finance", "Sales", "Support", "Legal", "People", "Data"];
    const roster = sixTeams(tag, names);
    const id = (name: string) => `${name.toLowerCase()}-${tag}`;
    // The model makes a region of every team, and invents one.
    const answer = {
      groups: [
        ...names.map((name) => ({ name: `${name} dept`, teamIds: [id(name)] })),
        { name: "Ghosts", teamIds: [`ghost-${tag}`] },
      ],
    };

    // Three regions of a staff list before, whose teams are all gone: they
    // take none of the map's four lobes.
    const old = unique();
    await admin.api.onboarding.saveRoster(await teamsMade(rosterOf(old)));
    const gone = ["finance", "sales", "support"].map((team, index) => ({
      id: `gone-${index}-${tag}`,
      name: `Gone ${index}`,
      teamIds: [`${team}-${old}`],
    }));
    await admin.api.brain.saveTeamGroups(gone);
    let ran = false;
    let requests: readonly unknown[] = [];
    const events = await auditedDuring(async () => {
      ({ ran, requests } = await alarmed(
        [arranging(answer)],
        async () =>
          await admin.api.onboarding.saveRoster(await teamsMade(roster))
      ));
    });
    const { teamGroups } = await admin.api.brain.read();
    const sent = JSON.stringify(requests);
    const arranged = events.filter(
      ({ action }) => action === "brain.team_groups.arranged"
    );

    expect({
      ran,
      asked: requests.length,
      sentNames: names.every((name) => sent.includes(name)),
      // Nothing about the teams but their names: not who is in them.
      sentPeople: sent.includes("Ann Example"),
      regions: teamGroups.map(({ name, teamIds, confirmed }) => ({
        name,
        teamIds,
        confirmed,
      })),
      audited: arranged.map(({ actor, provenance, detail }) => ({
        actor: actor.type,
        provenance,
        detail: { ...detail, save: typeof detail?.save },
      })),
      namesAudited: names.some((name) =>
        JSON.stringify(arranged).includes(name)
      ),
    }).toStrictEqual({
      ran: true,
      asked: 1,
      sentNames: true,
      sentPeople: false,
      regions: names.slice(0, 4).map((name) => ({
        name: `${name} dept`,
        teamIds: [id(name)],
        confirmed: true,
      })),
      audited: [
        {
          actor: "system",
          provenance: [...gone, ...teamGroups].map((group) => group.id),
          detail: { arranged: 4, groups: 7, before: 3, save: "string" },
        },
      ],
      namesAudited: false,
    });
  });

  it("never move a team an admin placed, and join a region by its name", async () => {
    const admin = await signedInApi(idp, "admin");
    const tag = unique();
    await admin.api.onboarding.saveRoster(await teamsMade(rosterOf(tag)));
    const finance = `finance-${tag}`;
    const sales = `sales-${tag}`;
    const support = `support-${tag}`;
    await admin.api.brain.saveTeamGroups([
      { id: "money", name: "Money matters", teamIds: [finance] },
    ]);

    // The model would move Finance out, and puts Sales in the admin's region.
    const { requests } = await alarmed(
      [
        arranging({
          groups: [
            { name: "money MATTERS", teamIds: [sales] },
            { name: "Customers", teamIds: [support, finance] },
          ],
        }),
      ],
      async () =>
        await admin.api.onboarding.saveRoster(await teamsMade(rosterOf(tag)))
    );
    const { teamGroups } = await admin.api.brain.read();

    expect({
      asked: requests.length,
      regions: teamGroups.map(({ id, name, teamIds }) => ({
        id,
        name,
        teamIds,
      })),
    }).toStrictEqual({
      asked: 1,
      regions: [
        { id: "money", name: "Money matters", teamIds: [finance, sales] },
        { id: "group-customers", name: "Customers", teamIds: [support] },
      ],
    });
  });

  it("keep a team an admin took out of every region out: the next staff list asks no model for it", async () => {
    const admin = await signedInApi(idp, "admin");
    const tag = unique();
    const finance = `finance-${tag}`;
    const sales = `sales-${tag}`;
    const support = `support-${tag}`;
    await alarmed(
      [
        arranging({
          groups: [{ name: "Everyone", teamIds: [finance, sales, support] }],
        }),
      ],
      async () =>
        await admin.api.onboarding.saveRoster(await teamsMade(rosterOf(tag)))
    );
    const arranged = await admin.api.brain.read();
    const everyone = arranged.teamGroups.find(({ teamIds }) =>
      teamIds.includes(finance)
    );
    // The admin sets Finance to "No group".
    await admin.api.brain.saveTeamGroups([
      { id: everyone?.id ?? "", name: "Everyone", teamIds: [sales, support] },
    ]);

    const { ran, requests } = await alarmed(
      [arranging({ groups: [{ name: "Money", teamIds: [finance] }] })],
      async () =>
        await admin.api.onboarding.saveRoster(await teamsMade(rosterOf(tag)))
    );
    const { teamGroups } = await admin.api.brain.read();

    expect({
      ran,
      asked: requests.length,
      regions: teamGroups.map(({ name, teamIds }) => ({ name, teamIds })),
    }).toStrictEqual({
      ran: true,
      asked: 0,
      regions: [{ name: "Everyone", teamIds: [sales, support] }],
    });
  });

  it("leave the teams in no region when no model answers, and are tried again after a minute, five and thirty, then given up until the staff list is saved again", async () => {
    const admin = await signedInApi(idp, "admin");
    const tag = unique();
    const store = onboardingStore(env);
    const failed = await alarmed(
      [refused],
      async () =>
        await admin.api.onboarding.saveRoster(await teamsMade(rosterOf(tag)))
    );
    const afterFailure = await admin.api.brain.read();
    const owed = await regionsRow();
    const alarmAt = await runInDurableObject(
      store,
      async (_instance, state) => await state.storage.getAlarm()
    );
    const start = Date.now();
    // Not before its minute; then again after five minutes and thirty.
    const tooSoon = await arrangingWith(
      [],
      async () => await store.arrangeNext(start + 1000)
    );
    const tries = await arrangingWith([refused, refused, refused], async () => [
      await store.arrangeNext(start + minute + 1000),
      await store.arrangeNext(start + 7 * minute),
      await store.arrangeNext(start + 40 * minute),
    ]);
    const givenUp = {
      row: await regionsRow(),
      later: await store.arrangeNext(start + 24 * 60 * minute),
    };
    // A new save owes it again, and the model answers now.
    await alarmed(
      [
        arranging({
          groups: [
            {
              name: "Everyone",
              teamIds: ["finance", "sales", "support"].map(
                (name) => `${name}-${tag}`
              ),
            },
          ],
        }),
      ],
      async () =>
        await admin.api.onboarding.saveRoster(await teamsMade(rosterOf(tag)))
    );
    const { teamGroups } = await admin.api.brain.read();

    expect({
      failedCalls: failed.requests.length,
      placed: afterFailure.teamGroups.flatMap(({ teamIds }) =>
        teamIds.filter((teamId) => teamId.endsWith(tag))
      ),
      owed: owed?.tries,
      retryInAMinute:
        owed !== null &&
        Math.abs(Date.parse(owed.after) - start - minute) < 30_000,
      alarmByThen:
        alarmAt !== null &&
        owed !== null &&
        alarmAt <= Date.parse(owed.after) + 1000,
      tooSoon: { asked: tooSoon.result, calls: tooSoon.requests.length },
      tries: { asked: tries.result, calls: tries.requests.length },
      givenUp,
      arranged: teamGroups
        .filter(({ name }) => name === "Everyone")
        .map(({ teamIds }) => teamIds.length),
    }).toStrictEqual({
      failedCalls: 1,
      placed: [],
      owed: 1,
      retryInAMinute: true,
      alarmByThen: true,
      tooSoon: { asked: false, calls: 0 },
      tries: { asked: [true, true, true], calls: 3 },
      givenUp: { row: null, later: false },
      arranged: [3],
    });
  });

  it("keep what an admin saves while the model answers, a team taken out included, and are owed again by a staff list saved meanwhile", async () => {
    const admin = await signedInApi(idp, "admin");
    const tag = unique();
    const finance = `finance-${tag}`;
    const sales = `sales-${tag}`;
    const support = `support-${tag}`;
    await admin.api.onboarding.saveRoster(await teamsMade(rosterOf(tag)));
    const store = onboardingStore(env);

    const { requests } = await arrangingWith(
      [
        async () => {
          // While the model answers: the admin places Sales and Finance,
          // takes Finance out again, and saves the staff list again.
          await admin.api.brain.saveTeamGroups([
            { id: "front", name: "Front office", teamIds: [sales, finance] },
          ]);
          await admin.api.brain.saveTeamGroups([
            { id: "front", name: "Front office", teamIds: [sales] },
          ]);
          await admin.api.onboarding.saveRoster(await teamsMade(rosterOf(tag)));
          return arranging({
            groups: [{ name: "Everyone", teamIds: [finance, sales, support] }],
          });
        },
      ],
      async () => await store.arrangeNext()
    );
    const { teamGroups } = await admin.api.brain.read();
    const owed = await regionsRow();

    expect({
      asked: requests.length,
      regions: teamGroups.map(({ id, teamIds }) => ({ id, teamIds })),
      owed: owed?.tries,
    }).toStrictEqual({
      asked: 1,
      regions: [
        { id: "front", teamIds: [sales] },
        { id: "group-everyone", teamIds: [support] },
      ],
      owed: 0,
    });
  });

  it("keep nothing of an arrangement when an admin saves between its last read and its write, and audit none", async () => {
    const admin = await signedInApi(idp, "admin");
    const tag = unique();
    const finance = `finance-${tag}`;
    const sales = `sales-${tag}`;
    const support = `support-${tag}`;
    await admin.api.onboarding.saveRoster(await teamsMade(rosterOf(tag)));
    // A fault at the database binding: once the arrangement prepares its
    // write (the statement that keeps the set of groups, seen through
    // D1's public `prepare`), an admin's save is made through the real
    // RPC, and only then does the arrangement's batch run. The model
    // gateway's own batches never prepare that statement.
    const writesSaves = /insert into "?brain_team_group_saves"?/iu;
    let writing = false;
    let injected = 0;
    const db = new Proxy(env.DB, {
      get: (target, key) => {
        if (key === "prepare") {
          return (query: string) => {
            writing ||= writesSaves.test(query);
            return target.prepare(query);
          };
        }
        if (key === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            if (writing && injected === 0) {
              injected += 1;
              await admin.api.brain.saveTeamGroups([
                { id: "front", name: "Front office", teamIds: [sales] },
              ]);
            }
            return await target.batch(statements);
          };
        }
        const value: unknown = Reflect.get(target, key, target);
        if (typeof value !== "function") {
          return value;
        }
        return (...args: unknown[]): unknown => {
          const result: unknown = Reflect.apply(value, target, args);
          return result;
        };
      },
    });
    const faulty: Env = { ...env, DB: db };
    const savesBefore = await keptSets();

    let refusal = "";
    const events = await auditedDuring(async () => {
      await arrangingWith(
        [
          arranging({
            groups: [{ name: "Everyone", teamIds: [finance, sales, support] }],
          }),
        ],
        async () => {
          try {
            await arrangeTeams(faulty, async () => await brainTeams(env));
          } catch (error) {
            refusal = error instanceof Error ? error.message : String(error);
          }
        }
      );
    });
    const { teamGroups } = await admin.api.brain.read();
    const savesAfter = await keptSets();

    expect({
      injected,
      // Thrown, so the onboarding's alarm keeps it owed and tries again.
      refusal,
      regions: teamGroups.map(({ id, teamIds }) => ({ id, teamIds })),
      saves: savesAfter - savesBefore,
      arranged: events.filter(
        ({ action }) => action === "brain.team_groups.arranged"
      ).length,
      saved: events.filter(({ action }) => action === "brain.team_groups.saved")
        .length,
    }).toStrictEqual({
      injected: 1,
      refusal: "The regions changed while Grasp arranged the teams.",
      regions: [{ id: "front", teamIds: [sales] }],
      saves: 1,
      arranged: 0,
      saved: 1,
    });
  });

  it("are never arranged in a request: saving the staff list and reading the brain ask no model", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    const tag = unique();

    const { requests, result } = await arrangingWith([], async () => {
      await admin.api.onboarding.saveRoster(await teamsMade(rosterOf(tag)));
      return [await admin.api.brain.read(), await member.api.brain.read()];
    });
    const owed = await regionsRow();

    expect({
      asked: requests.length,
      placed: result.flatMap(({ teamGroups }) =>
        teamGroups.flatMap(({ teamIds }) =>
          teamIds.filter((teamId) => teamId.endsWith(tag))
        )
      ),
      owed: owed?.tries,
    }).toStrictEqual({ asked: 0, placed: [], owed: 0 });
  });
});
