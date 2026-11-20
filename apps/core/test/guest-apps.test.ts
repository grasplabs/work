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
  signedInApi,
  signedInWithRole,
  unique,
} from "./sign-in.ts";

// A guest (GRA-2235) shared an App and using it, from the threat model
// on the issue: what a guest's session reaches (an App shared with them,
// as its user, and nothing else of the platform, guest-access.ts); who
// may share an App with a guest, and in which role; an App that holds a
// source reaching a guest only through an admin's share, at sharing and
// on every request; what a guest is inside the App (who they are, never
// the directory nor the Brain, a user's rows of its store); and access
// that ends with the share. The route families a guest is still refused
// are in guest-role.test.ts.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

/** Makes the member `userId` a guest, as nothing in the product does yet. */
const makeGuest = async (userId: string): Promise<void> => {
  await env.DB.prepare("UPDATE members SET role = ? WHERE user_id = ?")
    .bind(guestRole, userId)
    .run();
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

  it("is shared it only as its user, offered to whoever shares it and marked as a guest", async () => {
    const { builder, app } = await desk();
    const guest = await signedInGuest();

    const offered = await builder.api.apps.members.candidates(app);
    const asBuilder = await outcome(
      builder.api.apps.members.add(app, {
        type: "person",
        id: guest.userId,
        role: "builder",
      })
    );
    const asUser = await share(builder, app, guest);
    const listedMembers = await builder.api.apps.members.list(app);
    const member = listedMembers.find(({ id }) => id === guest.userId);

    expect({
      offered: offered.people.find(({ id }) => id === guest.userId),
      asBuilder,
      asUser,
      member: { role: member?.role, guest: member?.guest },
    }).toStrictEqual({
      offered: { id: guest.userId, name: guest.person.name, guest: true },
      asBuilder: "app.member_invalid",
      asUser: "ok",
      member: { role: "user", guest: true },
    });
  });

  it("is shared one holding a source by an admin alone: a builder is refused, and the refusal recorded", async () => {
    const shared = await desk();
    const { builder, app } = shared;
    const admin = await signedInApi(idp, "admin");
    const guest = await signedInGuest();
    await readsTheBrain(app);

    const refused = await share(builder, app, guest);
    const events = await auditedDuring(async () => {
      await share(builder, app, guest);
    });
    const byAdmin = await share(admin, app, guest);

    expect({
      refused,
      events: events.map(({ action, detail }) => ({ action, detail })),
      byAdmin,
      call: await call(shared, guest, "desk.notes"),
    }).toStrictEqual({
      refused: "app.guest_sources",
      events: [
        {
          action: "app.member.refused",
          detail: {
            memberType: "person",
            member: guest.userId,
            role: "user",
            reason: "app.guest_sources",
          },
        },
      ],
      byAdmin: "ok",
      call: [],
    });
  });

  it("loses one a builder shared once it gains a source, on their next request, until an admin shares it again", async () => {
    const shared = await desk();
    const { builder, app } = shared;
    const admin = await signedInApi(idp, "admin");
    const guest = await signedInGuest();
    await share(builder, app, guest);
    const before = await call(shared, guest, "desk.notes");

    await readsTheBrain(app);
    const after = await call(shared, guest, "desk.notes");
    const home = await listed(guest);
    // A builder sharing it again gives nothing back.
    const again = await share(builder, app, guest);
    const byAdmin = await share(admin, app, guest);
    const restored = await call(shared, guest, "desk.notes");

    expect({ before, after, home, again, byAdmin, restored }).toStrictEqual({
      before: [],
      after: "app.unreadable",
      home: [],
      again: "app.guest_sources",
      byAdmin: "ok",
      restored: [],
    });
  });

  it("is its user inside it: told who they are, never the directory or the Brain, and a user's rows of its store", async () => {
    const shared = await desk();
    const { builder, app } = shared;
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    const guest = await signedInGuest();
    await share(builder, app, member);
    // An admin's share: the App reads the Brain once called, by default.
    await share(admin, app, guest);
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
      memberBrain: await call(shared, member, "desk.ask"),
    };

    expect(inside).toStrictEqual({
      // No person field names a guest: they are never someone in the
      // company, so a person rule never reaches them.
      written: ["ok", "ok", "ok", "data.write_denied", "ok"],
      user: {
        id: guest.userId,
        name: guest.person.name,
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
