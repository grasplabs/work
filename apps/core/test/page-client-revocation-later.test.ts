import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { appHost } from "../src/durable-objects.ts";
import { newTeam } from "./knowledge.ts";
import { runMinuteTasks } from "./maintenance.ts";
import { apiOf, referenceTo } from "./notes-client-app.ts";
import {
  mockSessionIdp,
  personApi,
  openedApp,
  clientFor,
  reading,
  eventually,
  shown,
  requestOf,
  pageFollower,
  memberOf,
  withSecrets,
} from "./page-client.ts";
import {
  appLookup,
  awayAfterTheChange,
  deliveryWait,
  flakyDb,
  followDelayMs,
  followedList,
  holdPageReads,
  lettingGoEarly,
  manyApps,
  promotedBeforeTheChange,
  quickRevocations,
  refusedAndLetGo,
  revocationsClock,
  sharedWithQueries,
  unreachableRevocations,
  whenLetGo,
} from "./page-revocation.ts";
import { openRpc, outcome } from "./sign-in.ts";

// Revocation (spec 11.4): when a write takes a person's role in an App
// away, their open pages are cleared without waiting for anything to
// commit to what they read, on every tab, and nothing more reaches them;
// anyone whose access holds keeps their page, whatever the event says.
// Here: failures to try again, the clock's part when a host or the
// database is away, and a person who becomes only a user. The rest is
// in page-client-revocation.test.ts and
// page-client-revocation-every-app.test.ts.

mockSessionIdp();

describe("live queries when access is revoked", { timeout: 180_000 }, () => {
  it("refuses as a failure to try again, not a lost role, when the role can't be read for a moment", async () => {
    const opened = await openedApp();
    const { lease, member } = await memberOf(opened);
    const flaky = flakyDb(sharedWithQueries);
    const { core } = await openRpc(member.session, { coreEnv: flaky.env });
    const tab = core.authenticate().pages;
    const follower = await followedList(opened, tab, lease);

    flaky.fail();
    await appHost(env, opened.app).accessRevoked([member.userId]);

    await expect(whenLetGo(follower)).resolves.toStrictEqual({
      last: "internal.unexpected",
      released: true,
    });
  });

  it("reads one App's query once, though another App's access is looked at again while it is read", async () => {
    const opened = await openedApp();
    const other = await openedApp();
    const { lease, member } = await memberOf(opened);
    await other.builder.api.apps.members.add(other.app, {
      type: "person",
      id: member.userId,
      role: "user",
    });
    const { lease: otherLease } = await member.api.pages.open(other.app);
    await followedList(other, member.api.pages, otherLease);
    const pageSize = 7;
    const reads = await holdPageReads(opened, pageSize);
    try {
      const follower = pageFollower();
      await member.api.pages
        .frame(opened.app, lease)
        .watchQuery(
          requestOf(apiOf(opened.release).list, { pagination: { pageSize } }),
          follower.callback
        );
      await eventually(() => {
        expect(reads.count()).toBe(1);
      });

      // While this App's query is read, the other App's host tells the
      // connection to look again: only the other App's queries look.
      await expect(
        appHost(env, other.app).accessRevoked([member.userId])
      ).resolves.toBe(1);
      await scheduler.wait(500);
      reads.release();

      await eventually(() => {
        expect(follower.received.at(-1)?.result.ok).toBeTruthy();
      });
      await scheduler.wait(1000);
      expect({
        reads: reads.count(),
        pushes: follower.received.length,
      }).toStrictEqual({ reads: 1, pushes: 1 });
    } finally {
      reads.restore();
    }
  });

  it("reads nothing of an App until the host that let go of it early takes the connection on again", async () => {
    const opened = await openedApp();
    const admin = await personApi("admin");
    const demoted = await personApi("admin");
    const { lease } = await demoted.api.pages.open(opened.app);
    const { core } = await openRpc(demoted.session);
    const tab = core.authenticate().pages;
    // The host lets go of the connection's first following at once, and
    // takes the next one on only `followDelayMs` later.
    const undo = await lettingGoEarly(opened);
    try {
      const follower = pageFollower();
      await tab
        .frame(opened.app, lease)
        .watchQuery(
          requestOf(apiOf(opened.release).list, { pagination: {} }),
          follower.callback
        );
      await scheduler.wait(500);
      // Before the next following: no host tells the connection of this.
      await admin.api.members.setRole(demoted.userId, "user");

      await vi.waitFor(
        () => {
          expect(follower.state.released).toBeTruthy();
        },
        { ...deliveryWait, timeout: deliveryWait.timeout + followDelayMs }
      );
      expect(follower.received.map(({ result }) => result.ok)).toStrictEqual([
        false,
      ]);
    } finally {
      undo();
    }
  });

  it("refuses as a failure to try again, not a lost role, when the App can't be looked up for a moment", async () => {
    const opened = await openedApp();
    const { lease, member } = await memberOf(opened);
    const flaky = flakyDb(appLookup);
    const { core } = await openRpc(member.session, { coreEnv: flaky.env });
    const tab = core.authenticate().pages;
    const follower = await followedList(opened, tab, lease);

    flaky.fail();
    await appHost(env, opened.app).accessRevoked([member.userId]);

    await expect(whenLetGo(follower)).resolves.toStrictEqual({
      last: "internal.unexpected",
      released: true,
    });
  });

  it("tells an App's host later, from the clock, when it can't be reached when access drops", async () => {
    const opened = await openedApp();
    const { them, lease, member } = await memberOf(opened);
    const follower = await followedList(opened, member.api.pages, lease);
    // The builder's own connection, whose word to the App's host that
    // access dropped never arrives.
    const { core } = await openRpc(opened.cookie, {
      coreEnv: { ...env, APPS: unreachableRevocations(env.APPS) },
    });

    await core.authenticate().apps.members.remove(opened.app, them);
    await scheduler.wait(1500);
    const before = follower.state.released;
    await runMinuteTasks();

    expect(before).toBeFalsy();
    await expect(whenLetGo(follower)).resolves.toStrictEqual(refusedAndLetGo);
  });

  it("drops a kept revocation once it is a day old, however many others the clock tells first", async () => {
    const opened = await openedApp();
    const now = Date.now();
    const keep = env.DB.prepare(
      "insert into access_revocations (id, app_id, user_ids, attempts, created_at) values (?, ?, null, ?, ?)"
    );
    const expired = crypto.randomUUID();
    // More than one run tells, none tried yet: each run reaches them
    // before the old one, which was tried once.
    const fresh = Array.from({ length: 101 }, () =>
      keep.bind(crypto.randomUUID(), opened.app, 0, now)
    );
    await env.DB.batch([
      ...fresh,
      keep.bind(expired, opened.app, 1, now - 25 * 60 * 60 * 1000),
    ]);

    await runMinuteTasks();

    const left = await env.DB.prepare(
      "select id from access_revocations where id = ?"
    )
      .bind(expired)
      .first();
    expect(left).toBeNull();
  });

  it("clears the page from the clock when the database goes away right after an unsharing commits", async () => {
    const opened = await openedApp();
    const { them, lease, member } = await memberOf(opened);
    const follower = await followedList(opened, member.api.pages, lease);
    // The builder's own connection: nothing after the unsharing's batch
    // reaches the database, and the App's host can't be told.
    const { core } = await openRpc(opened.cookie, {
      coreEnv: {
        ...env,
        DB: awayAfterTheChange(),
        APPS: unreachableRevocations(env.APPS),
      },
    });

    await outcome(core.authenticate().apps.members.remove(opened.app, them));
    await scheduler.wait(1500);
    const before = follower.state.released;
    await runMinuteTasks();

    expect(before).toBeFalsy();
    await expect(whenLetGo(follower)).resolves.toStrictEqual(refusedAndLetGo);
  });

  it("clears the page of someone removed who reached the App through a team, from the clock when the database goes away right after", async () => {
    const opened = await openedApp();
    const admin = await personApi("admin");
    const member = await personApi("user");
    const team = await newTeam(admin, [member]);
    await admin.api.apps.members.add(opened.app, {
      type: "team",
      id: team,
      role: "user",
    });
    const { lease } = await member.api.pages.open(opened.app);
    const follower = await followedList(opened, member.api.pages, lease);
    // The admin's own connection: nothing after the removal's batch, which
    // takes their teams away too, reaches the database, and the App's host
    // can't be told.
    const { core } = await openRpc(admin.session, {
      coreEnv: {
        ...env,
        DB: awayAfterTheChange(),
        APPS: unreachableRevocations(env.APPS),
      },
    });

    await outcome(core.authenticate().members.remove(member.userId));
    await scheduler.wait(1500);
    const before = follower.state.released;
    await runMinuteTasks();

    expect(before).toBeFalsy();
    await expect(whenLetGo(follower)).resolves.toStrictEqual({
      last: "auth.unauthenticated",
      released: true,
    });
  });

  it("clears the page of someone removed who was made an admin after the removal read their role, of an App only admins reach", async () => {
    const opened = await openedApp();
    const admin = await personApi("admin");
    const removed = await personApi("admin");
    const { lease } = await removed.api.pages.open(opened.app);
    const follower = await followedList(opened, removed.api.pages, lease);
    // A user as the removal reads them first; an admin again by its batch.
    await env.DB.prepare("update members set role = 'user' where user_id = ?")
      .bind(removed.userId)
      .run();
    const { core } = await openRpc(admin.session, {
      coreEnv: { ...env, DB: promotedBeforeTheChange(removed.userId) },
    });

    await core.authenticate().members.remove(removed.userId);

    await expect(whenLetGo(follower)).resolves.toStrictEqual({
      last: "auth.unauthenticated",
      released: true,
    });
  });

  it("clears the page of an admin demoted out of an App past the first pages of Apps, at once", async () => {
    const opened = await openedApp();
    const admin = await personApi("admin");
    const demoted = await personApi("admin");
    // Before it in ID order: it is on the third page.
    await manyApps(admin.userId, 450, [demoted.userId], "!");
    const { lease } = await demoted.api.pages.open(opened.app);
    const follower = await followedList(opened, demoted.api.pages, lease);
    // The admin's own connection, whose word reaches only the opened App's
    // host and takes no time for the others: what is told at once is
    // what the change's own budget expands, however fast hosts wake.
    const told = { others: 0 };
    const { core } = await openRpc(admin.session, {
      coreEnv: {
        ...env,
        APPS: quickRevocations(env.APPS, opened.app, told),
      },
    });

    await core.authenticate().members.setRole(demoted.userId, "user");

    expect(told.others).toBeGreaterThanOrEqual(450);
    await expect(whenLetGo(follower)).resolves.toStrictEqual(refusedAndLetGo);
  });

  it("clears the page of an admin removed from the organization, from the clock when the database goes away right after", async () => {
    const opened = await openedApp();
    const admin = await personApi("admin");
    const removed = await personApi("admin");
    const { lease } = await removed.api.pages.open(opened.app);
    const follower = await followedList(opened, removed.api.pages, lease);
    const { core } = await openRpc(admin.session, {
      coreEnv: {
        ...env,
        DB: awayAfterTheChange(),
        APPS: unreachableRevocations(env.APPS),
      },
    });

    await outcome(core.authenticate().members.remove(removed.userId));
    await scheduler.wait(1500);
    const before = follower.state.released;
    // Only the opened App's host is woken: an every-App revocation tells
    // every App the earlier tests of this file made, and each host woken
    // costs the test time.
    const told = { others: 0 };
    await revocationsClock({
      APPS: quickRevocations(env.APPS, opened.app, told),
    });

    expect(before).toBeFalsy();
    await expect(whenLetGo(follower)).resolves.toStrictEqual({
      last: "auth.unauthenticated",
      released: true,
    });
  });

  it("stops showing builders' data to someone lowered to user, from the clock when the database goes away right after", async () => {
    const opened = await openedApp(withSecrets());
    const tell = referenceTo<{ text: string }, unknown, "mutation">(
      opened.release,
      "notes.tell"
    );
    const secrets = referenceTo<Record<never, never>, unknown, "query">(
      opened.release,
      "notes.secrets"
    );
    await clientFor(opened).client.mutation(tell, { text: "Builders only" });
    const admin = await personApi("admin");
    const member = await personApi("builder");
    await opened.builder.api.apps.members.add(opened.app, {
      type: "person",
      id: member.userId,
      role: "builder",
    });
    const { lease } = await member.api.pages.open(opened.app);
    const follower = pageFollower();
    await member.api.pages
      .frame(opened.app, lease)
      .watchQuery(requestOf(secrets, {}), follower.callback);
    const showsSecret = () =>
      JSON.stringify(follower.received.at(-1)?.result).includes(
        "Builders only"
      );
    await eventually(() => {
      expect(showsSecret()).toBeTruthy();
    });
    // The admin's own connection: nothing after the change's batch
    // reaches the database, and the App's host can't be told.
    const { core } = await openRpc(admin.session, {
      coreEnv: {
        ...env,
        DB: awayAfterTheChange(),
        APPS: unreachableRevocations(env.APPS),
      },
    });

    await outcome(core.authenticate().members.setRole(member.userId, "user"));
    await scheduler.wait(1500);
    const before = showsSecret();
    await runMinuteTasks();

    expect(before).toBeTruthy();
    await vi.waitFor(() => {
      expect(showsSecret()).toBeFalsy();
    }, deliveryWait);
  });

  it("keeps no revocation once the App's host is told, nor for a sharing that changed nothing", async () => {
    const opened = await openedApp();
    const { them } = await memberOf(opened);
    const keptFor = async () =>
      await env.DB.prepare(
        "select count(*) as kept from access_revocations where app_id = ?"
      )
        .bind(opened.app)
        .first<number>("kept");
    // A connection that can't tell the App's host: whatever it keeps
    // stays for the clock.
    const { core } = await openRpc(opened.cookie, {
      coreEnv: { ...env, APPS: unreachableRevocations(env.APPS) },
    });

    // Shared again in the role it has: nothing changes.
    await core.authenticate().apps.members.add(opened.app, {
      ...them,
      role: "user",
    });
    const keptForNothing = await keptFor();
    // Unshared over a connection that tells the App's host at once.
    await opened.builder.api.apps.members.remove(opened.app, them);

    expect({ keptForNothing, keptOnceTold: await keptFor() }).toStrictEqual({
      keptForNothing: 0,
      keptOnceTold: 0,
    });
  });

  it("reads again for someone who is now only a user, rather than keep showing what builders read", async () => {
    const opened = await openedApp(withSecrets());
    const tell = referenceTo<{ text: string }, unknown, "mutation">(
      opened.release,
      "notes.tell"
    );
    const secrets = referenceTo<Record<never, never>, unknown, "query">(
      opened.release,
      "notes.secrets"
    );
    await clientFor(opened).client.mutation(tell, { text: "Builders only" });
    const member = await personApi("builder");
    const them = { type: "person", id: member.userId } as const;
    await opened.builder.api.apps.members.add(opened.app, {
      ...them,
      role: "builder",
    });
    const { lease } = await member.api.pages.open(opened.app);
    const follower = pageFollower();
    await member.api.pages
      .frame(opened.app, lease)
      .watchQuery(requestOf(secrets, {}), follower.callback);
    const showsSecret = () =>
      JSON.stringify(follower.received.at(-1)?.result).includes(
        "Builders only"
      );
    await eventually(() => {
      expect(showsSecret()).toBeTruthy();
    });

    await opened.builder.api.apps.members.add(opened.app, {
      ...them,
      role: "user",
    });

    await vi.waitFor(() => {
      expect(showsSecret()).toBeFalsy();
    }, deliveryWait);
  });

  it("drops what a page kept from before the person became only a user, while the query it follows shows nothing yet", async () => {
    const opened = await openedApp(withSecrets());
    const tell = referenceTo<{ text: string }, unknown, "mutation">(
      opened.release,
      "notes.tell"
    );
    const secrets = referenceTo<Record<never, never>, unknown, "query">(
      opened.release,
      "notes.secrets"
    );
    await clientFor(opened).client.mutation(tell, { text: "Builders only" });
    const member = await personApi("builder");
    const them = { type: "person", id: member.userId } as const;
    await opened.builder.api.apps.members.add(opened.app, {
      ...them,
      role: "builder",
    });
    const { lease } = await member.api.pages.open(opened.app);
    const { client } = clientFor(
      { ...opened, lease, cookie: member.session, userId: member.userId },
      member.api.pages
    );
    const kept = reading(client, secrets, {});
    await eventually(() => {
      expect(JSON.stringify(kept.now().value)).toContain("Builders only");
    });
    // No longer shown: the client keeps it for a while.
    kept.stop();
    const pageSize = 9;
    const reads = await holdPageReads(opened, pageSize);
    try {
      // Followed, its first read held: it has shown nothing yet.
      const pending = reading(client, apiOf(opened.release).list, {
        pagination: { pageSize },
      });
      await eventually(() => {
        expect(reads.count()).toBe(1);
      });

      await opened.builder.api.apps.members.add(opened.app, {
        ...them,
        role: "user",
      });

      await vi.waitFor(() => {
        expect(pending.now().error?.code).toBe("page.access_changed");
      }, deliveryWait);
      expect(kept.now().value).toBeUndefined();
    } finally {
      reads.restore();
    }
  });

  it("shows nothing a page kept from before the person became only a user, followed or not", async () => {
    const opened = await openedApp(withSecrets());
    const tell = referenceTo<{ text: string }, unknown, "mutation">(
      opened.release,
      "notes.tell"
    );
    const secrets = referenceTo<Record<never, never>, unknown, "query">(
      opened.release,
      "notes.secrets"
    );
    await clientFor(opened).client.mutation(tell, { text: "Builders only" });
    const member = await personApi("builder");
    const them = { type: "person", id: member.userId } as const;
    await opened.builder.api.apps.members.add(opened.app, {
      ...them,
      role: "builder",
    });
    const { lease } = await member.api.pages.open(opened.app);
    const { client } = clientFor(
      { ...opened, lease, cookie: member.session, userId: member.userId },
      member.api.pages
    );
    const followed = reading(client, secrets, {});
    // Read once, then no longer shown: the client keeps it for a while.
    const kept = reading(client, apiOf(opened.release).list, {
      pagination: {},
    });
    await eventually(() => {
      expect({
        followed: JSON.stringify(followed.now().value).includes(
          "Builders only"
        ),
        kept: shown(kept.now()),
      }).toStrictEqual({ followed: true, kept: [] });
    });
    kept.stop();

    await opened.builder.api.apps.members.add(opened.app, {
      ...them,
      role: "user",
    });

    await vi.waitFor(() => {
      expect(followed.now().error?.code).toBe("page.access_changed");
    }, deliveryWait);
    expect(kept.now()).toMatchObject({ value: undefined });
    // Read again, it is read afresh, under the roles they have now.
    const again = reading(client, apiOf(opened.release).list, {
      pagination: {},
    });
    await eventually(() => {
      expect(shown(again.now())).toStrictEqual([]);
    });
  });
});
