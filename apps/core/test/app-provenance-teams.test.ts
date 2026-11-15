import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { outlook, published, requestGranted } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { newTeam } from "./knowledge.ts";
import { firstVersion, outcome, signedInApi, unique } from "./sign-in.ts";
import { connectDb } from "./test-env.ts";

// Provenance on sharing, for what an App recalled of a team's Brain: only
// that team's people may read it, so sharing the App must reach nobody
// outside the team. The ways this could go wrong, tried below: sharing it
// with someone outside the team, directly or through another team;
// someone joining a team the App is shared with; the grant naming another
// team later; and a team too large to check person by person. In a file of
// its own: once any grant names a team, every App's walk runs
// (`anyTeamGrant` in app-provenance.ts), which the depth tests of
// app-provenance.test.ts must not see.

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

/**
 * `app` granted to read the Brain of `team`, asked for by `owner`, who is
 * in it: what it recalled of it only the team's people may read. Returns
 * the grant's ID.
 */
const brainTeamFor = async (
  owner: Person,
  app: string,
  team: string
): Promise<string> =>
  await requestGranted(idp, owner, {
    subject: { type: "app", appId: app },
    object: { type: "platform", teams: [team] },
    actions: ["brain"],
    binding: `BRAIN_${unique().toUpperCase().replaceAll("-", "_")}`,
  });

/** The Brain grant `grant` names `team` alone from now on. */
const narrowedTo = async (grant: string, team: string): Promise<void> => {
  await env.DB.prepare("UPDATE permissions SET teams = ? WHERE id = ?")
    .bind(JSON.stringify([team]), grant)
    .run();
};

/**
 * A team as large as a whole department: sharing with it still answers,
 * naming exactly the people who can't read what the App read.
 */
const teamSize = 120;

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

describe("sharing an App that recalled a team's Brain", () => {
  it("is refused for the people of a team who can't read a team's Brain content the App read", async () => {
    const admin = await personApi("admin");
    const owner = await personApi("builder");
    const [anna, ben] = await Promise.all([
      personApi("user"),
      personApi("user"),
    ]);
    const hr = await newTeam(admin, [owner, anna]);
    const everyone = await newTeam(admin, [anna, ben]);
    const app = await newApp(owner);
    await brainTeamFor(owner, app, hr);

    await expect(
      Promise.all([
        shareRefusal(owner, app, { type: "person", id: anna.userId }),
        shareRefusal(owner, app, { type: "team", id: everyone }),
        shareRefusal(owner, app, { type: "person", id: ben.userId }),
      ])
    ).resolves.toStrictEqual([
      "ok",
      { sources: [`brain:${hr}`], people: [ben.userId] },
      { sources: [`brain:${hr}`], people: [ben.userId] },
    ]);
  });

  // Knowledge is gone (GRA-1735), but an App granted a collection before
  // may still hold what it read there, and nothing can say who may read
  // that now: it fails closed, as a source that doesn't resolve.
  it("stops reaching someone once the App is granted what they can't read, or they join a team it reaches", async () => {
    const admin = await personApi("admin");
    const owner = await personApi("builder");
    const [anna, ben] = await Promise.all([
      personApi("user"),
      personApi("user"),
    ]);
    const hr = await newTeam(admin, [owner, anna, admin]);
    const shared = await newTeam(admin, [anna]);
    const app = await newApp(owner);
    await brainTeamFor(owner, app, hr);
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

  it("stops reaching someone once the Brain grant the App read under names a team they aren't in", async () => {
    const admin = await personApi("admin");
    const owner = await personApi("builder");
    const anna = await personApi("user");
    const [readers, others] = await Promise.all([
      newTeam(admin, [anna, owner]),
      newTeam(admin, []),
    ]);
    const app = await newApp(owner);
    const grant = await brainTeamFor(owner, app, readers);
    await owner.api.apps.members.add(app, {
      type: "person",
      id: anna.userId,
      role: "user",
    });
    await expect(outcome(anna.api.apps.get(app))).resolves.toBe("ok");

    await narrowedTo(grant, others);
    await expect(outcome(anna.api.apps.get(app))).resolves.toBe(
      "app.unreadable"
    );
  });

  it("leaves out of a project's page and counts an App shared with it that someone in it may no longer read", async () => {
    const admin = await personApi("admin");
    const owner = await personApi("builder");
    const anna = await personApi("user");
    const [readers, others] = await Promise.all([
      newTeam(admin, [anna, owner]),
      newTeam(admin, [owner]),
    ]);
    const app = await newApp(owner);
    const grant = await brainTeamFor(owner, app, readers);
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

    // What the App read is now another team's alone.
    await narrowedTo(grant, others);

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
    const readers = await newTeam(admin, [owner]);
    const app = await newApp(owner);
    await brainTeamFor(owner, app, readers);
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
        // All but two of them read what the App read of the Brain too.
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
});
