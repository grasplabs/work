import { GraspClient } from "@grasp-os/sdk/host";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { appHost } from "../src/durable-objects.ts";
import { requestGranted } from "./apps.ts";
import { newTeam, readCollection } from "./knowledge.ts";
import { apiOf, referenceTo } from "./notes-client-app.ts";
import {
  mockSessionIdp,
  personApi,
  openedApp,
  pageTransport,
  clientFor,
  reading,
  eventually,
  shown,
  requestOf,
  pageFollower,
  titlesOf,
  memberOf,
  withSecrets,
} from "./page-client.ts";
import {
  afterACommit,
  deliveryWait,
  followDelayMs,
  followedList,
  refusedAndLetGo,
  slowToFollow,
  whenLetGo,
} from "./page-revocation.ts";
import { callAuth, openRpc, unique } from "./sign-in.ts";

// Revocation (spec 11.4): when a write takes a person's role in an App
// away, their open pages are cleared without waiting for anything to
// commit to what they read, on every tab, and nothing more reaches them;
// anyone whose access holds keeps their page, whatever the event says.
// Here: what clears a page at once. The clock's part, failures to try
// again and a person who becomes only a user are in
// page-client-revocation-later.test.ts; a revocation for every App in
// page-client-revocation-every-app.test.ts.

const idp = mockSessionIdp();

describe("live queries when access is revoked", { timeout: 180_000 }, () => {
  it("clears a page as soon as the person is unshared, with no commit after, and sends nothing more", async () => {
    const opened = await openedApp();
    const { them, lease, member } = await memberOf(opened);
    const follower = await followedList(opened, member.api.pages, lease);

    await opened.builder.api.apps.members.remove(opened.app, them);

    await expect(whenLetGo(follower)).resolves.toStrictEqual(refusedAndLetGo);
    await expect(afterACommit(opened, follower)).resolves.toStrictEqual([]);
  });

  it("clears the page of someone who leaves the team the App is shared with", async () => {
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

    await callAuth("/organization/remove-team-member", admin.session, {
      teamId: team,
      userId: member.userId,
    });

    await expect(whenLetGo(follower)).resolves.toStrictEqual(refusedAndLetGo);
  });

  it("clears the page of someone taken out of a project the App is shared with, of the App taken out of it, or of the project deleted", async () => {
    const opened = await openedApp();
    const admin = await personApi("admin");
    const [ada, ben, cy, dee] = await Promise.all([
      personApi("user"),
      personApi("user"),
      personApi("user"),
      personApi("user"),
    ]);
    const team = await newTeam(admin, [dee]);
    /** A project of the App's builder, the App shared with everyone in it. */
    const projectWith = async (
      ...people: { userId: string }[]
    ): Promise<string> => {
      const { id } = await opened.builder.api.projects.create({
        name: `Project ${unique()}`,
      });
      for (const person of people) {
        // oxlint-disable-next-line no-await-in-loop -- one member at a time
        await opened.builder.api.projects.addMember(id, {
          type: "person",
          id: person.userId,
          role: "user",
        });
      }
      await opened.builder.api.projects.file(id, {
        item: { type: "app", id: opened.app },
        share: true,
      });
      return id;
    };
    const followed = async (person: typeof ada) => {
      const { lease } = await person.api.pages.open(opened.app);
      return await followedList(opened, person.api.pages, lease);
    };
    const takenOut = await projectWith(ada);
    const unfiled = await projectWith(ben);
    const deleted = await projectWith(cy);
    const throughTeam = await projectWith();
    await opened.builder.api.projects.addMember(throughTeam, {
      type: "team",
      id: team,
      role: "user",
    });
    const [adaSees, benSees, cySees, deeSees] = await Promise.all([
      followed(ada),
      followed(ben),
      followed(cy),
      followed(dee),
    ]);

    await opened.builder.api.projects.removeMember(takenOut, {
      type: "person",
      id: ada.userId,
    });
    await opened.builder.api.projects.unfile(unfiled, {
      type: "app",
      id: opened.app,
    });
    await opened.builder.api.projects.remove(deleted);
    await callAuth("/organization/remove-team-member", admin.session, {
      teamId: team,
      userId: dee.userId,
    });

    await expect(
      Promise.all([adaSees, benSees, cySees, deeSees].map(whenLetGo))
    ).resolves.toStrictEqual([
      refusedAndLetGo,
      refusedAndLetGo,
      refusedAndLetGo,
      refusedAndLetGo,
    ]);
  });

  it("clears the page of someone whose team, the App's way to them, is deleted", async () => {
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
    // The organization keeps a team: this one is never its last.
    await newTeam(admin, []);

    const removed = await callAuth("/organization/remove-team", admin.session, {
      teamId: team,
    });
    expect(removed.status).toBe(200);

    await expect(whenLetGo(follower)).resolves.toStrictEqual(refusedAndLetGo);
  });

  it("clears the page of someone the App was shared with directly, once leaving a team leaves them unable to read what it read", async () => {
    const opened = await openedApp();
    const admin = await personApi("admin");
    const member = await personApi("user");
    const team = await newTeam(admin, [member]);
    const { id: collection } = await admin.api.knowledge.createCollection({
      name: `HR ${unique()}`,
      access: "teams",
      teams: [team],
      sensitive: false,
    });
    await requestGranted(
      idp,
      opened.builder,
      readCollection(
        { type: "app", appId: opened.app },
        collection,
        `HR_${unique().toUpperCase()}`
      )
    );
    // Shared with them as a person, never with the team.
    await opened.builder.api.apps.members.add(opened.app, {
      type: "person",
      id: member.userId,
      role: "user",
    });
    const { lease } = await member.api.pages.open(opened.app);
    const follower = await followedList(opened, member.api.pages, lease);

    await callAuth("/organization/remove-team-member", admin.session, {
      teamId: team,
      userId: member.userId,
    });

    await expect(whenLetGo(follower)).resolves.toStrictEqual(refusedAndLetGo);
  });

  it("clears an admin's page once they are demoted out of the App, on a session read just before", async () => {
    const opened = await openedApp();
    const admin = await personApi("admin");
    const demoted = await personApi("admin");
    const { lease } = await demoted.api.pages.open(opened.app);
    const follower = await followedList(opened, demoted.api.pages, lease);

    await admin.api.members.setRole(demoted.userId, "user");

    await expect(whenLetGo(follower)).resolves.toStrictEqual(refusedAndLetGo);
  });

  it("keeps the pages of everyone whose access holds, when others of the App lose theirs", async () => {
    const opened = await openedApp();
    const admin = await personApi("admin");
    const leaving = await personApi("user");
    const team = await newTeam(admin, [leaving]);
    const unshared = { type: "team", id: team } as const;
    await admin.api.apps.members.add(opened.app, { ...unshared, role: "user" });
    const { lease } = await leaving.api.pages.open(opened.app);
    const theirs = await followedList(opened, leaving.api.pages, lease);
    const staying = await memberOf(opened);
    const kept = await followedList(
      opened,
      staying.member.api.pages,
      staying.lease
    );

    // Everyone the App's host knows of looks again.
    await admin.api.apps.members.remove(opened.app, unshared);
    await expect(whenLetGo(theirs)).resolves.toStrictEqual(refusedAndLetGo);
    await staying.client.mutation(apiOf(opened.release).create, {
      title: "Still mine",
    });

    await eventually(() => {
      expect(titlesOf(kept.received.at(-1))).toStrictEqual(["Still mine"]);
    });
    expect({
      released: kept.state.released,
      refused: kept.received.some(({ result }) => !result.ok),
    }).toStrictEqual({ released: false, refused: false });
  });

  it("changes nothing for someone whose access holds, whoever says it was revoked", async () => {
    const opened = await openedApp();
    const { lease, member, client } = await memberOf(opened);
    const follower = await followedList(opened, member.api.pages, lease);

    await appHost(env, opened.app).accessRevoked([member.userId]);
    await appHost(env, opened.app).accessRevoked(null);
    await scheduler.wait(1500);
    await client.mutation(apiOf(opened.release).create, { title: "Mine" });

    await eventually(() => {
      expect(titlesOf(follower.received.at(-1))).toStrictEqual(["Mine"]);
    });
    expect({
      released: follower.state.released,
      refused: follower.received.some(({ result }) => !result.ok),
    }).toStrictEqual({ released: false, refused: false });
  });

  it("clears every tab of the person, each on its own connection", async () => {
    const opened = await openedApp();
    const { them, lease, member } = await memberOf(opened);
    const { core } = await openRpc(member.session);
    const otherTab = core.authenticate().pages;
    const first = await followedList(opened, member.api.pages, lease);
    const second = await followedList(opened, otherTab, lease);

    await opened.builder.api.apps.members.remove(opened.app, them);

    await expect(whenLetGo(first)).resolves.toStrictEqual(refusedAndLetGo);
    await expect(whenLetGo(second)).resolves.toStrictEqual(refusedAndLetGo);
  });

  it("clears what a frame of the tab follows through its own handle", async () => {
    const opened = await openedApp();
    const { them, lease, member } = await memberOf(opened);
    const frame = await member.api.pages.frame(opened.app, lease);
    const follower = pageFollower();
    await frame.watchQuery(
      requestOf(apiOf(opened.release).list, { pagination: {} }),
      follower.callback
    );
    await eventually(() => {
      expect(follower.received.at(-1)?.result.ok).toBeTruthy();
    });

    await opened.builder.api.apps.members.remove(opened.app, them);

    await expect(whenLetGo(follower)).resolves.toStrictEqual(refusedAndLetGo);
  });

  it("never shows a query followed right after the revocation, on a session read before it", async () => {
    const opened = await openedApp();
    const admin = await personApi("admin");
    const demoted = await personApi("admin");
    const { lease } = await demoted.api.pages.open(opened.app);
    // A tab that reads the session now, with the App's frame open, and
    // follows nothing of the App yet.
    const { core } = await openRpc(demoted.session);
    const frame = await core.authenticate().pages.frame(opened.app, lease);

    await admin.api.members.setRole(demoted.userId, "user");
    // The App's host is slow to take the tab on: the event went out
    // before, and the tab's reads must wait for it either way.
    const undo = await slowToFollow(opened);
    try {
      const follower = pageFollower();
      await frame.watchQuery(
        requestOf(apiOf(opened.release).list, { pagination: {} }),
        follower.callback
      );

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

  it("follows again once the App's host restarted, so a revocation after still clears the page", async () => {
    const opened = await openedApp();
    const admin = await personApi("admin");
    const demoted = await personApi("admin");
    const { lease } = await demoted.api.pages.open(opened.app);
    const follower = await followedList(opened, demoted.api.pages, lease);
    await runInDurableObject(appHost(env, opened.app), (_app, state) => {
      state.abort("Restarted by the test");
    }).catch(() => {
      // Aborting fails the call that aborted: that is the restart.
    });
    // Once the connection follows the new host: the event below must reach
    // it there. (Telling it, while its access holds, changes nothing.)
    await vi.waitFor(
      async () => {
        await expect(
          appHost(env, opened.app).accessRevoked([demoted.userId])
        ).resolves.toBeGreaterThan(0);
      },
      { timeout: 10_000, interval: 100 }
    );

    // A demotion tells the host and restarts nothing.
    await admin.api.members.setRole(demoted.userId, "user");

    await expect(whenLetGo(follower)).resolves.toStrictEqual(refusedAndLetGo);
  });

  it("clears the page of someone removed from the organization", async () => {
    const opened = await openedApp();
    const admin = await personApi("admin");
    const { lease, member } = await memberOf(opened);
    const follower = await followedList(opened, member.api.pages, lease);

    await admin.api.members.remove(member.userId);

    await expect(whenLetGo(follower)).resolves.toStrictEqual({
      last: "auth.unauthenticated",
      released: true,
    });
  });

  it("clears what a query kept while it waits to follow again, once the person is only a user", async () => {
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
    const page = pageTransport(
      { ...opened, lease, cookie: member.session, userId: member.userId },
      member.api.pages
    );
    const isSecrets = (request: string): boolean =>
      z
        .object({ reference: z.object({ name: z.string() }) })
        .parse(JSON.parse(request)).reference.name === secrets.name;
    // The secrets are followed once, then lost after their first push, and
    // followed again only once the test is over: meanwhile the query
    // waits to follow again, showing what it kept.
    const held = Promise.withResolvers<null>();
    let secretsFollows = 0;
    const client = new GraspClient({
      call: page.call,
      watch: async (request, onSnapshot, onLost) => {
        if (!isSecrets(request)) {
          return await page.watch(request, onSnapshot, onLost);
        }
        secretsFollows += 1;
        if (secretsFollows > 1) {
          await held.promise;
          return await page.watch(request, onSnapshot, onLost);
        }
        const handle: { release: (() => void) | undefined } = {
          release: undefined,
        };
        let pushed = false;
        const followed = await page.watch(
          request,
          (push) => {
            onSnapshot(push);
            if (!pushed) {
              pushed = true;
              setTimeout(() => {
                handle.release?.();
                onLost();
              }, 100);
            }
          },
          () => {
            // Told by the test.
          }
        );
        handle.release = followed.release;
        return followed;
      },
    });
    const waiting = reading(client, secrets, {});
    const followed = reading(client, apiOf(opened.release).list, {
      pagination: {},
    });
    await eventually(() => {
      expect({
        secrets: JSON.stringify(waiting.now().value).includes("Builders only"),
        lost: secretsFollows > 1,
        list: shown(followed.now()),
      }).toStrictEqual({ secrets: true, lost: true, list: [] });
    });

    try {
      await opened.builder.api.apps.members.add(opened.app, {
        ...them,
        role: "user",
      });

      await vi.waitFor(() => {
        expect(followed.now().error?.code).toBe("page.access_changed");
      }, deliveryWait);
      expect(waiting.now().value).toBeUndefined();
    } finally {
      held.resolve(null);
    }
  });
});
