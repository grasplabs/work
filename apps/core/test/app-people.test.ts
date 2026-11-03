import { peopleReferences } from "@grasp-os/sdk/host";
import type { Json } from "@grasp-os/shared/json";
import type { OperationResult } from "@grasp-os/shared/operations";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { callAppFunction } from "../src/app-functions.ts";
import type { Release } from "../src/app-releases.ts";
import { setCurrentVersion } from "../src/apps.ts";
import {
  appMembers,
  memberRemovals,
  teamMembers,
  teams,
} from "../src/db/core/schema.ts";
import { appWith, person, seal } from "./sealed-apps.ts";
import type { Fixture } from "./sealed-apps.ts";
import { auditedDuring, unique } from "./sign-in.ts";

// Who calls an App, and the organization's people (app-people.ts), from
// its threat model: who calls comes from core, for a builder, a user and
// a visitor (app-visitor-calls.test.ts) alike; a screen can't name
// someone else; a removed person is refused; the directory answers only
// members, at most 100 a read, each read recorded.

const peopleFiles: Record<string, string> = {
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  notes: defineTable({ text: v.string() }),
});
`,
  "operations/people.ts": `import { v } from "@grasp-os/sdk";
import { action, mutation, query } from "#grasp/server";

/** Who calls, as the function sees it. */
export const me = query({
  args: {},
  returns: v.string(),
  handler: (ctx) => JSON.stringify(ctx.caller),
});

/** The same, from a mutation and an action. */
export const meToo = mutation({
  args: {},
  returns: v.string(),
  handler: (ctx) => ctx.caller.kind,
});

export const meAgain = action({
  args: {},
  returns: v.string(),
  handler: (ctx) => ctx.caller.kind,
});

/** A search of the directory, or the code it was refused with. */
export const search = query({
  args: { query: v.string(), limit: v.number() },
  returns: v.string(),
  handler: async (ctx, args) => {
    try {
      return JSON.stringify(await ctx.people.search(args.query, { limit: args.limit }));
    } catch (error) {
      return JSON.stringify(String(Reflect.get(Object(error), "code")));
    }
  },
});

/** A team's members, and the people with the IDs given. */
export const team = query({
  args: { teamId: v.string(), ids: v.array(v.string()) },
  returns: v.string(),
  handler: async (ctx, args) => {
    const page = await ctx.people.team(args.teamId);
    const found = await ctx.people.find(args.ids);
    return JSON.stringify({ page, found });
  },
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { me, meAgain, meToo, search, team } from "./operations/people.ts";
import schema from "./schema.ts";

export default app({
  name: "Directory",
  schema,
  access: { tables: { notes: { read: "owner", write: "owner" } } },
  operations: { dir: { me, meToo, meAgain, search, team } },
  internalOperations: {},
  screens: [],
  uses: [],
});
`,
};

type Sealed = Fixture & { release: Release };

type Caller = Fixture["owner"];

/** The Directory App, sealed and current, owned by a builder. */
const directoryApp = async (): Promise<Sealed> => {
  const fixture = await appWith(peopleFiles, "Directory");
  const release = await seal(fixture);
  await setCurrentVersion(env, fixture.owner, fixture.app, 1);
  return { ...fixture, release };
};

/** Shares the App with `by`, as one of its users. */
const share = async ({ app, owner }: Sealed, by: Caller): Promise<void> => {
  await drizzle(env.DB).insert(appMembers).values({
    appId: app,
    memberType: "person",
    memberId: by.userId,
    role: "user",
    addedBy: owner.userId,
    addedAt: new Date(),
  });
};

/** A member called `name`, in team `team` when given, as their session has them. */
const member = async (
  name: string,
  team?: { id: string; name: string }
): Promise<Caller> => {
  const someone = await person("user");
  await env.DB.prepare("UPDATE users SET name = ? WHERE id = ?")
    .bind(name, someone.userId)
    .run();
  if (team === undefined) {
    return { ...someone, name };
  }
  await drizzle(env.DB).insert(teamMembers).values({
    id: crypto.randomUUID(),
    teamId: team.id,
    userId: someone.userId,
    createdAt: new Date(),
  });
  return { ...someone, name, teams: [team] };
};

/** A team of the organization. */
const newTeam = async (name: string): Promise<{ id: string; name: string }> => {
  const id = crypto.randomUUID();
  await drizzle(env.DB).insert(teams).values({
    id,
    name,
    organizationId: "organization",
    createdAt: new Date(),
  });
  return { id, name };
};

/** What `by` gets calling `path` of the App with `input`, as a screen sends it. */
const call = async (
  { app, release }: Sealed,
  by: Caller,
  path: string,
  input: unknown = {}
): Promise<OperationResult> => {
  const operation = release.app.operations[path];
  const { result } = await callAppFunction(
    env,
    by,
    app,
    JSON.stringify({
      reference: {
        resourceId: release.manifest.resourceId,
        resourceVersion: release.manifest.resourceVersion,
        contractId: path,
        fingerprint: release.fingerprints[path] ?? "",
        kind: operation?.kind ?? "query",
      },
      input,
    })
  );
  return result;
};

/** What a screen's `useCaller` or `usePeople` read answers `by`. */
const read = async (
  { app }: Sealed,
  by: Caller,
  reference: (typeof peopleReferences)[keyof typeof peopleReferences],
  input: unknown,
  /** What the screen sends of the reference in place of the SDK's. */
  forged: Record<string, unknown> = {}
): Promise<OperationResult> => {
  const { result } = await callAppFunction(
    env,
    by,
    app,
    JSON.stringify({
      reference: {
        resourceId: reference.resourceId,
        resourceVersion: reference.resourceVersion,
        contractId: reference.contractId,
        fingerprint: reference.fingerprint,
        kind: reference.kind,
        ...forged,
      },
      input,
    })
  );
  return result;
};

/** The JSON text a call answered, parsed; the refusal's code otherwise. */
const answerOf = (result: OperationResult): unknown => {
  if (!result.ok) {
    return result.error.code;
  }
  return typeof result.value === "string"
    ? JSON.parse(result.value)
    : result.value;
};

/** A caller as a test compares it: who, by name and role. */
const callerSchema = z.object({
  id: z.string(),
  name: z.string(),
  orgRole: z.string(),
});

/** Who a call answered was calling, or the code it was refused with. */
const callerOf = (result: OperationResult): unknown => {
  const answer = answerOf(result);
  return typeof answer === "string" ? answer : callerSchema.parse(answer);
};

/** A page of people as a test reads it. */
const pageSchema = z.object({
  people: z.array(z.object({ name: z.string() })),
  next: z.string().nullable(),
});

/** The names on a page of people, or the code its read was refused with. */
const namesOf = (page: unknown): unknown =>
  typeof page === "string"
    ? page
    : pageSchema.parse(page).people.map(({ name }) => name);

/** The value a call answered, or its refusal's code. */
const valueOf = (result: OperationResult): Json =>
  result.ok ? result.value : result.error.code;

describe("who calls an App, and its people", { timeout: 120_000 }, () => {
  it("tell every kind of function who calls, from core: a builder and a user each as themselves, with their roles and teams", async () => {
    const app = await directoryApp();
    const sales = await newTeam(`Sales ${unique()}`);
    const ana = await member(`Ana ${unique()}`, sales);
    await share(app, ana);

    expect({
      builder: answerOf(await call(app, app.owner, "dir.me")),
      user: answerOf(await call(app, ana, "dir.me")),
      mutation: valueOf(await call(app, ana, "dir.meToo")),
      action: valueOf(await call(app, ana, "dir.meAgain")),
    }).toStrictEqual({
      builder: {
        kind: "person",
        id: app.owner.userId,
        name: "Person",
        email: app.owner.email,
        orgRole: "builder",
        appRole: "builder",
        teams: [],
      },
      user: {
        kind: "person",
        id: ana.userId,
        name: ana.name,
        email: ana.email,
        orgRole: "user",
        appRole: "user",
        teams: [sales],
      },
      mutation: "person",
      action: "person",
    });
  });

  it("are core's to say: a name or role the caller's identity claims, or a screen's reference, makes it nobody else", async () => {
    const app = await directoryApp();
    const ana = await member(`Ana ${unique()}`);
    await share(app, ana);
    // What a client could claim of itself: core reads its own record.
    const claimed = { ...ana, name: "The Admin", role: "admin" as const };

    expect({
      fromServer: callerOf(await call(app, claimed, "dir.me")),
      fromScreen: callerOf(
        await read(app, claimed, peopleReferences.caller, {})
      ),
      // Another App and version named: the call's own App answers.
      otherApp: callerOf(
        await read(
          app,
          ana,
          peopleReferences.caller,
          {},
          {
            resourceId: "someone-elses",
            resourceVersion: 7,
          }
        )
      ),
      // Arguments that try to name someone: refused, not read.
      naming: valueOf(
        await read(app, ana, peopleReferences.caller, {
          userId: app.owner.userId,
        })
      ),
      otherContract: valueOf(
        await read(
          app,
          ana,
          peopleReferences.caller,
          {},
          {
            fingerprint: "0".repeat(64),
          }
        )
      ),
    }).toStrictEqual({
      fromServer: { id: ana.userId, name: ana.name, orgRole: "user" },
      fromScreen: { id: ana.userId, name: ana.name, orgRole: "user" },
      otherApp: { id: ana.userId, name: ana.name, orgRole: "user" },
      naming: "contract.invalid_args",
      otherContract: "version.mismatch",
    });
  });

  it("refuse someone an admin removed, on the server and in a screen", async () => {
    const app = await directoryApp();
    const ben = await member(`Ben ${unique()}`);
    await share(app, ben);
    const before = answerOf(await call(app, ben, "dir.me"));
    await drizzle(env.DB).insert(memberRemovals).values({
      organizationId: "organization",
      userId: ben.userId,
      removedAt: new Date(),
    });

    expect({
      before: typeof before === "object" ? "answered" : before,
      server: valueOf(await call(app, ben, "dir.me")),
      screen: valueOf(await read(app, ben, peopleReferences.caller, {})),
    }).toStrictEqual({
      before: "answered",
      server: "permission.person_inactive",
      screen: "permission.person_inactive",
    });
  });

  it("answer only current members, with their name, email, teams and manager, and nothing else", async () => {
    const app = await directoryApp();
    const team = await newTeam(`Ops ${unique()}`);
    const surname = unique();
    const cleo = await member(`Cleo ${surname}`, team);
    const dirk = await member(`Dirk ${surname}`, team);
    const gone = await member(`Gone ${surname}`, team);
    await drizzle(env.DB).insert(memberRemovals).values({
      organizationId: "organization",
      userId: gone.userId,
      removedAt: new Date(),
    });
    await share(app, cleo);

    const answer = answerOf(
      await call(app, cleo, "dir.team", {
        teamId: team.id,
        ids: [dirk.userId, gone.userId, "nobody"],
      })
    );
    const entry = (someone: Caller) => ({
      id: someone.userId,
      name: someone.name,
      email: someone.email,
      teams: [team],
      manager: null,
    });

    expect(answer).toStrictEqual({
      page: { people: [entry(cleo), entry(dirk)], next: null },
      found: [entry(dirk)],
    });
  });

  it("bound every read to 100 people, page by page, and record each read without whom it found", async () => {
    const app = await directoryApp();
    const surname = `Zed${unique()}`;
    const named = await Promise.all(
      ["A", "B", "C"].map(async (first) => await member(`${first} ${surname}`))
    );
    const [first] = named;
    if (first === undefined) {
      throw new Error("No member");
    }
    await share(app, first);

    let firstPage: unknown;
    const events = await auditedDuring(async () => {
      firstPage = answerOf(
        await call(app, first, "dir.search", { query: surname, limit: 2 })
      );
    });
    const { next } = pageSchema.parse(firstPage);
    const secondPage = answerOf(
      await read(app, first, peopleReferences.search, {
        query: surname,
        limit: 2,
        cursor: next,
      })
    );
    expect({
      first: namesOf(firstPage),
      next: typeof next,
      second: namesOf(secondPage),
      tooMany: answerOf(
        await call(app, first, "dir.search", { query: surname, limit: 101 })
      ),
      tooManyIds: valueOf(
        await read(app, first, peopleReferences.find, {
          ids: Array.from({ length: 101 }, () => crypto.randomUUID()),
        })
      ),
      wildcard: namesOf(
        answerOf(
          await call(app, first, "dir.search", { query: "%", limit: 100 })
        )
      ),
      recorded: events
        .filter(({ action }) => action === "app.people.read")
        .map(({ actor, detail }) => ({
          actor: actor.type === "app" ? [actor.appId, actor.part] : actor.type,
          detail,
        })),
    }).toStrictEqual({
      first: [`A ${surname}`, `B ${surname}`],
      next: "string",
      second: [`C ${surname}`],
      tooMany: "contract.invalid_args",
      tooManyIds: "contract.invalid_args",
      wildcard: [],
      recorded: [
        {
          actor: [app.app, "server"],
          detail: { person: first.userId, read: "search", count: 2 },
        },
      ],
    });
  });
});
