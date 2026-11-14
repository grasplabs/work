import { brainOf } from "@grasp-os/brain-next/contract";
import type { Reader } from "@grasp-os/brain-next/contract";
import { v } from "@grasp-os/runtime/app";
import type { FunctionResult } from "@grasp-os/shared/functions";
import { teamIdSchema } from "@grasp-os/shared/ids";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { Identity } from "@grasp-os/shared/rpc";
import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { callAppFunction } from "../src/app-functions.ts";
import { publishVersion } from "../src/app-publish.ts";
import type { Release } from "../src/app-releases.ts";
import { appFor } from "../src/apps.ts";
import {
  correctForCompanyAs,
  rememberForCompanyAs,
} from "../src/brain-next.ts";
import {
  answerDecision,
  confirmDecision,
  reviewDecision,
} from "../src/decisions/decisions.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { brainTeamVersionRead } from "../src/history-access.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import {
  grantPermission,
  requestPermission,
  revokePermission,
} from "../src/permissions.ts";
import { approveResourceBinding } from "../src/resource-bindings.ts";
import { approveWorkflowBinding } from "../src/workflow-bindings.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { testApp } from "./app-definitions.ts";
import { allEvents } from "./audit-events.ts";
import { appWith, person, seal } from "./sealed-apps.ts";
import type { Fixture } from "./sealed-apps.ts";
import { unique } from "./sign-in.ts";

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

/** An App whose action hands each operation what it is given, as JSON (`ask`). */
const memoriesApp = () =>
  testApp(
    {
      name: "Accounts",
      tables: {
        notes: {
          fields: { title: "v.string()" },
          access: { read: "owner", write: "owner" },
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
 * The App of `owner`'s, sealed and current, its declaration bound by
 * `admin` to its grant to read the Brain, and with `write`, its own grant
 * to write to it.
 */
const appOf = async (
  owner: Member,
  admin: Member,
  { write = true, teams }: { write?: boolean; teams?: string[] } = {}
) => {
  const fixture: Fixture = await appWith(memoriesApp(), "Accounts", owner);
  const release: Release = await seal(fixture);
  await publishVersion(env, fixture.owner, fixture.app, 1);
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
        { statement: "It left in May", confirmed: true },
        { statement: `${otherName} is active`, confirmed: false },
      ],
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
    const ada = await person("builder");
    const readOnly = await appOf(ada, admin, { write: false });
    const revoked = await appOf(ada, admin);
    const unplaced = await appOf(ada, admin);
    // Its grant to read the Brain names a team of Ada's: what it reads of
    // that team's may not reach the company.
    const teamScoped = await appOf(ada, admin, { teams: [await teamOf(ada)] });
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
  await publishWorkflowVersion(env, by, workflow.id, {
    definition: JSON.stringify({
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
      steps: [
        ...held,
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
      ],
    }),
    basedOn: null,
  });
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
    { version: 1, args, key: unique() }
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

describe("memories and entities, as a workflow reaches them", setUpTime, () => {
  // What a run's step writes is one change, its key the step's in every
  // attempt and replay (workflows/brain-calls.ts), and a reply lost is
  // asked again under it (brain-recall.ts `landed`): asked twice, it is
  // one memory and one fix, the first's answer again.
  it("writes one memory and one fix for one change, however often it is asked", async () => {
    const ada = await person("builder");
    const writer = `workflow:${unique()}`;
    const change = `run:${unique()}:remembered`;
    const remember = async () =>
      await rememberForCompanyAs(
        env,
        ada.userId,
        { writer, change },
        fact(`Hooli ${unique().slice(0, 4)}`)
      ).then(
        () => "written",
        (error: unknown) => z.object({ code: z.string() }).parse(error).code
      );
    const asked = {
      about: { kind: "customer", names: ["Hooli"] },
      statement: "Hooli is a customer",
    };
    const first = await rememberForCompanyAs(
      env,
      ada.userId,
      { writer, change },
      asked
    );
    const again = await rememberForCompanyAs(
      env,
      ada.userId,
      { writer, change },
      asked
    );
    const other = await written(`Pied ${unique()}`);
    const correction = {
      memory: other.memory,
      value: "churned",
      statement: "It left",
    };
    const fixChange = `run:${unique()}:fixed`;
    const fixed = await correctForCompanyAs(
      env,
      ada.userId,
      { writer, change: fixChange },
      correction
    );
    const fixedAgain = await correctForCompanyAs(
      env,
      ada.userId,
      { writer, change: fixChange },
      correction
    );

    expect({
      same: again,
      fixedAgain,
      // The same change with something else said is refused, never a second memory.
      otherSaid: await remember(),
      written: await writtenBy(writer),
    }).toStrictEqual({
      same: first,
      fixedAgain: fixed,
      otherSaid: "brain.request_invalid",
      written: 2,
    });
  });

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

  it("writes nothing once what the run recalled is erased, or when the chat that started it had read anything, and writes when nothing changed", async () => {
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
    const [unchanged, erased, chatted] = await Promise.all([
      startedRun(ada, workflow.id, args),
      startedRun(ada, workflow.id, args),
      startedRun(ada, workflow.id, { ...args, question: "nothing at all" }),
    ]);
    const asked = await Promise.all([unchanged, erased, chatted].map(openedIn));
    // The chat that started the third had read something, as its person
    // may still: code's recall there, of a source the company may read
    // too. Read as the chat's person, it can't be shown readable by
    // everyone a write would reach, so the run writes nothing.
    const chatRead = unique();
    await store().addSource({
      source: `upload:${chatRead}`,
      change: crypto.randomUUID(),
      text: "What the chat had read.",
      access: { kind: "audience", group: "company" },
    });
    await env.DB.prepare(
      "INSERT INTO run_chat_sources (run_id, source_id, workspace_id, chat_id, agent_id, person_id) VALUES (?, ?, ?, ?, ?, ?)"
    )
      .bind(
        chatted,
        brainTeamVersionRead({
          source: { producer: "upload", id: chatRead },
          version: 1,
        }),
        unique(),
        unique(),
        unique(),
        ada.userId
      )
      .run();
    // Answered one at a time: the unchanged run first, then the erasure,
    // then the others.
    const [first, second, third] = asked;
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error("A run opened no decision");
    }
    await goOn(reviewer, first);
    const left = await endOf(ada, workflow.id, unchanged);
    await store().eraseSource({ source: upload, reason: "deleted" });
    await goOn(reviewer, second);
    await goOn(reviewer, third);

    expect({
      left: z.object({ forgot: z.boolean() }).safeParse(left).success,
      afterErasure: await endOf(ada, workflow.id, erased),
      afterChat: await endOf(ada, workflow.id, chatted),
      // The unchanged run's one memory, and none of the others'.
      written: await writtenBy(`workflow:${workflow.id}`),
    }).toStrictEqual({
      left: true,
      afterErasure: { failed: "brain.revoked" },
      afterChat: { failed: "permission.denied" },
      written: 1,
    });
  });
});
