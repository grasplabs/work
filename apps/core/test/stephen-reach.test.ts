import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { stephenFor } from "../src/stephen-reach.ts";
import { mockIdp } from "./idp.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
} from "./sign-in.ts";

// Settings › Stephen as core keeps it: who reaches the company's assistant
// in its chat apps, and whether he acts there, as the chat door asks on
// every message (`stephenFor`). These start from the ways it can fail: a
// place reaching people Stephen doesn't; someone outside the audience
// reaching him; a change that only holds later; a change left unaudited,
// or made by someone who isn't the company's own admin.

const idp = mockIdp();

/** Signing people in can be slow on CI. */
const setUpTime = { timeout: 60_000 };

/** A team of the company's, with `userIds` in it. */
const teamOf = async (...userIds: string[]): Promise<string> => {
  const team = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO teams (id, name, organization_id, created_at) VALUES (?, 'Sales', 'organization', ?)"
    ).bind(team, Date.now()),
    ...userIds.map((userId) =>
      env.DB.prepare(
        "INSERT INTO team_members (id, team_id, user_id, created_at) VALUES (?, ?, ?, ?)"
      ).bind(crypto.randomUUID(), team, userId, Date.now())
    ),
  ]);
  return team;
};

/** What Stephen does in Teams for each of `people`, now. */
const inTeams = async (...people: { userId: string }[]) =>
  await Promise.all(
    people.map(async ({ userId }) => await stephenFor(env, userId, "teams"))
  );

const reachesActs = { reaches: true, acts: true };
const reachesOnly = { reaches: true, acts: false };
const nothing = { reaches: false, acts: false };

describe("Settings › Stephen", setUpTime, () => {
  beforeEach(async () => {
    // Every test starts from the defaults.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM stephen_reach"),
      env.DB.prepare("DELETE FROM stephen_places"),
      env.DB.prepare("DELETE FROM app_tool_classes"),
    ]);
  });

  it("reaches everyone and acts for them in Teams until an admin changes it", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "user");
    const team = await teamOf(person.userId);
    await expect(inTeams(person)).resolves.toStrictEqual([reachesActs]);
    const settings = await admin.api.connections.stephenReach();
    // The teams an audience may name, by name.
    expect(settings.teams).toContainEqual({ teamId: team, name: "Sales" });
    expect({
      on: settings.on,
      audience: settings.audience,
      places: settings.places,
      microsoft: settings.apps.find(({ app }) => app === "microsoft")?.classes,
    }).toStrictEqual({
      on: true,
      audience: { who: "everyone" },
      places: [
        {
          place: "teams",
          audience: { who: "asStephen" },
          acts: true,
          changedBy: null,
          changedAt: null,
        },
      ],
      microsoft: [
        "read-own",
        "read-company",
        "change-own",
        "change-company",
        "reach-others",
        "read-others",
      ].map((toolClass) => ({
        toolClass,
        audience: { who: "asClass" },
        changedBy: null,
        changedAt: null,
      })),
    });
  });

  it("follows each change from the next message, and lets a place only narrow who reaches him", async () => {
    const admin = await signedInApi(idp, "admin");
    const [sales, salesAndSupport, outside] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
    ]);
    const salesTeam = await teamOf(sales.userId, salesAndSupport.userId);
    const supportTeam = await teamOf(salesAndSupport.userId);

    await admin.api.connections.setStephenReach(true, {
      who: "teams",
      teams: [salesTeam],
    });
    const forSales = await inTeams(sales, salesAndSupport, outside);

    // Teams lets "everyone" in: everyone Stephen reaches, nobody more.
    await admin.api.connections.setStephenPlace(
      "teams",
      { who: "everyone" },
      true
    );
    const placeEveryone = await inTeams(sales, salesAndSupport, outside);

    // Support only, in Teams: the person in both teams, and nobody else.
    // Support's people outside Sales stay out: Stephen doesn't reach them.
    await admin.api.connections.setStephenPlace(
      "teams",
      { who: "teams", teams: [supportTeam] },
      true
    );
    const placeSupport = await inTeams(sales, salesAndSupport, outside);

    // He only answers there.
    await admin.api.connections.setStephenPlace(
      "teams",
      { who: "asStephen" },
      false
    );
    const answersOnly = await inTeams(sales, salesAndSupport, outside);

    // Off: nobody, in any place.
    await admin.api.connections.setStephenReach(false, { who: "everyone" });
    const switchedOff = await inTeams(sales, salesAndSupport, outside);

    expect({
      forSales,
      placeEveryone,
      placeSupport,
      answersOnly,
      switchedOff,
      slack: await stephenFor(env, sales.userId, "slack"),
    }).toStrictEqual({
      forSales: [reachesActs, reachesActs, nothing],
      placeEveryone: [reachesActs, reachesActs, nothing],
      placeSupport: [nothing, reachesActs, nothing],
      answersOnly: [reachesOnly, reachesOnly, nothing],
      switchedOff: [nothing, nothing, nothing],
      slack: nothing,
    });
  });

  it("is changed by the company's admins only, never by Grasp staff, and only to places, apps, classes and teams there are", async () => {
    const member = await signedInApi(idp, "user");
    const staffSession = await signedIn(idp, "grasp-staff", staffPerson());
    const staffRpc = await openRpc(staffSession);
    const staff = staffRpc.core.authenticate();
    const admin = await signedInApi(idp, "admin");
    const everyone = { who: "everyone" } as const;

    expect({
      memberReads: await outcome(member.api.connections.stephenReach()),
      member: await outcome(
        member.api.connections.setStephenReach(false, everyone)
      ),
      memberPlace: await outcome(
        member.api.connections.setStephenPlace("teams", everyone, true)
      ),
      memberApp: await outcome(
        member.api.connections.setAppToolClass(
          "microsoft",
          "reach-others",
          everyone
        )
      ),
      staff: await outcome(staff.connections.setStephenReach(false, everyone)),
      staffPlace: await outcome(
        staff.connections.setStephenPlace("teams", everyone, true)
      ),
      unknownTeam: await outcome(
        admin.api.connections.setStephenReach(true, {
          who: "teams",
          teams: [crypto.randomUUID()],
        })
      ),
      notAPlace: await outcome(
        admin.api.connections.setStephenPlace("web", everyone, true)
      ),
      notAnApp: await outcome(
        admin.api.connections.setAppToolClass("zoho", "read-company", everyone)
      ),
      // Google Workspace has no tool that changes the company's.
      classItLacks: await outcome(
        admin.api.connections.setAppToolClass(
          "google",
          "change-company",
          everyone
        )
      ),
      asClassForStephen: await outcome(
        admin.api.connections.setStephenReach(
          true,
          // @ts-expect-error -- `asClass` narrows an app's class, not Stephen
          { who: "asClass" }
        )
      ),
    }).toStrictEqual({
      memberReads: "role.forbidden",
      member: "role.forbidden",
      memberPlace: "role.forbidden",
      memberApp: "role.forbidden",
      staff: "role.forbidden",
      staffPlace: "role.forbidden",
      unknownTeam: "connection.invalid",
      notAPlace: "connection.invalid",
      notAnApp: "connection.invalid",
      classItLacks: "connection.invalid",
      asClassForStephen: "connection.invalid",
    });
    const settings = await admin.api.connections.stephenReach();
    expect({
      changedBy: settings.changedBy,
      places: settings.places.map(({ changedBy }) => changedBy),
    }).toStrictEqual({ changedBy: null, places: [null] });
  });

  it("records each change in the audit log, with its teams, and nothing for a change to nothing", async () => {
    const admin = await signedInApi(idp, "admin");
    const first = await teamOf();
    const second = await teamOf();
    const [low, high] = [first, second].toSorted();

    const events = await auditedDuring(async () => {
      await admin.api.connections.setStephenReach(true, {
        who: "teams",
        teams: [second, first],
      });
      // The same again changes nothing.
      await admin.api.connections.setStephenReach(true, {
        who: "teams",
        teams: [first, second],
      });
      await admin.api.connections.setStephenPlace(
        "teams",
        { who: "asStephen" },
        false
      );
      await admin.api.connections.setAppToolClass("microsoft", "change-own", {
        who: "nobody",
      });
      await admin.api.connections.setAppToolClass("microsoft", "change-own", {
        who: "nobody",
      });
    });

    const actor = { type: "person", userId: admin.userId };
    expect(
      events
        .filter(
          ({ action }) =>
            action.startsWith("stephen.") ||
            action === "connection.app_class.changed"
        )
        .map(({ action, actor: by, target, detail }) => ({
          action,
          actor: by,
          target,
          detail,
        }))
    ).toStrictEqual([
      {
        action: "stephen.reach.changed",
        actor,
        target: { type: "stephen", id: "stephen" },
        detail: { on: "true", who: "teams", team1: low, team2: high },
      },
      {
        action: "stephen.place.changed",
        actor,
        target: { type: "stephen_place", id: "teams" },
        detail: { place: "teams", who: "asStephen", acts: "false" },
      },
      {
        action: "connection.app_class.changed",
        actor,
        target: { type: "tool_class", id: "microsoft/change-own" },
        detail: { app: "microsoft", toolClass: "change-own", who: "nobody" },
      },
    ]);
  });
});
