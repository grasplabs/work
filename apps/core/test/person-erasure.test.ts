import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import { runMinuteTasks } from "./maintenance.ts";
import {
  auditedDuring,
  googlePerson,
  openRpc,
  outcome,
  signIn,
  signedIn,
  signedInApi,
  staffPerson,
} from "./sign-in.ts";

// Erasing a person (GRA-903, GRA-1180), from its threat model first. An
// admin erases someone they removed: their email, sign-ins and personal
// content go; their name and ID stay on the company's records, so what
// they did stays traceable (Nick: "user can be deleted but it should
// still show the name of the person, so its still traceable"). The ways
// it can go wrong:
// - erasing the wrong person: a stale ID, a mix-up of two people, or
//   someone still a member;
// - someone other than one of the client's admins asking: the person
//   themselves, a builder, Grasp staff, an agent;
// - an erasure that stops halfway, and is never finished;
// - the erased person coming back: signing in again, or being invited,
//   under the email that was theirs, or signing in as who they were under
//   another address;
// - their name lost from the company's records, so nobody can tell who
//   did what;
// - a record of it with more than IDs, or recorded twice.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

/** The row core keeps of `userId`. */
const userRow = async (userId: string) =>
  await env.DB.prepare(
    "SELECT name, email, email_verified AS verified, image FROM users WHERE id = ?"
  )
    .bind(userId)
    .first<{
      name: string;
      email: string;
      verified: number;
      image: string | null;
    }>();

/** The email core keeps of `userId`. */
const emailOf = async (userId: string): Promise<string | undefined> => {
  const row = await userRow(userId);
  return row?.email;
};

/** How many of `table`'s rows hold `userId` in `column`. */
const rowsOf = async (table: string, column: string, userId: string) => {
  const row = await env.DB.prepare(
    `SELECT count(*) AS count FROM ${table} WHERE ${column} = ?`
  )
    .bind(userId)
    .first<{ count: number }>();
  return row?.count ?? 0;
};

/**
 * What core holds of someone signing in as `claims`: users under their
 * email, and accounts under their IdP's subject.
 */
const storedOf = async (claims: Record<string, unknown>) => {
  const users = await env.DB.prepare(
    "SELECT count(*) AS count FROM users WHERE lower(email) = lower(?)"
  )
    .bind(String(claims.email))
    .first<{ count: number }>();
  const held = await env.DB.prepare(
    "SELECT count(*) AS count FROM accounts WHERE account_id = ?"
  )
    .bind(String(claims.sub))
    .first<{ count: number }>();
  return { users: users?.count ?? 0, accounts: held?.count ?? 0 };
};

/** How many invitations went to `address`, in any case. */
const invitedOf = async (address: string): Promise<number> => {
  const row = await env.DB.prepare(
    "SELECT count(*) AS count FROM invitations WHERE lower(email) = lower(?)"
  )
    .bind(address)
    .first<{ count: number }>();
  return row?.count ?? 0;
};

/** An admin, and someone else they removed. */
const removedPerson = async (): Promise<{ admin: Person; person: Person }> => {
  const admin = await signedInApi(idp, "admin");
  const person = await signedInApi(idp, "builder");
  await admin.api.members.remove(person.userId);
  return { admin, person };
};

describe("erasing a person", () => {
  it("erases their email and every sign-in, keeping only their name and ID", async () => {
    const { admin, person } = await removedPerson();
    const name = String(person.person.name);
    const email = String(person.person.email);
    const preview = await admin.api.members.erasure(person.userId);

    const erased = await admin.api.members.erase(person.userId, name);

    const row = await userRow(person.userId);
    expect({
      preview,
      erased: {
        ...erased,
        requestedAt: typeof erased.requestedAt,
        completedAt: typeof erased.completedAt,
      },
      name: row?.name,
      emailKept: row?.email.toLowerCase() === email.toLowerCase(),
      emailLooksLikeOne: row?.email.includes(email.split("@")[0] ?? email),
      verified: row?.verified,
      image: row?.image,
      accounts: await rowsOf("accounts", "user_id", person.userId),
      sessions: await rowsOf("sessions", "user_id", person.userId),
      after: await admin.api.members.erasure(person.userId),
    }).toMatchObject({
      preview: {
        userId: person.userId,
        name,
        email,
        removed: true,
        erasure: null,
      },
      erased: {
        requestedAt: "string",
        completedAt: "string",
        areas: [
          { area: "identity", state: "complete" },
          { area: "channels", state: "complete" },
        ],
      },
      name,
      emailKept: false,
      emailLooksLikeOne: false,
      verified: 0,
      image: null,
      accounts: 0,
      sessions: 0,
      after: { name, email: null, removed: true },
    });
  });

  it("keeps their name on the company's records, so what they did stays traceable", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "builder");
    const name = String(person.person.name);
    // A record of theirs the company keeps: an app they asked Grasp for.
    const asked = await person.api.connections.requestApp({
      name: `Wanted ${crypto.randomUUID().slice(0, 8)}`,
    });
    await admin.api.members.remove(person.userId);

    await admin.api.members.erase(person.userId, name);

    const requests = await admin.api.connections.appRequests();
    expect(
      requests.find(({ id }) => id === asked.id)?.requestedBy
    ).toStrictEqual({ userId: person.userId, name });
  });

  it("is for the client's admins only: not the person, a builder or Grasp staff, and a refusal changes and records nothing", async () => {
    const { person } = await removedPerson();
    const name = String(person.person.name);
    const builder = await signedInApi(idp, "builder");
    const staff = await signedIn(idp, "grasp-staff", staffPerson());
    const { core } = await openRpc(staff);
    const staffApi = core.authenticate();
    const audited = await auditedDuring(async () => {
      await expect(
        Promise.all([
          outcome(builder.api.members.erasure(person.userId)),
          outcome(builder.api.members.erase(person.userId, name)),
          outcome(staffApi.members.erasure(person.userId)),
          outcome(staffApi.members.erase(person.userId, name)),
        ])
      ).resolves.toStrictEqual([
        "role.forbidden",
        "role.forbidden",
        "role.forbidden",
        "role.forbidden",
      ]);
    });
    expect(audited).toStrictEqual([]);
    await expect(emailOf(person.userId)).resolves.toBe(
      String(person.person.email)
    );
  });

  it("refuses someone still a member, the admin themselves, and a name that isn't theirs now", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    const { person } = await removedPerson();
    const audited = await auditedDuring(async () => {
      await expect(
        Promise.all([
          outcome(
            admin.api.members.erase(member.userId, String(member.person.name))
          ),
          outcome(
            admin.api.members.erase(admin.userId, String(admin.person.name))
          ),
          // Another person's name, or theirs in other letters: a mix-up.
          outcome(
            admin.api.members.erase(person.userId, String(member.person.name))
          ),
          outcome(
            admin.api.members.erase(
              person.userId,
              String(person.person.name).toUpperCase()
            )
          ),
        ])
      ).resolves.toStrictEqual([
        "member.erase_not_removed",
        "member.self",
        "member.erase_name_mismatch",
        "member.erase_name_mismatch",
      ]);
    });
    expect(audited).toStrictEqual([]);
    await expect(emailOf(person.userId)).resolves.toBe(
      String(person.person.email)
    );
    await expect(emailOf(member.userId)).resolves.toBe(
      String(member.person.email)
    );
  });

  it("keeps them out: signing in again under their old email gives no session, and they can't be invited back", async () => {
    const { admin, person } = await removedPerson();
    await admin.api.members.erase(person.userId, String(person.person.name));

    const again = await signIn(idp, "microsoft", person.person);
    expect(again.session).toBeUndefined();
    // Refused before Better Auth wrote anything of theirs again.
    await expect(storedOf(person.person)).resolves.toStrictEqual({
      users: 0,
      accounts: 0,
    });
    await expect(
      outcome(admin.api.members.invite(String(person.person.email), "user"))
    ).resolves.toBe("member.invite_removed");
    const listed = await admin.api.members.list();
    expect(listed.map(({ email }) => email)).not.toContain(
      String(person.person.email)
    );
  });

  it("keeps them out under another address too: the identity their IdP verified was theirs", async () => {
    const { admin, person } = await removedPerson();
    await admin.api.members.erase(person.userId, String(person.person.name));
    const [, domain] = String(person.person.email).split("@");

    const renamed = {
      ...person.person,
      email: `renamed-${crypto.randomUUID().slice(0, 8)}@${domain}`,
    };

    const again = await signIn(idp, "microsoft", renamed);

    expect({
      session: again.session,
      stored: await storedOf(renamed),
    }).toStrictEqual({
      session: undefined,
      stored: { users: 0, accounts: 0 },
    });
  });

  it("answers where it stands when asked again, and is recorded once, by IDs only", async () => {
    const { admin, person } = await removedPerson();
    const name = String(person.person.name);
    const audited = await auditedDuring(async () => {
      const first = await admin.api.members.erase(person.userId, name);
      // Once erased, the name they had still asks for them.
      const again = await admin.api.members.erase(person.userId, name);
      expect(again).toStrictEqual(first);
    });
    const requested = audited.filter(
      ({ action }) => action === "member.erasure.requested"
    );
    const completed = audited.filter(
      ({ action }) => action === "member.erased"
    );
    expect({
      requested: requested.length,
      completed: completed.length,
      record: requested[0],
    }).toMatchObject({
      requested: 1,
      completed: 1,
      record: {
        source: "core",
        actor: { type: "person", userId: admin.userId },
        target: { type: "member" },
        detail: { userId: person.userId },
      },
    });
    const text = JSON.stringify(audited);
    expect(text).not.toContain(String(person.person.email));
    expect(text).not.toContain(name);
  });

  it("is finished by the clock once an area failed, however it stopped", async () => {
    const { admin, person } = await removedPerson();
    const name = String(person.person.name);
    // The area fails as the request runs it: its sign-ins can't go yet.
    await env.DB.prepare(
      `CREATE TRIGGER IF NOT EXISTS keep_accounts_${person.userId.replaceAll("-", "_")}
       BEFORE DELETE ON accounts WHEN OLD.user_id = '${person.userId}'
       BEGIN SELECT RAISE(ABORT, 'held by the test'); END`
    ).run();
    const pending = await admin.api.members.erase(person.userId, name);
    await env.DB.prepare(
      `DROP TRIGGER keep_accounts_${person.userId.replaceAll("-", "_")}`
    ).run();
    const meanwhile = {
      email: await emailOf(person.userId),
      accounts: await rowsOf("accounts", "user_id", person.userId),
    };

    await runMinuteTasks();

    const done = await admin.api.members.erasure(person.userId);
    expect({
      pending,
      meanwhile,
      done: {
        email: done.email,
        completed: typeof done.erasure?.completedAt,
        areas: done.erasure?.areas,
      },
      accounts: await rowsOf("accounts", "user_id", person.userId),
    }).toMatchObject({
      pending: {
        completedAt: null,
        areas: [
          { area: "identity", state: "pending" },
          { area: "channels", state: "complete" },
        ],
      },
      // Nothing of the area went: one statement, or none of it.
      meanwhile: { email: String(person.person.email), accounts: 1 },
      done: {
        email: null,
        completed: "string",
        areas: [
          { area: "identity", state: "complete" },
          { area: "channels", state: "complete" },
        ],
      },
      accounts: 0,
    });
  });

  it("keeps out an account linked while the erasure ran too, finishing once it is gone", async () => {
    const { admin, person } = await removedPerson();
    const late = googlePerson();
    const trigger = `late_account_${person.userId.replaceAll("-", "_")}`;
    // An account linked to them as the erasure's batch deletes theirs,
    // after it read which they had.
    await env.DB.prepare(
      `CREATE TRIGGER ${trigger}
       AFTER DELETE ON accounts WHEN OLD.user_id = '${person.userId}'
       BEGIN
         INSERT OR IGNORE INTO accounts (id, account_id, provider_id, user_id, created_at, updated_at)
         VALUES ('${crypto.randomUUID()}', '${String(late.sub)}', 'google', '${person.userId}', 0, 0);
       END`
    ).run();
    const pending = await admin.api.members.erase(
      person.userId,
      String(person.person.name)
    );
    await env.DB.prepare(`DROP TRIGGER ${trigger}`).run();
    const meanwhile = await rowsOf("accounts", "user_id", person.userId);

    await runMinuteTasks();

    const done = await admin.api.members.erasure(person.userId);
    const again = await signIn(idp, "google", late);
    expect({
      stored: await storedOf(late),
      // The identity area's own; any other area finishes on its own.
      pending: pending.areas.filter(({ area }) => area === "identity"),
      meanwhile,
      done: done.erasure?.areas.filter(({ area }) => area === "identity"),
      accounts: await rowsOf("accounts", "user_id", person.userId),
      session: again.session,
    }).toStrictEqual({
      pending: [{ area: "identity", state: "pending" }],
      meanwhile: 1,
      done: [{ area: "identity", state: "complete" }],
      accounts: 0,
      session: undefined,
      stored: { users: 0, accounts: 0 },
    });
  });

  it("keeps their old address out until an admin releases it, audited by ID only, and only for admins", async () => {
    const { admin, person } = await removedPerson();
    const email = String(person.person.email);
    await admin.api.members.erase(person.userId, String(person.person.name));
    const builder = await signedInApi(idp, "builder");
    const before = await admin.api.members.erasure(person.userId);

    const audited = await auditedDuring(async () => {
      await expect(
        outcome(builder.api.members.releaseAddress(email))
      ).resolves.toBe("role.forbidden");
      await expect(
        admin.api.members.releaseAddress(email.toUpperCase())
      ).resolves.toStrictEqual({ released: true });
      // Released already, or never an erased person's: nothing to release.
      await expect(
        admin.api.members.releaseAddress(email)
      ).resolves.toStrictEqual({ released: false });
    });

    const invited = await admin.api.members.invite(email, "user");
    const after = await admin.api.members.erasure(person.userId);
    const released = audited.filter(
      ({ action }) => action === "member.address.released"
    );
    expect({
      before: before.addressKeptOut,
      after: after.addressKeptOut,
      invited: invited.email,
      released: released.map(({ actor, detail }) => ({ actor, detail })),
      text: JSON.stringify(released).includes(email.split("@")[0] ?? email),
    }).toStrictEqual({
      before: true,
      after: false,
      invited: email.toLowerCase(),
      released: [
        {
          actor: { type: "person", userId: admin.userId },
          detail: { userId: person.userId },
        },
      ],
      text: false,
    });
  });

  it("takes out how they were reached: their chat accounts and links, conversations, offers, invitations to their old address, notifications and teams", async () => {
    const { admin, person } = await removedPerson();
    const { userId } = person;
    const email = String(person.person.email);
    const now = Date.now();
    // What came back, or was left, since they were removed.
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO channel_accounts (id, platform, platform_user_id, user_id, name, linked_at, linked_how) VALUES (?, 'teams', ?, ?, 'Them on Teams', ?, 'sign_in_link')"
      ).bind(crypto.randomUUID(), `teams-${userId}`, userId, now),
      env.DB.prepare(
        "INSERT INTO channel_links (secret_hash, platform, platform_user_id, name, created_at, expires_at, used_at, used_by) VALUES (?, 'teams', ?, 'Them on Teams', ?, ?, ?, ?)"
      ).bind(
        `hash-${userId}`,
        `teams-${userId}`,
        now,
        now + 60_000,
        now,
        userId
      ),
      env.DB.prepare(
        "INSERT INTO channel_conversations (platform, thread_id, user_id, created_at, last_message_at) VALUES ('teams', ?, ?, ?, ?)"
      ).bind(`thread-${userId}`, userId, now, now),
      env.DB.prepare(
        "INSERT INTO chat_workflow_offers (id, user_id, workspace_id, chat_id, workflow_id, workflow_name, version, input, created_at, expires_at) VALUES (?, ?, 'workspace', 'chat', 'workflow', 'Follow-up', 1, '{}', ?, ?)"
      ).bind(crypto.randomUUID(), userId, now, now + 60_000),
      env.DB.prepare(
        "INSERT INTO invitations (id, organization_id, email, role, status, expires_at, created_at, inviter_id) VALUES (?, 'organization', ?, 'user', 'accepted', ?, ?, ?)"
      ).bind(
        crypto.randomUUID(),
        email.toUpperCase(),
        now + 60_000,
        now,
        admin.userId
      ),
      env.DB.prepare(
        "INSERT INTO notifications (id, person_id, type, created_at, updated_at) VALUES (?, ?, 'run_failed', ?, ?)"
      ).bind(crypto.randomUUID(), userId, now, now),
    ]);
    // A team of theirs that came back.
    const team = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO teams (id, name, organization_id, created_at) VALUES (?, 'Theirs', 'organization', ?)"
      ).bind(team, now),
      env.DB.prepare(
        "INSERT INTO team_members (id, team_id, user_id, created_at) VALUES (?, ?, ?, ?)"
      ).bind(crypto.randomUUID(), team, userId, now),
    ]);
    const seeded = await rowsOf("team_members", "user_id", userId);
    // Someone else's, which stays.
    const other = `other-${crypto.randomUUID().slice(0, 8)}@acme.test`;
    await env.DB.prepare(
      "INSERT INTO invitations (id, organization_id, email, role, status, expires_at, created_at, inviter_id) VALUES (?, 'organization', ?, 'user', 'pending', ?, ?, ?)"
    )
      .bind(crypto.randomUUID(), other, now + 60_000, now, admin.userId)
      .run();

    await admin.api.members.erase(userId, String(person.person.name));

    expect({
      seeded,
      accounts: await rowsOf("channel_accounts", "user_id", userId),
      links: await rowsOf("channel_links", "used_by", userId),
      conversations: await rowsOf("channel_conversations", "user_id", userId),
      offers: await rowsOf("chat_workflow_offers", "user_id", userId),
      notifications: await rowsOf("notifications", "person_id", userId),
      teams: await rowsOf("team_members", "user_id", userId),
      invitedThem: await invitedOf(email),
      invitedOther: await invitedOf(other),
    }).toStrictEqual({
      seeded: 1,
      accounts: 0,
      links: 0,
      conversations: 0,
      offers: 0,
      notifications: 0,
      teams: 0,
      invitedThem: 0,
      invitedOther: 1,
    });
  });

  it("takes out every invitation to their old address, however many there were", async () => {
    const { admin, person } = await removedPerson();
    const email = String(person.person.email);
    const now = Date.now();
    await env.DB.batch(
      Array.from({ length: 150 }, (_, index) =>
        env.DB.prepare(
          "INSERT INTO invitations (id, organization_id, email, role, status, expires_at, created_at, inviter_id) VALUES (?, 'organization', ?, 'user', 'canceled', ?, ?, ?)"
        ).bind(
          crypto.randomUUID(),
          index % 2 === 0 ? email : email.toUpperCase(),
          now + 60_000,
          now - index,
          admin.userId
        )
      )
    );

    const erased = await admin.api.members.erase(
      person.userId,
      String(person.person.name)
    );

    expect({
      channels: erased.areas.find(({ area }) => area === "channels")?.state,
      invited: await invitedOf(email),
    }).toStrictEqual({ channels: "complete", invited: 0 });
  });

  it("keeps the invitation of someone the address was released to while their erasure ran", async () => {
    const { admin, person } = await removedPerson();
    const email = String(person.person.email);
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO invitations (id, organization_id, email, role, status, expires_at, created_at, inviter_id) VALUES (?, 'organization', ?, 'user', 'accepted', ?, ?, ?)"
    )
      .bind(crypto.randomUUID(), email, now + 60_000, now, admin.userId)
      .run();
    // Core's database as the erasure reaches it: just before the batch
    // that takes out their invitations, after it read which were theirs,
    // an admin releases the address and invites its new owner.
    const deletes = new WeakSet<D1PreparedStatement>();
    const tagged = (statement: D1PreparedStatement): D1PreparedStatement => {
      deletes.add(statement);
      const bind = statement.bind.bind(statement);
      statement.bind = (...values) => tagged(bind(...values));
      return statement;
    };
    let reinvited: Promise<{ id: string }> | undefined;
    const real = env.DB;
    const interleaved: D1Database = {
      prepare: (query) => {
        const statement = real.prepare(query);
        return /^delete from "invitations"/iu.test(query)
          ? tagged(statement)
          : statement;
      },
      batch: async <T>(statements: D1PreparedStatement[]) => {
        if (statements.some((statement) => deletes.has(statement))) {
          reinvited ??= (async () => {
            await admin.api.members.releaseAddress(email);
            return await admin.api.members.invite(email, "user");
          })();
          await reinvited;
        }
        return await real.batch<T>(statements);
      },
      exec: async (query) => await real.exec(query),
      // oxlint-disable-next-line typescript/no-deprecated -- D1Database still has it
      dump: async () => await real.dump(),
      withSession: (constraint) => real.withSession(constraint),
    };
    // Their address goes first, their invitations on a later try: the
    // area that takes them out fails the first time, as it would on a
    // failure of the database, and the clock runs it again.
    const trigger = `keep_channels_${person.userId.replaceAll("-", "_")}`;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO channel_accounts (id, platform, platform_user_id, user_id, name, linked_at, linked_how) VALUES (?, 'teams', ?, ?, 'Them on Teams', ?, 'sign_in_link')"
      ).bind(crypto.randomUUID(), `teams-${person.userId}`, person.userId, now),
      env.DB.prepare(
        `CREATE TRIGGER ${trigger} BEFORE DELETE ON channel_accounts
         WHEN OLD.user_id = '${person.userId}'
         BEGIN SELECT RAISE(ABORT, 'held by the test'); END`
      ),
    ]);
    await admin.api.members.erase(person.userId, String(person.person.name));
    await env.DB.prepare(`DROP TRIGGER ${trigger}`).run();

    await runMinuteTasks({ DB: interleaved });

    const newOwner = await reinvited;
    const { results } = await env.DB.prepare(
      "SELECT id FROM invitations WHERE lower(email) = lower(?)"
    )
      .bind(email)
      .all<{ id: string }>();
    const after = await admin.api.members.erasure(person.userId);
    expect({
      invitations: results.map(({ id }) => id),
      channels: after.erasure?.areas.find(({ area }) => area === "channels")
        ?.state,
    }).toStrictEqual({ invitations: [newOwner?.id], channels: "complete" });
  });
});
