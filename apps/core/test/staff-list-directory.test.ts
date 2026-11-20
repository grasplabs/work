import { noTeamId } from "@grasp-os/shared/onboarding";
import type { RosterInput } from "@grasp-os/shared/onboarding";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  connectedDirectory,
  directoryHolds,
  directoryUser as user,
} from "./directory.ts";
import { mockIdp } from "./idp.ts";
import { runClockTask } from "./maintenance.ts";
import { acmeTenant, entraClient } from "./sign-in-config.ts";
import {
  auditedDuring,
  callAuth,
  entraPerson,
  signedIn,
  unique,
  whoami,
  withSignIn,
} from "./sign-in.ts";

// The teams a confirm of the onboarding's staff list makes in Settings ›
// Members, filled from the connected directory at once (GRA-2248), by the
// daily read itself rather than a day later; and the list's team for
// people it gives no team never one of them, as no directory fills it.
// Only Microsoft's side is faked.

const idp = mockIdp();

/** Someone who signed in with Microsoft under `oid`, as a member. */
const memberWith = async (oid: string): Promise<string> => {
  const person = entraPerson(acmeTenant, "acme.test", { oid });
  const session = await signedIn(idp, "microsoft", person, {
    coreEnv: withSignIn({
      admins: [String(person.email)],
      entra: { tenantId: acmeTenant, clientId: entraClient.id },
    }),
  });
  const { userId } = await whoami(session);
  return userId;
};

type Admin = Awaited<ReturnType<typeof connectedDirectory>>["admin"];

/** The members' teams whose name ends in `tag`, by name: who is in each. */
const teamsTagged = async (admin: Admin, tag: string) => {
  const teams = await admin.api.members.teams();
  return Object.fromEntries(
    teams
      .filter(({ name }) => name.endsWith(tag))
      .map(({ name, memberIds }) => [name, memberIds.toSorted()])
  );
};

describe("a confirmed staff list's teams", { timeout: 120_000 }, () => {
  it("are filled from the directory once the confirm made them, though the day's read ran already, and a second confirm changes nothing", async () => {
    const { admin } = await connectedDirectory(idp);
    const tag = unique();
    const [ann, ben, cas] = [
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
    ];
    const ids = {
      ann: await memberWith(ann),
      ben: await memberWith(ben),
      cas: await memberWith(cas),
    };
    await directoryHolds([
      user({ id: ann, department: `Finance ${tag}` }),
      user({ id: ben, department: `Sales ${tag}` }),
      user({ id: cas, department: null }),
    ]);
    // The day's read, before the teams were there: the clock reads again
    // only a day later.
    await runClockTask("directory.people");
    const roster: RosterInput = {
      teams: [
        { id: `finance-${tag}`, name: `Finance ${tag}`, lead: null },
        { id: `sales-${tag}`, name: `Sales ${tag}`, lead: null },
        { id: noTeamId, name: `Other ${tag}`, lead: null },
      ],
      people: [
        { id: `ann-${tag}`, name: "Ann", team: `finance-${tag}` },
        { id: `ben-${tag}`, name: "Ben", team: `sales-${tag}` },
        { id: `cas-${tag}`, name: "Cas", team: noTeamId },
      ],
    };

    const { roster: confirmed } =
      await admin.api.onboarding.confirmRoster(roster);
    const filled = {
      [`Finance ${tag}`]: [ids.ann],
      [`Sales ${tag}`]: [ids.ben],
    };
    await vi.waitFor(
      async () => {
        await expect(teamsTagged(admin, tag)).resolves.toStrictEqual(filled);
      },
      { timeout: 20_000, interval: 100 }
    );

    const events = await auditedDuring(async () => {
      await admin.api.onboarding.confirmRoster(confirmed ?? roster);
    });
    expect({
      teams: await teamsTagged(admin, tag),
      // The list keeps its team for people without one, for the interviews.
      listed: confirmed?.teams.map(({ id }) => id).includes(noTeamId),
      changed: events
        .map(({ action }) => action)
        .filter((action) => action.startsWith("team.")),
    }).toStrictEqual({ teams: filled, listed: true, changed: [] });
  });

  it("leave the list's team for people without one out of Settings › Members, where an admin may still make a team of that name", async () => {
    const { admin } = await connectedDirectory(idp);
    const tag = unique();
    await admin.api.onboarding.confirmRoster({
      teams: [
        { id: `ops-${tag}`, name: `Ops ${tag}`, lead: null },
        { id: noTeamId, name: `Other ${tag}`, lead: null },
      ],
      people: [
        { id: `dee-${tag}`, name: "Dee", team: `ops-${tag}` },
        { id: `eli-${tag}`, name: "Eli", team: noTeamId },
      ],
    });
    const before = Object.keys(await teamsTagged(admin, tag));

    const made = await callAuth("/organization/create-team", admin.session, {
      name: `Other ${tag}`,
    });
    await made.body?.cancel();

    expect({
      before,
      made: made.status,
      after: Object.keys(await teamsTagged(admin, tag)).toSorted(),
    }).toStrictEqual({
      before: [`Ops ${tag}`],
      made: 200,
      after: [`Ops ${tag}`, `Other ${tag}`].toSorted(),
    });
  });
});
