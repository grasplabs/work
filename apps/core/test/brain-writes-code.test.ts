import type { FunctionResult } from "@grasp-os/shared/functions";
import {
  agentIdSchema,
  chatIdSchema,
  teamIdSchema,
  workspaceIdSchema,
} from "@grasp-os/shared/ids";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { Identity } from "@grasp-os/shared/rpc";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { callAppFunction, callPageFunction } from "../src/app-functions.ts";
import { addMember } from "../src/app-members.ts";
import { recallsTheBrain } from "../src/app-provenance.ts";
import { appFor, appKind } from "../src/apps.ts";
import { teamsOf } from "../src/auth/identity.ts";
import { memoriesAs, recallAs } from "../src/brain-next.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import { grantPermission, requestPermission } from "../src/permissions.ts";
import { rollback } from "../src/publish.ts";
import { approveResourceBinding } from "../src/resource-bindings.ts";
import { testApp } from "./app-definitions.ts";
import type { TableSpec } from "./app-definitions.ts";
import { commitDefined } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { appWith, person, seal } from "./sealed-apps.ts";
import { unique } from "./sign-in.ts";
import { connectDb } from "./test-env.ts";

// An App's code remembering and forgetting in the Brain (GRA-1883; the
// threat model is on the issue): `ctx.brain.remember` and `.forget`, in
// the App's own word, read only through its own code by whoever uses it
// when it reads. How it can fail, and what each test holds it to:
// 1. Someone who may not use the App reads what it remembered: another
//    App's code, a team-mate it isn't shared with, chat recall and the
//    Memories page find nothing; an agent's or Code Mode's call of the
//    App's own code reads none of it.
// 2. A write says what fewer people may read than use the App: a table
//    of owners' or a team's rows, or one only builders read, for someone
//    who builds it, refuses, checked on the version the call runs on, a
//    publish during the call included; so do a team's part of the Brain,
//    a personal connection and another App it can reach.
// 3. A write from where its arguments may hold someone's chat: an
//    agent's and Code Mode's calls are refused, and write nothing.
// 4. A call made again writes again, or keeps an audit event that differs:
//    one memory and one `done`, the same event, by ids alone.
// The leak harness (brain-next-leaks.test.ts) probes the same calls with
// marked memories, every way they answer.

/** Signing people in, sealing and granting can be slow on CI. */
const setUpTime = { timeout: 180_000 };

type Member = Awaited<ReturnType<typeof person>>;

const rolesOf = (by: Identity) => ({
  app: async (named: string, role: "user" | "builder") =>
    await appFor(env, by, named, role),
  resource: async (
    ref: Parameters<typeof requireResourceRole>[2],
    needed: Parameters<typeof requireResourceRole>[3]
  ) => {
    await requireResourceRole(env, by, ref, needed);
  },
});

/** A team of `members`, as core keeps one: its ID. */
const teamOf = async (...members: Member[]): Promise<string> => {
  const team = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO teams (id, name, organization_id, created_at) VALUES (?, 'Accounts', 'organization', ?)"
    ).bind(team, Date.now()),
    ...members.map((member) =>
      env.DB.prepare(
        "INSERT INTO team_members (id, team_id, user_id, created_at) VALUES (?, ?, ?, ?)"
      ).bind(crypto.randomUUID(), team, member.userId, Date.now())
    ),
  ]);
  return team;
};

/** `member` as their session has them now, their teams included. */
const signedIn = async (member: Member): Promise<Member> => ({
  ...member,
  teams: await teamsOf(env.DB, member.userId),
});

/**
 * An App whose action hands each Brain operation what it is given, as
 * JSON (`memories.ask`): `both` finds entities first, then remembers, so
 * a test can hold the call between its two requests. With `tables`.
 */
const memoriesApp = (tables: Readonly<Record<string, TableSpec>> = {}) =>
  testApp(
    {
      name: "Accounts",
      tables,
      permissions: [
        'permission.brain({ operations: ["remember", "forget", "entities.get", "entities.find"] })',
      ],
    },
    {
      "server/memories.ts": `import { v } from "@grasp-os/sdk";
import { action } from "@server/_generated/server";

export const ask = action({
  args: { operation: v.string(), input: v.string() },
  handler: async (ctx, args) => {
    const input = JSON.parse(args.input);
    switch (args.operation) {
      case "remember":
        return await ctx.brain.remember(input);
      case "forget":
        return await ctx.brain.forget(input);
      case "get":
        return await ctx.brain.entities.get(input);
      case "both":
        await ctx.brain.entities.find({ kind: "customer" });
        return await ctx.brain.remember(input);
      default:
        return await ctx.brain.entities.find(input);
    }
  },
});
`,
    }
  );

/** A table of one field, read as `read` says, written by its readers. */
const table = (
  read: NonNullable<TableSpec["access"]>["read"],
  rows?: NonNullable<NonNullable<TableSpec["access"]>["rows"]>["read"]
): TableSpec => ({
  fields: {
    title: "v.string()",
    team: "v.string().optional()",
    assignee: "v.person().optional()",
  },
  access: {
    read,
    write: read,
    ...(rows === undefined ? {} : { rows: { read: rows, write: rows } }),
  },
});

/**
 * App `tables` of `owner`'s, sealed and current, its Brain declaration
 * bound by `admin` to its grant to read the Brain, naming `teams` if any.
 */
const appOf = async (
  owner: Member,
  admin: Member,
  {
    tables,
    teams,
  }: { tables?: Readonly<Record<string, TableSpec>>; teams?: string[] } = {}
) => {
  const fixture = await appWith(memoriesApp(tables), "Accounts", owner);
  const release = await seal(fixture);
  await rollback(env, appKind, fixture.owner, fixture.app, 1);
  const asked = await requestPermission(
    env,
    owner,
    {
      subject: { type: "app", appId: fixture.app },
      object:
        teams === undefined
          ? { type: "platform" }
          : {
              type: "platform",
              teams: teams.map((team) => teamIdSchema.parse(team)),
            },
      actions: ["brain"],
      binding: `BRAIN_${unique().replaceAll(/\W/gu, "_").toUpperCase()}`,
    } satisfies PermissionRequest,
    rolesOf(owner)
  );
  await grantPermission(env, admin, asked.id, {
    version: release.manifest.resourceVersion,
  });
  await approveResourceBinding(env, admin, {
    app: fixture.app,
    alias: "brain",
    target: { kind: "brain", permissionId: asked.id },
    reviewed: { version: 1 },
  });
  return fixture;
};

type App = Awaited<ReturnType<typeof appOf>>;

/** Version `version` of `app`, with `tables`, sealed and made current. */
const published = async (
  app: App,
  version: number,
  tables: Readonly<Record<string, TableSpec>>
): Promise<void> => {
  await commitDefined(env, app.owner, app.app, memoriesApp(tables));
  await seal(app, version);
  await rollback(env, appKind, app.owner, app.app, version);
};

/** The call of `operation` with `input`, as a page sends it. */
const requestOf = (
  operation: string,
  input: unknown,
  idempotencyKey?: string
): string =>
  JSON.stringify({
    reference: { name: "memories.ask", kind: "action" },
    args: { operation, input: JSON.stringify(input) },
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  });

/** What `result` answered: its value, or its error's code and details. */
const answerOf = (result: FunctionResult): unknown =>
  result.ok ? result.value : { failed: result.error.code };

/** What `operation` of `app`'s answers `by` on its page. */
const onPage = async (
  app: App,
  by: Member,
  operation: string,
  input: unknown,
  { key, on = env }: { key?: string; on?: Env } = {}
): Promise<unknown> => {
  const { result } = await callPageFunction(
    on,
    by,
    app.app,
    requestOf(operation, input, key),
    Date.now() + 60_000
  );
  return answerOf(result);
};

/** What `operation` of `app`'s answers `by`'s chat's agent, or its Code Mode run. */
const byAgent = async (
  app: App,
  by: Member,
  operation: string,
  input: unknown,
  { codeMode = false } = {}
): Promise<unknown> => {
  const { result } = await callAppFunction(
    env,
    by,
    app.app,
    requestOf(operation, input),
    Date.now() + 60_000,
    undefined,
    codeMode ? `session-${unique()}` : undefined,
    {
      agentId: agentIdSchema.parse(crypto.randomUUID()),
      workspaceId: workspaceIdSchema.parse(crypto.randomUUID()),
      chatId: chatIdSchema.parse(crypto.randomUUID()),
    }
  );
  return answerOf(result);
};

/** A fact about a new customer `name`, as code remembers one. */
const fact = (name: string) => ({
  about: { kind: "customer", names: [name] },
  attribute: "status",
  value: "active",
  statement: `${name} is active`,
});

/** Any text, as an expectation. */
const someText: unknown = expect.any(String);

const rememberedSchema = z.strictObject({
  memory: z.uuid(),
  entity: z.uuid(),
});

/** The statements of a card code read, or none. */
const statementsOf = (card: unknown): string[] =>
  card === null
    ? []
    : z
        .object({
          attributes: z.array(
            z.object({ memories: z.array(z.object({ statement: z.string() })) })
          ),
        })
        .parse(card)
        .attributes.flatMap(({ memories }) =>
          memories.map(({ statement }) => statement)
        );

/** The ids of a page of entities code found. */
const idsOf = (page: unknown): string[] =>
  z
    .object({ entities: z.array(z.object({ id: z.string() })) })
    .parse(page)
    .entities.map(({ id }) => id);

/** The audit events of `action` about `memory`, once `count` are kept. */
const eventsOf = async (action: string, memory: string, count: number) =>
  await vi.waitFor(
    async () => {
      const all = await allEvents();
      const events = all.filter(
        (event) =>
          event.action === action &&
          JSON.stringify(event.detail).includes(memory)
      );
      expect(events.length).toBeGreaterThanOrEqual(count);
      return events;
    },
    { timeout: 10_000, interval: 50 }
  );

/** A grant as an admin's writes its row: what the provenance walk follows. */
const grant = (
  subjectType: "app" | "workflow",
  subject: string,
  objectType: "connection" | "workflow" | "app",
  object: string,
  actions: readonly string[],
  status = "active"
) =>
  env.DB.prepare(
    `INSERT INTO permissions (id, subject_type, subject_id, object_type, object_id,
      actions, binding, status, requested_by, requested_at, granted_by, granted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'test', 0, 'test', 0)`
  ).bind(
    crypto.randomUUID(),
    subjectType,
    subject,
    objectType,
    object,
    JSON.stringify(actions),
    `GRANT_${unique().replaceAll(/\W/gu, "_").toUpperCase()}`,
    status
  );

/**
 * `namespace` with the shared store's `method` waiting for `before` the
 * first time it is called, then answering as it would: a call held
 * between two of its requests, for a test to change what it runs on.
 */
const holdingFirst = (
  namespace: Env["BRAIN_STORE"],
  method: string,
  before: () => Promise<void>
): Env["BRAIN_STORE"] => {
  let first = true;
  const stubOf = (stub: object): object =>
    new Proxy(stub, {
      get: (target, property): unknown => {
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== "function") {
          return value;
        }
        // An RPC stub's method takes no `bind`: it would be a remote call.
        return async (...args: unknown[]): Promise<unknown> => {
          if (property === method && first) {
            first = false;
            await before();
          }
          return await Reflect.apply(value, target, args);
        };
      },
    });
  const namespaceOf = (of: Env["BRAIN_STORE"]): Env["BRAIN_STORE"] =>
    new Proxy(of, {
      get: (target, property): unknown => {
        if (property === "jurisdiction") {
          return (jurisdiction: DurableObjectJurisdiction) =>
            namespaceOf(target.jurisdiction(jurisdiction));
        }
        if (property === "getByName") {
          return (name: string) => {
            const stub = target.getByName(name);
            return name === "brain" ? stubOf(stub) : stub;
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return namespaceOf(namespace);
};

describe("an App's code remembers and forgets for its users", setUpTime, () => {
  it("remembers for the App's users, read back through its own code; nothing else finds it; forgets only its own; and a call made again is one memory and one event", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const [bob, cara, dan] = await Promise.all([
      person("user"),
      person("user"),
      person("user"),
    ]);
    // Shared with Bob and Cara's team; Dan is in a team with Bob alone.
    const team = await teamOf(bob, cara);
    await teamOf(bob, dan);
    const app = await appOf(ada, admin);
    const other = await appOf(ada, admin);
    await addMember(env, ada, app.app, {
      type: "team",
      id: team,
      role: "user",
    });
    const [asBob, asCara, asDan] = await Promise.all(
      [bob, cara, dan].map(async (member) => await signedIn(member))
    );
    if (asBob === undefined || asCara === undefined || asDan === undefined) {
      throw new Error("No sessions");
    }
    const name = `Acme ${unique()}`;
    const key = `call-${unique()}`;
    // An event kept again with other content is logged as a conflict.
    const warn = vi.spyOn(console, "warn");

    const written = rememberedSchema.parse(
      await onPage(app, asBob, "remember", fact(name), { key })
    );
    // The same call made again: the same memory.
    const again = await onPage(app, asBob, "remember", fact(name), { key });
    const card = await onPage(app, asCara, "get", { entity: written.entity });
    const found = await onPage(app, asCara, "find", { name });
    const recalled = await recallAs(env, bob.userId, {
      question: name,
      budget: { tokens: 2000 },
      personal: true,
    });

    expect({
      again,
      read: statementsOf(card),
      found: idsOf(found),
      // Another App's code, an agent's and Code Mode's call of this one.
      otherApp: await onPage(other, ada, "get", { entity: written.entity }),
      agent: await byAgent(app, asCara, "get", { entity: written.entity }),
      codeMode: await byAgent(
        app,
        asCara,
        "find",
        { name },
        { codeMode: true }
      ),
      // A team-mate it isn't shared with can't call it at all.
      dan: await onPage(app, asDan, "get", { entity: written.entity }),
      // Their own Memories page and chat recall: nothing of the App's.
      pages: await Promise.all(
        [bob, dan].map(async ({ userId }) => {
          const page = await memoriesAs(env, userId, {
            entity: { store: "shared", id: written.entity },
          });
          return page.memories;
        })
      ),
      recalled: recalled.memories.some(({ statement }) =>
        statement.includes(name)
      ),
    }).toStrictEqual({
      again: written,
      read: [`${name} is active`],
      found: [written.entity],
      otherApp: null,
      agent: null,
      codeMode: { entities: [], next: null },
      dan: { failed: "app.not_found" },
      pages: [[], []],
      recalled: false,
    });

    // Another App forgets none of it; its own forgets it, again the same.
    const forgotByOther = await onPage(other, ada, "forget", {
      memory: written.memory,
    });
    const forgetKey = `call-${unique()}`;
    const forgot = await onPage(
      app,
      asCara,
      "forget",
      { memory: written.memory },
      { key: forgetKey }
    );
    // Made again: answers the time the store recorded, so the same event.
    const forgotAgain = await onPage(
      app,
      asCara,
      "forget",
      { memory: written.memory },
      { key: forgetKey }
    );
    expect({
      forgotByOther,
      forgot,
      forgotAgain,
      read: statementsOf(
        await onPage(app, asBob, "get", { entity: written.entity })
      ),
    }).toStrictEqual({
      forgotByOther: false,
      forgot: true,
      forgotAgain: true,
      read: [],
    });

    // One `done` for the memory, the same event whichever call kept it,
    // by ids alone: never what it says.
    const remembered = await eventsOf(
      "brain.memory.remembered",
      written.memory,
      1
    );
    const forgotten = await eventsOf(
      "brain.memory.forgotten",
      written.memory,
      3
    );
    expect({
      remembered: remembered.map(({ actor, target, detail }) => ({
        actor,
        target,
        detail,
      })),
      forgotten: forgotten
        .filter(({ detail }) => detail?.result === "done")
        .map(({ id, at, detail }) => ({ id, at, detail })),
      said: JSON.stringify([...remembered, ...forgotten]).includes(name),
      conflicts: warn.mock.calls.filter((args) =>
        [...remembered, ...forgotten].some(
          ({ id }) =>
            JSON.stringify(args).includes("audit.conflicting_duplicate") &&
            JSON.stringify(args).includes(id)
        )
      ).length,
    }).toStrictEqual({
      remembered: [
        {
          actor: { type: "app", appId: app.app, part: "server" },
          target: { type: "app", id: app.app },
          detail: {
            onBehalfOf: bob.userId,
            outcome: "done",
            memory: written.memory,
            entity: written.entity,
          },
        },
      ],
      // Cara's call and the same call made again: one event.
      forgotten: [
        {
          id: someText,
          at: someText,
          detail: {
            onBehalfOf: cara.userId,
            memory: written.memory,
            outcome: "done",
            result: "done",
          },
        },
      ],
      said: false,
      conflicts: 0,
    });
  });

  it("is refused, writing nothing, when an agent or Code Mode calls the App", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const app = await appOf(ada, admin);
    const name = `Agentco ${unique()}`;

    expect({
      agent: await byAgent(app, ada, "remember", fact(name)),
      codeMode: await byAgent(app, ada, "remember", fact(name), {
        codeMode: true,
      }),
      found: idsOf(await onPage(app, ada, "find", { name })),
      // It declares no recall, yet holds the Brain: it answers no visitor
      // (app-visitor-calls.test.ts holds a visitor to that).
      answersNoVisitor: await recallsTheBrain(env, app.app),
    }).toStrictEqual({
      agent: { failed: "permission.brain_write_caller" },
      codeMode: { failed: "permission.brain_write_caller" },
      found: [],
      answersNoVisitor: true,
    });
  });

  it("writes only while every table of the version that runs is read by everyone who uses the App: owners', a team's or a person's rows refuse; builders' alone refuse a builder alone; a table nobody reads doesn't", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const bob = await person("user");
    const app = await appOf(ada, admin, { tables: { diary: table("owner") } });
    await addMember(env, ada, app.app, {
      type: "person",
      id: bob.userId,
      role: "user",
    });
    const tried = async (by: Member) =>
      await onPage(app, by, "remember", fact(`Tableco ${unique()}`));
    const owners = await tried(ada);
    await published(app, 2, {
      diary: table("appMembers", [{ kind: "team", field: "team" }]),
    });
    const teams = await tried(ada);
    await published(app, 3, {
      diary: table("appMembers", [{ kind: "person", field: "assignee" }]),
    });
    const persons = await tried(ada);
    await published(app, 4, { plans: table("appBuilders") });
    const builders = {
      ada: await tried(ada),
      bob: rememberedSchema.safeParse(await tried(bob)).success,
    };
    await published(app, 5, {
      hidden: table("none"),
      notes: table("appMembers"),
      tasks: table("appMembers", [{ kind: "role", role: "user" }]),
    });
    const everyones = rememberedSchema.safeParse(await tried(ada)).success;

    expect({ owners, teams, persons, builders, everyones }).toStrictEqual({
      owners: { failed: "permission.brain_write_table" },
      teams: { failed: "permission.brain_write_table" },
      persons: { failed: "permission.brain_write_table" },
      builders: {
        ada: { failed: "permission.brain_write_builders_table" },
        bob: true,
      },
      everyones: true,
    });
  });

  it("checks the tables of the version the call runs on: a publish during the call that opens its owners' table still refuses it", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const app = await appOf(ada, admin, { tables: { diary: table("owner") } });
    // The call's first request held until version 2 is current.
    const reached = Promise.withResolvers<null>();
    const held = Promise.withResolvers<null>();
    const holding = holdingFirst(env.BRAIN_STORE, "findEntities", async () => {
      reached.resolve(null);
      await held.promise;
    });
    const name = `Midco ${unique()}`;
    const during = onPage(app, ada, "both", fact(name), {
      on: { ...env, BRAIN_STORE: holding },
    });
    await reached.promise;
    await published(app, 2, { diary: table("appMembers") });
    held.resolve(null);

    expect({
      during: await during,
      // Version 2 itself writes: only the version that ran refused.
      after: rememberedSchema.safeParse(
        await onPage(app, ada, "remember", fact(`After ${unique()}`))
      ).success,
      found: idsOf(await onPage(app, ada, "find", { name })),
    }).toStrictEqual({
      during: { failed: "permission.brain_write_table" },
      after: true,
      found: [],
    });
  });

  it("writes only while everything the App can reach is everyone's: a team's part of the Brain, a personal connection and another App each refuse, for good", async () => {
    const admin = await person("admin");
    const ada = await signedIn(await person("builder"));
    const team = await teamOf(ada);
    const asAda = await signedIn(ada);
    const teamBrain = await appOf(asAda, admin, { teams: [team] });
    const mailbox = await appOf(ada, admin);
    const reaching = await appOf(ada, admin);
    const reached = await appOf(ada, admin);
    // A personal connection, granted and then revoked: it still counts.
    const connection = `connection-mailbox-${unique()}`;
    const now = Date.now();
    await connectDb()
      .prepare(
        "INSERT INTO connections (id, provider, scope, owner_user_id, status, server_kind, server, created_at, updated_at) VALUES (?, 'microsoft', 'personal', ?, 'active', 'native', 'microsoft-365', ?, ?)"
      )
      .bind(connection, ada.userId, now, now)
      .run();
    const workflow = `workflow_${unique().replaceAll("-", "")}`;
    await env.DB.batch([
      grant(
        "app",
        mailbox.app,
        "connection",
        connection,
        ["mail.read"],
        "revoked"
      ),
      // Reaching starts a workflow that calls the other App's functions.
      grant("app", reaching.app, "workflow", workflow, ["start"]),
      grant("workflow", workflow, "app", reached.app, ["call"]),
    ]);

    const tried = async (app: App, by: Member = ada) =>
      await onPage(app, by, "remember", fact(`Reachco ${unique()}`));
    expect({
      teamBrain: await tried(teamBrain, asAda),
      mailbox: await tried(mailbox),
      reaching: await tried(reaching),
      reached: await tried(reached),
    }).toStrictEqual({
      teamBrain: { failed: "permission.brain_write_reach" },
      mailbox: { failed: "permission.brain_write_reach" },
      reaching: { failed: "permission.brain_write_reach" },
      reached: { failed: "permission.brain_write_reach" },
    });
  });
});
