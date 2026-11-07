import { peopleReferences } from "@grasp-os/sdk/host";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import type { OperationResult } from "@grasp-os/shared/operations";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { callAppFunction } from "../src/app-functions.ts";
import { publishVersion } from "../src/app-publish.ts";
import { loadRelease } from "../src/app-releases.ts";
import type { Release } from "../src/app-releases.ts";
import {
  appMembers,
  memberRemovals,
  teamMembers,
  teams,
} from "../src/db/core/schema.ts";
import { revokeRelease } from "../src/release-retention.ts";
import { chatOf, codeResults, codeStep, says } from "./agent-chat.ts";
import { appDefinition } from "./app-definitions.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { appWith, person, seal } from "./sealed-apps.ts";
import type { Fixture } from "./sealed-apps.ts";
import { auditedDuring, signedInApi, unique } from "./sign-in.ts";

// Who calls an App, and the organization's people (app-people.ts), from
// its threat model: who calls comes from core, for a builder, a user, a
// workflow run's person, an agent's person and a visitor
// (app-visitor-calls.test.ts) alike; a page can't name someone else; a
// removed person is refused; only an App that declares it reads the
// directory, which answers only members, at most 100 a read, each read
// recorded as whoever made it.

const idp = mockIdp();

/** The Directory App's files: it declares the directory unless `people` is false. */
const peopleFiles = (people = true): Record<string, string> => ({
  ...appDefinition({
    name: "Directory",
    tables: {
      notes: {
        fields: { text: "v.string()" },
        access: { read: "owner", write: "owner" },
      },
    },
    permissions: people ? ["people"] : [],
  }),
  "server/dir.ts": `import { v } from "@grasp-os/sdk";
import { action, mutation, query } from "@server/_generated/server";

/** Who calls, as the function sees it. */
export const me = query({
  args: {},
  returns: v.string(),
  handler: async (ctx) => JSON.stringify(await ctx.auth.getUser()),
});

/** The same, from a mutation and an action: whose ID it is. */
export const meToo = mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => (await ctx.auth.getUser()).id,
});

export const meAgain = action({
  args: {},
  returns: v.string(),
  handler: async (ctx) => (await ctx.auth.getUser()).id,
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

/** Keeps a note, and lists them: how a test follows an action. */
export const note = mutation({
  args: { text: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("notes", { text: args.text });
    return null;
  },
});

export const noted = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => (await ctx.db.query("notes").take(100)).map(({ text }) => text),
});

/**
 * Reads the directory, says so in a note, then reads it again until a
 * read is refused: what it was refused with.
 */
export const twice = action({
  args: {},
  returns: v.string(),
  uses: [note],
  handler: async (ctx) => {
    const first = await ctx.people.search("Person", { limit: 1 });
    await ctx.runMutation(note, { text: "read once" });
    for (let polls = 0; polls < 40; polls += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      try {
        await ctx.people.find([]);
      } catch (error) {
        return JSON.stringify({ first: first.people.length, afterwards: String(Reflect.get(Object(error), "code")) });
      }
    }
    return JSON.stringify({ first: first.people.length, afterwards: "read" });
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
});

type Sealed = Fixture & { release: Release };

type Caller = Fixture["owner"];

/** The Directory App, sealed and current, owned by a builder. */
const directoryApp = async (people = true): Promise<Sealed> => {
  const fixture = await appWith(peopleFiles(people), "Directory");
  const release = await seal(fixture);
  await publishVersion(env, fixture.owner, fixture.app, 1);
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
  { team, email }: { team?: { id: string; name: string }; email?: string } = {}
): Promise<Caller> => {
  const someone = await person("user");
  await env.DB.prepare("UPDATE users SET name = ?, email = ? WHERE id = ?")
    .bind(name, email ?? someone.email, someone.userId)
    .run();
  if (team === undefined) {
    return { ...someone, name, email: email ?? someone.email };
  }
  await drizzle(env.DB).insert(teamMembers).values({
    id: crypto.randomUUID(),
    teamId: team.id,
    userId: someone.userId,
    createdAt: new Date(),
  });
  return { ...someone, name, email: email ?? someone.email, teams: [team] };
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

/** The request of `path` of the App with `input`, as a page sends it. */
const requestOf = (release: Release, path: string, input: unknown): string =>
  JSON.stringify({
    reference: {
      name: path,
      kind: release.app.operations[path]?.kind ?? "query",
    },
    input,
  });

/** What `by` gets calling `path` of the App with `input`, as a page sends it. */
const call = async (
  { app, release }: Sealed,
  by: Caller,
  path: string,
  input: unknown = {}
): Promise<OperationResult> => {
  const { result } = await callAppFunction(
    env,
    by,
    app,
    requestOf(release, path, input)
  );
  return result;
};

type PeopleReference = (typeof peopleReferences)[keyof typeof peopleReferences];

/** The request a page's `useUser` or `usePeople` read sends. */
const readRequestOf = (
  reference: PeopleReference,
  input: unknown,
  forged: Record<string, unknown> = {}
): string =>
  JSON.stringify({
    reference: { name: reference.name, kind: "query", ...forged },
    input,
  });

/** What a page's `useUser` or `usePeople` read answers `by`. */
const read = async (
  { app }: Sealed,
  by: Caller,
  reference: PeopleReference,
  input: unknown,
  /** What the page sends of the reference in place of the SDK's. */
  forged: Record<string, unknown> = {}
): Promise<OperationResult> => {
  const { result } = await callAppFunction(
    env,
    by,
    app,
    readRequestOf(reference, input, forged)
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

/**
 * Who calls, as a test compares it: who, by name and address. Their roles
 * are the call's gate's, which the first test reads; what a caller's
 * identity claims of itself is what the gate decides on.
 */
const callerSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().nullable(),
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

/** The directory reads recorded in `events`: who read, and what. */
const recordedReads = (
  events: readonly {
    action: string;
    actor: { type: string };
    detail: unknown;
  }[]
) =>
  events
    .filter(({ action }) => action.startsWith("app.people."))
    .map(({ action, actor, detail }) => ({
      action,
      actor: "part" in actor ? actor.part : actor.type,
      detail,
    }));

describe("who calls an App, and its people", { timeout: 120_000 }, () => {
  it("tell every kind of function who calls, from core: a builder and a user each as themselves, with their roles", async () => {
    const app = await directoryApp();
    const sales = await newTeam(`Sales ${unique()}`);
    const ana = await member(`Ana ${unique()}`, { team: sales });
    await share(app, ana);

    expect({
      builder: answerOf(await call(app, app.owner, "dir.me")),
      user: answerOf(await call(app, ana, "dir.me")),
      mutation: valueOf(await call(app, ana, "dir.meToo")),
      action: valueOf(await call(app, ana, "dir.meAgain")),
    }).toStrictEqual({
      builder: {
        id: app.owner.userId,
        name: "Person",
        email: app.owner.email,
        roles: ["builder", "user"],
      },
      user: {
        id: ana.userId,
        name: ana.name,
        email: ana.email,
        roles: ["user"],
      },
      mutation: ana.userId,
      action: ana.userId,
    });
  });

  it("are core's to say: a name or role the caller's identity claims, or a page's reference, makes it nobody else", async () => {
    const app = await directoryApp();
    const ana = await member(`Ana ${unique()}`);
    await share(app, ana);
    // What a client could claim of itself: core reads its own record.
    const claimed = { ...ana, name: "The Admin", role: "admin" as const };
    const anaAs = {
      id: ana.userId,
      name: ana.name,
      email: ana.email,
    };

    expect({
      fromServer: callerOf(await call(app, claimed, "dir.me")),
      fromPage: callerOf(await read(app, claimed, peopleReferences.user, {})),
      // Another App and version named: a reference is a name, and nothing
      // more is read.
      otherApp: valueOf(
        await read(
          app,
          ana,
          peopleReferences.user,
          {},
          {
            resourceId: "someone-elses",
            resourceVersion: 7,
          }
        )
      ),
      // Arguments that try to name someone: refused, not read.
      naming: valueOf(
        await read(app, ana, peopleReferences.user, {
          userId: app.owner.userId,
        })
      ),
      otherContract: valueOf(
        await read(
          app,
          ana,
          peopleReferences.user,
          {},
          {
            fingerprint: "0".repeat(64),
          }
        )
      ),
    }).toStrictEqual({
      fromServer: anaAs,
      fromPage: anaAs,
      otherApp: "contract.invalid_request",
      naming: "contract.invalid_args",
      otherContract: "contract.invalid_request",
    });
  });

  it("refuse someone an admin removed, on the server and in a page", async () => {
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
      page: valueOf(await read(app, ben, peopleReferences.user, {})),
    }).toStrictEqual({
      before: "answered",
      server: "permission.person_inactive",
      page: "permission.person_inactive",
    });
  });

  it("admit every directory read again: one made after the release is revoked mid-action is refused", async () => {
    const app = await directoryApp();
    const running = call(app, app.owner, "dir.twice");
    await vi.waitFor(
      async () => {
        expect(valueOf(await call(app, app.owner, "dir.noted"))).toStrictEqual([
          "read once",
        ]);
      },
      { timeout: 6000, interval: 100 }
    );
    await revokeRelease(
      env,
      await person("admin"),
      { app: appIdSchema.parse(app.app), version: 1 },
      "Reads too much"
    );

    expect(answerOf(await running)).toStrictEqual({
      first: 1,
      afterwards: "version.revoked",
    });
  });

  it("refuse the directory to an App that doesn't declare it, recorded, and still tell it who calls", async () => {
    const app = await directoryApp(false);
    const ana = await member(`Ana ${unique()}`);
    await share(app, ana);

    let answers: Record<string, unknown> = {};
    const events = await auditedDuring(async () => {
      answers = {
        caller: callerOf(await call(app, ana, "dir.me")),
        server: answerOf(
          await call(app, ana, "dir.search", { query: "Ana", limit: 5 })
        ),
        page: valueOf(
          await read(app, ana, peopleReferences.search, { query: "Ana" })
        ),
      };
    });

    expect({ ...answers, recorded: recordedReads(events) }).toStrictEqual({
      caller: {
        id: ana.userId,
        name: ana.name,
        email: ana.email,
      },
      server: "permission.denied",
      page: "permission.denied",
      recorded: [
        {
          action: "app.people.refused",
          actor: "server",
          detail: { person: ana.userId, read: "search", reason: "undeclared" },
        },
        {
          action: "app.people.refused",
          actor: "page",
          detail: { person: ana.userId, read: "search", reason: "undeclared" },
        },
      ],
    });
  });

  it("answer only current members, with their name, email and teams, and no placeholder address", async () => {
    const app = await directoryApp();
    const team = await newTeam(`Ops ${unique()}`);
    const surname = unique();
    const cleo = await member(`Cleo ${surname}`, { team });
    const dirk = await member(`Dirk ${surname}`, {
      team,
      // Made from the directory, never signed in: no address of theirs.
      email: `${crypto.randomUUID()}@directory.invalid`,
    });
    const gone = await member(`Gone ${surname}`, { team });
    await drizzle(env.DB).insert(memberRemovals).values({
      organizationId: "organization",
      userId: gone.userId,
      removedAt: new Date(),
    });
    await share(app, cleo);
    await share(app, dirk);

    const answer = answerOf(
      await call(app, cleo, "dir.team", {
        teamId: team.id,
        ids: [dirk.userId, gone.userId, "nobody"],
      })
    );
    const entry = (someone: Caller, email: string | null) => ({
      id: someone.userId,
      name: someone.name,
      email,
      teams: [team],
    });

    expect({
      answer,
      dirkIs: callerOf(await call(app, dirk, "dir.me")),
      placeholders: namesOf(
        answerOf(
          await call(app, cleo, "dir.search", {
            query: "directory.invalid",
            limit: 100,
          })
        )
      ),
    }).toStrictEqual({
      answer: {
        page: {
          people: [entry(cleo, cleo.email), entry(dirk, null)],
          next: null,
        },
        found: [entry(dirk, null)],
      },
      dirkIs: {
        id: dirk.userId,
        name: dirk.name,
        email: null,
      },
      placeholders: [],
    });
  });

  it("bound every read to 100 people, page by page, take a search literally, and record each read without whom it found", async () => {
    const app = await directoryApp();
    const surname = `Zed${unique()}`;
    const named = await Promise.all(
      ["A", "B", "C", "Émile"].map(
        async (first) => await member(`${first} ${surname}`)
      )
    );
    const [first] = named;
    if (first === undefined) {
      throw new Error("No member");
    }
    await share(app, first);
    const search = async (query: string, limit = 100) =>
      namesOf(answerOf(await call(app, first, "dir.search", { query, limit })));

    let firstPage: unknown;
    let secondPage: unknown;
    const events = await auditedDuring(async () => {
      firstPage = answerOf(
        await call(app, first, "dir.search", { query: surname, limit: 2 })
      );
      secondPage = answerOf(
        await read(app, first, peopleReferences.search, {
          query: surname,
          limit: 2,
          cursor: pageSchema.parse(firstPage).next,
        })
      );
    });

    expect({
      first: namesOf(firstPage),
      second: namesOf(secondPage),
      tooMany: await search(surname, 101),
      tooManyIds: valueOf(
        await read(app, first, peopleReferences.find, {
          ids: Array.from({ length: 101 }, () => crypto.randomUUID()),
        })
      ),
      everyone: await search("@"),
      oneLetter: await search(".a."),
      // `%`, `_` and `\` are characters, never a pattern's wildcards or escape.
      percent: await search(`A%${surname}`),
      underscore: await search(`A_${surname}`),
      backslash: await search(`A\\ ${surname}`),
      accented: await search(`Émile ${surname}`),
      recorded: recordedReads(events),
    }).toStrictEqual({
      first: [`A ${surname}`, `B ${surname}`],
      second: [`C ${surname}`, `Émile ${surname}`],
      tooMany: "contract.invalid_args",
      tooManyIds: "contract.invalid_args",
      everyone: "contract.invalid_args",
      oneLetter: "contract.invalid_args",
      percent: [],
      underscore: [],
      backslash: [],
      accented: [`Émile ${surname}`],
      recorded: [
        {
          action: "app.people.read",
          actor: "server",
          detail: { person: first.userId, read: "search", count: 2 },
        },
        {
          action: "app.people.read",
          actor: "page",
          detail: { person: first.userId, read: "search", count: 2 },
        },
      ],
    });
  });
});

describe("a chat's agent and who calls an App", { timeout: 180_000 }, () => {
  it("is its person to the App, and is recorded as the agent when it reads the directory itself", async () => {
    const builder = await signedInApi(idp, "builder");
    const { id } = await builder.api.apps.create({ name: "Directory" });
    const { version } = await builder.api.apps.files.commit(
      id,
      peopleFiles(),
      "First"
    );
    await builder.api.apps.versions.setCurrent(id, version);
    const release = await loadRelease(env, appIdSchema.parse(id), version);
    const chat = await chatOf(
      builder.userId,
      codeStep(`export default async (self, env) => {
        const stream = (text) => new Blob([text]).stream();
        const me = await env.apps.call(${JSON.stringify(id)}, stream(${JSON.stringify(requestOf(release, "dir.me", {}))}));
        const search = await env.apps.call(${JSON.stringify(id)}, stream(${JSON.stringify(readRequestOf(peopleReferences.search, { query: "Person", limit: 1 }))}));
        return { me: me.result, search: search.result };
      };`),
      says("Done.")
    );
    await requestGranted(idp, builder, {
      subject: chat.agent,
      object: { type: "app", appId: id },
      actions: ["read"],
      binding: "DIRECTORY",
    });

    await chat.ask("Who am I in the Directory App?");
    const [result] = await codeResults(chat.stub, chat.chat.id);
    const returned = z
      .object({
        me: z.object({ ok: z.literal(true), value: z.string() }),
        search: z.object({
          ok: z.literal(true),
          value: z.object({ people: z.array(z.unknown()) }),
        }),
      })
      .parse(JSON.parse(result?.text.replace("Returned:\n", "") ?? "{}"));
    const events = await allEvents();

    expect({
      me: z
        .object({ id: z.string(), roles: z.array(z.string()) })
        .parse(JSON.parse(returned.me.value)),
      searched: returned.search.value.people.length,
      recorded: events
        .filter(
          ({ action, target }) =>
            action === "app.people.read" && target?.id === id
        )
        .map(({ actor, detail }) => ({ actor, detail })),
    }).toStrictEqual({
      me: { id: builder.userId, roles: ["builder", "user"] },
      searched: 1,
      recorded: [
        {
          actor: {
            type: "agent",
            agentId: chat.agent.agentId,
            onBehalfOf: builder.userId,
          },
          detail: { person: builder.userId, read: "search", count: 1 },
        },
      ],
    });
  });
});
