import { errorPayloadSchema } from "@grasp-os/shared/errors";
import type { Json } from "@grasp-os/shared/json";
import {
  appFunctionPath,
  pageLeaseHeader,
  pagePersonHeader,
} from "@grasp-os/shared/pages";
import { guestRole } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { loadRelease } from "../src/app-releases.ts";
import { testApp } from "./app-definitions.ts";
import { commitApp } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { clientOrigin } from "./sign-in-config.ts";
import {
  auditedDuring,
  firstVersion,
  followedVersion,
  openRpc,
  outcome,
  routed,
  signedIn,
  signedInApi,
  signedInWithRole,
  staffPerson,
  unique,
} from "./sign-in.ts";
import { storedGrant } from "./stored-grants.ts";
import { connectDb } from "./test-env.ts";

// A guest (GRA-2235) shared an App and using it, from the threat model
// on the issue: what a guest's session reaches (an App shared with them,
// as its user, and nothing else of the platform, guest-access.ts); who
// may share an App with a guest, and in which role; an App that holds a
// source reaching no guest, whoever shares it, at sharing and on every
// request, a call, a live query or a stream already running included;
// what a guest is inside the App (who they are, never
// the directory nor the Brain, a user's rows of its store); and access
// that ends with the share. The route families a guest is still refused
// are in guest-role.test.ts.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

/**
 * Makes the member `userId` a guest, as nothing in this pull request does
 * yet: nameless, as guest-members.ts makes one.
 */
const makeGuest = async (userId: string): Promise<void> => {
  await env.DB.batch([
    env.DB.prepare("UPDATE members SET role = ? WHERE user_id = ?").bind(
      guestRole,
      userId
    ),
    env.DB.prepare("UPDATE users SET name = '' WHERE id = ?").bind(userId),
  ]);
};

/** Someone signed in as a member, made a guest, on a connection of their own. */
const signedInGuest = async (): Promise<Person> => {
  const guest = await signedInWithRole(idp, "user");
  await makeGuest(guest.userId);
  const { core, closed } = await openRpc(guest.session);
  return { ...guest, core, closed, api: core.authenticate() };
};

/**
 * The Desk App: notes each caller keeps (`owner`), members' notes
 * (`appMembers`), a builders' ledger (`appBuilders`), accounts each team
 * reads (a `team` rule), tasks each person reads (a `person` rule), who
 * calls, a directory search, and a recall of the Brain by default.
 */
const deskFiles = testApp(
  {
    name: "Desk",
    tables: {
      notes: {
        fields: { text: "v.string()" },
        access: { read: "owner", write: "owner" },
      },
      shared: {
        fields: { text: "v.string()" },
        access: { read: "appMembers", write: "appMembers" },
      },
      ledger: {
        fields: { text: "v.string()" },
        access: { read: "appBuilders", write: "appBuilders" },
      },
      accounts: {
        fields: { text: "v.string()", team: "v.string()" },
        access: {
          read: "appMembers",
          write: "appMembers",
          rows: {
            read: [{ kind: "team", field: "team" }],
            write: [{ kind: "team", field: "team" }],
          },
        },
      },
      gates: {
        fields: { text: "v.string()" },
        access: { read: "appMembers", write: "appMembers" },
      },
      tasks: {
        fields: { text: "v.string()", who: "v.person()" },
        access: {
          read: "appMembers",
          write: "appMembers",
          rows: { read: [{ kind: "person", field: "who" }] },
        },
      },
    },
    permissions: ["people"],
  },
  {
    "server/desk.ts": `import { v } from "@grasp-os/sdk";
import { action, mutation, query } from "@server/_generated/server";

const codeOf = (error: unknown): string => String(Reflect.get(Object(error), "code"));

/** Writes a row: "ok", or the code it was refused with. */
const writing = async (write: () => Promise<unknown>): Promise<string> => {
  try {
    await write();
    return JSON.stringify("ok");
  } catch (error) {
    return JSON.stringify(codeOf(error));
  }
};

/** The texts of the rows read, sorted, or the code the read was refused with. */
const reading = async (read: () => Promise<{ text: string }[]>): Promise<string> => {
  try {
    return JSON.stringify((await read()).map(({ text }) => text).toSorted());
  } catch (error) {
    return JSON.stringify(codeOf(error));
  }
};

export const putNote = mutation({
  args: { text: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => await writing(() => ctx.db.insert("notes", args)),
});

export const putShared = mutation({
  args: { text: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => await writing(() => ctx.db.insert("shared", args)),
});

export const putLedger = mutation({
  args: { text: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => await writing(() => ctx.db.insert("ledger", args)),
});

export const putAccount = mutation({
  args: { text: v.string(), team: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => await writing(() => ctx.db.insert("accounts", args)),
});

export const putTask = mutation({
  args: { text: v.string(), who: v.person() },
  returns: v.string(),
  handler: async (ctx, args) => await writing(() => ctx.db.insert("tasks", args)),
});

export const notes = query({
  args: {},
  returns: v.string(),
  handler: async (ctx) => await reading(() => ctx.db.query("notes").take(100)),
});

export const shared = query({
  args: {},
  returns: v.string(),
  handler: async (ctx) => await reading(() => ctx.db.query("shared").take(100)),
});

export const ledger = query({
  args: {},
  returns: v.string(),
  handler: async (ctx) => await reading(() => ctx.db.query("ledger").take(100)),
});

export const accounts = query({
  args: {},
  returns: v.string(),
  handler: async (ctx) => await reading(() => ctx.db.query("accounts").take(100)),
});

export const tasks = query({
  args: {},
  returns: v.string(),
  handler: async (ctx) => await reading(() => ctx.db.query("tasks").take(100)),
});

export const openGate = mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => await writing(() => ctx.db.insert("gates", { text: "open" })),
});

export const gateOpen = query({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => (await ctx.db.query("gates").take(1)).length > 0,
});

/**
 * Writes "before" to the members' table and reads it, waits for the gate
 * to open (or a read to be refused), then tries to write "after", its
 * refusal swallowed: answers what it read.
 */
export const waitThenShare = action({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    await ctx.runMutation(putShared, { text: "before" });
    const read = await ctx.runQuery(shared, {});
    for (let polls = 0; polls < 100; polls += 1) {
      try {
        if (await ctx.runQuery(gateOpen, {})) {
          break;
        }
      } catch {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    try {
      await ctx.runMutation(putShared, { text: "after" });
    } catch {
      // Refused: what it read is still its answer.
    }
    return read;
  },
});

/** Says each step, one every 100 ms, a hundred times. */
export const ticks = action({
  args: {},
  returns: v.null(),
  stream: v.object({ step: v.number() }),
  handler: async (ctx) => {
    for (let step = 1; step <= 100; step += 1) {
      await ctx.emit({ step });
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  },
});

/** Who calls, as the function sees it. */
export const who = query({
  args: {},
  returns: v.string(),
  handler: async (ctx) => JSON.stringify(await ctx.auth.getUser()),
});

/** The IDs a search of the directory finds, or the code it was refused with. */
export const look = query({
  args: { query: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => {
    try {
      const page = await ctx.people.search(args.query, { limit: 100 });
      return JSON.stringify(page.people.map(({ id }) => id));
    } catch (error) {
      return JSON.stringify(codeOf(error));
    }
  },
});

/** Recalls the Brain, declaring no permission to: "ok", or the code it was refused with. */
export const ask = action({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    try {
      await ctx.brain.recall({ question: "What does the company do?", budget: { tokens: 500 } });
      return JSON.stringify("ok");
    } catch (error) {
      return JSON.stringify(codeOf(error));
    }
  },
});
`,
    "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
function Desk() {
  return <p>Desk</p>;
}

export const Route = createFileRoute("/")({ component: Desk });
`,
  }
);

/** A builder's Desk App, live, and its release. */
const desk = async (builder?: Person) => {
  const owner = builder ?? (await signedInApi(idp, "builder"));
  const { id } = await owner.api.apps.create({ name: `Desk ${unique()}` });
  const { version } = await commitApp(owner.api, id, deskFiles);
  await owner.api.versions.rollback({ kind: "app", id }, version);
  const release = await loadRelease(env, id, version);
  return { builder: owner, app: id, release };
};

type Desk = Awaited<ReturnType<typeof desk>>;

/** Shares `app` with `who` as its user, as `by`. */
const share = async (by: Person, app: string, who: { userId: string }) =>
  await outcome(
    by.api.apps.members.add(app, {
      type: "person",
      id: who.userId,
      role: "user",
    })
  );

/** Unshares `app` with `who`, as `by`. */
const unshare = async (by: Person, app: string, who: { userId: string }) => {
  await by.api.apps.members.remove(app, { type: "person", id: who.userId });
};

/** A call's answer: the function's JSON text, or the code it failed with. */
const answeredSchema = z.object({
  result: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), value: z.string() }),
    z.object({ ok: z.literal(false), error: z.object({ code: z.string() }) }),
  ]),
});

/** The leases core gave each person's page of each App, by both. */
const leases = new Map<string, string>();

/**
 * The lease core gives `who`'s page of `app` as they open it, kept once
 * given, as a page keeps it; or the code opening it was refused with.
 */
const leaseOf = async (
  who: Person,
  app: string
): Promise<{ lease: string; refused?: undefined } | { refused: string }> => {
  const kept = leases.get(`${who.userId} ${app}`);
  if (kept !== undefined) {
    return { lease: kept };
  }
  const opening = who.api.pages.open(app);
  const opened = await outcome(opening);
  if (opened !== "ok") {
    return { refused: opened };
  }
  const { lease } = await opening;
  leases.set(`${who.userId} ${app}`, lease);
  return { lease };
};

/**
 * Calls `path` of `app` with `args` as `who`'s page does, through the one
 * page-call path, under the lease core gave their page as they opened it:
 * the function's result, or the code core refused the call with.
 */
const call = async (
  { app, release }: Desk,
  who: Person,
  path: string,
  args: Json = {}
): Promise<unknown> => {
  const lease = await leaseOf(who, app);
  if (lease.refused !== undefined) {
    return lease.refused;
  }
  const response = await routed(`${appFunctionPath}/${app}`, {
    method: "POST",
    headers: {
      origin: clientOrigin,
      "content-type": "application/json",
      cookie: who.session,
      [pagePersonHeader]: who.userId,
      [pageLeaseHeader]: lease.lease,
    },
    body: JSON.stringify({
      reference: { name: path, kind: release.app.functions[path]?.kind },
      args,
    }),
  });
  const answer: unknown = await response.json();
  if (!response.ok) {
    return errorPayloadSchema.parse(answer).code;
  }
  const { result } = answeredSchema.parse(answer);
  if (!result.ok) {
    return result.error.code;
  }
  // Each function answers JSON text, so a refusal inside it reads alike.
  return JSON.parse(result.value);
};

/** The Apps `who`'s home lists, by ID. */
const listed = async (who: Person): Promise<string[]> => {
  const apps = await who.api.pages.opensApps();
  return apps.map(({ app }) => app);
};

/**
 * An App or a workflow marked as having read the Brain by default, as
 * core's default read marks it (resource-brain.ts).
 */
const readByDefault = (subject: "app" | "workflow", id: string) =>
  env.DB.prepare(
    "INSERT INTO brain_default_reads (subject_type, subject_id, first_read_at) VALUES (?, ?, ?)"
  ).bind(subject, id, Date.now());

/** A grant of `subject` on `object`, active, as an admin's grant writes it. */
const grantedRow = (
  subjectType: "app" | "workflow",
  subject: string,
  objectType: "app" | "workflow",
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
    `GRANT_${unique().toUpperCase().replaceAll(/\W/gu, "_")}`
  );

/** A workflow's ID no other test has. */
const workflowId = (): string => `workflow_${unique().replaceAll("-", "")}`;

/** Marks App `app` as having read the Brain by default (resource-brain.ts). */
const readsTheBrain = async (app: string): Promise<void> => {
  await env.DB.prepare(
    "INSERT INTO brain_default_reads (subject_type, subject_id, first_read_at) VALUES ('app', ?, ?)"
  )
    .bind(app, Date.now())
    .run();
};

describe("a guest shared an App", { timeout: 120_000 }, () => {
  it("opens and calls it as its user, and reaches no other App and nothing else of the platform", async () => {
    const { builder, ...shared } = await desk();
    const other = await desk(builder);
    const guest = await signedInGuest();
    await share(builder, shared.app, guest);

    const me = await guest.api.whoami();
    const followed = await firstVersion(
      async (onVersion) =>
        await guest.api.pages.watchVersion(shared.app, onVersion)
    );
    const answers = {
      whoami: { guest: me.guest, role: me.role, teams: me.teams },
      home: await listed(guest),
      call: await call({ builder, ...shared }, guest, "desk.putNote", {
        text: "hello",
      }),
      otherOpen: await outcome(guest.api.pages.open(other.app)),
      // A problem in its page, to its error log; another App's refused.
      report: await outcome(
        guest.api.pages.report(
          shared.app,
          { version: shared.release.manifest.resourceVersion, path: "/" },
          { kind: "error", message: "Broken" }
        )
      ),
      otherReport: await outcome(
        guest.api.pages.report(
          other.app,
          { version: other.release.manifest.resourceVersion, path: "/" },
          { kind: "error", message: "Broken" }
        )
      ),
      otherFrame: await outcome(guest.api.pages.frame(other.app, "lease")),
      otherVersion: await outcome(
        firstVersion(
          async (onVersion) =>
            await guest.api.pages.watchVersion(other.app, onVersion)
        )
      ),
      version: followed.version,
      // Everything else of their connection answers them as nobody.
      apps: await outcome(guest.api.apps.list()),
      app: await outcome(guest.api.apps.get(shared.app)),
      sidebar: await outcome(guest.api.pages.sidebar()),
      surfaces: await outcome(guest.api.pages.surfaces(shared.app)),
      members: await outcome(guest.api.apps.members.list(shared.app)),
      chats: await outcome(guest.api.chats.list()),
      sessions: await outcome(guest.api.sessions.list()),
      onboarding: await outcome(guest.api.onboarding.flow()),
    };

    expect(answers).toStrictEqual({
      whoami: { guest: true, role: "user", teams: [] },
      home: [shared.app],
      call: "ok",
      otherOpen: "app.not_found",
      report: "ok",
      otherReport: "app.not_found",
      otherFrame: "app.not_found",
      otherVersion: "app.not_found",
      version: shared.release.manifest.resourceVersion,
      apps: "auth.unauthenticated",
      app: "auth.unauthenticated",
      sidebar: "auth.unauthenticated",
      surfaces: "auth.unauthenticated",
      members: "auth.unauthenticated",
      chats: "auth.unauthenticated",
      sessions: "auth.unauthenticated",
      onboarding: "auth.unauthenticated",
    });
  });

  it("is shared it only as its user, named by their address to whoever shares it, and marked as a guest", async () => {
    const { builder, app } = await desk();
    const member = await signedInApi(idp, "user");
    const guest = await signedInGuest();
    await share(builder, app, member);
    const staffSession = await signedIn(idp, "grasp-staff", staffPerson());
    const { core: staffCore } = await openRpc(staffSession);
    const staff = { api: staffCore.authenticate() };

    const offered = await builder.api.apps.members.candidates(app);
    const asBuilder = await outcome(
      builder.api.apps.members.add(app, {
        type: "person",
        id: guest.userId,
        role: "builder",
      })
    );
    const asUser = await share(builder, app, guest);
    const guestIn = async (who: Person) => {
      const members = await who.api.apps.members.list(app);
      const found = members.find(({ id }) => id === guest.userId);
      return { name: found?.name, role: found?.role, guest: found?.guest };
    };

    expect({
      offered: offered.people.find(({ id }) => id === guest.userId),
      asBuilder,
      asUser,
      toBuilder: await guestIn(builder),
      // Someone who only uses it isn't told the guest's address.
      toMember: await guestIn(member),
      // Nor is Grasp staff, who reach none of it.
      toStaff: await outcome(staff.api.apps.members.candidates(app)),
    }).toStrictEqual({
      offered: { id: guest.userId, name: guest.person.email, guest: true },
      asBuilder: "app.member_invalid",
      asUser: "ok",
      toBuilder: { name: guest.person.email, role: "user", guest: true },
      toMember: { name: "", role: "user", guest: true },
      toStaff: "role.forbidden",
    });
  });

  it("is never shared one that holds a source, by an admin or a builder alike, and each refusal is recorded", async () => {
    const shared = await desk();
    const { builder, app } = shared;
    const admin = await signedInApi(idp, "admin");
    const guest = await signedInGuest();
    await readsTheBrain(app);

    const events = await auditedDuring(async () => {
      expect([
        await share(builder, app, guest),
        await share(admin, app, guest),
      ]).toStrictEqual(["app.guest_sources", "app.guest_sources"]);
    });

    expect({
      events: events.map(({ action, actor, detail }) => ({
        action,
        actor,
        detail,
      })),
      call: await call(shared, guest, "desk.notes"),
    }).toStrictEqual({
      events: [builder, admin].map(({ userId }) => ({
        action: "app.member.refused",
        actor: { type: "person", userId },
        detail: {
          memberType: "person",
          member: guest.userId,
          role: "user",
          reason: "app.guest_sources",
        },
      })),
      call: "app.not_found",
    });
  });

  it("loses it for good on their next request once it gains a source of any kind", async () => {
    const builder = await signedInApi(idp, "builder");
    const admin = await signedInApi(idp, "admin");
    const guest = await signedInGuest();
    const now = Date.now();
    // Each kind of source, as a grant, connect's record of a connection
    // or core's mark of a default read leaves it.
    const kinds: Record<string, (app: string) => Promise<void>> = {
      personalConnection: async (app) => {
        const id = `connection-mailbox-${unique()}`;
        await connectDb()
          .prepare(
            "INSERT INTO connections (id, provider, scope, owner_user_id, status, server_kind, server, created_at, updated_at) VALUES (?, 'microsoft', 'personal', ?, 'active', 'native', 'microsoft-365', ?, ?)"
          )
          .bind(id, builder.userId, now, now)
          .run();
        await storedGrant(
          { type: "app", id: app },
          { type: "connection", id },
          ["users.messages.list"],
          `MAIL_${unique().replaceAll("-", "_").toUpperCase()}`
        );
      },
      sharedConnection: async (app) => {
        const id = `connection-shared-${unique()}`;
        await connectDb()
          .prepare(
            "INSERT INTO connections (id, provider, scope, status, server_kind, server, created_at, updated_at) VALUES (?, 'mail', 'shared', 'active', 'composio', 'https://backend.composio.dev/v3/mcp/none', ?, ?)"
          )
          .bind(id, now, now)
          .run();
        await storedGrant(
          { type: "app", id: app },
          { type: "connection", id },
          ["mail.list"],
          `MAIL_${unique().replaceAll("-", "_").toUpperCase()}`
        );
      },
      brainGrant: async (app) => {
        await storedGrant(
          { type: "app", id: app },
          { type: "platform", id: "platform" },
          ["brain"],
          `BRAIN_${unique().replaceAll("-", "_").toUpperCase()}`
        );
      },
      brainByDefault: async (app) => {
        await readsTheBrain(app);
      },
      // A workflow that reads the Brain by default calls the App's
      // functions.
      throughAWorkflow: async (app) => {
        const workflow = workflowId();
        await env.DB.batch([
          readByDefault("workflow", workflow),
          grantedRow("workflow", workflow, "app", app, ["call"]),
        ]);
      },
      // Another App that reads the Brain by default starts a workflow
      // that calls this one's functions.
      throughAnotherApp: async (app) => {
        const [{ app: other }, workflow] = [await desk(builder), workflowId()];
        await env.DB.batch([
          readByDefault("app", other),
          grantedRow("app", other, "workflow", workflow, ["start"]),
          grantedRow("workflow", workflow, "app", app, ["call"]),
        ]);
      },
      // An App with no row starts a workflow that calls this one's
      // functions: what it holds can't be known, so it counts as a source.
      throughAnUnknownApp: async (app) => {
        const [other, workflow] = [crypto.randomUUID(), workflowId()];
        await env.DB.batch([
          grantedRow("app", other, "workflow", workflow, ["start"]),
          grantedRow("workflow", workflow, "app", app, ["call"]),
        ]);
      },
    };
    const answers: Record<string, unknown> = {};
    for (const [kind, gain] of Object.entries(kinds)) {
      // oxlint-disable-next-line no-await-in-loop -- one App after the other
      const shared = await desk(builder);
      // oxlint-disable-next-line no-await-in-loop -- one App after the other
      await share(builder, shared.app, guest);
      // oxlint-disable-next-line no-await-in-loop -- one App after the other
      const before = await call(shared, guest, "desk.notes");
      // oxlint-disable-next-line no-await-in-loop -- one App after the other
      await gain(shared.app);
      answers[kind] = {
        before,
        // oxlint-disable-next-line no-await-in-loop -- one App after the other
        after: await call(shared, guest, "desk.notes"),
        // Nobody gives it back, an admin included.
        // oxlint-disable-next-line no-await-in-loop -- one App after the other
        again: await share(admin, shared.app, guest),
      };
    }
    const expected = {
      before: [],
      after: "app.unreadable",
      again: "app.guest_sources",
    };

    expect({ answers, home: await listed(guest) }).toStrictEqual({
      answers: Object.fromEntries(
        Object.keys(kinds).map((kind) => [kind, expected])
      ),
      home: [],
    });
  });

  it("keeps what a call already running read once the App gains a source: its next commit and its answer are refused", async () => {
    const shared = await desk();
    const { builder, app } = shared;
    const member = await signedInApi(idp, "user");
    const guest = await signedInGuest();
    await share(builder, app, member);
    await share(builder, app, guest);
    await call(shared, member, "desk.shared");

    const running = call(shared, guest, "desk.waitThenShare");
    // Once its first write is in, the App gains a source, then the
    // action is let go on.
    for (let polls = 0; polls < 100; polls += 1) {
      // oxlint-disable-next-line no-await-in-loop -- until the first write is in
      const rows = await call(shared, member, "desk.shared");
      if (Array.isArray(rows) && rows.includes("before")) {
        break;
      }
      // oxlint-disable-next-line no-await-in-loop -- until the first write is in
      await scheduler.wait(100);
    }
    await readsTheBrain(app);
    await call(shared, member, "desk.openGate");

    expect({
      answer: await running,
      rows: await call(shared, member, "desk.shared"),
    }).toStrictEqual({ answer: "app.unreadable", rows: ["before"] });
  });

  it("is pushed nothing a live query read after the App gained a source, though it was following it", async () => {
    const shared = await desk();
    const { builder, app, release } = shared;
    const member = await signedInApi(idp, "user");
    const guest = await signedInGuest();
    await share(builder, app, member);
    await share(builder, app, guest);
    const lease = await leaseOf(guest, app);
    if (lease.refused !== undefined) {
      throw new Error(lease.refused);
    }
    const pushes: string[] = [];
    const first = Promise.withResolvers<null>();
    const subscription = await guest.api.pages
      .frame(app, lease.lease)
      .watchQuery(
        JSON.stringify({
          reference: {
            name: "desk.shared",
            kind: release.app.functions["desk.shared"]?.kind,
          },
          args: {},
        }),
        (push) => {
          pushes.push(JSON.stringify(push.result));
          first.resolve(null);
        }
      );
    await first.promise;

    // Within the second a look at access was kept for: the App gains a
    // source, then a member writes what the query reads.
    await readsTheBrain(app);
    await call(shared, member, "desk.putShared", { text: "after the source" });
    for (
      let polls = 0;
      polls < 50 && !pushes.some((push) => push.includes('"ok":false'));
      polls += 1
    ) {
      // oxlint-disable-next-line no-await-in-loop -- until the query is told
      await scheduler.wait(100);
    }
    await subscription.release();

    const last = z
      .object({ ok: z.literal(false), error: z.object({ code: z.string() }) })
      .safeParse(JSON.parse(pushes.at(-1) ?? "null"));
    expect({
      leaked: pushes.some((push) => push.includes("after the source")),
      // The query ends refused, as for someone the App isn't open to.
      refused: last.success ? last.data.error.code : undefined,
    }).toStrictEqual({ leaked: false, refused: "app.not_found" });
  });

  it("is sent no more of a stream's progress once the App gains a source while it runs", async () => {
    const shared = await desk();
    const { builder, app, release } = shared;
    const guest = await signedInGuest();
    await share(builder, app, guest);
    const lease = await leaseOf(guest, app);
    if (lease.refused !== undefined) {
      throw new Error(lease.refused);
    }
    const response = await routed(`${appFunctionPath}/${app}/stream`, {
      method: "POST",
      headers: {
        origin: clientOrigin,
        "content-type": "application/json",
        cookie: guest.session,
        [pagePersonHeader]: guest.userId,
        [pageLeaseHeader]: lease.lease,
      },
      body: JSON.stringify({
        reference: {
          name: "desk.ticks",
          kind: release.app.functions["desk.ticks"]?.kind,
        },
        args: {},
        idempotencyKey: `ticks-${unique()}`,
      }),
    });
    const reader = response.body
      ?.pipeThrough(new TextDecoderStream())
      .getReader();
    if (reader === undefined) {
      throw new Error("The stream has no body");
    }
    let buffered = "";
    /** The next frame's type, and its error's code if it has one. */
    const nextFrame = async (): Promise<string> => {
      for (;;) {
        const end = buffered.indexOf("\n");
        if (end !== -1) {
          const line = buffered.slice(0, end);
          buffered = buffered.slice(end + 1);
          const frame = z
            .looseObject({
              type: z.string(),
              error: z.object({ code: z.string() }).optional(),
            })
            .parse(JSON.parse(line));
          return frame.error === undefined
            ? frame.type
            : `${frame.type} ${frame.error.code}`;
        }
        // oxlint-disable-next-line no-await-in-loop -- one chunk after another
        const { done, value } = await reader.read();
        if (done) {
          return "ended";
        }
        buffered += value;
      }
    };
    const before = await nextFrame();

    await readsTheBrain(app);
    // What follows, until the stream is refused or ends: at most the one
    // frame already on its way when the source was gained.
    const after: string[] = [];
    for (let frames = 0; frames < 60; frames += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one frame after another
      const frame = await nextFrame();
      after.push(frame);
      if (frame.startsWith("refused") || frame === "ended") {
        break;
      }
    }
    await reader.cancel();

    expect({
      before,
      progressAfter: after.filter((frame) => frame === "progress").length <= 1,
      last: after.at(-1),
    }).toStrictEqual({
      before: "progress",
      progressAfter: true,
      last: "refused app.unreadable",
    });
  });

  it("is its user inside it: told who they are, never the directory or the Brain, and a user's rows of its store", async () => {
    const shared = await desk();
    const { builder, app } = shared;
    const member = await signedInApi(idp, "user");
    const guest = await signedInGuest();
    await share(builder, app, member);
    await share(builder, app, guest);
    const written = [];
    for (const [path, row] of [
      ["desk.putNote", { text: "member's note" }],
      ["desk.putShared", { text: "for everyone in the App" }],
      ["desk.putTask", { text: "member's task", who: member.userId }],
      ["desk.putTask", { text: "for the guest", who: guest.userId }],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one row after the other
      written.push(await call(shared, member, path, row));
    }
    written.push(
      await call(shared, builder, "desk.putLedger", { text: "builders' entry" })
    );

    const user = await call(shared, guest, "desk.who");
    const inside = {
      written,
      user,
      look: await call(shared, guest, "desk.look", { query: "Person" }),
      memberLooks: Array.isArray(
        await call(shared, member, "desk.look", { query: "Person" })
      ),
      put: await call(shared, guest, "desk.putNote", { text: "guest's note" }),
      notes: await call(shared, guest, "desk.notes"),
      shared: await call(shared, guest, "desk.shared"),
      ledger: await call(shared, guest, "desk.ledger"),
      accounts: await call(shared, guest, "desk.accounts"),
      // A team rule matches no team of a guest's: they are in none.
      emptyTeam: await call(shared, guest, "desk.putAccount", {
        text: "nobody's",
        team: "",
      }),
      tasks: await call(shared, guest, "desk.tasks"),
      brain: await call(shared, guest, "desk.ask"),
      // Refused before the App is marked as reading the Brain: it stays
      // open to guests.
      marked: await env.DB.prepare(
        "SELECT count(*) AS n FROM brain_default_reads WHERE subject_id = ?"
      )
        .bind(app)
        .first<number>("n"),
      afterBrain: await call(shared, guest, "desk.notes"),
      memberBrain: await call(shared, member, "desk.ask"),
    };

    expect(inside).toStrictEqual({
      // No person field names a guest: they are never someone in the
      // company, so a person rule never reaches them.
      written: ["ok", "ok", "ok", "data.write_denied", "ok"],
      user: {
        id: guest.userId,
        name: "",
        email: guest.person.email,
        roles: ["user"],
      },
      look: "permission.denied",
      memberLooks: true,
      put: "ok",
      notes: ["guest's note"],
      shared: ["for everyone in the App"],
      ledger: "data.access_denied",
      accounts: [],
      emptyTeam: "data.write_denied",
      tasks: [],
      // In the function host's words for a Brain read refused.
      brain: "permission.unavailable",
      marked: 0,
      afterBrain: ["guest's note"],
      memberBrain: "ok",
    });
  });

  it("loses it on their next request once unshared or removed, and an open page is told", async () => {
    const shared = await desk();
    const { builder, app } = shared;
    const admin = await signedInApi(idp, "admin");
    const guest = await signedInGuest();
    const removed = await signedInGuest();
    await share(builder, app, guest);
    await share(builder, app, removed);
    const followed = await followedVersion(
      async (onVersion) => await guest.api.pages.watchVersion(app, onVersion)
    );
    const first = await followed.next();

    await unshare(builder, app, guest);
    const told = await followed.next();
    const unshared = await call(shared, guest, "desk.notes");
    const before = await call(shared, removed, "desk.notes");
    await admin.api.members.remove(removed.userId);
    const after = await outcome(
      routed(`${appFunctionPath}/${app}`, {
        method: "POST",
        headers: {
          origin: clientOrigin,
          "content-type": "application/json",
          cookie: removed.session,
          [pagePersonHeader]: removed.userId,
        },
        body: "{}",
      }).then(async (response) => {
        throw Object.assign(new Error("refused"), {
          code: errorPayloadSchema.parse(await response.json()).code,
        });
      })
    );
    await followed.release();

    expect({
      first: first.type,
      told: told.type === "refused" ? told.error.code : told.type,
      unshared,
      before,
      after,
    }).toStrictEqual({
      first: "current",
      told: "app.not_found",
      unshared: "app.not_found",
      before: [],
      after: "auth.unauthenticated",
    });
  });
});
