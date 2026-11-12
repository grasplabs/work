import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { commitApp, testApp, withFiles } from "./app-definitions.ts";
import { outlook, release } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { newTeam } from "./knowledge.ts";
import { calledAs } from "./sealed-apps.ts";
import {
  auditedDuring,
  firstVersion,
  letSessionRecheckPass,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  signedInWithRole,
  staffPerson,
  unique,
} from "./sign-in.ts";

// App roles: an App is private to its owner and the organization's
// admins until a builder of it shares it with people or teams, as users
// (its pages) or builders (its code and settings). The ways this could
// go wrong, tried below: someone without a role reaching an App or
// learning it exists, a user changing code or settings or sharing it on,
// someone becoming a builder whose role in the organization doesn't
// build, access outliving unsharing or a team change, staff deciding whom
// a client's App reaches, and a change nobody recorded.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

const personApi = async (role: Role): Promise<Person> =>
  await signedInApi(idp, role);

const files = testApp(
  { name: "Desk", tables: {} },
  {
    "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
const Page = () => <p>Desk</p>;

export const Route = createFileRoute("/")({ component: Page });
`,
  }
);

/** The page at `path` that says `text`. */
const pageSaying = (path: string, text: string): string =>
  `import { createFileRoute } from "@tanstack/react-router";
const Page = () => <p>${text}</p>;\n

export const Route = createFileRoute("${path}")({ component: Page });
`;

/** A released App of `owner`'s, sealed. */
const newApp = async (owner: Person): Promise<string> => {
  const { id } = await owner.api.apps.create({ name: `Desk ${unique()}` });
  await release(owner, id, files);
  return id;
};

/** The code a function call of `person`'s was refused with, or "ok". */
const functionOutcome = async (
  { api }: Pick<Person, "api">,
  app: string
): Promise<string> => {
  const answered = await calledAs(await api.whoami(), app, {
    name: "desk.missing",
    kind: "query",
  });
  return answered.ok ? "ok" : answered.error.code;
};

/** What `person` gets from each call their role in an App decides. */
const callsOn = async ({ api }: Person, app: string) => ({
  // What its pages use.
  get: await outcome(api.apps.get(app)),
  contents: await outcome(api.apps.contents(app)),
  page: await outcome(
    firstVersion(
      async (onVersion) => await api.pages.watchVersion(app, onVersion)
    )
  ),
  report: await outcome(
    api.pages.report(
      app,
      { version: 1, path: "/" },
      { kind: "error", message: "Oops" }
    )
  ),
  open: await outcome(api.pages.open(app)),
  call: await functionOutcome({ api }, app),
  members: await outcome(api.apps.members.list(app)),
  // Its code and settings.
  read: await outcome(api.apps.files.read(app)),
  commit: await outcome(
    commitApp(api.apps.files, app, { "notes.md": "# Mine\n" }, "Mine")
  ),
  versions: await outcome(api.apps.versions.list(app)),
  version: await outcome(api.apps.versions.get(app, 1)),
  diff: await outcome(api.apps.versions.diff(app, 1, 1)),
  publish: await outcome(api.apps.versions.publish(app, 1)),
  errors: await outcome(api.pages.errors(app)),
  permission: await outcome(
    api.permissions.request({
      ...outlook(app),
      binding: `B_${unique().toUpperCase()}`,
    })
  ),
  share: await outcome(
    api.apps.members.add(app, { type: "team", id: "team-none", role: "user" })
  ),
});

const asUser = {
  get: "ok",
  contents: "ok",
  page: "ok",
  report: "ok",
  open: "ok",
  // Past the role check: the App's release has no such function.
  call: "function.not_found",
  members: "ok",
  read: "role.forbidden",
  commit: "role.forbidden",
  versions: "role.forbidden",
  version: "role.forbidden",
  diff: "role.forbidden",
  publish: "role.forbidden",
  errors: "role.forbidden",
  permission: "role.forbidden",
  share: "role.forbidden",
};

/** Whether `person` finds `app` among theirs. */
const lists = async ({ api }: Person, app: string): Promise<boolean> => {
  const [apps, overview] = await Promise.all([
    api.apps.list(),
    api.apps.overview(),
  ]);
  const listed = apps.some(({ id }) => id === app);
  // The overview lists the same Apps, in the same roles, each with what
  // its contents say.
  expect(overview.map(({ app: each }) => each)).toStrictEqual(apps);
  const contents = overview.find(({ app: each }) => each.id === app)?.contents;
  expect(contents).toStrictEqual(
    listed ? await api.apps.contents(app) : undefined
  );
  // Whether it has pages is said exactly when it is listed: someone who
  // can't open the App never learns it has pages, nor that it exists.
  expect(contents?.pages).toStrictEqual(listed ? true : undefined);
  return listed;
};

// Each test releases an App of its own and, through `callsOn`, makes some
// thirty calls in a row, opening its page among them: that builds the
// pages of that App's version, which the build cache can't share across
// Apps (it keys builds by App). A loaded runner takes longer than the
// default five seconds for that,
// as page-bridge.test.ts's tests do.
describe("App roles", { timeout: 60_000 }, () => {
  it("keep an App private to its owner and the admins", async () => {
    const owner = await personApi("builder");
    const [builder, user, admin] = await Promise.all([
      personApi("builder"),
      personApi("user"),
      personApi("admin"),
    ]);
    const app = await newApp(owner);

    const outsider = await callsOn(builder, app);
    // Refused as an App that isn't there, so nobody learns it exists.
    expect(new Set(Object.values(outsider))).toStrictEqual(
      new Set(["app.not_found"])
    );
    await expect(callsOn(user, app)).resolves.toStrictEqual(
      Object.fromEntries(
        Object.keys(outsider).map((call) => [
          call,
          // The organization's users never build, whatever the App.
          call === "permission" ? "role.forbidden" : "app.not_found",
        ])
      )
    );
    await expect(
      Promise.all(
        [builder, user, admin, owner].map(async (p) => await lists(p, app))
      )
    ).resolves.toStrictEqual([false, false, true, true]);
    // Admins manage every App.
    await expect(
      outcome(
        commitApp(
          admin.api.apps.files,
          app,
          { "notes.md": "# Admin\n" },
          "Admin"
        )
      )
    ).resolves.toBe("ok");
  });

  it("let a user work in an App's pages and nothing more, and a builder build it", async () => {
    const owner = await personApi("builder");
    const [user, builder] = await Promise.all([
      personApi("builder"),
      personApi("builder"),
    ]);
    const app = await newApp(owner);
    await owner.api.apps.members.add(app, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    await owner.api.apps.members.add(app, {
      type: "person",
      id: builder.userId,
      role: "builder",
    });

    await expect(callsOn(user, app)).resolves.toStrictEqual(asUser);
    const asBuilder = await callsOn(builder, app);
    expect(asBuilder).toMatchObject({
      read: "ok",
      commit: "ok",
      versions: "ok",
      version: "ok",
      diff: "ok",
      publish: "ok",
      errors: "ok",
      permission: "ok",
      // Refused for the team there isn't, past the role check.
      share: "app.member_invalid",
    });
    await expect(
      Promise.all([lists(user, app), lists(builder, app)])
    ).resolves.toStrictEqual([true, true]);
    const members = await user.api.apps.members.list(app);
    expect(
      members
        .map(({ id, name, role, addedBy }) => ({ id, name, role, addedBy }))
        .toSorted((a, b) => a.role.localeCompare(b.role))
    ).toStrictEqual([
      {
        id: builder.userId,
        name: builder.person.name,
        role: "builder",
        addedBy: owner.userId,
      },
      {
        id: user.userId,
        name: user.person.name,
        role: "user",
        addedBy: owner.userId,
      },
    ]);
  });

  it("follow a team's people as they join and leave it", async () => {
    const admin = await personApi("admin");
    const owner = await personApi("builder");
    const [anna, ben] = await Promise.all([
      personApi("builder"),
      personApi("builder"),
    ]);
    const team = await newTeam(admin, [anna]);
    const app = await newApp(owner);
    await owner.api.apps.members.add(app, {
      type: "team",
      id: team,
      role: "builder",
    });
    // As a person too, in a lower role: the higher one counts.
    await owner.api.apps.members.add(app, {
      type: "person",
      id: anna.userId,
      role: "user",
    });

    await expect(
      Promise.all([
        outcome(anna.api.apps.files.read(app)),
        outcome(ben.api.apps.get(app)),
      ])
    ).resolves.toStrictEqual(["ok", "app.not_found"]);

    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM team_members WHERE team_id = ? AND user_id = ?"
      ).bind(team, anna.userId),
      env.DB.prepare(
        "INSERT INTO team_members (id, team_id, user_id, created_at) VALUES (?, ?, ?, ?)"
      ).bind(crypto.randomUUID(), team, ben.userId, Date.now()),
    ]);
    using _clock = letSessionRecheckPass();
    await expect(
      Promise.all([
        outcome(anna.api.apps.files.read(app)),
        outcome(anna.api.apps.get(app)),
        outcome(ben.api.apps.files.read(app)),
      ])
    ).resolves.toStrictEqual(["role.forbidden", "ok", "ok"]);
    // Ben, now in the team, finds its pages; someone in neither doesn't.
    const outsider = await personApi("builder");
    await expect(
      Promise.all([lists(ben, app), lists(outsider, app)])
    ).resolves.toStrictEqual([true, false]);
  });

  it("list an App to those who only use it once a version is live, with the pages of the live version", async () => {
    const owner = await personApi("builder");
    const [user, builder] = await Promise.all([
      personApi("builder"),
      personApi("builder"),
    ]);
    const { id: app } = await owner.api.apps.create({
      name: `Desk ${unique()}`,
    });
    const { version } = await commitApp(
      owner.api.apps.files,
      app,
      files,
      "One"
    );
    await owner.api.apps.members.add(app, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    await owner.api.apps.members.add(app, {
      type: "person",
      id: builder.userId,
      role: "builder",
    });
    const listedBy = async ({ api }: Person): Promise<boolean> => {
      const listed = await api.apps.list();
      return listed.some(({ id }) => id === app);
    };

    // Nothing live yet: its builders' alone, as opening it is.
    const notLive = await Promise.all([
      listedBy(user),
      listedBy(builder),
      listedBy(owner),
      outcome(user.api.apps.contents(app)),
    ]);
    await owner.api.apps.versions.publish(app, version);
    // A version committed after the live one doesn't count: its page
    // opens for nobody yet.
    await commitApp(
      owner.api.apps.files,
      app,
      {
        "src/routes/later.tsx": `import { createFileRoute } from "@tanstack/react-router";
const Page = () => <p>Later</p>;

export const Route = createFileRoute("/later")({ component: Page });
`,
      },
      "Later"
    );

    expect({
      notLive,
      live: await Promise.all([
        lists(user, app),
        lists(builder, app),
        lists(owner, app),
      ]),
      contents: await user.api.apps.contents(app),
    }).toStrictEqual({
      notLive: [false, true, true, "app.not_found"],
      live: [true, true, true],
      contents: { version, pages: true },
    });
  });

  it("list each App once with its pages as its pages, however many pages it has", async () => {
    const owner = await personApi("builder");
    const names = {
      oldest: `Oldest ${unique()}`,
      middle: `Middle ${unique()}`,
      newest: `Newest ${unique()}`,
      empty: `Empty ${unique()}`,
    };
    const [oldest, middle, newest, empty] = await Promise.all(
      [names.oldest, names.middle, names.newest, names.empty].map(
        async (name) => {
          const { id } = await owner.api.apps.create({ name });
          return id;
        }
      )
    );
    if (
      oldest === undefined ||
      middle === undefined ||
      newest === undefined ||
      empty === undefined
    ) {
      throw new Error("Four Apps were made");
    }
    // Published, its pages committed out of their order.
    await release(
      owner,
      oldest,
      withFiles(files, {
        "src/routes/zeta.tsx": pageSaying("/zeta", "Zeta"),
        "src/routes/alpha.tsx": pageSaying("/alpha", "Alpha"),
      })
    );
    // A draft that serves a business process.
    const { version } = await commitApp(
      owner.api.apps.files,
      middle,
      files,
      "Draft"
    );
    await owner.api.apps.versions.publish(middle, version);
    await owner.api.apps.update(middle, { process: "o2c" });
    // Published, then archived.
    await release(owner, newest, files);
    await owner.api.apps.archive(newest);
    // Listed by when each was made, the oldest first, whatever order the
    // requests landed in. `empty`, the newest of all, has no current
    // version, so no pages.
    const start = Date.now() - 60_000;
    await env.DB.batch(
      [oldest, middle, newest, empty].map((id, index) =>
        env.DB.prepare("UPDATE apps SET created_at = ? WHERE id = ?").bind(
          start + index * 1000,
          id
        )
      )
    );

    const listed = await owner.api.apps.overview();
    const ours = new Set<string>([oldest, middle, newest, empty]);
    expect(
      listed
        .filter(({ app }) => ours.has(app.id))
        .map(({ app, contents }) => ({
          id: app.id,
          name: app.name,
          archived: app.archived,
          process: app.process,
          pages: contents.pages,
        }))
    ).toStrictEqual([
      // One App with three pages: one entry, its pages its pages.
      {
        id: oldest,
        name: names.oldest,
        archived: false,
        process: null,
        pages: true,
      },
      {
        id: middle,
        name: names.middle,
        archived: false,
        process: "o2c",
        pages: true,
      },
      {
        id: newest,
        name: names.newest,
        archived: true,
        process: null,
        pages: true,
      },
      {
        id: empty,
        name: names.empty,
        archived: false,
        process: null,
        pages: false,
      },
    ]);
  });

  it("keep an App's permissions, and its workflows, to those with a role in it", async () => {
    const [owner, other, admin] = await Promise.all([
      personApi("builder"),
      personApi("builder"),
      personApi("admin"),
    ]);
    const app = await newApp(owner);
    const { id: permission } = await owner.api.permissions.request(
      outlook(app)
    );
    // An agent's permission names the App too.
    const { id: agents } = await admin.api.permissions.request({
      subject: { type: "agent", agentId: `agent-${unique()}` },
      object: { type: "app", appId: app },
      actions: ["read"],
      binding: "REPORT",
    });
    const startsReport: PermissionRequest = {
      subject: { type: "agent", agentId: `agent-${unique()}` },
      object: { type: "app", appId: app },
      actions: ["read"],
      binding: "REPORT",
    };
    const listed = async (person: Person, subject?: string) => {
      const found = await person.api.permissions.list(
        subject === undefined ? undefined : { type: "app", appId: subject }
      );
      return [permission, agents].map((wanted) =>
        found.some(({ id }) => id === wanted)
      );
    };

    const before = {
      all: await listed(other),
      ofApp: await listed(other, app),
      admin: await listed(admin),
      // As for an App that isn't there.
      workflow: await outcome(other.api.permissions.request(startsReport)),
    };
    await owner.api.apps.members.add(app, {
      type: "person",
      id: other.userId,
      role: "user",
    });
    expect({
      before,
      after: {
        all: await listed(other),
        workflow: await outcome(other.api.permissions.request(startsReport)),
      },
    }).toStrictEqual({
      before: {
        all: [false, false],
        ofApp: [false, false],
        admin: [true, true],
        workflow: "app.not_found",
      },
      after: { all: [true, true], workflow: "ok" },
    });
  });

  it("list only people still in the organization, and teams that still exist", async () => {
    const admin = await personApi("admin");
    const owner = await personApi("builder");
    const [stays, leaves] = await Promise.all([
      personApi("user"),
      personApi("user"),
    ]);
    const [kept, deleted] = await Promise.all([
      newTeam(admin, []),
      newTeam(admin, []),
    ]);
    const app = await newApp(owner);
    for (const member of [
      { type: "person", id: stays.userId },
      { type: "person", id: leaves.userId },
      { type: "team", id: kept },
      { type: "team", id: deleted },
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one share at a time
      await owner.api.apps.members.add(app, { ...member, role: "user" });
    }

    await admin.api.members.remove(leaves.userId);
    await env.DB.prepare("DELETE FROM teams WHERE id = ?").bind(deleted).run();
    const listed = await owner.api.apps.members.list(app);
    expect(new Set(listed.map(({ id }) => id))).toStrictEqual(
      new Set([stays.userId, kept])
    );
  });

  it("say each person's own role in an App as they open or list it: by whom it is shared with, capped by their role in the organization", async () => {
    const admin = await personApi("admin");
    const [owner, sharedAsUser, sharedAsBuilder] = await Promise.all([
      personApi("builder"),
      personApi("builder"),
      personApi("builder"),
    ]);
    const memberOnly = await personApi("user");
    const team = await newTeam(admin, [memberOnly]);
    const app = await newApp(owner);
    await owner.api.apps.members.add(app, {
      type: "person",
      id: sharedAsUser.userId,
      role: "user",
    });
    await owner.api.apps.members.add(app, {
      type: "person",
      id: sharedAsBuilder.userId,
      role: "builder",
    });
    // Builders as a team, yet one of them can't build in the organization.
    await owner.api.apps.members.add(app, {
      type: "team",
      id: team,
      role: "builder",
    });
    const roles = async ({ api }: Person) => {
      const [opened, listed] = await Promise.all([
        api.apps.get(app),
        api.apps.list(),
      ]);
      return [opened.role, listed.find(({ id }) => id === app)?.role];
    };

    await expect(
      Promise.all(
        [owner, sharedAsUser, sharedAsBuilder, memberOnly, admin].map(roles)
      )
    ).resolves.toStrictEqual([
      ["builder", "builder"],
      // A builder in the organization, but only a user of this App.
      ["user", "user"],
      ["builder", "builder"],
      ["user", "user"],
      ["builder", "builder"],
    ]);
  });

  it("never let someone build whose role in the organization doesn't", async () => {
    const admin = await personApi("admin");
    const owner = await personApi("builder");
    const user = await personApi("user");
    const team = await newTeam(admin, [user]);
    const app = await newApp(owner);

    await expect(
      outcome(
        owner.api.apps.members.add(app, {
          type: "person",
          id: user.userId,
          role: "builder",
        })
      )
    ).resolves.toBe("app.member_invalid");
    // A team can be builders; each of its people builds only if they may.
    await owner.api.apps.members.add(app, {
      type: "team",
      id: team,
      role: "builder",
    });
    await expect(callsOn(user, app)).resolves.toStrictEqual(asUser);

    // Nor does the owner, once their role in the organization is `user`.
    await env.DB.prepare("UPDATE members SET role = 'user' WHERE user_id = ?")
      .bind(owner.userId)
      .run();
    using _clock = letSessionRecheckPass();
    await expect(
      Promise.all([
        outcome(owner.api.apps.get(app)),
        outcome(owner.api.apps.files.read(app)),
      ])
    ).resolves.toStrictEqual(["ok", "role.forbidden"]);
  });

  it("share only with the organization's people and teams, never the owner", async () => {
    const owner = await personApi("builder");
    const app = await newApp(owner);
    const shareWith = async (type: "person" | "team", id: string) =>
      await outcome(
        owner.api.apps.members.add(app, { type, id, role: "user" })
      );

    await expect(
      Promise.all([
        shareWith("person", "user-nobody"),
        shareWith("team", "team-nobody"),
        shareWith("person", owner.userId),
        outcome(
          owner.api.apps.members.add(app, {
            type: "person",
            id: owner.userId,
            // @ts-expect-error: not an App role, as a client could send it
            role: "admin",
          })
        ),
      ])
    ).resolves.toStrictEqual([
      "app.member_invalid",
      "app.member_invalid",
      "app.member_invalid",
      "app.invalid",
    ]);
    await expect(owner.api.apps.members.list(app)).resolves.toStrictEqual([]);
  });

  it("stop at the next call once an App is unshared, and record who shared and unshared it", async () => {
    const owner = await personApi("builder");
    const person = await personApi("builder");
    const app = await newApp(owner);
    const member = { type: "person", id: person.userId } as const;

    const events = await auditedDuring(async () => {
      await owner.api.apps.members.add(app, { ...member, role: "user" });
      // Sharing again in the same role changes and records nothing.
      await owner.api.apps.members.add(app, { ...member, role: "user" });
      await owner.api.apps.members.add(app, { ...member, role: "builder" });
      await expect(person.api.apps.files.read(app)).resolves.toBeDefined();
      await owner.api.apps.members.remove(app, member);
      // So does unsharing again.
      await owner.api.apps.members.remove(app, member);
    });

    await expect(outcome(person.api.apps.get(app))).resolves.toBe(
      "app.not_found"
    );
    // Nor are its pages listed to them any longer.
    await expect(lists(person, app)).resolves.toBeFalsy();
    const target = { type: "app", id: app };
    const actor = { type: "person", userId: owner.userId };
    expect(
      events.map(({ actor: by, action, target: on, detail }) => ({
        by,
        action,
        on,
        detail,
      }))
    ).toStrictEqual(
      (
        [
          ["app.member.added", "user"],
          ["app.member.added", "builder"],
          ["app.member.removed", "builder"],
        ] as const
      ).map(([action, role]) => ({
        by: actor,
        action,
        on: target,
        detail: { memberType: "person", member: person.userId, role },
      }))
    );
  });

  it("offer a builder of an App the organization's people and teams to share with, by name alone, and nobody else", async () => {
    const admin = await personApi("admin");
    const owner = await personApi("builder");
    const [colleague, user, stranger] = await Promise.all([
      personApi("user"),
      personApi("user"),
      personApi("builder"),
    ]);
    const team = await newTeam(admin, [colleague]);
    const app = await newApp(owner);
    await owner.api.apps.members.add(app, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    const offered = await owner.api.apps.members.candidates(app);
    const person = offered.people.find(({ id }) => id === colleague.userId);
    const offeredTeam = offered.teams.find(({ id }) => id === team);

    expect({
      // Its name and ID, and nothing more: no address, no role, no members.
      person: person === undefined ? null : Object.keys(person).toSorted(),
      team:
        offeredTeam === undefined ? null : Object.keys(offeredTeam).toSorted(),
      owner: offered.people.some(({ id }) => id === owner.userId),
    }).toStrictEqual({
      person: ["id", "name"],
      team: ["id", "name"],
      owner: true,
    });
    await expect(
      Promise.all([
        // Someone it is shared with as a user, who may not share it on.
        outcome(user.api.apps.members.candidates(app)),
        // Someone without a role in it, who doesn't learn it exists.
        outcome(stranger.api.apps.members.candidates(app)),
      ])
    ).resolves.toStrictEqual([
      await outcome(
        user.api.apps.members.add(app, {
          type: "person",
          id: colleague.userId,
          role: "user",
        })
      ),
      "app.not_found",
    ]);
  });

  it("leave whom a client's App reaches to the client, not Grasp staff", async () => {
    const owner = await personApi("builder");
    const person = await signedInWithRole(idp, "user");
    const app = await newApp(owner);
    const { core } = await openRpc(
      await signedIn(idp, "grasp-staff", staffPerson())
    );
    const staff = core.authenticate();

    await expect(
      Promise.all([
        outcome(staff.apps.files.read(app)),
        outcome(staff.apps.members.list(app)),
        outcome(
          staff.apps.members.add(app, {
            type: "person",
            id: person.userId,
            role: "user",
          })
        ),
      ])
    ).resolves.toStrictEqual([
      "role.forbidden",
      "role.forbidden",
      "role.forbidden",
    ]);
  });
});
