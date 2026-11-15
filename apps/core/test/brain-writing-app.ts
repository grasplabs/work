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
import { expect, vi } from "vite-plus/test";
import { z } from "zod";

import { callAppFunction, callPageFunction } from "../src/app-functions.ts";
import { appFor, appKind } from "../src/apps.ts";
import { teamsOf } from "../src/auth/identity.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import { grantPermission, requestPermission } from "../src/permissions.ts";
import { rollback } from "../src/publish.ts";
import { approveResourceBinding } from "../src/resource-bindings.ts";
import { testApp } from "./app-definitions.ts";
import type { TableSpec } from "./app-definitions.ts";
import { commitDefined } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import type { person } from "./sealed-apps.ts";
import { appWith, seal } from "./sealed-apps.ts";
import { unique } from "./sign-in.ts";

// An App whose code remembers and forgets in the Brain (GRA-1883), as
// brain-writes-code.test.ts and the leak harness (brain-next-surfaces.ts)
// build and call it: sealed and current, its Brain declaration bound to
// its own grant, called as a page, an agent or Code Mode would.

export type Member = Awaited<ReturnType<typeof person>>;

export const rolesOf = (by: Identity) => ({
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
export const teamOf = async (...members: Member[]): Promise<string> => {
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
export const signedIn = async (member: Member): Promise<Member> => ({
  ...member,
  teams: await teamsOf(env.DB, member.userId),
});

/**
 * An App whose action hands each Brain operation what it is given, as
 * JSON (`memories.ask`): `both` finds entities first, then remembers, so
 * a test can hold the call between its two requests. With `tables`.
 */
export const memoriesApp = (tables: Readonly<Record<string, TableSpec>> = {}) =>
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
export const table = (
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
export const appOf = async (
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
  return { ...fixture, permissionId: asked.id };
};

export type App = Awaited<ReturnType<typeof appOf>>;

/** Version `version` of `app`, with `tables`, sealed and made current. */
export const published = async (
  app: App,
  version: number,
  tables: Readonly<Record<string, TableSpec>>
): Promise<void> => {
  await commitDefined(env, app.owner, app.app, memoriesApp(tables));
  await seal(app, version);
  await rollback(env, appKind, app.owner, app.app, version);
};

/** The call of `operation` with `input`, as a page sends it. */
export const requestOf = (
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
export const answerOf = (result: FunctionResult): unknown =>
  result.ok ? result.value : { failed: result.error.code };

/** What `operation` of `app`'s answers `by` on its page. */
export const onPage = async (
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
export const byAgent = async (
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
export const fact = (name: string) => ({
  about: { kind: "customer", names: [name] },
  attribute: "status",
  value: "active",
  statement: `${name} is active`,
});

/** Any text, as an expectation. */
export const someText: unknown = expect.any(String);

export const rememberedSchema = z.strictObject({
  memory: z.uuid(),
  entity: z.uuid(),
});

/** The statements of a card code read, or none. */
export const statementsOf = (card: unknown): string[] =>
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
export const idsOf = (page: unknown): string[] =>
  z
    .object({ entities: z.array(z.object({ id: z.string() })) })
    .parse(page)
    .entities.map(({ id }) => id);

/** The audit events of `action` about `memory`, once `count` are kept. */
export const eventsOf = async (action: string, memory: string, count: number) =>
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
export const grant = (
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
export const holdingFirst = (
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
