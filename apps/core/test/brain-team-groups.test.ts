import type { RosterInput } from "@grasp-os/shared/onboarding";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { onboardingStore } from "../src/onboarding/store.ts";
import { mockIdp } from "./idp.ts";
import {
  aloneInTheStore,
  answering,
  answeringWith,
  holdAlarm,
} from "./interview-link.ts";
import type { ProviderReply, SentRequest } from "./model-provider.ts";
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

/**
 * `save` (of the staff list), with no alarm set before it, and then the
 * onboarding store's own alarm, as the save set it, while the model
 * answers `replies`; then the alarm is held again. Whether the save set
 * it, and the requests the model got.
 */
const alarmed = async (
  replies: ProviderReply[],
  save: () => Promise<unknown>
) => {
  const store = onboardingStore(env);
  await runInDurableObject(store, async (instance, state) => {
    await state.storage.deleteAlarm();
    // The fixture holds the alarm with a spy on it: taken off, so the
    // store's own alarm runs.
    vi.spyOn(instance, "alarm").mockRestore();
  });
  try {
    const { requests, result } = await answering(replies, async () => {
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

describe("the company's groups of teams", { timeout: 120_000 }, () => {
  beforeEach(aloneInTheStore);

  it("are confirmed by an admin, read by every member and audited", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    const tag = unique();
    await admin.api.onboarding.confirmRoster(rosterOf(tag));

    let saved: unknown;
    const events = await auditedDuring(async () => {
      saved = await admin.api.brain.saveTeamGroups([
        {
          id: "front",
          name: "Front office",
          teamIds: [`team-sales-${tag}`, `team-support-${tag}`],
        },
        { id: "back", name: "Back office", teamIds: [`team-finance-${tag}`] },
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
          teamIds: [`team-sales-${tag}`, `team-support-${tag}`],
          confirmed: true,
        },
        {
          id: "back",
          name: "Back office",
          teamIds: [`team-finance-${tag}`],
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
    await admin.api.onboarding.saveRoster(rosterOf(tag));
    const finance = `team-finance-${tag}`;
    const sales = `team-sales-${tag}`;
    const support = `team-support-${tag}`;
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
    await admin.api.onboarding.saveRoster(rosterOf(tag));
    const finance = `team-finance-${tag}`;
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
          { id: "ghost", name: "Ghosts", teamIds: [`team-ghost-${tag}`] },
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
    const id = (name: string) => `team-${name.toLowerCase()}-${tag}`;
    // The model makes a region of every team, and invents one.
    const answer = {
      groups: [
        ...names.map((name) => ({ name: `${name} dept`, teamIds: [id(name)] })),
        { name: "Ghosts", teamIds: [`team-ghost-${tag}`] },
      ],
    };

    await admin.api.brain.saveTeamGroups([]);
    let ran = false;
    let requests: readonly SentRequest[] = [];
    const events = await auditedDuring(async () => {
      ({ ran, requests } = await alarmed(
        [arranging(answer)],
        async () => await admin.api.onboarding.saveRoster(roster)
      ));
    });
    const { teamGroups } = await admin.api.brain.read();
    const sent = JSON.stringify(requests.map(({ body }) => body));
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
          provenance: teamGroups.map((group) => group.id),
          detail: { arranged: 4, groups: 4, before: 0, save: "string" },
        },
      ],
      namesAudited: false,
    });
  });

  it("never move a team an admin placed, and join a region by its name", async () => {
    const admin = await signedInApi(idp, "admin");
    const tag = unique();
    await admin.api.onboarding.saveRoster(rosterOf(tag));
    const finance = `team-finance-${tag}`;
    const sales = `team-sales-${tag}`;
    const support = `team-support-${tag}`;
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
      async () => await admin.api.onboarding.saveRoster(rosterOf(tag))
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

  it("leave the teams in no region when no model answers, and are tried again after a minute, five and thirty, then given up until the staff list is saved again", async () => {
    const admin = await signedInApi(idp, "admin");
    const tag = unique();
    const store = onboardingStore(env);
    const failed = await alarmed(
      [],
      async () => await admin.api.onboarding.saveRoster(rosterOf(tag))
    );
    const afterFailure = await admin.api.brain.read();
    const owed = await regionsRow();
    const alarmAt = await runInDurableObject(
      store,
      async (_instance, state) => await state.storage.getAlarm()
    );
    const start = Date.now();
    // Not before its minute; then again after five minutes and thirty.
    const tooSoon = await answering(
      [],
      async () => await store.arrangeNext(start + 1000)
    );
    const tries = await answering([], async () => [
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
                (name) => `team-${name}-${tag}`
              ),
            },
          ],
        }),
      ],
      async () => await admin.api.onboarding.saveRoster(rosterOf(tag))
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

  it("keep what an admin saves while the model answers, and are owed again by a staff list saved meanwhile", async () => {
    const admin = await signedInApi(idp, "admin");
    const tag = unique();
    const finance = `team-finance-${tag}`;
    const sales = `team-sales-${tag}`;
    const support = `team-support-${tag}`;
    await admin.api.onboarding.saveRoster(rosterOf(tag));
    const store = onboardingStore(env);

    const { requests } = await answeringWith(
      async () => {
        // While the model answers: the admin places Sales, and saves the
        // staff list again.
        await admin.api.brain.saveTeamGroups([
          { id: "front", name: "Front office", teamIds: [sales] },
        ]);
        await admin.api.onboarding.saveRoster(rosterOf(tag));
        return arranging({
          groups: [{ name: "Everyone", teamIds: [finance, sales, support] }],
        });
      },
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
        { id: "group-everyone", teamIds: [finance, support] },
      ],
      owed: 0,
    });
  });

  it("are never arranged in a request: saving the staff list and reading the brain ask no model", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    const tag = unique();

    const { requests, result } = await answering([], async () => {
      await admin.api.onboarding.saveRoster(rosterOf(tag));
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
