import { errorPayloadSchema } from "@grasp-os/shared/errors";
import { storeIdSchema } from "@grasp-os/shared/ids";
import { interviewApiPath } from "@grasp-os/shared/interview-links";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { setCurrentVersion } from "../src/apps.ts";
import { personalWorkspaceId } from "../src/chats-rpc.ts";
import { workspace, inJurisdiction } from "../src/durable-objects.ts";
import { modelLedger } from "../src/model-ledger.ts";
import { onboardingStore } from "../src/onboarding/store.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { allEvents } from "./audit-events.ts";
import { consentCode } from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import { runMinuteTasks } from "./maintenance.ts";
import { appWith, seal } from "./sealed-apps.ts";
import { acmeTenant } from "./sign-in-config.ts";
import {
  auditedDuring,
  googlePerson,
  openRpc,
  outcome,
  routed,
  signIn,
  signedIn,
  signedInApi,
  staffPerson,
} from "./sign-in.ts";
import { connectDb } from "./test-env.ts";

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

/** A note `who` keeps in their own Personal collection. */
const noteOf = async (who: Person, text: string) => {
  const { personal } = await who.api.memory.collections();
  return await who.api.knowledge.saveDocument({
    collectionId: personal,
    path: `notes/${crypto.randomUUID().slice(0, 8)}.md`,
    text,
    ifVersion: 0,
  });
};

/** Whether Knowledge still has document `documentId`. */
const inKnowledge = async (documentId: string): Promise<number> => {
  const row = await env.KNOWLEDGE.prepare(
    "SELECT count(*) AS count FROM documents WHERE id = ?"
  )
    .bind(documentId)
    .first<{ count: number }>();
  return row?.count ?? 0;
};

/** Whether run `runId` of an independent workflow was asked to stop. */
const stopAsked = async (runId: string): Promise<boolean> => {
  const row = await env.DB.prepare(
    "SELECT stop_requested_at AS asked FROM workflow_resource_runs WHERE id = ?"
  )
    .bind(runId)
    .first<{ asked: number | null }>();
  return row?.asked !== null && row?.asked !== undefined;
};

/** Runs `sql` in the deployment's onboarding store: its rows. */
const onList = async (sql: string, ...values: unknown[]) =>
  await runInDurableObject(onboardingStore(env), (_instance, state) =>
    state.storage.sql.exec(sql, ...values).toArray()
  );

/** What a link's page gets opening it with `secret`: open, or the refusal. */
const sessionWith = async (secret: string): Promise<string> => {
  const response = await routed(interviewApiPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "session", secret }),
  });
  if (response.ok) {
    return "open";
  }
  const payload = errorPayloadSchema.safeParse(await response.json());
  return payload.success ? payload.data.code : String(response.status);
};

/**
 * Someone with `email` and someone else on the onboarding's list, both
 * sent their links: their IDs and their links' secrets.
 */
const onTheList = async (email: string) => {
  const ids = { team: `ops-${crypto.randomUUID().slice(0, 8)}` };
  const theirs = `person-${crypto.randomUUID().slice(0, 8)}`;
  const others = `person-${crypto.randomUUID().slice(0, 8)}`;
  const store = onboardingStore(env);
  const by = { type: "system" } as const;
  await store.setPaused(false, by);
  await store.saveRoster(
    {
      teams: [{ id: ids.team, name: "Ops", lead: null, does: "", off: false }],
      people: [
        {
          id: theirs,
          name: "Them",
          team: ids.team,
          // Their list address, in other letters.
          email: email.toUpperCase(),
          title: "",
          away: false,
        },
        {
          id: others,
          name: "Someone else",
          team: ids.team,
          email: `other-${crypto.randomUUID().slice(0, 8)}@acme.test`,
          title: "",
          away: false,
        },
      ],
    },
    by
  );
  await store.savePlan(
    {
      start: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
      days: 14,
    },
    by
  );
  await store.setAgreements(
    { processing: true, assessment: true, council: "none" },
    by
  );
  await store.releaseDue();
  const secretOf = async (id: string) => {
    const link = await store.linkOf(id);
    return link?.split("#")[1] ?? "";
  };
  const theirSecret = await secretOf(theirs);
  const otherSecret = await secretOf(others);
  return { theirs, others, theirSecret, otherSecret };
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

/** Connects `person`'s own Microsoft account as a personal connection. */
const connectOwnAccount = async (person: Person): Promise<string> => {
  const { url } = await person.api.connections.start({
    provider: "microsoft",
    scope: "personal",
  });
  const authorization = new URL(url);
  const query = new URLSearchParams({
    code: consentCode(authorization, acmeTenant, String(person.person.oid)),
    state: authorization.searchParams.get("state") ?? "",
  });
  await routed(`/api/connections/callback?${query.toString()}`, {
    headers: { cookie: person.session },
  });
  const [connection] = await person.api.connections.list();
  if (connection === undefined) {
    throw new Error("Not connected");
  }
  return connection.id;
};

/** What connect keeps of connection `id`, and its tokens and calls. */
const keptInConnect = async (id: string) => {
  const db = connectDb();
  const row = await db
    .prepare(
      "SELECT status, account_id AS accountId, account_name AS accountName, account_email AS accountEmail, account_addresses AS addresses, account_senders AS senders FROM connections WHERE id = ?"
    )
    .bind(id)
    .first<Record<string, string | null>>();
  const count = async (table: string) => {
    const counted = await db
      .prepare(`SELECT count(*) AS count FROM ${table} WHERE connection_id = ?`)
      .bind(id)
      .first<{ count: number }>();
    return counted?.count ?? 0;
  };
  return {
    status: row?.status,
    named: [
      row?.accountId,
      row?.accountName,
      row?.accountEmail,
      row?.addresses,
      row?.senders,
    ].some((value) => value !== null && value !== undefined),
    tokens: await count("connection_tokens"),
    calls: await count("idempotent_calls"),
  };
};

/** A call through connection `id` for `userId`, as connect keeps it. */
const madeCall = async (id: string, userId: string): Promise<void> => {
  await connectDb()
    .prepare(
      "INSERT INTO idempotent_calls (subject_type, subject_id, on_behalf_of, connection_id, action, idempotency_key, input_hash, state, output, created_at) VALUES ('app', 'app', ?, ?, 'mail.list', ?, 'h', 'done', '{\"subject\":\"Their mail\"}', ?)"
    )
    .bind(userId, id, crypto.randomUUID(), Date.now())
    .run();
};

/** How many rows of `table` `userId`'s own workspace holds. */
const inWorkspace = async (userId: string, table: string): Promise<number> =>
  await runInDurableObject(
    workspace(env, personalWorkspaceId(userId)),
    (_instance, state) =>
      state.storage.sql
        .exec<{ count: number }>(`SELECT count(*) AS count FROM ${table}`)
        .one().count
  );

/** The env a Durable Object instance runs with. */
const envOf = (instance: object): object => {
  const objectEnv: unknown = Reflect.get(instance, "env");
  if (typeof objectEnv !== "object" || objectEnv === null) {
    throw new TypeError("The object has no env");
  }
  return objectEnv;
};

/** An App with preferences, sealed, current, and its store's ID. */
const appWithPreferences = async () => {
  const fixture = await appWith(
    {
      "schema.ts": `import { defineSchema } from "@grasp-os/sdk";

export default defineSchema({});
`,
      "app.ts": `import { app, v } from "@grasp-os/sdk";
import schema from "./schema.ts";

export default app({
  name: "Desk",
  schema,
  access: { tables: {} },
  operations: {},
  screens: [{ name: "desk", path: "/", source: "screens/desk.tsx" }],
  preferences: v.object({ theme: v.enum(["light", "dark"]).default("light") }),
  uses: [],
});
`,
      "screens/desk.tsx": `export default function Desk() {
  return <main>Desk</main>;
}
`,
    },
    "Desk"
  );
  const release = await seal(fixture);
  await setCurrentVersion(env, fixture.owner, fixture.app, 1);
  return {
    app: fixture.app,
    storeId: storeIdSchema.parse(release.store?.storeId),
  };
};

/** Runs `run` on store `storeId`'s own SQL. */
const inStore = async <T>(
  storeId: string,
  run: (sql: SqlStorage) => T
): Promise<T> =>
  await runInDurableObject(
    inJurisdiction(env, env.DATA_STORES).getByName(
      storeIdSchema.parse(storeId)
    ),
    (_instance, state) => run(state.storage.sql)
  );

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
          { area: "connect", state: "complete" },
          { area: "workspace", state: "complete" },
          { area: "apps", state: "complete" },
          { area: "interview", state: "complete" },
          { area: "runs", state: "complete" },
          { area: "brain", state: "complete" },
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
          { area: "connect", state: "complete" },
          { area: "workspace", state: "complete" },
          { area: "apps", state: "complete" },
          { area: "interview", state: "complete" },
          { area: "runs", state: "complete" },
          { area: "brain", state: "complete" },
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
          { area: "connect", state: "complete" },
          { area: "workspace", state: "complete" },
          { area: "apps", state: "complete" },
          { area: "interview", state: "complete" },
          { area: "runs", state: "complete" },
          { area: "brain", state: "complete" },
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

  it("purges what the Brain and Knowledge hold of them, their Personal collection with it, and leaves everyone else's", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "builder");
    const other = await signedInApi(idp, "user");
    const theirs = await noteOf(person, "# Mine\nWhat only I wrote down.");
    const others = await noteOf(other, "# Theirs\nWhat someone else wrote.");
    await admin.api.members.remove(person.userId);

    await admin.api.members.erase(person.userId, String(person.person.name));

    expect({
      theirs: await inKnowledge(theirs.id),
      others: await inKnowledge(others.id),
    }).toStrictEqual({ theirs: 0, others: 1 });
  });

  it("stops what still runs for them, and takes their decision confirmations and model limit, and leaves everyone else's", async () => {
    const { admin, person } = await removedPerson();
    const other = await signedInApi(idp, "builder");
    const workflow = await createWorkflowResource(
      env,
      { userId: admin.userId, role: "admin", teams: [], staff: false },
      `waits-${crypto.randomUUID().slice(0, 8)}`
    );
    await publishWorkflowVersion(
      env,
      { userId: admin.userId, role: "admin", teams: [], staff: false },
      workflow.id,
      {
        definition: JSON.stringify({
          document: {
            dsl: "1.0.3",
            namespace: workflowNamespace,
            name: workflow.name,
            version: "1.0.0",
            title: workflow.name,
            metadata: {
              grasp: {
                profile: "grasp-open-workflow/1",
                params: {},
                bindings: {},
              },
            },
          },
          input: {
            schema: {
              format: "json",
              document: {
                type: "object",
                properties: {},
                additionalProperties: false,
              },
            },
          },
          output: {
            schema: {
              format: "json",
              document: {
                type: "object",
                properties: {},
                additionalProperties: false,
              },
            },
          },
          do: [{ hold: { wait: "PT1H" } }],
        }),
        basedOn: null,
      }
    );
    // A run for each, started while they were members, still waiting.
    const now = Date.now();
    const version = await env.DB.prepare(
      "SELECT manifest_hash AS hash FROM workflow_resource_versions WHERE workflow_resource_id = ? AND version = 1"
    )
      .bind(workflow.id)
      .first<{ hash: string }>();
    const manifest = version?.hash ?? "";
    const runFor = async (userId: string): Promise<string> => {
      const runId = crypto.randomUUID();
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO workflow_start_receipts (id, invoker_type, invoker_id, idempotency_key, workflow_resource_id, workflow_resource_version, manifest_hash, principal_id, authority_generation, input_hash, created_at) VALUES (?, 'person', ?, ?, ?, 1, ?, ?, 1, 'h', ?)"
        ).bind(
          runId,
          userId,
          `key-${runId}`,
          workflow.id,
          manifest,
          userId,
          now
        ),
        env.DB.prepare(
          "INSERT INTO workflow_resource_runs (id, workflow_resource_id, version, manifest_hash, build_hash, principal_id, status, created_at) VALUES (?, ?, 1, ?, 'b', ?, 'running', ?)"
        ).bind(runId, workflow.id, manifest, userId, now),
        env.DB.prepare(
          "INSERT INTO workflow_decisions (id, resource_run_id, step, deciders, description, status, opened_at, expires_at, input) VALUES (?, ?, 'task:ask', ?, 'Approve?', 'open', ?, ?, '{}')"
        ).bind(runId, runId, `person:${userId}`, now, now + 60_000),
        env.DB.prepare(
          "INSERT INTO workflow_decision_confirmations (token_hash, decision_id, user_id, context_fingerprint, response_fingerprint, created_at, expires_at) VALUES (?, ?, ?, 'c', 'r', ?, ?)"
        ).bind(crypto.randomUUID(), runId, userId, now, now + 60_000),
      ]);
      return runId;
    };
    const theirs = await runFor(person.userId);
    const others = await runFor(other.userId);
    for (const userId of [person.userId, other.userId]) {
      // oxlint-disable-next-line no-await-in-loop -- one person at a time
      await modelLedger(env).setPersonLimit(
        { type: "person", userId },
        { monthlyMicros: 1_000_000, messagesAnHour: 10 },
        null,
        { type: "system" }
      );
    }

    await admin.api.members.erase(person.userId, String(person.person.name));

    const limits = await modelLedger(env).personLimits();
    const limited = new Set(
      limits.flatMap(({ subject }) =>
        subject.type === "person" ? [subject.userId] : []
      )
    );
    expect({
      theirRun: await stopAsked(theirs),
      otherRun: await stopAsked(others),
      theirConfirmations: await rowsOf(
        "workflow_decision_confirmations",
        "user_id",
        person.userId
      ),
      otherConfirmations: await rowsOf(
        "workflow_decision_confirmations",
        "user_id",
        other.userId
      ),
      theirLimit: limited.has(person.userId),
      otherLimit: limited.has(other.userId),
      // Their run stays, a company record naming them.
      theirRunKept: await rowsOf(
        "workflow_resource_runs",
        "principal_id",
        person.userId
      ),
    }).toStrictEqual({
      theirRun: true,
      otherRun: false,
      theirConfirmations: 0,
      otherConfirmations: 1,
      theirLimit: false,
      otherLimit: true,
      theirRunKept: 1,
    });
  });

  it("deletes their interview, found on the list by the address that was theirs, closes their link, and leaves their entry and everyone else's", async () => {
    const { admin, person } = await removedPerson();
    const { theirs, others, theirSecret, otherSecret } = await onTheList(
      String(person.person.email)
    );
    const before = await sessionWith(theirSecret);
    await onList(
      "INSERT INTO interview_texts (person, mark, at) VALUES (?, 'what they said', ?)",
      theirs,
      new Date().toISOString()
    );
    // A reminder to them, still to go, as the onboarding queues one.
    const queue = async (id: string): Promise<void> => {
      await onList(
        "INSERT INTO mail_outbox (key, about, to_address, mail, state, next_at, queued_at) VALUES (?, ?, 'them@acme.test', '{}', 'queued', ?, ?)",
        `reminder:${id}`,
        id,
        Date.now() + 86_400_000,
        new Date().toISOString()
      );
    };
    await queue(theirs);
    await queue(others);

    await admin.api.members.erase(person.userId, String(person.person.name));

    const textsOf = async (id: string) => {
      const rows = await onList(
        "SELECT person FROM interview_texts WHERE person = ?",
        id
      );
      return rows.length;
    };
    const listed = async (id: string) => {
      const rows = await onList("SELECT id FROM people WHERE id = ?", id);
      return rows.length;
    };
    const queuedFor = async (id: string) => {
      const rows = await onList(
        "SELECT key FROM mail_outbox WHERE about = ? AND state = 'queued'",
        id
      );
      return rows.length;
    };
    expect({
      before,
      // Their old link opens nothing any more, so nothing new is saved.
      after: await sessionWith(theirSecret),
      other: await sessionWith(otherSecret),
      theirTexts: await textsOf(theirs),
      theirEntry: await listed(theirs),
      otherEntry: await listed(others),
      theirMail: await queuedFor(theirs),
      otherMail: await queuedFor(others),
    }).toStrictEqual({
      before: "open",
      after: "interview.link_invalid",
      other: "open",
      theirTexts: 0,
      // Their entry is the company's: it stays, for an admin to remove.
      theirEntry: 1,
      otherEntry: 1,
      theirMail: 0,
      otherMail: 1,
    });
  });

  it("records the interview as skipped, never done, when the address that was theirs can't find them any more", async () => {
    const { admin, person } = await removedPerson();
    const now = Date.now();
    // An erasure made under an older key: its hash finds nobody now.
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO person_erasures (user_id, name, email_hash, email_key_version, requested_by, requested_at) VALUES (?, ?, ?, 0, ?, ?)"
      ).bind(
        person.userId,
        String(person.person.name),
        `old-${person.userId}`,
        admin.userId,
        now
      ),
      env.DB.prepare(
        "INSERT INTO person_erasure_areas (user_id, area, state, attempts, updated_at) VALUES (?, 'interview', 'pending', 0, ?)"
      ).bind(person.userId, now),
    ]);

    await runMinuteTasks();

    const erasure = await admin.api.members.erasure(person.userId);
    expect({
      areas: erasure.erasure?.areas,
      completed: typeof erasure.erasure?.completedAt,
    }).toStrictEqual({
      areas: [{ area: "interview", state: "skipped" }],
      completed: "string",
    });
  });

  it("keeps the interview from a link sent to their entry after their erasure was asked for, as one sent to whoever the address went to", async () => {
    const { admin, person } = await removedPerson();
    const { theirs, theirSecret } = await onTheList(
      String(person.person.email)
    );
    await onList(
      "INSERT INTO interview_texts (person, mark, at) VALUES (?, 'the new owner said', ?)",
      theirs,
      new Date().toISOString()
    );
    // The address released and a link sent to the entry again while the
    // erasure ran: sent after the erasure was asked for.
    await onList(
      "UPDATE links SET sent_at = ? WHERE person = ?",
      new Date(Date.now() + 60_000).toISOString(),
      theirs
    );

    const erased = await admin.api.members.erase(
      person.userId,
      String(person.person.name)
    );

    const texts = await onList(
      "SELECT person FROM interview_texts WHERE person = ?",
      theirs
    );
    expect({
      interview: erased.areas.find(({ area }) => area === "interview")?.state,
      texts: texts.length,
      link: await sessionWith(theirSecret),
    }).toStrictEqual({ interview: "complete", texts: 1, link: "open" });
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

  it("empties their personal connections in connect, revoked at the provider, and leaves everyone else's as they were", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "builder");
    const other = await signedInApi(idp, "user");
    const theirs = await connectOwnAccount(person);
    const others = await connectOwnAccount(other);
    await madeCall(theirs, person.userId);
    await madeCall(others, other.userId);
    const otherBefore = await keptInConnect(others);
    await admin.api.members.remove(person.userId);

    await admin.api.members.erase(person.userId, String(person.person.name));
    // Connect's own events, once core took them from its outbox.
    const events = await allEvents();

    expect({
      theirs: await keptInConnect(theirs),
      others: await keptInConnect(others),
      otherBefore,
      erased: events
        .filter(
          ({ action, detail }) =>
            action === "connection.person_erased" &&
            detail?.ownerUserId === person.userId
        )
        .map(({ source, detail }) => ({ source, detail })),
    }).toStrictEqual({
      theirs: { status: "disconnected", named: false, tokens: 0, calls: 0 },
      others: otherBefore,
      otherBefore: { status: "active", named: true, tokens: 1, calls: 1 },
      erased: [
        {
          source: "connect",
          detail: { ownerUserId: person.userId, connections: 1 },
        },
      ],
    });
  });

  it("empties their workspace, their chats and everything in them, and leaves everyone else's as it was", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "builder");
    const other = await signedInApi(idp, "user");
    await person.api.chats.create("Theirs");
    const kept = await other.api.chats.create("Someone else's");
    // Who was in a chat on a chat platform, as each chat's agent reads it:
    // one of their own, and someone else's they were in.
    const audience = env.DB.prepare(
      "INSERT INTO chat_audiences (chat_id, workspace_id, members, outsiders, updated_at) VALUES (?, ?, ?, 0, ?)"
    );
    await env.DB.batch([
      audience.bind(
        "their-group-chat",
        personalWorkspaceId(person.userId),
        JSON.stringify([person.userId, other.userId]),
        Date.now()
      ),
      audience.bind(
        "a-group-chat-they-were-in",
        personalWorkspaceId(other.userId),
        JSON.stringify([other.userId, person.userId]),
        Date.now()
      ),
    ]);
    await admin.api.members.remove(person.userId);
    const before = await inWorkspace(person.userId, "chats");

    await admin.api.members.erase(person.userId, String(person.person.name));
    const others = await other.api.chats.list();
    const { results: audiences } = await env.DB.prepare(
      "SELECT chat_id AS chatId FROM chat_audiences WHERE chat_id IN ('their-group-chat', 'a-group-chat-they-were-in')"
    ).all<{ chatId: string }>();

    expect({
      before,
      after: await inWorkspace(person.userId, "chats"),
      outbox: await inWorkspace(person.userId, "audit_outbox"),
      others: others.map(({ id }) => id),
      audiences: audiences.map(({ chatId }) => chatId),
    }).toStrictEqual({
      before: 1,
      after: 0,
      outbox: 0,
      others: [kept.id],
      // A shared chat elsewhere is the company's, and keeps its audience.
      audiences: ["a-group-chat-they-were-in"],
    });
  });

  it("delivers every audit event of their workspace to the log before it goes, and waits while the log is out", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "builder");
    const stub = workspace(env, personalWorkspaceId(person.userId));
    const realLog = env.AUDIT_LOG;
    // The log refuses everything their workspace delivers, for now.
    const failing = {
      getByName: () => ({
        append: async () => {
          await Promise.resolve();
          throw new Error("The audit log is out");
        },
      }),
      jurisdiction: () => failing,
    };
    await runInDurableObject(stub, (instance) => {
      Object.assign(envOf(instance), { AUDIT_LOG: failing });
    });
    const chat = await person.api.chats.create("Made while the log was out");
    // A turn's capture, still to go to the Brain.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO brain_capture_intents (event_id, evidence_id, facts, state, attempts, created_at) VALUES (?, ?, '{}', 'pending', 0, ?)",
        crypto.randomUUID(),
        chat.id,
        Date.now()
      );
    });
    await admin.api.members.remove(person.userId);

    const erasing = await admin.api.members.erase(
      person.userId,
      String(person.person.name)
    );
    const meanwhile = {
      chats: await inWorkspace(person.userId, "chats"),
      waiting: await inWorkspace(person.userId, "audit_outbox"),
      captures: await inWorkspace(person.userId, "brain_capture_intents"),
    };
    await runInDurableObject(stub, (instance) => {
      Object.assign(envOf(instance), { AUDIT_LOG: realLog });
    });
    await runMinuteTasks();
    const done = await admin.api.members.erasure(person.userId);
    const events = await allEvents();

    expect({
      workspace: erasing.areas.find(({ area }) => area === "workspace")?.state,
      meanwhile,
      done: done.erasure?.areas.find(({ area }) => area === "workspace")?.state,
      chats: await inWorkspace(person.userId, "chats"),
      created: events.filter(
        ({ action, target }) =>
          action === "chat.created" && target?.id === chat.id
      ).length,
    }).toStrictEqual({
      workspace: "pending",
      // Nothing went while an event of it was undelivered.
      // Its capture dropped already: none goes to the Brain once its
      // erasure began, refused or not.
      meanwhile: { chats: 1, waiting: 1, captures: 0 },
      done: "complete",
      chats: 0,
      // Delivered, once, never dropped.
      created: 1,
    });
  });

  it("forgets their preferences in every App's store, their screens' submissions and their own Knowledge signals, and leaves everyone else's", async () => {
    const { admin, person } = await removedPerson();
    const other = await signedInApi(idp, "user");
    const { app, storeId } = await appWithPreferences();
    await inStore(storeId, (sql) => {
      for (const who of [person.userId, other.userId]) {
        sql.exec(
          "INSERT INTO sdk_preferences (person_id, revision, value_json, updated_at) VALUES (?, 1, ?, ?)",
          who,
          JSON.stringify({ theme: "dark" }),
          Date.now()
        );
      }
    });
    const now = Date.now();
    for (const who of [person.userId, other.userId]) {
      // oxlint-disable-next-line no-await-in-loop -- one person at a time
      await env.DB.prepare(
        "INSERT INTO screen_submissions (id, person_id, app_id, kind, contract_id, fingerprint, app_version, path, attempt, idempotency_key, created_at, expires_at) VALUES (?, ?, ?, 'mutation', 'notes.add', 'f', 1, '/', 1, ?, ?, ?)"
      )
        .bind(
          crypto.randomUUID(),
          who,
          app,
          crypto.randomUUID(),
          now,
          now + 60_000
        )
        .run();
    }

    // The usage signals of a Knowledge collection of each, its searches'
    // keys being what they asked.
    const computation = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO knowledge_signal_computations (id, day, started_at, finished_at) VALUES (?, '2026-10-27', ?, ?)"
    )
      .bind(computation, now, now)
      .run();
    for (const who of [person.userId, other.userId]) {
      // oxlint-disable-next-line no-await-in-loop -- one person at a time
      await env.DB.prepare(
        "INSERT INTO knowledge_signals (computation, id, kind, collection_id, subject, owner, value, evidence) VALUES (?, ?, 'unanswered_question', ?, 'what they asked', ?, 1, '{}')"
      )
        .bind(computation, crypto.randomUUID(), `collection-${who}`, who)
        .run();
    }

    await admin.api.members.erase(person.userId, String(person.person.name));

    const preferencesOf = async (who: string) =>
      await inStore(
        storeId,
        (sql) =>
          sql
            .exec<{ count: number }>(
              "SELECT count(*) AS count FROM sdk_preferences WHERE person_id = ?",
              who
            )
            .one().count
      );
    expect({
      theirs: await preferencesOf(person.userId),
      others: await preferencesOf(other.userId),
      theirSubmissions: await rowsOf(
        "screen_submissions",
        "person_id",
        person.userId
      ),
      otherSubmissions: await rowsOf(
        "screen_submissions",
        "person_id",
        other.userId
      ),
      theirSignals: await rowsOf("knowledge_signals", "owner", person.userId),
      otherSignals: await rowsOf("knowledge_signals", "owner", other.userId),
    }).toStrictEqual({
      theirs: 0,
      others: 1,
      theirSubmissions: 0,
      otherSubmissions: 1,
      theirSignals: 0,
      otherSignals: 1,
    });
  });
});
