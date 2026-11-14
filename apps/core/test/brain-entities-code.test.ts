import { brainOf } from "@grasp-os/brain-next/contract";
import type { FunctionResult } from "@grasp-os/shared/functions";
import { teamIdSchema } from "@grasp-os/shared/ids";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { Identity } from "@grasp-os/shared/rpc";
import type {
  WorkflowCandidateRun,
  WorkflowResourceRun,
} from "@grasp-os/shared/workflow-resources";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { callAppFunction } from "../src/app-functions.ts";
import type { Release } from "../src/app-releases.ts";
import { appFor, appKind } from "../src/apps.ts";
import { teamsOf } from "../src/auth/identity.ts";
import { eraseSource } from "../src/brain-next.ts";
import type { SourceRef } from "../src/brain-next.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import { grantPermission, requestPermission } from "../src/permissions.ts";
import { rollback } from "../src/publish.ts";
import { approveResourceBinding } from "../src/resource-bindings.ts";
import { approveWorkflowBinding } from "../src/workflow-bindings.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import { editWorkflowDraft, workflowDraft } from "../src/workflow-editor.ts";
import { createWorkflowResource } from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import {
  candidateRunFor,
  startCandidateRun,
} from "../src/workflows/candidate-runs.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { testApp } from "./app-definitions.ts";
import { allEvents } from "./audit-events.ts";
import { appWith, person, seal } from "./sealed-apps.ts";
import type { Fixture } from "./sealed-apps.ts";
import { unique } from "./sign-in.ts";
import { publishDefinition } from "./workflow-publishing.ts";

// The Brain's entities for code (GRA-1837; the threat model is on the
// issue): an App's action (`ctx.brain.entities.get`, `.find`) and a
// workflow's step (`ctx.brain.<alias>.entities.…`). How it can fail, and
// what each test holds it to:
// 1. Code reads past the company: a team's memory or entity, or one only
//    a person may read, reaches it. It reads as the company alone, even
//    under a grant that names teams.
// 2. Code learns what exists that it may not read: an entity it may not
//    see answers as one nobody holds.
// 3. A run passes on what the company may no longer read: a card's
//    sources are pinned with the run, so its result is withheld once one
//    is erased.
// 4. The audit log carries what was read: one event per read, by ids and
//    counts only.
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

/** A grant to read the Brain for `subject`, naming `teams` if any. */
const brainGrant = (
  subject: PermissionRequest["subject"],
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
  actions: ["brain"],
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

/** A source everyone in the company may read, saying `text`. */
const sourceForEveryone = async (text: string): Promise<SourceRef> => {
  const source: SourceRef = { producer: "upload", id: crypto.randomUUID() };
  await store().addSource({
    source: `upload:${source.id}`,
    change: crypto.randomUUID(),
    text,
    access: { kind: "audience", group: "company" },
  });
  return source;
};

/**
 * A customer `name` with one status memory, read by `group`: in an App's
 * word, or drawn from version 1 of `source`. Its id and its memory's.
 */
const written = async (
  name: string,
  { group = "company", source }: { group?: string; source?: SourceRef } = {}
): Promise<{ memory: string; entity: string }> => {
  const writer = `app:${unique()}`;
  const statement = `${name} is active`;
  const added = await store().addMemories({
    change: crypto.randomUUID(),
    access: { kind: "audience", group },
    entities: [{ key: "c", kind: "customer", names: [name] }],
    memories: [
      {
        about: "c",
        attribute: "status",
        value: "active",
        type: "fact",
        statement,
        speaker: { kind: "agent", agent: writer },
        basis:
          source === undefined
            ? { kind: "writer", writer }
            : {
                kind: "source",
                source: `${source.producer}:${source.id}`,
                version: 1,
                quote: statement,
              },
      },
    ],
  });
  return { memory: added.memories[0] ?? "", entity: added.entities.c ?? "" };
};

/** The Brain's audit events of `onBehalfOf` for entities, once `count` are kept. */
const entityEvents = async (onBehalfOf: string, count: number) =>
  await vi.waitFor(
    async () => {
      const all = await allEvents();
      const events = all.filter(
        ({ action, detail }) =>
          action.startsWith("brain.entities.") &&
          detail?.onBehalfOf === onBehalfOf
      );
      expect(events.length).toBeGreaterThanOrEqual(count);
      return events;
    },
    { timeout: 10_000, interval: 50 }
  );

// An App.

/** An App whose action hands `entities.get` or `.find` what it is given, as JSON (`ask`). */
const entitiesApp = () =>
  testApp(
    {
      name: "Accounts",
      permissions: [
        'permission.brain({ operations: ["entities.get", "entities.find"] })',
      ],
    },
    {
      "server/entities.ts": `import { v } from "@grasp-os/sdk";
import { action } from "@server/_generated/server";

export const ask = action({
  args: { operation: v.string(), input: v.string() },
  handler: async (ctx, args) => {
    const input = JSON.parse(args.input);
    return args.operation === "get"
      ? await ctx.brain.entities.get(input)
      : await ctx.brain.entities.find(input);
  },
});
`,
    }
  );

/**
 * The App of `owner`'s, sealed and current, its declaration bound by
 * `admin` to its grant to read the Brain, naming `teams` if any.
 */
const appOf = async (owner: Member, admin: Member, teams?: string[]) => {
  const fixture: Fixture = await appWith(entitiesApp(), "Accounts", owner);
  const release: Release = await seal(fixture);
  await rollback(env, appKind, fixture.owner, fixture.app, 1);
  const permissionId = await granted(
    owner,
    admin,
    brainGrant({ type: "app", appId: fixture.app }, teams),
    release.manifest.resourceVersion
  );
  await approveResourceBinding(env, admin, {
    app: fixture.app,
    alias: "brain",
    target: { kind: "brain", permissionId },
    reviewed: { version: 1 },
  });
  return { ...fixture, release };
};

/** What `operation` of `app`'s answers `by` for `input`: its value, or its error's code. */
const askedOf = async (
  app: Awaited<ReturnType<typeof appOf>>,
  by: Member,
  operation: "get" | "find",
  input: unknown
): Promise<unknown> => {
  const fn = app.release.app.functions["entities.ask"];
  if (fn === undefined) {
    throw new Error("No entities.ask");
  }
  const { result }: { result: FunctionResult } = await callAppFunction(
    env,
    by,
    app.app,
    JSON.stringify({
      reference: { name: "entities.ask", kind: fn.kind },
      args: { operation, input: JSON.stringify(input) },
    })
  );
  return result.ok ? result.value : { failed: result.error.code };
};

/** Any text, as an expectation. */
const someText: unknown = expect.any(String);

/** The ids of a page of entities. */
const idsOf = (page: unknown): string[] =>
  z
    .object({ entities: z.array(z.object({ id: z.string() })) })
    .parse(page)
    .entities.map(({ id }) => id);

describe("entities, as an App reads them", setUpTime, () => {
  it("reads a card and finds entities as the company may; answers one it may not see as one nobody holds; and records each read once, by ids and counts", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const app = await appOf(ada, admin);
    const name = `Acme ${unique()}`;
    const seen = await written(name);
    const hiddenName = `Hidden ${unique()}`;
    const hidden = await written(hiddenName, { group: `team:${unique()}` });

    const nobodys = crypto.randomUUID();
    const card = await askedOf(app, ada, "get", { entity: seen.entity });
    const found = await askedOf(app, ada, "find", { name });
    // One it may not see, and one nobody holds, alike, as one call site
    // asks each.
    const alike: Record<string, unknown> = {};
    for (const [as, entity, named] of [
      ["hidden", hidden.entity, hiddenName],
      ["unknown", nobodys, `Nobody ${unique()}`],
    ] as const) {
      alike[as] = [
        // oxlint-disable-next-line no-await-in-loop -- one call site, one at a time
        await askedOf(app, ada, "get", { entity }),
        // oxlint-disable-next-line no-await-in-loop -- one call site, one at a time
        idsOf(await askedOf(app, ada, "find", { name: named })),
      ];
    }
    const invalid = await askedOf(app, ada, "get", { entity: "Acme" });

    expect({ card, found: idsOf(found), alike, invalid }).toStrictEqual({
      card: {
        entity: { id: seen.entity, kind: "customer", name },
        attributes: [
          {
            attribute: "status",
            memories: [
              {
                id: seen.memory,
                attribute: "status",
                value: "active",
                statement: `${name} is active`,
                learnedAt: someText,
                confirmed: false,
                contested: false,
              },
            ],
            contested: false,
          },
        ],
        relations: [],
        notes: [],
        next: null,
      },
      found: [seen.entity],
      alike: { hidden: [null, []], unknown: [null, []] },
      invalid: { failed: "permission.invalid_args" },
    });
    // Each read audited once for her, by ids and counts, never a name.
    const events = await entityEvents(ada.userId, 6);
    expect({
      details: events
        .map(({ action, detail }) => ({ action, ...detail }))
        .toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      said: [name, hiddenName].some((said) =>
        JSON.stringify(events).includes(said)
      ),
    }).toStrictEqual({
      details: [
        {
          action: "brain.entities.find",
          onBehalfOf: ada.userId,
          entities: 0,
        },
        {
          action: "brain.entities.find",
          onBehalfOf: ada.userId,
          entities: 0,
        },
        {
          action: "brain.entities.find",
          onBehalfOf: ada.userId,
          entities: 1,
        },
        {
          action: "brain.entities.get",
          onBehalfOf: ada.userId,
          entity: null,
          refused: "permission.invalid_args",
        },
        {
          action: "brain.entities.get",
          onBehalfOf: ada.userId,
          entity: hidden.entity,
          found: false,
          memories: 0,
        },
        {
          action: "brain.entities.get",
          onBehalfOf: ada.userId,
          entity: nobodys,
          found: false,
          memories: 0,
        },
        {
          action: "brain.entities.get",
          onBehalfOf: ada.userId,
          entity: seen.entity,
          found: true,
          memories: 1,
        },
      ].toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      said: false,
    });
  });

  it("reads only what the company may, even under a grant that names a team the person is in", async () => {
    const admin = await person("admin");
    const signedIn = await person("builder");
    // In a team of hers, as a request of hers signed in now names it.
    const team = await teamOf(signedIn);
    const ada = { ...signedIn, teams: await teamsOf(env.DB, signedIn.userId) };
    const app = await appOf(ada, admin, [team]);
    const name = `Teamco ${unique()}`;
    const theTeams = await written(name, { group: `team:${team}` });

    expect({
      card: await askedOf(app, ada, "get", { entity: theTeams.entity }),
      found: idsOf(await askedOf(app, ada, "find", { name })),
    }).toStrictEqual({ card: null, found: [] });
  });
});

// A workflow.

/**
 * A workflow of `by`'s that reads its args' entity's card and finds
 * entities by its args' name, its `brain` permission bound by `admin` to
 * a grant of its own.
 */
const entitiesWorkflow = async (by: Member, admin: Member) => {
  const key = `brain-${unique()}`;
  await publishCatalogContract(env, admin, { key, kind: "brain" });
  const workflow = await createWorkflowResource(
    env,
    by,
    `entities-${unique()}`
  );
  await publishDefinition(
    env,
    by,
    workflow.id,
    JSON.stringify({
      $schema: workflowSchemaUrl,
      args: {
        kind: "object",
        fields: { entity: { kind: "string" }, name: { kind: "string" } },
      },
      returns: {
        kind: "object",
        fields: {
          name: { kind: "string" },
          found: { kind: "number" },
          handed: { kind: "string" },
        },
      },
      result: {
        // The card it read: none for an entity it may not see.
        name: { $expr: 'card?.entity.name ?? ""' },
        found: { $expr: "found.entities.length" },
        // All it was handed, names included, passed on whole.
        handed: { $expr: "JSON.stringify([card, found])" },
      },
      permissions: { brain: { docs: { contract: key } } },
      steps: [
        {
          id: "card",
          type: "call",
          brain: "docs",
          action: "entities.get",
          args: { entity: { $expr: "args.entity" } },
        },
        {
          id: "found",
          type: "call",
          brain: "docs",
          action: "entities.find",
          args: { name: { $expr: "args.name" } },
        },
      ],
    })
  );
  const permissionId = await granted(
    by,
    admin,
    brainGrant({ type: "workflow", workflowId: workflow.id })
  );
  await approveWorkflowBinding(env, admin, workflow.id, {
    alias: "docs",
    target: { kind: "brain", permissionId },
    reviewed: { version: 1 },
  });
  return workflow;
};

/** A run of `id` for `by` on `args`, ended: its ID. */
const endedRun = async (
  by: Member,
  id: string,
  args: { entity: string; name: string }
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
  await vi.waitFor(
    async () => {
      const read: WorkflowResourceRun = await resourceRunFor(
        env,
        by,
        id,
        runId
      );
      expect(read.endedAt).not.toBeNull();
    },
    { timeout: 30_000, interval: 100 }
  );
  return runId;
};

/** What `by` sees of run `runId` of `id`: its status, result and error's code. */
const recordOf = async (by: Member, id: string, runId: string) => {
  const run = await resourceRunFor(env, by, id, runId);
  return {
    status: run.status,
    result: run.result ?? null,
    error: run.error?.code ?? null,
  };
};

/**
 * An entity of `kind` named `name` by one memory alone: one resting on
 * `source`'s first version, or in `writer`'s own word. Its id and memory's.
 */
const namedBy = async (
  kind: "customer" | "project" | "supplier",
  name: string,
  basis: { source: SourceRef } | { writer: string }
): Promise<{ entity: string; memory: string }> => {
  const statement = `${name} is known here`;
  const added = await store().addMemories({
    change: crypto.randomUUID(),
    access: { kind: "audience", group: "company" },
    entities: [{ key: "e", kind, names: [name] }],
    memories: [
      {
        about: "e",
        type: "fact",
        statement,
        speaker: { kind: "system" },
        basis:
          "writer" in basis
            ? { kind: "writer", writer: basis.writer }
            : {
                kind: "source",
                source: `${basis.source.producer}:${basis.source.id}`,
                version: 1,
                quote: statement,
              },
      },
    ],
  });
  return { entity: added.entities.e ?? "", memory: added.memories[0] ?? "" };
};

/** What `by` sees of run `runId` of `id`: its status, its error's code, and which of `names` its result shows. */
const showsOf = async (
  by: Member,
  id: string,
  runId: string,
  names: readonly string[]
) => {
  const { status, result, error } = await recordOf(by, id, runId);
  return {
    status,
    error,
    shows: names.filter((name) => JSON.stringify(result).includes(name)),
  };
};

/** A card of `entity` and nothing else, as a test run's fixture answers one. */
const cardOf = (entity: Record<string, unknown>) => ({
  entity,
  attributes: [],
  relations: [],
  notes: [],
  next: null,
});

describe("entities, as a workflow reads them", setUpTime, () => {
  it("reads a card and finds entities in a run as the company may, and withholds its result once a source the card rests on is erased", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const workflow = await entitiesWorkflow(ada, admin);
    const name = `Globex ${unique()}`;
    const source = await sourceForEveryone(`${name} is active.`);
    const drawn = await written(name, { source });
    const hiddenName = `Hidden ${unique()}`;
    const hidden = await written(hiddenName, { group: `team:${unique()}` });

    const kept = await endedRun(ada, workflow.id, {
      entity: drawn.entity,
      name,
    });
    const unseen = await endedRun(ada, workflow.id, {
      entity: hidden.entity,
      name: hiddenName,
    });
    const before = await recordOf(ada, workflow.id, kept);
    await eraseSource(env, {
      source,
      readers: { kind: "none" },
      reason: "deleted",
    });

    expect({
      before,
      unseen: await recordOf(ada, workflow.id, unseen),
      // Withheld from everyone, admins included, its status still shown.
      afterErasure: await recordOf(admin, workflow.id, kept),
    }).toStrictEqual({
      before: {
        status: "completed",
        result: { name, found: 1, handed: someText },
        error: null,
      },
      unseen: {
        status: "completed",
        result: { name: "", found: 0, handed: someText },
        error: null,
      },
      afterErasure: {
        status: "completed",
        result: null,
        error: "brain.revoked",
      },
    });
  });

  it("keeps every name a run is handed with the run: a related entity's and one found, each withheld once the source that named it is erased; a name in a person's own word stands once its memory is retired", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const workflow = await entitiesWorkflow(ada, admin);
    const [related, found, card] = [
      `Falcon ${unique()}`,
      `Supplyco ${unique()}`,
      `Acme ${unique()}`,
    ];
    // A project named only by a memory of its own source, which a
    // customer's relation, from another source, points to.
    const projectSource = await sourceForEveryone(`${related} is a project.`);
    const project = await namedBy("project", related, {
      source: projectSource,
    });
    const relationSource = await sourceForEveryone(`${card} works on it.`);
    await store().addMemories({
      change: crypto.randomUUID(),
      access: { kind: "audience", group: "company" },
      entities: [
        { key: "c", kind: "customer", names: [card] },
        { key: "p", id: project.entity, kind: "project" },
      ],
      memories: [
        {
          about: "c",
          object: "p",
          type: "fact",
          statement: `${card} works on it`,
          speaker: { kind: "system" },
          basis: {
            kind: "source",
            source: `upload:${relationSource.id}`,
            version: 1,
            quote: `${card} works on it`,
          },
        },
      ],
    });
    const customer = z
      .object({ entities: z.array(z.object({ id: z.string() })) })
      .parse(
        await store().findEntities({
          reader: { person: null, groups: ["company"] },
          name: card,
        })
      ).entities[0]?.id;
    // A supplier named only by its own source, which a run finds.
    const foundSource = await sourceForEveryone(`${found} supplies us.`);
    await namedBy("supplier", found, { source: foundSource });
    // A customer named only in Ada's own word.
    const said = `Initech ${unique()}`;
    const inHerWord = await namedBy("customer", said, { writer: ada.userId });

    const runs = {
      relation: await endedRun(ada, workflow.id, {
        entity: customer ?? "",
        name: card,
      }),
      found: await endedRun(ada, workflow.id, {
        entity: crypto.randomUUID(),
        name: found,
      }),
      said: await endedRun(ada, workflow.id, {
        entity: inHerWord.entity,
        name: said,
      }),
    };
    const names = [related, found, said];
    const before = {
      relation: await showsOf(ada, workflow.id, runs.relation, names),
      found: await showsOf(ada, workflow.id, runs.found, names),
      said: await showsOf(ada, workflow.id, runs.said, names),
    };
    await eraseSource(env, {
      source: projectSource,
      readers: { kind: "none" },
      reason: "deleted",
    });
    await eraseSource(env, {
      source: foundSource,
      readers: { kind: "none" },
      reason: "deleted",
    });
    const retired = await store().retireMemory({
      memory: inHerWord.memory,
      reader: { person: ada.userId, groups: ["company"] },
    });

    expect({
      before,
      retired,
      after: {
        relation: await showsOf(admin, workflow.id, runs.relation, names),
        found: await showsOf(admin, workflow.id, runs.found, names),
        said: await showsOf(admin, workflow.id, runs.said, names),
      },
    }).toStrictEqual({
      before: {
        relation: { status: "completed", error: null, shows: [related] },
        found: { status: "completed", error: null, shows: [found] },
        said: { status: "completed", error: null, shows: [said] },
      },
      retired: "done",
      after: {
        relation: { status: "completed", error: "brain.revoked", shows: [] },
        found: { status: "completed", error: "brain.revoked", shows: [] },
        // A retired memory stays as history and still names its entity
        // for everyone who may read it: nothing a run passed on is now
        // hidden from them.
        said: { status: "completed", error: null, shows: [said] },
      },
    });
  });

  it("refuses a test run's card that carries what a name rests on, as a real answer that did would be", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const key = `brain-${unique()}`;
    await publishCatalogContract(env, admin, { key, kind: "brain" });
    const workflow = await createWorkflowResource(env, ada, `card-${unique()}`);
    const { revision: base } = await workflowDraft(env, ada, workflow.id);
    const saved = await editWorkflowDraft(env, ada, workflow.id, {
      revision: base,
      source: JSON.stringify({
        $schema: workflowSchemaUrl,
        args: { kind: "object", fields: {} },
        returns: { kind: "object", fields: { name: { kind: "string" } } },
        result: { name: { $expr: 'card?.entity.name ?? ""' } },
        permissions: { brain: { docs: { contract: key } } },
        steps: [
          {
            id: "card",
            type: "call",
            brain: "docs",
            action: "entities.get",
            args: { entity: crypto.randomUUID() },
          },
        ],
      }),
    });
    expect(saved.problems).toStrictEqual([]);
    const entity = {
      id: crypto.randomUUID(),
      kind: "customer",
      name: "Acme",
    } as const;
    const ran = async (answer: unknown) => {
      const { runId } = await startCandidateRun(env, ada, workflow.id, {
        revision: saved.revision,
        args: {},
        fixtures: { docs: { result: answer } },
      });
      const run: WorkflowCandidateRun = await vi.waitFor(
        async () => {
          const read = await candidateRunFor(env, ada, workflow.id, runId);
          if (read.status === "starting" || read.status === "running") {
            throw new Error(`Test run ${runId} is ${read.status}`);
          }
          return read;
        },
        { timeout: 20_000, interval: 100 }
      );
      return run.status === "completed"
        ? { status: run.status, result: run.result }
        : { status: run.status, code: run.error?.code };
    };

    expect({
      plain: await ran(cardOf(entity)),
      carrying: await ran(
        cardOf({
          ...entity,
          nameFrom: { source: { producer: "upload", id: "u" }, version: 1 },
        })
      ),
    }).toStrictEqual({
      plain: { status: "completed", result: { name: "Acme" } },
      carrying: { status: "failed", code: "workflow.call_invalid" },
    });
  });
});
