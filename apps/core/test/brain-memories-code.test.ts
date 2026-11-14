import { brainOf } from "@grasp-os/brain-next/contract";
import type { Reader } from "@grasp-os/brain-next/contract";
import { v } from "@grasp-os/runtime/app";
import { readDefinition } from "@grasp-os/runtime/definition";
import type { FunctionResult } from "@grasp-os/shared/functions";
import {
  appIdSchema,
  chatIdSchema,
  teamIdSchema,
  workflowResourceIdSchema,
} from "@grasp-os/shared/ids";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { Identity } from "@grasp-os/shared/rpc";
import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { stepIdempotencyKey } from "@grasp-os/shared/workflows";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import type { AgentScope } from "../src/agent-scope.ts";
import { callAppFunction } from "../src/app-functions.ts";
import { addMember, removeMember } from "../src/app-members.ts";
import type { Release } from "../src/app-releases.ts";
import { appFor, appKind } from "../src/apps.ts";
import { memberOf, teamsOf } from "../src/auth/identity.ts";
import { memoriesAs, recallAs } from "../src/brain-next.ts";
import {
  answerDecision,
  confirmDecision,
  reviewDecision,
} from "../src/decisions/decisions.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import {
  grantPermission,
  requestPermission,
  revokePermission,
} from "../src/permissions.ts";
import { rollback } from "../src/publish.ts";
import { approveResourceBinding } from "../src/resource-bindings.ts";
import { approveWorkflowBinding } from "../src/workflow-bindings.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import { shareWorkflowResource } from "../src/workflow-members.ts";
import { createWorkflowResource } from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { callingRunOf } from "../src/workflows/resource-authority.ts";
import { makeCall } from "../src/workflows/resource-calls.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { openTestRun, personalChatsOf } from "./agent-chat.ts";
import { testApp } from "./app-definitions.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { appWith, person, seal } from "./sealed-apps.ts";
import type { Fixture } from "./sealed-apps.ts";
import { signedInApi, unique } from "./sign-in.ts";
import { publishDefinition } from "./workflow-publishing.ts";

// The Brain's memories and entities for code (GRA-1837; the threat model
// is on the issue): an App's action (`ctx.brain.remember`, `.forget`,
// `.correct`, `.entities.get`, `.entities.find`) and a workflow's step
// (`ctx.brain.<alias>.…`). How it can fail, and what each test holds it
// to:
// 1. A write reaches readers wider than what code may read: what it
//    remembers is read by the company alone, and a fix by exactly the
//    readers of the memory it corrects.
// 2. A write lands without its own consent, or from code that may have
//    read what not every member may: refused without the grant to write,
//    for an App or a workflow whose sources not every member may read,
//    for a run whose chat had read anything, and once what a run
//    recalled is erased.
// 3. Code forgets or overrules what isn't its own, or tells what it may
//    not read exists: another App's memory isn't forgotten, and an id it
//    may not read answers as one nobody holds.
// 4. A step asked again writes again, or a refusal or the audit log
//    carries what was said: one change, one memory; ids and counts only.
// The leak harness (brain-next-leaks.test.ts) probes the same calls with
// marked memories, every way they answer.

const idp = mockIdp();

/** Signing people in, sealing and granting can be slow on CI. */
const setUpTime = { timeout: 120_000 };

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

/** A permission `by` asks for and `admin` grants, for App `version` if any. */
const granted = async (
  by: Identity,
  admin: Identity,
  request: PermissionRequest,
  version: number | null = null
): Promise<string> => {
  const asked = await requestPermission(env, by, request, rolesOf(by));
  await grantPermission(env, admin, asked.id, { version });
  return asked.id;
};

/** A platform permission of `action` for `subject`, as an admin gives it. */
const platformGrant = (
  subject: PermissionRequest["subject"],
  action: "brain" | "brain.write",
  teams?: string[]
): PermissionRequest => ({
  subject,
  object:
    teams === undefined
      ? { type: "platform" }
      : {
          type: "platform",
          teams: teams.map((team) => teamIdSchema.parse(team)),
        },
  actions: [action],
  binding: `BRAIN_${unique().replaceAll(/\W/gu, "_").toUpperCase()}`,
});

/** The shared store, as core reaches it. */
const store = () => brainOf(inJurisdiction(env, env.BRAIN_STORE));

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

/** Whom code reads as, and whom a team alone reads as. */
const company: Reader = { person: null, groups: ["company"] };
const teamOnly = (): Reader => ({ person: null, groups: [`team:${unique()}`] });

/**
 * A memory about a customer of its own (`name`), in `writer`'s word, read
 * by `group`: its id and its entity's.
 */
const written = async (
  name: string,
  { writer = `app:${unique()}`, group = "company" } = {}
): Promise<{ memory: string; entity: string }> => {
  const added = await store().addMemories({
    change: crypto.randomUUID(),
    access: { kind: "audience", group },
    entities: [
      {
        key: "c",
        kind: "customer",
        names: [name],
      },
    ],
    memories: [
      {
        about: "c",
        attribute: "status",
        value: "active",
        type: "fact",
        statement: `${name} is active`,
        speaker: { kind: "agent", agent: writer },
        basis: { kind: "writer", writer },
      },
    ],
  });
  return { memory: added.memories[0] ?? "", entity: added.entities.c ?? "" };
};

/** What `reader` reads of `entity`'s status: each statement, and whether confirmed, in order. */
const statusOf = async (entity: string, reader: Reader) => {
  const { memories } = await store().readMemories({
    entity,
    reader,
    attribute: "status",
  });
  return memories.map(({ statement, confirmed }) => ({
    statement,
    confirmed: confirmed !== null,
  }));
};

// An App.

const operations = [
  "remember",
  "forget",
  "correct",
  "entities.get",
  "entities.find",
] as const;

/**
 * An App whose action hands each operation what it is given, as JSON
 * (`ask`), with a table its members read (`appMembers`) or one of each
 * owner's own rows (`owner`).
 */
const memoriesApp = (read: "appMembers" | "owner") =>
  testApp(
    {
      name: "Accounts",
      tables: {
        notes: {
          fields: { title: "v.string()" },
          access: { read, write: read },
        },
      },
      permissions: [
        `permission.brain({ operations: ${JSON.stringify(operations)} })`,
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
      case "correct":
        return await ctx.brain.correct(input);
      case "entities.get":
        return await ctx.brain.entities.get(input);
      default:
        return await ctx.brain.entities.find(input);
    }
  },
});
`,
    }
  );

/**
 * App `app` of `owner`'s shared with every member of the organization now
 * but its admins and its owner, who have a role in it anyway: each of
 * them, as a person.
 */
const sharedWithEveryone = async (owner: Member, app: string) => {
  const { results } = await env.DB.prepare(
    "SELECT user_id AS id FROM members WHERE organization_id = 'organization' AND role != 'admin' AND user_id != ? AND user_id NOT IN (SELECT user_id FROM member_removals)"
  )
    .bind(owner.userId)
    .all<{ id: string }>();
  for (const { id } of results) {
    // oxlint-disable-next-line no-await-in-loop -- one share at a time
    await addMember(env, owner, app, { type: "person", id, role: "user" });
  }
};

/** A Diary App: each owner's own entries (`entries`, read by its owner alone). */
const diaryApp = () =>
  testApp(
    {
      name: "Diary",
      tables: {
        entries: {
          fields: { title: "v.string()" },
          access: { read: "owner", write: "owner" },
        },
      },
    },
    {
      "server/diary.ts": `import { v } from "@grasp-os/sdk";
import { mutation, query } from "@server/_generated/server";

export const add = mutation({
  args: { title: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("entries", args);
    return null;
  },
});

export const mine = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) =>
    (await ctx.db.query("entries").take(100)).map((entry) => entry.title),
});
`,
    }
  );

/** App `test` of `owner`'s, sealed and current, named `name`; shared with every member with `everyone`. */
const publishedApp = async (
  owner: Member,
  test: ReturnType<typeof testApp>,
  name: string,
  { everyone = false } = {}
) => {
  const fixture: Fixture = await appWith(test, name, owner);
  const release: Release = await seal(fixture);
  await rollback(env, appKind, fixture.owner, fixture.app, 1);
  if (everyone) {
    await sharedWithEveryone(owner, fixture.app);
  }
  return { ...fixture, release };
};

/** The stable ID of function `name` of `app`'s latest version. */
const functionIdOf = async (app: string, name: string): Promise<string> => {
  const row = await env.DB.prepare(
    "SELECT definition FROM app_versions WHERE app_id = ? ORDER BY version DESC LIMIT 1"
  )
    .bind(app)
    .first<{ definition: string }>();
  const { functions = [] } = readDefinition(
    JSON.parse(row?.definition ?? "null")
  );
  const found = functions.find((fn) => fn.name === name);
  if (found === undefined) {
    throw new Error(`No function ${name}`);
  }
  return found.id;
};

/**
 * A grant an admin gave, as its row holds it: of `subject` (an App or a
 * workflow) on `object` (a workflow or an App), with `actions`. What the
 * provenance walk follows, whatever it is for.
 */
const grantRow = async (
  subject: { type: "app" | "workflow"; id: string },
  object: { type: "app" | "workflow"; id: string },
  actions: readonly string[]
): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO permissions (id, subject_type, subject_id, object_type, object_id,
      actions, binding, status, requested_by, requested_at, granted_by, granted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 'test', 0, 'test', 0)`
  )
    .bind(
      crypto.randomUUID(),
      subject.type,
      subject.id,
      object.type,
      object.id,
      JSON.stringify(actions),
      `GRANT_${unique().replaceAll(/\W/gu, "_").toUpperCase()}`
    )
    .run();
};

/**
 * The App of `owner`'s, sealed and current, shared with every member
 * unless `everyone` is false, its declaration bound by
 * `admin` to its grant to read the Brain, and with `write`, its own grant
 * to write to it.
 */
const appOf = async (
  owner: Member,
  admin: Member,
  {
    write = true,
    teams,
    read = "appMembers",
    everyone = true,
  }: {
    write?: boolean;
    teams?: string[];
    read?: "appMembers" | "owner";
    everyone?: boolean;
  } = {}
) => {
  const fixture: Fixture = await appWith(memoriesApp(read), "Accounts", owner);
  const release: Release = await seal(fixture);
  await rollback(env, appKind, fixture.owner, fixture.app, 1);
  const subject = { type: "app" as const, appId: fixture.app };
  const version = release.manifest.resourceVersion;
  const permissionId = await granted(
    owner,
    admin,
    platformGrant(subject, "brain", teams),
    version
  );
  await approveResourceBinding(env, admin, {
    app: fixture.app,
    alias: "brain",
    target: { kind: "brain", permissionId },
    reviewed: { version: 1 },
  });
  const writeId = write
    ? await granted(
        owner,
        admin,
        platformGrant(subject, "brain.write"),
        version
      )
    : null;
  if (everyone) {
    await sharedWithEveryone(owner, fixture.app);
  }
  return { ...fixture, release, writeId };
};

/** What `operation` of `app`'s answers `by` for `input`: its value, or its error's code. */
const askedOf = async (
  app: Awaited<ReturnType<typeof appOf>>,
  by: Member,
  operation: (typeof operations)[number],
  input: unknown
): Promise<unknown> => {
  const fn = app.release.app.functions["memories.ask"];
  if (fn === undefined) {
    throw new Error("No memories.ask");
  }
  const { result }: { result: FunctionResult } = await callAppFunction(
    env,
    by,
    app.app,
    JSON.stringify({
      reference: { name: "memories.ask", kind: fn.kind },
      args: { operation, input: JSON.stringify(input) },
    })
  );
  return result.ok ? result.value : { failed: result.error.code };
};

/**
 * `namespace` with the shared store's `method` committing, then throwing
 * as a lost reply does, the first time it is called: what the caller
 * believes then, and asks again, is a write whose answer it never got.
 */
const losingFirstReply = (
  namespace: Env["BRAIN_STORE"],
  method: "addMemories" | "correctMemory" | "retireMemory"
): Env["BRAIN_STORE"] => {
  let lost = false;
  const stubOf = (stub: object): object =>
    new Proxy(stub, {
      get: (target, property): unknown => {
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== "function") {
          return value;
        }
        // An RPC stub's method takes no `bind`: it would be a remote call.
        if (property !== method) {
          return async (...args: unknown[]): Promise<unknown> =>
            await Reflect.apply(value, target, args);
        }
        return async (...args: unknown[]): Promise<unknown> => {
          const answer: unknown = await Reflect.apply(value, target, args);
          if (!lost) {
            lost = true;
            throw new Error("The reply was lost (a test's)");
          }
          return answer;
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

/** How many memories `writer` wrote in the shared store, current or not. */
const writtenBy = async (writer: string): Promise<number> =>
  await runInDurableObject(
    inJurisdiction(env, env.BRAIN_STORE).getByName("brain"),
    (_instance, state) =>
      state.storage.sql
        .exec<{ count: number }>(
          "SELECT count(*) AS count FROM memories WHERE writer = ?",
          writer
        )
        .one().count
  );

/**
 * What the audit log's keeping has said so far of conflicts: the events
 * moved out as ones the log refused (`audit_outbox_rejected`), the gaps
 * recorded for them (`audit.gap`), and the warnings of an event ID held
 * with other content (`audit.conflicting_duplicate`) among `warned`.
 */
const auditTrouble = async (warned: readonly unknown[][]) => {
  const { results } = await env.DB.prepare(
    "SELECT count(*) AS count FROM audit_outbox_rejected"
  ).all<{ count: number }>();
  const all = await allEvents();
  return {
    rejected: results[0]?.count ?? 0,
    gaps: all.filter(({ action }) => action === "audit.gap").length,
    conflicts: warned.filter((args) =>
      JSON.stringify(args).includes("audit.conflicting_duplicate")
    ).length,
  };
};

/** A fact about a new customer `name`, as code remembers one. */
const fact = (name: string) => ({
  about: { kind: "customer", names: [name] },
  statement: `${name} is a customer`,
});

/** The Brain's audit events of `onBehalfOf` for memories and entities, once `count` are kept. */
const memoryEvents = async (onBehalfOf: string, count: number) =>
  await vi.waitFor(
    async () => {
      const all = await allEvents();
      const events = all.filter(
        ({ action, detail }) =>
          (action.startsWith("brain.memory.") ||
            action.startsWith("brain.entities.")) &&
          detail?.onBehalfOf === onBehalfOf
      );
      expect(events.length).toBeGreaterThanOrEqual(count);
      return events;
    },
    { timeout: 10_000, interval: 50 }
  );

const rememberedSchema = z.strictObject({
  memory: z.uuid(),
  entity: z.uuid(),
});

describe("memories and entities, as an App reaches them", setUpTime, () => {
  it("remembers in the App's word, read by the company alone; reads it back; corrects a company memory under its readers; forgets only its own; answers an id it may not read as one nobody holds; and records each by ids", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const app = await appOf(ada, admin);
    const name = `Acme ${unique()}`;
    const statement = `${name} renews on 1 March`;

    const remembered = rememberedSchema.parse(
      await askedOf(app, ada, "remember", {
        about: { kind: "customer", names: [name] },
        attribute: "status",
        value: "renewing",
        statement,
      })
    );
    // What it remembered, read by the company, and by a team alone not.
    const byCompany = await statusOf(remembered.entity, company);
    const byTeam = await statusOf(remembered.entity, teamOnly());
    const card = await askedOf(app, ada, "entities.get", {
      entity: remembered.entity,
    });
    const found = await askedOf(app, ada, "entities.find", { name });
    // Another App's memory, the company's, which this App corrects and
    // may not forget.
    const otherName = `Other ${unique()}`;
    const other = await written(otherName);
    const fix = z.strictObject({ memory: z.uuid() }).parse(
      await askedOf(app, ada, "correct", {
        memory: other.memory,
        value: "churned",
        statement: "It left in May",
      })
    );
    // As people see it: on the Brain page and in a recall, both sides
    // contested, neither confirmed, since an App's word confirms nothing.
    const onPage = await memoriesAs(env, ada.userId, {
      entity: { store: "shared", id: other.entity },
    });
    const recalled = await recallAs(env, ada.userId, {
      question: `${otherName} status`,
      budget: { tokens: 2000 },
      personal: false,
    });
    const forgotOther = await askedOf(app, ada, "forget", {
      memory: other.memory,
    });
    const forgotOwn = await askedOf(app, ada, "forget", {
      memory: remembered.memory,
    });

    expect({
      card: z
        .object({
          entity: z.object({ id: z.string(), name: z.string().nullable() }),
          attributes: z.array(
            z.object({
              attribute: z.string(),
              memories: z.array(
                z.object({ id: z.string(), statement: z.string() })
              ),
            })
          ),
        })
        .parse(card),
      found: z
        .object({ entities: z.array(z.object({ id: z.string() })) })
        .parse(found)
        .entities.some(({ id }) => id === remembered.entity),
      byCompany,
      byTeam,
      // The fix under the company's readers too, read first.
      corrected: await statusOf(other.entity, company),
      onPage: onPage.memories.map((memory) => ({
        statement: memory.statement,
        confirmed: memory.confirmed !== null,
        contested: memory.contested,
      })),
      recalled: recalled.memories
        .filter(({ about }) => about === other.entity)
        .map((memory) => ({
          statement: memory.statement,
          confirmed: memory.confirmed,
          contested: memory.contested,
        }))
        .toSorted((a, b) => a.statement.localeCompare(b.statement)),
      correctedByTeam: await statusOf(other.entity, teamOnly()),
      fixed: fix.memory.length > 0,
      forgotOther,
      forgotOwn,
      afterForget: await statusOf(remembered.entity, company),
    }).toStrictEqual({
      card: {
        entity: { id: remembered.entity, name },
        attributes: [
          {
            attribute: "status",
            memories: [{ id: remembered.memory, statement }],
          },
        ],
      },
      found: true,
      byCompany: [{ statement, confirmed: false }],
      byTeam: [],
      corrected: [
        { statement: "It left in May", confirmed: false },
        { statement: `${otherName} is active`, confirmed: false },
      ],
      onPage: [
        { statement: "It left in May", confirmed: false, contested: true },
        {
          statement: `${otherName} is active`,
          confirmed: false,
          contested: true,
        },
      ],
      recalled: [
        { statement: "It left in May", confirmed: false, contested: true },
        {
          statement: `${otherName} is active`,
          confirmed: false,
          contested: true,
        },
      ].toSorted((a, b) => a.statement.localeCompare(b.statement)),
      correctedByTeam: [],
      fixed: true,
      forgotOther: false,
      forgotOwn: true,
      afterForget: [],
    });
    // An id it may not read (a team's alone) and one nobody holds, alike,
    // as one call site asks each.
    const hidden = await written(`Hidden ${unique()}`, {
      group: `team:${unique()}`,
    });
    const answersFor = async (entity: string, memory: string) => [
      await askedOf(app, ada, "entities.get", { entity }),
      await askedOf(app, ada, "correct", {
        memory,
        value: "churned",
        statement: "Gone",
      }),
      await askedOf(app, ada, "forget", { memory }),
      await askedOf(app, ada, "remember", {
        about: { kind: "customer", id: entity },
        statement: "A fact",
      }),
    ];
    const alike: Record<string, unknown> = {};
    for (const [as, entity, memory] of [
      ["hidden", hidden.entity, hidden.memory],
      ["unknown", crypto.randomUUID(), crypto.randomUUID()],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one call site, one at a time
      alike[as] = await answersFor(entity, memory);
    }
    expect(alike).toStrictEqual({
      hidden: alike.unknown,
      unknown: [null, null, false, { failed: "permission.invalid_args" }],
    });
    // Each call audited for her, by ids, never what it said.
    const events = await memoryEvents(ada.userId, 8);
    expect({
      actions: [...new Set(events.map(({ action }) => action))].toSorted(),
      said: [statement, name, "It left in May"].some((said) =>
        JSON.stringify(events).includes(said)
      ),
      done: events
        .filter(({ detail }) => detail?.outcome === "done")
        .map(({ action }) => action)
        .toSorted(),
    }).toStrictEqual({
      actions: [
        "brain.entities.find",
        "brain.entities.get",
        "brain.memory.corrected",
        "brain.memory.forgotten",
        "brain.memory.remembered",
      ],
      said: false,
      // The hidden and unknown ones are done too: they answered null or
      // false, as the store did.
      done: [
        "brain.memory.corrected",
        "brain.memory.corrected",
        "brain.memory.corrected",
        "brain.memory.forgotten",
        "brain.memory.forgotten",
        "brain.memory.forgotten",
        "brain.memory.forgotten",
        "brain.memory.remembered",
      ],
    });
  });

  it("writes nothing without its own grant to write, once that is revoked, from an App whose sources not every member may read, or from one whose grant names teams; and still reads", async () => {
    const admin = await person("admin");
    const signedIn = await person("builder");
    // In a team of hers, as a request of hers signed in now names it.
    const team = await teamOf(signedIn);
    const ada = { ...signedIn, teams: await teamsOf(env.DB, signedIn.userId) };
    const readOnly = await appOf(ada, admin, { write: false });
    const revoked = await appOf(ada, admin);
    const unplaced = await appOf(ada, admin);
    // Its grant to read the Brain names a team of Ada's: what it reads of
    // that team's may not reach the company, and it can be shared with
    // nobody outside the team (GRA-1842), so it is never the company's.
    const teamScoped = await appOf(ada, admin, {
      teams: [team],
      everyone: false,
    });
    // A connection it was granted that nobody can be placed for: connect
    // doesn't know it.
    await env.DB.prepare(
      `INSERT INTO permissions (id, subject_type, subject_id, object_type, object_id,
        actions, binding, status, requested_by, requested_at, granted_by, granted_at)
       VALUES (?, 'app', ?, 'connection', ?, '["mail.read"]', ?, 'active', 'test', 0, 'test', 0)`
    )
      .bind(
        crypto.randomUUID(),
        unplaced.app,
        `connection-gone-${unique()}`,
        `MAIL_${unique().replaceAll(/\W/gu, "_").toUpperCase()}`
      )
      .run();
    const before = await askedOf(revoked, ada, "remember", fact("Before"));
    if (revoked.writeId === null) {
      throw new Error("No grant to write");
    }
    await revokePermission(env, admin, revoked.writeId);

    expect({
      before: rememberedSchema.safeParse(before).success,
      readOnly: await askedOf(readOnly, ada, "remember", fact("Read only")),
      revoked: await askedOf(revoked, ada, "remember", fact("Revoked")),
      unplaced: await askedOf(unplaced, ada, "remember", fact("Unplaced")),
      teamScoped: await askedOf(teamScoped, ada, "remember", fact("Teams")),
      unplacedForget: await askedOf(unplaced, ada, "forget", {
        memory: crypto.randomUUID(),
      }),
      // Reading stays: what it reads is the company's anyway.
      unplacedReads: await askedOf(unplaced, ada, "entities.find", {
        kind: "customer",
      }).then(
        (page) =>
          z.object({ entities: z.array(z.unknown()) }).safeParse(page).success
      ),
    }).toStrictEqual({
      before: true,
      readOnly: { failed: "permission.unavailable" },
      revoked: { failed: "permission.unavailable" },
      unplaced: { failed: "permission.unavailable" },
      teamScoped: { failed: "permission.unavailable" },
      unplacedForget: { failed: "permission.unavailable" },
      unplacedReads: true,
    });
  });

  it("writes only while everything the App holds is the whole company's: never with a table of owners' own rows, shared with one team, or once it is narrowed", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const uma = await person("user");
    const team = await teamOf(uma);
    // Owners' own notes: what one person wrote, only they read.
    const ownRows = await appOf(ada, admin, { read: "owner" });
    // Shared with one team only.
    const oneTeam = await appOf(ada, admin, { everyone: false });
    await addMember(env, ada, oneTeam.app, {
      type: "team",
      id: team,
      role: "user",
    });
    // The whole company's: then narrowed, taking Uma's share away.
    const wide = await appOf(ada, admin);
    const before = await askedOf(wide, ada, "remember", fact("Wide"));
    await removeMember(env, ada, wide.app, {
      type: "person",
      id: uma.userId,
    });

    expect({
      ownRows: await askedOf(ownRows, ada, "remember", fact("Own rows")),
      oneTeam: await askedOf(oneTeam, ada, "remember", fact("One team")),
      before: rememberedSchema.safeParse(before).success,
      narrowed: await askedOf(wide, ada, "remember", fact("Narrowed")),
      // Forgetting and correcting are writes too.
      narrowedForget: await askedOf(wide, ada, "forget", {
        memory: rememberedSchema.parse(before).memory,
      }),
    }).toStrictEqual({
      ownRows: { failed: "permission.unavailable" },
      oneTeam: { failed: "permission.unavailable" },
      before: true,
      narrowed: { failed: "permission.unavailable" },
      narrowedForget: { failed: "permission.unavailable" },
    });
  });

  it("writes one memory and keeps one outcome when the store's reply to a write is lost and it is asked again", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const app = await appOf(ada, admin);
    const namespace = env.BRAIN_STORE;
    const warn = vi.spyOn(console, "warn");
    const troubleBefore = await auditTrouble([]);
    Reflect.set(env, "BRAIN_STORE", losingFirstReply(namespace, "addMemories"));
    let answer: unknown;
    try {
      answer = await askedOf(app, ada, "remember", fact("Lost reply"));
    } finally {
      Reflect.set(env, "BRAIN_STORE", namespace);
    }
    const events = await memoryEvents(ada.userId, 2);
    const troubleAfter = await auditTrouble(warn.mock.calls);
    warn.mockRestore();

    expect({
      answered: rememberedSchema.safeParse(answer).success,
      written: await writtenBy(`app:${app.app}`),
      outcomes: events
        .filter(({ action }) => action === "brain.memory.remembered")
        .map(({ detail }) => detail?.outcome),
      trouble: troubleAfter,
    }).toStrictEqual({
      answered: true,
      written: 1,
      outcomes: ["attempted", "done"],
      trouble: { ...troubleBefore, conflicts: 0 },
    });
  });

  it("writes only while everything the App reaches through its grants is the company's: a clean chain writes, and once a workflow it starts can read an App's owners' own rows, or a deeper chain can, it writes nothing", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const wide = await appOf(ada, admin);
    const deeper = await appOf(ada, admin);
    const clean = await publishedApp(ada, memoriesApp("appMembers"), "Clean", {
      everyone: true,
    });
    const diary = await publishedApp(ada, diaryApp(), "Diary");
    const starts = async (app: string, workflow: string) => {
      await grantRow(
        { type: "app", id: app },
        { type: "workflow", id: workflow },
        ["start"]
      );
    };
    const calls = async (workflow: string, app: string) => {
      await grantRow(
        { type: "workflow", id: workflow },
        { type: "app", id: app },
        ["call"]
      );
    };
    // App → workflow → an App that is the company's.
    const workflow = crypto.randomUUID();
    await starts(wide.app, workflow);
    await calls(workflow, clean.app);
    const before = await askedOf(wide, ada, "remember", fact("Clean chain"));
    // Then the workflow may call the Diary, whose rows are each owner's.
    await calls(workflow, diary.app);
    // App → workflow → workflow → the Diary.
    const [first, second] = [crypto.randomUUID(), crypto.randomUUID()];
    await starts(deeper.app, first);
    await grantRow(
      { type: "workflow", id: first },
      { type: "workflow", id: second },
      ["start"]
    );
    await calls(second, diary.app);

    expect({
      before: rememberedSchema.safeParse(before).success,
      after: await askedOf(wide, ada, "remember", fact("Unclean chain")),
      afterForget: await askedOf(wide, ada, "forget", {
        memory: rememberedSchema.parse(before).memory,
      }),
      deeper: await askedOf(deeper, ada, "remember", fact("Deeper chain")),
    }).toStrictEqual({
      before: true,
      after: { failed: "permission.unavailable" },
      afterForget: { failed: "permission.unavailable" },
      deeper: { failed: "permission.unavailable" },
    });
  });
});

// A workflow.

/** A memory's id, and what came of the step that wrote it, as a workflow declares it. */
const resultDescriptor = {
  kind: "object",
  fields: {
    memory: { kind: "string" },
    name: { kind: "string" },
    forgot: { kind: "boolean" },
  },
};

/**
 * A workflow of `by`'s that remembers its args' customer, reads its card
 * and forgets what it remembered, its `brain` permission bound by `admin`
 * to a grant of its own, and its own grant to write. With `holdFor`, it
 * recalls a question first, then asks that person to go on before it
 * writes (a test acts meanwhile).
 */
const memoriesWorkflow = async (
  by: Member,
  admin: Member,
  { holdFor }: { holdFor?: Member } = {}
) => {
  const key = `brain-${unique()}`;
  await publishCatalogContract(env, admin, { key, kind: "brain" });
  const decision = `go-on-${unique()}`;
  if (holdFor !== undefined) {
    await publishCatalogContract(env, admin, {
      key: decision,
      kind: "decision",
      input: JSON.stringify(v.object({ amount: v.number() }).descriptor),
      response: JSON.stringify(v.null().descriptor),
    });
  }
  const workflow = await createWorkflowResource(
    env,
    by,
    `memories-${unique()}`
  );
  const held =
    holdFor === undefined
      ? []
      : [
          {
            id: "recalled",
            type: "call",
            brain: "docs",
            action: "recall",
            args: {
              question: { $expr: "args.question" },
              budget: { tokens: 400 },
            },
          },
          {
            id: "goOn",
            type: "decide",
            decision: "go",
            recipients: [`person:${holdFor.userId}`],
            prompt: "Go on?",
            input: { amount: 1 },
          },
        ];
  // Remember the args' customer, read its card back, forget it.
  const steps = [
    {
      id: "remembered",
      type: "call",
      brain: "docs",
      action: "remember",
      args: {
        about: { kind: "customer", names: [{ $expr: "args.name" }] },
        statement: { $expr: 'args.name + " is a customer"' },
      },
    },
    {
      id: "card",
      type: "call",
      brain: "docs",
      action: "entities.get",
      args: { entity: { $expr: "remembered.entity" } },
    },
    {
      id: "forgot",
      type: "call",
      brain: "docs",
      action: "forget",
      args: { memory: { $expr: "remembered.memory" } },
    },
  ];
  await publishDefinition(
    env,
    by,
    workflow.id,
    JSON.stringify({
      $schema: workflowSchemaUrl,
      args: {
        kind: "object",
        fields: { name: { kind: "string" }, question: { kind: "string" } },
      },
      returns: resultDescriptor,
      result: {
        memory: { $expr: "remembered.memory" },
        // The card it read back: none for an entity it may not see.
        name: { $expr: 'card?.entity.name ?? ""' },
        forgot: { $expr: "forgot" },
      },
      permissions: {
        brain: { docs: { contract: key } },
        ...(holdFor === undefined
          ? {}
          : { decisions: { go: { contract: decision } } }),
      },
      steps: [...held, ...steps],
    })
  );
  const subject = { type: "workflow" as const, workflowId: workflow.id };
  const permissionId = await granted(
    by,
    admin,
    platformGrant(subject, "brain")
  );
  await granted(by, admin, platformGrant(subject, "brain.write"));
  await approveWorkflowBinding(env, admin, workflow.id, {
    alias: "docs",
    target: { kind: "brain", permissionId },
    reviewed: { version: 1 },
  });
  if (holdFor !== undefined) {
    await approveWorkflowBinding(env, admin, workflow.id, {
      alias: "go",
      target: { kind: "decision", deciders: [`person:${holdFor.userId}`] },
      reviewed: { version: 1 },
    });
  }
  return workflow;
};

/** A run of `id` for `by` on `args`, started: its ID. */
const startedRun = async (
  by: Member,
  id: string,
  args: { name: string; question: string }
): Promise<string> => {
  const { runId } = await startWorkflow(
    env,
    { type: "person", person: by },
    id,
    { expected: 1, args, key: unique() }
  );
  if (runId === null) {
    throw new Error("The start admitted no run");
  }
  return runId;
};

/** How run `runId` of `id` ended: its result, or its code. */
const endOf = async (
  by: Member,
  id: string,
  runId: string
): Promise<unknown> => {
  const run: WorkflowResourceRun = await vi.waitFor(
    async () => {
      const read = await resourceRunFor(env, by, id, runId);
      expect(read.endedAt).not.toBeNull();
      return read;
    },
    { timeout: 30_000, interval: 100 }
  );
  return run.status === "completed" ? run.result : { failed: run.error?.code };
};

/** How run `id` ended, as its row has it: its status and failure's code. */
const rowEndOf = async (id: string) =>
  await vi.waitFor(
    async () => {
      const run = await env.DB.prepare(
        "SELECT status, failure_code AS code, ended_at AS ended FROM workflow_resource_runs WHERE id = ?"
      )
        .bind(id)
        .first<{ status: string; code: string | null; ended: number | null }>();
      expect(run?.ended ?? null).not.toBeNull();
      return { status: run?.status, code: run?.code ?? null };
    },
    { timeout: 30_000, interval: 100 }
  );

/** The decision run `runId` opened, once it had recalled. */
const openedIn = async (runId: string): Promise<string> =>
  await vi.waitFor(
    async () => {
      const row = await env.DB.prepare(
        "SELECT id FROM workflow_decisions WHERE resource_run_id = ?"
      )
        .bind(runId)
        .first<{ id: string }>();
      if (row === null) {
        throw new Error("No decision yet");
      }
      return row.id;
    },
    { timeout: 30_000, interval: 100 }
  );

/** `by`'s answer to `decision`: go on, reviewed and confirmed. */
const goOn = async (by: Member, decision: string): Promise<void> => {
  const answer = { approved: true };
  const review = await reviewDecision(env, by, decision, answer);
  if (review.state === "recorded") {
    return;
  }
  const { confirmation } = await confirmDecision(
    env,
    by,
    decision,
    review.decision.revision,
    review.response
  );
  await answerDecision(env, by, decision, review.response, confirmation);
};

describe("memories and entities, as a workflow reaches them", setUpTime, () => {
  it("remembers in the workflow's own word, reads its card back and forgets it, one memory per step", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const workflow = await memoriesWorkflow(ada, admin);
    const name = `Globex ${unique()}`;

    const runId = await startedRun(ada, workflow.id, { name, question: name });
    const ended = z
      .strictObject({
        memory: z.uuid(),
        name: z.string(),
        forgot: z.boolean(),
      })
      .parse(await endOf(ada, workflow.id, runId));

    expect({
      name: ended.name,
      forgot: ended.forgot,
      // Its step's one memory, in the workflow's word, forgotten.
      written: await writtenBy(`workflow:${workflow.id}`),
    }).toStrictEqual({ name, forgot: true, written: 1 });
  });

  // A step whose attempt was cut off after its write runs again under its
  // step's key, as every attempt and replay does (stepIdempotencyKey): its
  // call made twice by hand under the key the run's own step takes, then
  // by the run itself.
  it("writes one memory and keeps one outcome for a step made again after its write, however often", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const reviewer = await person("user");
    const workflow = await memoriesWorkflow(ada, admin, { holdFor: reviewer });
    const name = `Umbrella ${unique()}`;
    const runId = await startedRun(ada, workflow.id, { name, question: name });
    const decision = await openedIn(runId);
    const run = await callingRunOf(env, workflow.id, runId);
    if (run === undefined) {
      throw new Error("The run isn't running");
    }
    const again = async () =>
      await makeCall(
        env,
        run,
        "remembered",
        {
          name: "grasp.brain",
          binding: "docs",
          operation: "remember",
          arguments: {
            about: { kind: "customer", names: [name] },
            statement: `${name} is a customer`,
          },
        },
        {
          // The key the run's own step takes (its receipts name it).
          key: stepIdempotencyKey(runId, "remembered:task"),
          deadline: Date.now() + 30_000,
          requireHolds: () => {
            // Holds.
          },
        }
      );
    const warn = vi.spyOn(console, "warn");
    const troubleBefore = await auditTrouble([]);
    const first = await again();
    // Drained: the first `done` reaches the log before the repeat.
    await allEvents();
    const second = await again();
    await goOn(reviewer, decision);
    const ended = await endOf(ada, workflow.id, runId);
    const troubleAfter = await auditTrouble(warn.mock.calls);
    warn.mockRestore();
    const events = await vi.waitFor(
      async () => {
        const all = await allEvents();
        const ofRun = all.filter(
          ({ action, target }) =>
            action === "brain.memory.remembered" && target?.id === runId
        );
        expect(ofRun).toHaveLength(4);
        return ofRun;
      },
      { timeout: 10_000, interval: 50 }
    );

    expect({
      same: second,
      ended: z.object({ memory: z.string() }).parse(ended).memory,
      // The step's one memory, though its call was made three times.
      written: await writtenBy(`workflow:${workflow.id}`),
      // Each attempt kept, and its one outcome.
      outcomes: events
        .map(({ detail }) => String(detail?.outcome))
        .toSorted((a, b) => a.localeCompare(b)),
    }).toStrictEqual({
      same: first,
      ended: rememberedSchema.parse(first).memory,
      written: 1,
      outcomes: ["attempted", "attempted", "attempted", "done"],
    });
    // The repeats' `done` is the event the log holds: none refused, no
    // gap, no conflict.
    expect(troubleAfter).toStrictEqual({ ...troubleBefore, conflicts: 0 });
  });

  it("writes nothing once what the run recalled is erased, and writes when nothing changed", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const reviewer = await person("user");
    const word = `fx${unique().replaceAll(/\W/gu, "").toLowerCase()}`;
    // A source everyone in the company may read, which a run recalls.
    const upload = `upload:${unique()}`;
    await store().addSource({
      source: upload,
      change: crypto.randomUUID(),
      text: `The ${word} settlement closes on Fridays.`,
      access: { kind: "audience", group: "company" },
    });
    const workflow = await memoriesWorkflow(ada, admin, { holdFor: reviewer });
    const args = {
      name: `Initech ${unique()}`,
      question: `${word} settlement`,
    };
    const [unchanged, erased] = await Promise.all([
      startedRun(ada, workflow.id, args),
      startedRun(ada, workflow.id, args),
    ]);
    const [first, second] = await Promise.all(
      [unchanged, erased].map(openedIn)
    );
    if (first === undefined || second === undefined) {
      throw new Error("A run opened no decision");
    }
    // The unchanged run first, then the erasure, then the other.
    await goOn(reviewer, first);
    const left = await endOf(ada, workflow.id, unchanged);
    await store().eraseSource({ source: upload, reason: "deleted" });
    await goOn(reviewer, second);

    expect({
      left: z.object({ forgot: z.boolean() }).safeParse(left).success,
      afterErasure: await endOf(ada, workflow.id, erased),
      // The unchanged run's one memory, and none of the other's.
      written: await writtenBy(`workflow:${workflow.id}`),
    }).toStrictEqual({
      left: true,
      afterErasure: { failed: "brain.revoked" },
      written: 1,
    });
  });

  it("writes nothing from a run that calls an App whose rows are each owner's own", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const diary = await publishedApp(ada, diaryApp(), "Diary");
    const secret = `Ada's private note ${unique()}`;
    const add = diary.release.app.functions["diary.add"];
    await callAppFunction(
      env,
      ada,
      diary.app,
      JSON.stringify({
        reference: { name: "diary.add", kind: add?.kind },
        args: { title: secret },
      })
    );
    const fn = await functionIdOf(diary.app, "diary.mine");
    const key = `brain-${unique()}`;
    await publishCatalogContract(env, admin, { key, kind: "brain" });
    const workflow = await createWorkflowResource(
      env,
      ada,
      `diary-${unique()}`
    );
    await publishDefinition(
      env,
      ada,
      workflow.id,
      JSON.stringify({
        $schema: workflowSchemaUrl,
        args: { kind: "object", fields: { name: { kind: "string" } } },
        returns: { kind: "object", fields: { memory: { kind: "string" } } },
        result: { memory: { $expr: "remembered.memory" } },
        permissions: {
          brain: { docs: { contract: key } },
          apps: {
            diary: { app: diary.app, functions: { [fn]: "diary.mine" } },
          },
        },
        steps: [
          { id: "read", type: "call", app: "diary", function: fn, args: {} },
          {
            id: "remembered",
            type: "call",
            brain: "docs",
            action: "remember",
            args: {
              about: { kind: "customer", names: [{ $expr: "args.name" }] },
              statement: { $expr: "read[0]" },
            },
          },
        ],
      })
    );
    const subject = { type: "workflow" as const, workflowId: workflow.id };
    await granted(
      ada,
      admin,
      {
        subject,
        object: {
          type: "app",
          appId: appIdSchema.parse(diary.app),
          function: fn,
        },
        actions: ["call"],
        binding: `DIARY_${unique().replaceAll(/\W/gu, "_").toUpperCase()}`,
      },
      1
    );
    const permissionId = await granted(
      ada,
      admin,
      platformGrant(subject, "brain")
    );
    await granted(ada, admin, platformGrant(subject, "brain.write"));
    await approveWorkflowBinding(env, admin, workflow.id, {
      alias: "docs",
      target: { kind: "brain", permissionId },
      reviewed: { version: 1 },
    });
    const { runId } = await startWorkflow(
      env,
      { type: "person", person: ada },
      workflow.id,
      { expected: 1, args: { name: `Diary Co ${unique()}` }, key: unique() }
    );
    if (runId === null) {
      throw new Error("The start admitted no run");
    }

    expect({
      ended: await endOf(ada, workflow.id, runId),
      written: await writtenBy(`workflow:${workflow.id}`),
    }).toStrictEqual({
      ended: { failed: "permission.denied" },
      written: 0,
    });
  });

  // Through a chat: its code recalls (a read the run is started with, as
  // the chat's person may read it), then it starts a run that remembers,
  // confirmed by its person. That read can't be shown readable by
  // everyone the write would reach, so the run writes nothing; a run
  // started from a chat that read nothing writes.
  it("writes nothing from a run whose chat had read anything, and writes from one whose chat read nothing", async () => {
    const user = await signedInApi(idp, "user");
    const builder = await signedInApi(idp, "builder");
    const admin = await person("admin");
    const by = await memberOf(env.DB, builder.userId);
    if (by === undefined) {
      throw new Error("Not a member");
    }
    const key = `brain-${unique()}`;
    await publishCatalogContract(env, admin, { key, kind: "brain" });
    const workflow = await createWorkflowResource(env, by, `mem-${unique()}`);
    await publishDefinition(
      env,
      by,
      workflow.id,
      JSON.stringify({
        $schema: workflowSchemaUrl,
        args: { kind: "object", fields: { text: { kind: "string" } } },
        returns: { kind: "object", fields: { memory: { kind: "string" } } },
        result: { memory: { $expr: "remembered.memory" } },
        permissions: { brain: { docs: { contract: key } } },
        steps: [
          {
            id: "remembered",
            type: "call",
            brain: "docs",
            action: "remember",
            args: {
              about: { kind: "customer", names: ["Probe Co"] },
              statement: { $expr: "args.text" },
            },
          },
        ],
      })
    );
    const subject = { type: "workflow" as const, workflowId: workflow.id };
    const permissionId = await requestGranted(
      idp,
      builder,
      platformGrant(subject, "brain")
    );
    await requestGranted(idp, builder, platformGrant(subject, "brain.write"));
    await approveWorkflowBinding(env, admin, workflow.id, {
      alias: "docs",
      target: { kind: "brain", permissionId },
      reviewed: { version: 1 },
    });
    await shareWorkflowResource(env, by, workflow.id, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    const chats = await personalChatsOf(user.userId);
    await requestGranted(idp, builder, {
      subject: { type: "agent", agentId: chats.agent.agentId },
      object: {
        type: "workflow",
        workflowId: workflowResourceIdSchema.parse(workflow.id),
      },
      actions: ["start"],
      binding: `START_${unique().toUpperCase().replaceAll("-", "_")}`,
    });
    await requestGranted(idp, builder, {
      subject: { type: "agent", agentId: chats.agent.agentId },
      object: { type: "platform" },
      actions: ["brain"],
      binding: `BRAIN_${unique().toUpperCase().replaceAll("-", "_")}`,
    });
    const scopeOf = async (chatId: string): Promise<AgentScope> => ({
      workspaceId: chats.id,
      agentId: chats.agent.agentId,
      chatId: chatIdSchema.parse(chatId),
      personId: user.userId,
      runId: await openTestRun(chats.stub, chatIdSchema.parse(chatId)),
      ownChat: true,
    });
    /** How a run started from chat `chatId` ended, its code recalling first with `recall`. */
    const startedFrom = async (chatId: string, recall: boolean) => {
      if (recall) {
        const brain = exports.BrainAgentApi({ props: await scopeOf(chatId) });
        await brain.recall({
          question: "anything at all",
          budget: { tokens: 400 },
        });
      }
      const workflows = exports.WorkflowsApi({ props: await scopeOf(chatId) });
      const held = await workflows.start(
        workflow.id,
        { text: `Probe ${unique()}` },
        unique()
      );
      const listed = await user.api.heldStarts.list();
      const shown = listed.find(({ id }) => id === held.held);
      const confirmed = await user.api.heldStarts.confirm(
        held.held,
        shown?.argsHash ?? ""
      );
      return await rowEndOf(confirmed.run ?? confirmed.start);
    };

    const [recalling, quietly] = [await chats.newChat(), await chats.newChat()];
    const recalled = recalling.chat.id;
    const quiet = quietly.chat.id;
    const afterRecall = await startedFrom(recalled, true);
    const pins = await env.DB.prepare(
      "SELECT count(*) AS n FROM run_chat_sources WHERE agent_id = ?"
    )
      .bind(chats.agent.agentId)
      .first<{ n: number }>();
    const noRead = await startedFrom(quiet, false);

    expect({
      afterRecall,
      pins: pins?.n,
      noRead,
      written: await writtenBy(`workflow:${workflow.id}`),
    }).toStrictEqual({
      afterRecall: { status: "failed", code: "permission.denied" },
      pins: 1,
      noRead: { status: "completed", code: null },
      written: 1,
    });
  });
});
