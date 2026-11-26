import type { RosterInput } from "@grasp-os/shared/onboarding";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { brainTeams } from "../src/brain-rpc.ts";
import { arrangeTeams } from "../src/brain-team-groups.ts";
import { onboardingStore } from "../src/onboarding/store.ts";
import { mockIdp } from "./idp.ts";
import { aloneInTheStore, answering, holdAlarm } from "./interview-link.ts";
import { teamsMade } from "./members-teams.ts";
import { arrangementCalls, arrangementReplies } from "./model-provider.ts";
import type { ProviderReply } from "./model-provider.ts";
import { auditedDuring, signedInApi, unique } from "./sign-in.ts";
import { testBinding } from "./test-env.ts";

// The company's own groups of teams, the brain's regions (core's
// brain-team-groups.ts), which Grasp arranges by itself (GRA-1993). What
// can go wrong, tried here: a change kept without its audit event, or an
// earlier set lost to it; a placed team moved; more regions than the
// map's four lobes; the model given more than the teams' names, or
// trusted when it invents a team; the staff list's save held up or
// failed by the model, or a read asking it; a failure that is never tried
// again, or tried forever.

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

/** The ids of a set of groups as `brain_team_group_saves` keeps it. */
const groupIds = (stored: string | undefined): string[] =>
  z
    .array(z.object({ id: z.string() }))
    .parse(JSON.parse(stored ?? "[]"))
    .map((group) => group.id);

/** A staff-list team's id as the Brain named it before its bare id (GRA-2055). */
const was = (id: string): string => `team-${id}`;

describe("the company's groups of teams", { timeout: 120_000 }, () => {
  beforeEach(aloneInTheStore);

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

    // Three regions Grasp made of a staff list before, whose teams are all
    // gone: they take none of the map's four lobes.
    const old = unique();
    await alarmed(
      [
        arranging({
          groups: ["finance", "sales", "support"].map((team, index) => ({
            name: `Gone ${index} ${tag}`,
            teamIds: [`${team}-${old}`],
          })),
        }),
      ],
      async () =>
        await admin.api.onboarding.saveRoster(await teamsMade(rosterOf(old)))
    );
    const { teamGroups: gone } = await admin.api.brain.read();
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
    // The set kept whole, before and after, by the save the event names.
    const kept = await env.DB.prepare(
      "SELECT before, after FROM brain_team_group_saves WHERE id = ?"
    )
      .bind(arranged[0]?.detail?.save ?? "")
      .first<{ before: string; after: string }>();

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
      kept: { before: groupIds(kept?.before), after: groupIds(kept?.after) },
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
      kept: {
        before: gone.map((group) => group.id),
        after: [...gone, ...teamGroups].map((group) => group.id),
      },
    });
  });

  it("never move a team once placed, and join a region by its name", async () => {
    const admin = await signedInApi(idp, "admin");
    const tag = unique();
    const finance = `finance-${tag}`;
    const sales = `sales-${tag}`;
    const support = `support-${tag}`;
    // Grasp places Finance alone first; Sales and Support wait.
    await alarmed(
      [arranging({ groups: [{ name: "Money matters", teamIds: [finance] }] })],
      async () =>
        await admin.api.onboarding.saveRoster(await teamsMade(rosterOf(tag)))
    );

    // The model would move Finance out, and puts Sales in Finance's region.
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
        {
          id: "group-money-matters",
          name: "Money matters",
          teamIds: [finance, sales],
        },
        { id: "group-customers", name: "Customers", teamIds: [support] },
      ],
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

  it("keep what the model answers while the staff list is saved again, and are owed again by that save", async () => {
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
          // While the model answers, the admin saves the staff list again.
          await admin.api.onboarding.saveRoster(await teamsMade(rosterOf(tag)));
          return arranging({
            groups: [
              { name: `Everyone ${tag}`, teamIds: [finance, sales, support] },
            ],
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
        { id: `group-everyone-${tag}`, teamIds: [finance, sales, support] },
      ],
      owed: 0,
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

  it("keep every team in the region it was in before the Brain named a staff-list team by its bare id, and place none of them again", async () => {
    const admin = await signedInApi(idp, "admin");
    const tag = unique();
    const finance = `finance-${tag}`;
    const sales = `sales-${tag}`;
    const support = `support-${tag}`;
    await admin.api.onboarding.saveRoster(await teamsMade(rosterOf(tag)));
    // The regions and their kept sets as main's code wrote them: each
    // staff-list team as `team-<id>`. A region whose name holds "team-";
    // an empty one; Support placed once, then taken out of every region by
    // an admin ("No group"); and the teams of the Brain's arrangement only.
    const regions = (withSupport: boolean) => [
      {
        id: `money-${tag}`,
        name: "team-money",
        teamIds: [was(finance), ...(withSupport ? [was(support)] : [])],
        confirmed: true,
      },
      {
        id: `front-${tag}`,
        name: "Front",
        teamIds: [was(sales)],
        confirmed: true,
      },
      { id: `empty-${tag}`, name: "Empty", teamIds: [], confirmed: true },
    ];
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM brain_team_groups"),
      ...regions(false).map((region, position) =>
        env.DB.prepare(
          "INSERT INTO brain_team_groups (id, name, team_ids, position, confirmed_at, saved_at) VALUES (?, ?, ?, ?, ?, ?)"
        ).bind(
          region.id,
          region.name,
          JSON.stringify(region.teamIds),
          position,
          now,
          now
        )
      ),
      env.DB.prepare(
        "INSERT INTO brain_team_group_saves (id, saved_at, before, after) VALUES (?, ?, '[]', ?)"
      ).bind(`first-${tag}`, now - 2, JSON.stringify(regions(true))),
      env.DB.prepare(
        "INSERT INTO brain_team_group_saves (id, saved_at, before, after) VALUES (?, ?, ?, ?)"
      ).bind(
        `second-${tag}`,
        now - 1,
        JSON.stringify(regions(true)),
        JSON.stringify(regions(false))
      ),
    ]);
    // The rewrite core migration 0278 makes of them, once.
    const migrations = z
      .array(z.object({ name: z.string(), queries: z.array(z.string()) }))
      .parse(testBinding("CORE_MIGRATIONS"));
    const rewrite = (
      migrations.find(({ name }) => name === "0278_staff_list_teams.sql")
        ?.queries ?? []
    ).filter((query) => query.includes("brain_team_group"));
    await env.DB.batch(rewrite.map((query) => env.DB.prepare(query)));

    const { teamGroups } = await admin.api.brain.read();
    const { results: rows } = await env.DB.prepare(
      "SELECT name, team_ids AS teams FROM brain_team_groups ORDER BY position"
    ).all<{ name: string; teams: string }>();
    const { requests } = await arrangingWith(
      [arranging({ groups: [{ name: "Help", teamIds: [support] }] })],
      async () => {
        await arrangeTeams(env, async () => await brainTeams(env));
      }
    );
    const after = await admin.api.brain.read();

    expect({
      rewrote: rewrite.length,
      // As kept, the empty region too, which the read leaves out, as it
      // did before.
      rows,
      regions: teamGroups.map(({ name, teamIds }) => ({ name, teamIds })),
      asked: requests.length,
      unchanged: after.teamGroups.map(({ name, teamIds }) => ({
        name,
        teamIds,
      })),
    }).toStrictEqual({
      rewrote: 2,
      rows: [
        { name: "team-money", teams: JSON.stringify([finance]) },
        { name: "Front", teams: JSON.stringify([sales]) },
        { name: "Empty", teams: "[]" },
      ],
      regions: [
        { name: "team-money", teamIds: [finance] },
        { name: "Front", teamIds: [sales] },
      ],
      asked: 0,
      unchanged: [
        { name: "team-money", teamIds: [finance] },
        { name: "Front", teamIds: [sales] },
      ],
    });
  });
});
