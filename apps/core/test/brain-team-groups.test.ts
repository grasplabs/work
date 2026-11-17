import type { RosterInput } from "@grasp-os/shared/onboarding";
import type { Identity } from "@grasp-os/shared/rpc";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { proposeTeamGroups } from "../src/brain-team-groups.ts";
import { mockIdp } from "./idp.ts";
import { fakeProvider } from "./model-provider.ts";
import { auditedDuring, outcome, signedInApi, unique } from "./sign-in.ts";

// The company's own groups of teams, the brain's regions (core's
// brain-team-groups.ts). What can go wrong, tried here: someone who isn't
// an admin regrouping the company; a group naming a team the brain
// doesn't have, or one team in two groups; a change kept without its
// audit event, or an earlier set lost to it; Grasp's proposal taken for
// the company's word, given more
// than the teams' names, or trusted when it leaves a team out or invents
// one.

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

describe("the company's groups of teams", { timeout: 120_000 }, () => {
  it("are confirmed by an admin, read by every member and audited", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    const tag = unique();
    await admin.api.onboarding.saveRoster(rosterOf(tag));

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
      // A member reads the groups as they read the teams: the staff list
      // is the admin's, so its teams aren't theirs, nor are the groups.
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
      member: [],
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
      memberProposes: await outcome(member.api.brain.proposeTeamGroups()),
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
        memberProposes: "role.forbidden",
        unknownTeam: "brain.team_groups_invalid",
        twice: "brain.team_groups_invalid",
        empty: "brain.team_groups_invalid",
      },
      kept: ["kept"],
    });
  });

  it("are proposed by Grasp for the teams in none, from their names alone, checked and kept as proposals", async () => {
    const admin = await signedInApi(idp, "admin");
    const tag = unique();
    await admin.api.onboarding.saveRoster(rosterOf(tag));
    const finance = `team-finance-${tag}`;
    const sales = `team-sales-${tag}`;
    const support = `team-support-${tag}`;
    await admin.api.brain.saveTeamGroups([
      { id: "back", name: "Back office", teamIds: [finance] },
    ]);
    const { teams } = await admin.api.brain.read();
    // The model groups one team, invents another, and leaves Support out.
    const provider = await fakeProvider({
      text: JSON.stringify({
        groups: [
          { name: "Revenue", teamIds: [sales, `team-invented-${tag}`] },
          { name: "Back office", teamIds: [finance] },
        ],
      }),
      inputTokens: 40,
      outputTokens: 20,
    });
    const person: Identity = {
      userId: admin.userId,
      email: "admin@acme.test",
      name: "Admin",
      role: "admin",
      teams: [],
      staff: false,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };

    let groups: unknown;
    const events = await auditedDuring(async () => {
      groups = await proposeTeamGroups(
        env,
        person,
        async () => await Promise.resolve(teams)
      );
    });
    const sent = JSON.stringify(provider.requests.map(({ body }) => body));

    expect({
      groups,
      sentNames: sent.includes("Support") && sent.includes("Sales"),
      // Nothing about the teams but their names: not who is in them.
      sentPeople: sent.includes("Ann Example"),
      audited: events
        .filter(({ action }) => action === "brain.team_groups.proposed")
        .map(({ detail }) => detail),
    }).toStrictEqual({
      groups: [
        {
          id: "back",
          name: "Back office",
          teamIds: [finance],
          confirmed: true,
        },
        {
          id: "group-revenue",
          name: "Revenue",
          teamIds: [sales],
          confirmed: false,
        },
        {
          id: "group-support",
          name: "Support",
          teamIds: [support],
          confirmed: false,
        },
      ],
      sentNames: true,
      sentPeople: false,
      audited: [{ groups: 2 }],
    });
  });
});
