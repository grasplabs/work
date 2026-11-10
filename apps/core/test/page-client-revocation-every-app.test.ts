import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { mockSessionIdp, personApi } from "./page-client.ts";
import {
  awayAfterTheChange,
  everyAppKeptFor,
  keptForPerson,
  manyApps,
  organizationRoleOf,
  revocationsClock,
  unreachableRevocations,
} from "./page-revocation.ts";
import { openRpc, outcome } from "./sign-in.ts";

// Revocation (spec 11.4): when a write takes a person's role in an App
// away, their open pages are cleared without waiting for anything to
// commit to what they read, on every tab, and nothing more reaches them;
// anyone whose access holds keeps their page, whatever the event says.
// Here: a revocation for every App, when an admin is removed or
// demoted, kept once and expanded a page of Apps at a time from the
// clock. The rest is in page-client-revocation.test.ts and
// page-client-revocation-later.test.ts.

mockSessionIdp();

describe("live queries when access is revoked", { timeout: 180_000 }, () => {
  it("keeps one revocation for every App when an admin is removed or demoted, however many Apps there are", async () => {
    const admin = await personApi("admin");
    const removed = await personApi("admin");
    const demoted = await personApi("admin");
    await manyApps(admin.userId, 1000, [removed.userId, demoted.userId]);
    // Connections on which nothing after the change's batch reaches the
    // database: what the batch kept is all there is.
    const changing = async () => {
      const { core } = await openRpc(admin.session, {
        coreEnv: {
          ...env,
          DB: awayAfterTheChange(),
          APPS: unreachableRevocations(env.APPS),
        },
      });
      return core;
    };
    const removing = await changing();
    await outcome(removing.authenticate().members.remove(removed.userId));
    const demoting = await changing();
    await outcome(
      demoting.authenticate().members.setRole(demoted.userId, "user")
    );

    expect({
      removed: await organizationRoleOf(removed.userId),
      demoted: await organizationRoleOf(demoted.userId),
      keptForRemoved: await keptForPerson(removed.userId),
      keptForDemoted: await keptForPerson(demoted.userId),
    }).toStrictEqual({
      removed: null,
      demoted: "user",
      keptForRemoved: [
        {
          appId: null,
          userIds: JSON.stringify([removed.userId]),
          afterAppId: null,
        },
      ],
      keptForDemoted: [
        {
          appId: null,
          userIds: JSON.stringify([demoted.userId]),
          afterAppId: null,
        },
      ],
    });
  });

  it("expands a revocation for every App a page at a time from the clock, until each App has its own", async () => {
    const admin = await personApi("admin");
    const removed = await personApi("admin");
    await manyApps(admin.userId, 450, [removed.userId]);
    const { core } = await openRpc(admin.session, {
      coreEnv: {
        ...env,
        DB: awayAfterTheChange(),
        APPS: unreachableRevocations(env.APPS),
      },
    });
    await outcome(core.authenticate().members.remove(removed.userId));
    const theirs = JSON.stringify([removed.userId]);
    const kept = async () => {
      const row = await env.DB.prepare(
        "select count(distinct app_id) as apps, count(*) - count(app_id) as everyApp from access_revocations where user_ids = ?"
      )
        .bind(theirs)
        .first<{ apps: number; everyApp: number }>();
      return row ?? { apps: 0, everyApp: 0 };
    };
    const allApps = await env.DB.prepare(
      "select count(*) as apps from apps"
    ).first<number>("apps");
    // Hosts that can't be told keep each App's row, so it can be counted.
    const unreachable = { APPS: unreachableRevocations(env.APPS) };
    const runs: { apps: number; everyApp: number }[] = [await kept()];
    while ((runs.at(-1)?.everyApp ?? 0) > 0 && runs.length < 10) {
      // oxlint-disable-next-line no-await-in-loop -- one run after the other
      await revocationsClock(unreachable);
      // oxlint-disable-next-line no-await-in-loop -- see above
      runs.push(await kept());
    }

    // Each run expands whole pages of 200 Apps, as many as its budget
    // allows, and the row goes with the last one.
    const between = runs.slice(1, -1);
    expect({
      first: runs[0],
      between: between.every(
        ({ apps, everyApp }) => everyApp === 1 && apps > 0 && apps % 200 === 0
      ),
      growing: runs.every(
        (run, index) => index === 0 || run.apps > (runs[index - 1]?.apps ?? 0)
      ),
      last: runs.at(-1),
    }).toStrictEqual({
      first: { apps: 0, everyApp: 1 },
      between: true,
      growing: true,
      last: { apps: allApps, everyApp: 0 },
    });
  });

  it("expands a revocation for every App once, whichever expansions reach the same page together", async () => {
    const admin = await personApi("admin");
    const removed = await personApi("admin");
    await manyApps(admin.userId, 450, [removed.userId]);
    const { core } = await openRpc(admin.session, {
      coreEnv: {
        ...env,
        DB: awayAfterTheChange(),
        APPS: unreachableRevocations(env.APPS),
      },
    });
    await outcome(core.authenticate().members.remove(removed.userId));
    const unreachable = { APPS: unreachableRevocations(env.APPS) };
    const everyAppLeft = async () =>
      await env.DB.prepare(
        "select count(*) as left from access_revocations where app_id is null and user_ids = ?"
      )
        .bind(JSON.stringify([removed.userId]))
        .first<number>("left");
    let left = await everyAppLeft();
    for (let runs = 0; runs < 10 && left !== 0; runs += 1) {
      // Two runs at once, each reading the same cursor.
      // oxlint-disable-next-line no-await-in-loop -- a pair after the other
      await Promise.all([
        revocationsClock(unreachable),
        revocationsClock(unreachable),
      ]);
      // oxlint-disable-next-line no-await-in-loop -- see above
      left = await everyAppLeft();
    }

    const counted = await env.DB.prepare(
      "select count(*) as rows, count(distinct app_id) as apps from access_revocations where app_id is not null and user_ids = ?"
    )
      .bind(JSON.stringify([removed.userId]))
      .first<{ rows: number; apps: number }>();
    const allApps = await env.DB.prepare(
      "select count(*) as apps from apps"
    ).first<number>("apps");
    expect({ left, counted }).toStrictEqual({
      left: 0,
      counted: { rows: allApps, apps: allApps },
    });
  });

  it("keeps expanding a revocation for every App past a day, and drops it, logged, past a week or ten failed expansions", async () => {
    const admin = await personApi("admin");
    const [dayOld, weekOld, failing] = await Promise.all([
      personApi("admin"),
      personApi("admin"),
      personApi("admin"),
    ]);
    await manyApps(admin.userId, 450, [
      dayOld.userId,
      weekOld.userId,
      failing.userId,
    ]);
    for (const person of [dayOld, weekOld, failing]) {
      // oxlint-disable-next-line no-await-in-loop -- one removal after the other
      const { core } = await openRpc(admin.session, {
        coreEnv: {
          ...env,
          DB: awayAfterTheChange(),
          APPS: unreachableRevocations(env.APPS),
        },
      });
      // oxlint-disable-next-line no-await-in-loop -- see above
      await outcome(core.authenticate().members.remove(person.userId));
    }
    const hourMs = 60 * 60 * 1000;
    const age = env.DB.prepare(
      "update access_revocations set created_at = ?, attempts = ? where app_id is null and user_ids = ?"
    );
    await env.DB.batch([
      age.bind(Date.now() - 25 * hourMs, 0, JSON.stringify([dayOld.userId])),
      age.bind(
        Date.now() - 8 * 24 * hourMs,
        0,
        JSON.stringify([weekOld.userId])
      ),
      age.bind(Date.now(), 10, JSON.stringify([failing.userId])),
    ]);

    await revocationsClock({ APPS: unreachableRevocations(env.APPS) });

    const dayOldKept = await everyAppKeptFor(dayOld.userId);
    expect({
      // Expanded on, however far the run's budget went.
      dayOld: (dayOldKept?.apps ?? 0) >= 200,
      weekOld: await everyAppKeptFor(weekOld.userId),
      failing: await everyAppKeptFor(failing.userId),
    }).toStrictEqual({
      dayOld: true,
      weekOld: { everyApp: 0, apps: 0 },
      failing: { everyApp: 0, apps: 0 },
    });
  });
});
