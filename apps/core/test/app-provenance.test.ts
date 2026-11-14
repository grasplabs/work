import { connectionOwnersMax } from "@grasp-os/shared/connect";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { sourcesOfApps } from "../src/app-provenance.ts";
import { mayRead } from "../src/knowledge/access.ts";
import { outlook, published, requestGranted } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { newTeam, readCollection, storedGrant } from "./knowledge.ts";
import { mailConnection } from "./mail-connection.ts";
import {
  auditedDuring,
  firstVersion,
  outcome,
  signedInApi,
  unique,
} from "./sign-in.ts";
import { connectDb } from "./test-env.ts";

// Provenance on sharing: an App keeps what it reads, so sharing it must
// reach nobody who couldn't read that where it comes from. The ways this
// could go wrong, tried below: sharing an App that read someone's mailbox
// or a sensitive collection with someone who can't read it, directly or
// through a team; the App keeping its data after its grant is revoked;
// someone joining a team after the App was shared with it; and a source
// the App is granted after it was shared.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

const personApi = async (role: Role): Promise<Person> =>
  await signedInApi(idp, role);

const newApp = async (owner: Person): Promise<string> => {
  const { id } = await owner.api.apps.create({ name: `Desk ${unique()}` });
  await published(id);
  return id;
};

/** A personal connection of `owner`'s, such as their mailbox. */
const mailboxOf = async (owner: Person): Promise<string> => {
  const id = `connection-mailbox-${unique()}`;
  const now = Date.now();
  await connectDb()
    .prepare(
      "INSERT INTO connections (id, provider, scope, owner_user_id, status, server_kind, server, created_at, updated_at) VALUES (?, 'microsoft', 'personal', ?, 'active', 'native', 'microsoft-365', ?, ?)"
    )
    .bind(id, owner.userId, now, now)
    .run();
  return id;
};

/** Grants `app` `connectionId`, asked for by `owner`. Returns its ID. */
const grantConnection = async (
  owner: Person,
  app: string,
  connectionId: string
): Promise<string> =>
  await requestGranted(idp, owner, {
    ...outlook(app, `MAIL_${unique().toUpperCase()}`),
    object: { type: "connection", connectionId },
  });

/** A collection for `team`'s people, and `app` granted to read it. */
const collectionFor = async (
  admin: Person,
  owner: Person,
  app: string,
  team: string,
  sensitive = false
): Promise<string> => {
  const { id } = await admin.api.knowledge.createCollection({
    name: `HR ${unique()}`,
    access: "teams",
    teams: [team],
    sensitive,
  });
  await requestGranted(
    idp,
    owner,
    readCollection(
      { type: "app", appId: app },
      id,
      `HR_${unique().toUpperCase()}`
    )
  );
  return id;
};

/**
 * A team as large as a whole department: sharing with it still answers,
 * naming exactly the people who can't read what the App read.
 */
const teamSize = 120;

/** Apps enough that checking each on its own would add up. */
const manyApps = 30;

const refusalSchema = z.object({
  code: z.literal("app.share_unreadable"),
  details: z.object({
    sources: z.array(z.string()),
    people: z.array(z.string()),
  }),
});

/** Why sharing `app` with `member` was refused, or "ok". */
const shareRefusal = async (
  owner: Person,
  app: string,
  member: { type: "person" | "team"; id: string }
) => {
  try {
    await owner.api.apps.members.add(app, { ...member, role: "user" });
    return "ok";
  } catch (error) {
    const { details } = refusalSchema.parse(error);
    return details;
  }
};

/** The same reads, by Knowledge and by `mayRead`. */
const same = (reads: boolean[]) => ({ knowledge: reads, mayRead: reads });

describe("who reads a collection the App read", () => {
  it("is decided just as Knowledge decides who reads it", async () => {
    const admin = await personApi("admin");
    const [member, outsider] = await Promise.all([
      personApi("user"),
      personApi("user"),
    ]);
    const team = await newTeam(admin, [member]);
    // Everyone's, a team's that its owner isn't in, and someone's own.
    const made = await Promise.all([
      admin.api.knowledge.createCollection({
        name: `All ${unique()}`,
        access: "everyone",
      }),
      admin.api.knowledge.createCollection({
        name: `Team ${unique()}`,
        access: "teams",
        teams: [team],
      }),
      member.api.knowledge.createCollection({
        name: `Mine ${unique()}`,
        access: "me",
      }),
    ]);
    const decided = async (person: Person) => {
      const [listed, { teams }] = await Promise.all([
        person.api.knowledge.listCollections(),
        person.api.whoami(),
      ]);
      const reader = {
        userId: person.userId,
        teamIds: teams.map(({ id }) => id),
        admin: false,
      };
      return {
        knowledge: made.map(({ id }) => listed.some((one) => one.id === id)),
        mayRead: made.map(({ access, owner, teams: teamIds }) =>
          mayRead(reader, { access, owner, teamIds })
        ),
      };
    };
    await expect(
      Promise.all([admin, member, outsider].map(decided))
    ).resolves.toStrictEqual([
      same([true, true, false]),
      same([true, true, true]),
      same([true, false, false]),
    ]);
  });
});

describe("sharing an App", () => {
  it("is refused, with why, when the App read a mailbox they can't read, and audited", async () => {
    const owner = await personApi("builder");
    const [anna, admin] = await Promise.all([
      personApi("builder"),
      personApi("admin"),
    ]);
    const app = await newApp(owner);
    const mailbox = await mailboxOf(owner);
    await grantConnection(owner, app, mailbox);

    let refused: unknown;
    const events = await auditedDuring(async () => {
      refused = await shareRefusal(owner, app, {
        type: "person",
        id: anna.userId,
      });
    });
    expect(refused).toStrictEqual({
      sources: [`connection:${mailbox}`],
      people: [anna.userId],
    });
    expect(
      events.map(({ action, provenance, detail }) => ({
        action,
        provenance,
        detail,
      }))
    ).toStrictEqual([
      {
        action: "app.member.refused",
        provenance: [`connection:${mailbox}`],
        detail: {
          memberType: "person",
          member: anna.userId,
          role: "user",
          reason: "app.share_unreadable",
        },
      },
    ]);
    await expect(owner.api.apps.members.list(app)).resolves.toStrictEqual([]);

    // The owner and admins aren't checked: a team of only them is fine.
    const team = await newTeam(admin, [owner, admin]);
    await expect(
      shareRefusal(owner, app, { type: "team", id: team })
    ).resolves.toBe("ok");
  });

  it("is refused for the people of a team who can't read a collection the App read", async () => {
    const admin = await personApi("admin");
    const owner = await personApi("builder");
    const [anna, ben] = await Promise.all([
      personApi("user"),
      personApi("user"),
    ]);
    const hr = await newTeam(admin, [owner, anna]);
    const everyone = await newTeam(admin, [anna, ben]);
    const app = await newApp(owner);
    const collection = await collectionFor(admin, owner, app, hr, true);

    await expect(
      Promise.all([
        shareRefusal(owner, app, { type: "person", id: anna.userId }),
        shareRefusal(owner, app, { type: "team", id: everyone }),
        shareRefusal(owner, app, { type: "person", id: ben.userId }),
      ])
    ).resolves.toStrictEqual([
      "ok",
      { sources: [`collection:${collection}`], people: [ben.userId] },
      { sources: [`collection:${collection}`], people: [ben.userId] },
    ]);
  });

  it("stays refused once the App's grant is revoked: it may still hold what it read", async () => {
    const [owner, anna, admin] = await Promise.all([
      personApi("builder"),
      personApi("builder"),
      personApi("admin"),
    ]);
    const app = await newApp(owner);
    const mailbox = await mailboxOf(owner);
    const granted = await grantConnection(owner, app, mailbox);
    await admin.api.permissions.revoke(granted);

    await expect(
      shareRefusal(owner, app, { type: "person", id: anna.userId })
    ).resolves.toMatchObject({ people: [anna.userId] });
  });

  it("counts every connection the App was granted, however many, and one connect doesn't know as nobody's", async () => {
    const [owner, anna] = await Promise.all([
      personApi("builder"),
      personApi("builder"),
    ]);
    const app = await newApp(owner);
    const mailbox = await mailboxOf(owner);
    const gone = `connection-gone-${unique()}`;
    // More shared ones than connect answers for at once, which everyone
    // may read, then the mailbox and one connect never had.
    const now = Date.now();
    const shared = Array.from(
      { length: connectionOwnersMax + 1 },
      () => `connection-shared-${unique()}`
    );
    await connectDb().batch(
      shared.map((id) =>
        connectDb()
          .prepare(
            "INSERT INTO connections (id, provider, scope, status, server_kind, server, created_at, updated_at) VALUES (?, 'mail', 'shared', 'active', 'composio', 'https://backend.composio.dev/v3/mcp/none', ?, ?)"
          )
          .bind(id, now, now)
      )
    );
    for (const [index, connectionId] of [...shared, mailbox, gone].entries()) {
      // oxlint-disable-next-line no-await-in-loop -- one grant at a time
      await storedGrant(
        { type: "app", id: app },
        { type: "connection", id: connectionId },
        ["mail.list"],
        `MAIL_${index}`
      );
    }

    await expect(
      shareRefusal(owner, app, { type: "person", id: anna.userId })
    ).resolves.toStrictEqual({
      sources: [`connection:${mailbox}`, `connection:${gone}`],
      people: [anna.userId],
    });
  });

  it("reaches anyone when the App read only what everyone may: a shared connection", async () => {
    const [owner, anna] = await Promise.all([
      personApi("builder"),
      personApi("user"),
    ]);
    const app = await newApp(owner);
    const mail = await mailConnection();
    await grantConnection(owner, app, mail.id);

    await expect(
      shareRefusal(owner, app, { type: "person", id: anna.userId })
    ).resolves.toBe("ok");
    await expect(anna.api.apps.get(app)).resolves.toMatchObject({ id: app });
  });

  it("stops reaching someone once the App is granted what they can't read, or they join a team it reaches", async () => {
    const admin = await personApi("admin");
    const owner = await personApi("builder");
    const [anna, ben] = await Promise.all([
      personApi("user"),
      personApi("user"),
    ]);
    const hr = await newTeam(admin, [owner, anna]);
    const shared = await newTeam(admin, [anna]);
    const app = await newApp(owner);
    await collectionFor(admin, owner, app, hr, true);
    await owner.api.apps.members.add(app, {
      type: "team",
      id: shared,
      role: "user",
    });
    const opens = async (person: Person) =>
      await outcome(person.api.apps.get(app));

    // Ben joins the team the App is shared with, but can't read HR.
    await env.DB.prepare(
      "INSERT INTO team_members (id, team_id, user_id, created_at) VALUES (?, ?, ?, ?)"
    )
      .bind(crypto.randomUUID(), shared, ben.userId, Date.now())
      .run();
    await expect(Promise.all([opens(anna), opens(ben)])).resolves.toStrictEqual(
      ["ok", "app.unreadable"]
    );

    // Then the App is granted the owner's mailbox, which Anna can't read.
    await grantConnection(owner, app, await mailboxOf(owner));
    await expect(
      Promise.all([
        opens(anna),
        outcome(
          firstVersion(
            async (onVersion) =>
              await anna.api.pages.watchVersion(app, onVersion)
          )
        ),
        opens(owner),
        opens(admin),
      ])
    ).resolves.toStrictEqual(["app.unreadable", "app.unreadable", "ok", "ok"]);
  });

  it("stops reaching someone once a collection the App read no longer lets them read it", async () => {
    const admin = await personApi("admin");
    const owner = await personApi("builder");
    const anna = await personApi("user");
    const [readers, others] = await Promise.all([
      newTeam(admin, [anna]),
      newTeam(admin, []),
    ]);
    const app = await newApp(owner);
    // Not sensitive: every collection the App read counts.
    const collection = await collectionFor(admin, owner, app, readers);
    await owner.api.apps.members.add(app, {
      type: "person",
      id: anna.userId,
      role: "user",
    });
    await expect(outcome(anna.api.apps.get(app))).resolves.toBe("ok");

    await env.DB.prepare(
      "UPDATE collection_teams SET team_id = ? WHERE collection_id = ?"
    )
      .bind(others, collection)
      .run();
    await expect(outcome(anna.api.apps.get(app))).resolves.toBe(
      "app.unreadable"
    );
  });

  it("leaves out of a project's page and counts an App shared with it that someone in it may no longer read", async () => {
    const admin = await personApi("admin");
    const owner = await personApi("builder");
    const anna = await personApi("user");
    const [readers, others] = await Promise.all([
      newTeam(admin, [anna]),
      newTeam(admin, []),
    ]);
    const app = await newApp(owner);
    const collection = await collectionFor(admin, owner, app, readers);
    const { id: project } = await owner.api.projects.create({
      name: `Project ${unique()}`,
    });
    await owner.api.projects.addMember(project, {
      type: "person",
      id: anna.userId,
      role: "user",
    });
    await owner.api.projects.file(project, {
      item: { type: "app", id: app },
      share: true,
    });
    const listed = async (who: Person) => {
      const page = await who.api.projects.get(project);
      return { apps: page.items.length, counted: page.counts.apps };
    };
    const before = await listed(anna);

    // The collection the App read is now another team's alone.
    await env.DB.prepare(
      "UPDATE collection_teams SET team_id = ? WHERE collection_id = ?"
    )
      .bind(others, collection)
      .run();

    expect({
      before,
      anna: await listed(anna),
      opens: await outcome(anna.api.apps.get(app)),
      owner: await listed(owner),
    }).toStrictEqual({
      before: { apps: 1, counted: 1 },
      anna: { apps: 0, counted: 0 },
      opens: "app.unreadable",
      owner: { apps: 1, counted: 1 },
    });
  });

  it("checks a large team's people at once, but not those no longer in the organization", async () => {
    const admin = await personApi("admin");
    const owner = await personApi("builder");
    const team = await newTeam(admin, []);
    const readers = await newTeam(admin, []);
    const app = await newApp(owner);
    await collectionFor(admin, owner, app, readers);
    const now = Date.now();
    const people = Array.from({ length: teamSize }, () => `member-${unique()}`);
    const [cannot, removed] = people;
    await env.DB.batch(
      people.flatMap((id) => [
        env.DB.prepare(
          "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, 'Member', ?, 1, ?, ?)"
        ).bind(id, `${id}@acme.test`, now, now),
        env.DB.prepare(
          "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, 'organization', ?, 'user', ?)"
        ).bind(`membership-${id}`, id, now),
        env.DB.prepare(
          "INSERT INTO team_members (id, team_id, user_id, created_at) VALUES (?, ?, ?, ?)"
        ).bind(`team-${id}`, team, id, now),
        // All but two of them read the collection too.
        ...(id === cannot || id === removed
          ? []
          : [
              env.DB.prepare(
                "INSERT INTO team_members (id, team_id, user_id, created_at) VALUES (?, ?, ?, ?)"
              ).bind(`readers-${id}`, readers, id, now),
            ]),
      ])
    );
    const shareWithTeam = async () =>
      await shareRefusal(owner, app, { type: "team", id: team });

    const before = await shareWithTeam();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO member_removals (organization_id, user_id, removed_at) VALUES ('organization', ?, ?)"
      ).bind(removed, now),
      env.DB.prepare(
        "INSERT INTO team_members (id, team_id, user_id, created_at) VALUES (?, ?, ?, ?)"
      ).bind(`readers-${cannot}`, readers, cannot, now),
    ]);
    const after = await shareWithTeam();
    expect({
      before: before === "ok" ? before : new Set(before.people),
      // The one removed can't read it, and reaches nothing anyway.
      after,
    }).toStrictEqual({ before: new Set([cannot, removed]), after: "ok" });
  });

  it("hides the App's permissions from someone it reaches once it read what they can't", async () => {
    const [owner, anna, admin] = await Promise.all([
      personApi("builder"),
      personApi("builder"),
      personApi("admin"),
    ]);
    const app = await newApp(owner);
    await owner.api.apps.members.add(app, {
      type: "person",
      id: anna.userId,
      role: "builder",
    });
    const mail = await mailConnection();
    const shared = await grantConnection(owner, app, mail.id);
    // An agent's permission names the App too, as its exports'.
    const { id: agents } = await admin.api.permissions.request({
      subject: { type: "agent", agentId: `agent-${unique()}` },
      object: { type: "app", appId: app },
      actions: ["read"],
      binding: "REPORT",
    });
    const sees = async (person: Person) => {
      const listed = await person.api.permissions.list();
      return [shared, agents].map((wanted) =>
        listed.some(({ id }) => id === wanted)
      );
    };

    const before = await sees(anna);
    const mailbox = await grantConnection(owner, app, await mailboxOf(owner));
    const after = await anna.api.permissions.list();
    const ownerLists = await owner.api.permissions.list();
    expect({
      before,
      after: after.filter(
        ({ subject, object }) =>
          (subject.type === "app" && subject.appId === app) ||
          (object.type === "app" && object.appId === app)
      ),
      owner: await sees(owner),
      ownersMailbox: ownerLists.some(({ id }) => id === mailbox),
    }).toStrictEqual({
      before: [true, true],
      after: [],
      owner: [true, true],
      ownersMailbox: true,
    });
  });

  it("decides the permissions of many Apps shared with someone at once", async () => {
    const [owner, anna] = await Promise.all([
      personApi("builder"),
      personApi("builder"),
    ]);
    const [mail, mailbox] = await Promise.all([
      mailConnection(),
      mailboxOf(owner),
    ]);
    const apps = await Promise.all(
      Array.from({ length: manyApps }, async () => await newApp(owner))
    );
    // Every App reads the shared mail; every other one the owner's mailbox.
    const kept: string[] = [];
    for (const [index, app] of apps.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- one App at a time
      await owner.api.apps.members.add(app, {
        type: "person",
        id: anna.userId,
        role: "builder",
      });
      // oxlint-disable-next-line no-await-in-loop -- one App at a time
      const grant = await storedGrant(
        { type: "app", id: app },
        { type: "connection", id: mail.id },
        ["mail.list"],
        "MAIL"
      );
      if (index % 2 === 0) {
        kept.push(grant);
      } else {
        // oxlint-disable-next-line no-await-in-loop -- one App at a time
        await storedGrant(
          { type: "app", id: app },
          { type: "connection", id: mailbox },
          ["mail.list"],
          "MAILBOX"
        );
      }
    }

    const all = await anna.api.permissions.list();
    const listed = all
      .filter(
        ({ subject }) => subject.type === "app" && apps.includes(subject.appId)
      )
      .map(({ id }) => id);
    // Only the Apps that read nothing she can't: their mail, nothing else.
    expect(new Set(listed)).toStrictEqual(new Set(kept));
  });
});

/** A permission row's subject and object types, as permissions.ts names them. */
type SubjectType = "app" | "workflow";
type ObjectType = "connection" | "workflow";

/** The statement inserting a permission row, as an admin's grant writes it. */
const grantStatement = (
  subjectType: SubjectType,
  subject: string,
  objectType: ObjectType,
  object: string,
  actions: string[]
) =>
  env.DB.prepare(
    `INSERT INTO permissions (id, subject_type, subject_id, object_type, object_id,
      actions, binding, status, requested_by, requested_at, granted_by, granted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 'test', 0, 'test', 0)`
  ).bind(
    crypto.randomUUID(),
    subjectType,
    subject,
    objectType,
    object,
    JSON.stringify(actions),
    `GRANT_${unique().toUpperCase().replaceAll("-", "_")}`
  );

/**
 * A permission row as an admin's grant writes it, for a subject the
 * request path would refuse here only for lack of the other resources it
 * checks (a workflow's builders).
 */
const grantRow = async (
  subjectType: SubjectType,
  subject: string,
  objectType: ObjectType,
  object: string,
  actions = ["notes.list"]
): Promise<void> => {
  await grantStatement(subjectType, subject, objectType, object, actions).run();
};

/**
 * Links Apps `a` and `b` both ways, as two Apps that both start one
 * workflow are: what either read may reach the other through its runs.
 * Answers the workflow's ID.
 */
const linked = async (a: string, b: string): Promise<string> => {
  const workflow = `workflow_${unique().replaceAll("-", "")}`;
  await env.DB.batch([
    grantStatement("app", a, "workflow", workflow, ["start"]),
    grantStatement("app", b, "workflow", workflow, ["start"]),
  ]);
  return workflow;
};

describe("sharing an App that reaches other Apps sealed", () => {
  it("is refused when an App it shares a workflow with read a mailbox, revoked or not, either end", async () => {
    const [owner, anna] = await Promise.all([
      personApi("builder"),
      personApi("builder"),
    ]);
    const [caller, callee, revokedCaller] = await Promise.all([
      newApp(owner),
      newApp(owner),
      newApp(owner),
    ]);
    const mailbox = await mailboxOf(owner);
    await grantConnection(owner, callee, mailbox);
    await linked(caller, callee);
    const revoked = await linked(revokedCaller, callee);
    await env.DB.prepare(
      "UPDATE permissions SET status = 'revoked' WHERE object_id = ?"
    )
      .bind(revoked)
      .run();
    // And the other way: the caller read a mailbox, its calls may carry it.
    const [sender, receiver] = await Promise.all([
      newApp(owner),
      newApp(owner),
    ]);
    const sent = await mailboxOf(owner);
    await grantConnection(owner, sender, sent);
    await linked(sender, receiver);
    const anyone = { type: "person", id: anna.userId } as const;

    await expect(
      Promise.all([
        shareRefusal(owner, caller, anyone),
        shareRefusal(owner, revokedCaller, anyone),
        shareRefusal(owner, receiver, anyone),
      ])
    ).resolves.toStrictEqual([
      { sources: [`connection:${mailbox}`], people: [anna.userId] },
      { sources: [`connection:${mailbox}`], people: [anna.userId] },
      { sources: [`connection:${sent}`], people: [anna.userId] },
    ]);
  });

  it("fails closed for a workflow it shares with an App that doesn't exist", async () => {
    const [owner, anna] = await Promise.all([
      personApi("builder"),
      personApi("builder"),
    ]);
    const app = await newApp(owner);
    const ghost = `app_${unique().replaceAll("-", "")}`;
    await linked(app, ghost);

    await expect(
      shareRefusal(owner, app, { type: "person", id: anna.userId })
    ).resolves.toStrictEqual({
      sources: [`app:${ghost}`],
      people: [anna.userId],
    });
  });
});

/** Ways an App `a` comes to hold what an App `b` read, both sealed. */
const links = [
  [
    "a workflow both start",
    async (a: string, b: string) => {
      await linked(a, b);
    },
  ],
] as const;

/** Ways an App comes to hold something that doesn't resolve, and how it is named. */
const dangling = [
  [
    "a workflow it shares with an App that doesn't exist",
    async (app: string) => {
      const ghost = `app_${unique().replaceAll("-", "")}`;
      await linked(app, ghost);
      return `app:${ghost}`;
    },
  ],
] as const;

describe("who still passes once an App reaches another sealed", () => {
  it.each(links)(
    "lets the mailbox's owner and the admin through, and no one else, over %s",
    async (_name, link) => {
      const [owner, anna, ben, admin] = await Promise.all([
        personApi("builder"),
        personApi("builder"),
        personApi("builder"),
        personApi("admin"),
      ]);
      const team = await newTeam(admin, [anna, ben]);
      const [shared, unshared, callee] = await Promise.all([
        newApp(owner),
        newApp(owner),
        newApp(anna),
      ]);
      // Shared with the team before it reaches anything, as in the order
      // that can't be refused up front.
      await owner.api.apps.members.add(shared, {
        type: "team",
        id: team,
        role: "user",
      });
      const mailbox = await mailboxOf(anna);
      await grantConnection(anna, callee, mailbox);
      await link(shared, callee);
      await link(unshared, callee);

      await expect(
        Promise.all([
          shareRefusal(owner, unshared, { type: "person", id: anna.userId }),
          shareRefusal(owner, unshared, { type: "person", id: ben.userId }),
        ])
      ).resolves.toStrictEqual([
        "ok",
        { sources: [`connection:${mailbox}`], people: [ben.userId] },
      ]);
      await expect(
        Promise.all(
          [anna, ben, admin, owner].map(
            async (person) => await outcome(person.api.apps.get(shared))
          )
        )
      ).resolves.toStrictEqual(["ok", "app.unreadable", "ok", "ok"]);
    }
  );

  it.each(dangling)(
    "fails closed over %s to what doesn't resolve: the owner and the admin pass, Anna doesn't",
    async (_name, reach) => {
      const [owner, anna, admin] = await Promise.all([
        personApi("builder"),
        personApi("builder"),
        personApi("admin"),
      ]);
      const team = await newTeam(admin, [anna]);
      const [shared, unshared] = await Promise.all([
        newApp(owner),
        newApp(owner),
      ]);
      await owner.api.apps.members.add(shared, {
        type: "team",
        id: team,
        role: "user",
      });
      await reach(shared);
      const named = await reach(unshared);

      await expect(
        Promise.all(
          [anna, admin, owner].map(
            async (person) => await outcome(person.api.apps.get(shared))
          )
        )
      ).resolves.toStrictEqual(["app.unreadable", "ok", "ok"]);
      await expect(
        shareRefusal(owner, unshared, { type: "person", id: anna.userId })
      ).resolves.toStrictEqual({ sources: [named], people: [anna.userId] });
    }
  );
});

describe("how far sharing follows Apps reaching each other", () => {
  it("follows a chain of Apps down to the mailbox, and a cycle without end", async () => {
    const [owner, anna] = await Promise.all([
      personApi("builder"),
      personApi("builder"),
    ]);
    const [a, b, c, x, y] = await Promise.all([
      newApp(owner),
      newApp(owner),
      newApp(owner),
      newApp(owner),
      newApp(owner),
    ]);
    const mailbox = await mailboxOf(owner);
    await grantConnection(owner, c, mailbox);
    // A calls B, which calls C (the mailbox's App).
    await linked(a, b);
    await linked(b, c);
    // And X and Y call each other, X's data from Y's mailbox.
    const other = await mailboxOf(owner);
    await grantConnection(owner, y, other);
    await linked(x, y);
    await linked(y, x);
    const anyone = { type: "person", id: anna.userId } as const;

    await expect(
      Promise.all([
        shareRefusal(owner, a, anyone),
        shareRefusal(owner, x, anyone),
      ])
    ).resolves.toStrictEqual([
      { sources: [`connection:${mailbox}`], people: [anna.userId] },
      { sources: [`connection:${other}`], people: [anna.userId] },
    ]);
  });

  it("follows what a third App holds through an App both share workflows with", async () => {
    const [owner, anna] = await Promise.all([
      personApi("builder"),
      personApi("builder"),
    ]);
    const [writer, middle, caller] = await Promise.all([
      newApp(owner),
      newApp(owner),
      newApp(owner),
    ]);
    const mailbox = await mailboxOf(owner);
    await grantConnection(owner, writer, mailbox);
    // The writer and the caller each share a workflow with middle.
    await linked(writer, middle);
    await linked(caller, middle);
    const anyone = { type: "person", id: anna.userId } as const;

    await expect(
      Promise.all([
        shareRefusal(owner, middle, anyone),
        shareRefusal(owner, caller, anyone),
      ])
    ).resolves.toStrictEqual([
      { sources: [`connection:${mailbox}`], people: [anna.userId] },
      { sources: [`connection:${mailbox}`], people: [anna.userId] },
    ]);
  });

  it("fails closed past the depth it follows, instead of walking on", async () => {
    const [owner, anna] = await Promise.all([
      personApi("builder"),
      personApi("builder"),
    ]);
    const chain = await Promise.all(
      Array.from({ length: 40 }, async () => await newApp(owner))
    );
    await grantConnection(owner, chain.at(-1) ?? "", await mailboxOf(owner));
    for (const [at, from] of chain.entries()) {
      const to = chain[at + 1];
      if (to !== undefined) {
        // oxlint-disable-next-line no-await-in-loop -- in order
        await linked(from, to);
      }
    }

    await expect(
      shareRefusal(owner, chain[0] ?? "", { type: "person", id: anna.userId })
    ).resolves.toStrictEqual({ sources: ["app:*"], people: [anna.userId] });
  });

  it("closes an App past the depth it follows to its owner once a Brain grant names teams, and not before", async () => {
    const [owner, admin] = await Promise.all([
      personApi("builder"),
      personApi("admin"),
    ]);
    const chain = await Promise.all(
      Array.from({ length: 40 }, async () => await newApp(owner))
    );
    for (const [at, from] of chain.entries()) {
      const to = chain[at + 1];
      if (to !== undefined) {
        // oxlint-disable-next-line no-await-in-loop -- in order
        await linked(from, to);
      }
    }
    const opened = async () =>
      await owner.api.apps.get(chain[0] ?? "").then(
        () => "opened",
        (error: unknown) => z.object({ code: z.string() }).parse(error).code
      );
    // No grant names teams: the owner opens their App, however deep.
    const before = await opened();
    // A grant at the far end names a team, the owner's own: what the walk
    // can't place is closed, to them too (GRA-1842).
    const team = await newTeam(admin, [owner]);
    await env.DB.prepare(
      "INSERT INTO permissions (id, subject_type, subject_id, object_type, object_id, actions, binding, status, requested_by, requested_at, granted_by, granted_at, teams) VALUES (?, 'app', ?, 'platform', 'platform', '[\"brain\"]', 'TEAM_BRAIN', 'active', 'test', 0, 'test', 0, ?)"
    )
      .bind(crypto.randomUUID(), chain.at(-1) ?? "", JSON.stringify([team]))
      .run();
    expect({ before, after: await opened() }).toStrictEqual({
      before: "opened",
      after: "app.unreadable",
    });
  });
});

describe("sharing an App granted an independent workflow", () => {
  it("is refused when the workflow it starts or follows read a mailbox, and lets the mailbox's owner, the admin and the owner through", async () => {
    const [owner, anna, ben, admin] = await Promise.all([
      personApi("builder"),
      personApi("builder"),
      personApi("builder"),
      personApi("admin"),
    ]);
    const team = await newTeam(admin, [anna, ben]);
    const [starter, follower] = await Promise.all([
      newApp(owner),
      newApp(owner),
    ]);
    // Shared with the team before it reaches anything, as in the order
    // that can't be refused up front.
    await owner.api.apps.members.add(starter, {
      type: "team",
      id: team,
      role: "user",
    });
    const mailbox = await mailboxOf(anna);
    const workflow = `workflow_${unique().replaceAll("-", "")}`;
    await grantRow("workflow", workflow, "connection", mailbox);
    await grantRow("app", starter, "workflow", workflow, ["start"]);
    await grantRow("app", follower, "workflow", workflow, ["read"]);

    await expect(
      Promise.all([
        shareRefusal(owner, starter, { type: "person", id: ben.userId }),
        shareRefusal(owner, follower, { type: "person", id: ben.userId }),
        shareRefusal(owner, starter, { type: "person", id: anna.userId }),
      ])
    ).resolves.toStrictEqual([
      { sources: [`connection:${mailbox}`], people: [ben.userId] },
      { sources: [`connection:${mailbox}`], people: [ben.userId] },
      "ok",
    ]);
    await expect(
      Promise.all(
        [anna, ben, admin, owner].map(
          async (person) => await outcome(person.api.apps.get(starter))
        )
      )
    ).resolves.toStrictEqual(["ok", "app.unreadable", "ok", "ok"]);
  });
});

/** Workflows enough that two Apps' together pass the walk's cap, one's alone don't. */
const workflowsEach = 300;

describe("deciding many Apps at once past the walk's cap", () => {
  it("still shows each App that passes on its own, and hides the one that doesn't", async () => {
    const [owner, anna] = await Promise.all([
      personApi("builder"),
      personApi("builder"),
    ]);
    const mail = await mailConnection();
    const shared = await Promise.all(
      Array.from({ length: 3 }, async () => await newApp(owner))
    );
    const mailbox = await mailboxOf(owner);
    const grants: string[] = [];
    for (const [index, app] of shared.entries()) {
      // Shared before it reaches anything, as in the order that can't be
      // refused up front.
      // oxlint-disable-next-line no-await-in-loop -- one App at a time
      await owner.api.apps.members.add(app, {
        type: "person",
        id: anna.userId,
        role: "user",
      });
      // Each shared App calls an App of the owner's that follows many
      // workflows of its own: wide, but nothing Anna can't read.
      // oxlint-disable-next-line no-await-in-loop -- one App at a time
      const wide = await newApp(owner);
      // oxlint-disable-next-line no-await-in-loop -- one App at a time
      await linked(app, wide);
      const workflows = Array.from(
        { length: workflowsEach },
        () => `workflow_${unique().replaceAll("-", "")}`
      );
      // oxlint-disable-next-line no-await-in-loop -- one App at a time
      await env.DB.batch(
        workflows.map((workflow) =>
          grantStatement("app", wide, "workflow", workflow, ["read"])
        )
      );
      // But the last one's first workflow read the owner's mailbox.
      if (index === shared.length - 1) {
        // oxlint-disable-next-line no-await-in-loop -- one App at a time
        await grantRow("workflow", workflows[0] ?? "", "connection", mailbox);
      }
      // oxlint-disable-next-line no-await-in-loop -- one App at a time
      const grant = await storedGrant(
        { type: "app", id: app },
        { type: "connection", id: mail.id },
        ["mail.list"],
        "MAIL"
      );
      grants.push(grant);
    }

    const all = await anna.api.permissions.list();
    const listed = all
      .filter(
        ({ subject }) =>
          subject.type === "app" && shared.includes(subject.appId)
      )
      .map(({ id }) => id);
    expect(new Set(listed)).toStrictEqual(new Set(grants.slice(0, -1)));
  });
});

/** Apps shared at once that all reach one graph wider than the walk's cap. */
const hubApps = 40;
/** Workflows the App they all call follows: past the cap on its own. */
const hubWorkflows = 600;
/**
 * Queries deciding them all may take: a walk again for each, querying the
 * same graph, would take over a dozen apiece.
 */
const maxQueries = 30;

/** `env`, counting the statements prepared on its core database. */
const countingEnv = (): { counted: Env; queries: () => number } => {
  let prepared = 0;
  const db: D1Database = {
    prepare: (query) => {
      prepared += 1;
      return env.DB.prepare(query);
    },
    batch: async (statements) => await env.DB.batch(statements),
    exec: async (query) => await env.DB.exec(query),
    withSession: (constraint) => env.DB.withSession(constraint),
    // oxlint-disable-next-line typescript/no-deprecated -- the type still declares it; nothing calls it
    dump: async () => await Promise.reject(new Error("Not counted")),
  };
  return { counted: { ...env, DB: db }, queries: () => prepared };
};

describe("deciding many Apps that reach one wide graph", () => {
  it("queries each part of the graph once, however many Apps reach it, and still decides each App", async () => {
    const owner = await personApi("builder");
    const [hub, medium, wide, small] = await Promise.all([
      newApp(owner),
      newApp(owner),
      newApp(owner),
      newApp(owner),
    ]);
    const bound = await Promise.all(
      Array.from({ length: hubApps }, async () => await newApp(owner))
    );
    // Every one of `bound` calls `hub`, which follows more workflows than
    // the walk follows: none of them passes, alone or together.
    await Promise.all(
      bound.map(async (app) => {
        await linked(app, hub);
      })
    );
    await env.DB.batch(
      Array.from({ length: hubWorkflows }, () =>
        grantStatement(
          "app",
          hub,
          "workflow",
          `workflow_${unique().replaceAll("-", "")}`,
          ["read"]
        )
      )
    );
    // `medium` calls an App following fewer: it passes on its own, once
    // the batch has tripped the cap. `small` reaches nothing.
    await linked(medium, wide);
    await env.DB.batch(
      Array.from({ length: workflowsEach }, () =>
        grantStatement(
          "app",
          wide,
          "workflow",
          `workflow_${unique().replaceAll("-", "")}`,
          ["read"]
        )
      )
    );
    const asked = [medium, small, ...bound].map((id) => appIdSchema.parse(id));
    const { counted, queries } = countingEnv();

    const sources = await sourcesOfApps(counted, asked);

    expect(
      Object.fromEntries(
        asked.map((app) => [app, sources.get(app)?.unresolved])
      )
    ).toStrictEqual({
      [medium]: [],
      [small]: [],
      ...Object.fromEntries(bound.map((app) => [app, ["app:*"]])),
    });
    expect(queries()).toBeLessThanOrEqual(maxQueries);
  });
});
