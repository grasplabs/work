import { brainOf } from "@grasp-os/brain-next/contract";
import { v } from "@grasp-os/runtime/app";
import type { FunctionResult } from "@grasp-os/shared/functions";
import { httpContract } from "@grasp-os/shared/http-contract";
import { teamIdSchema } from "@grasp-os/shared/ids";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { Identity } from "@grasp-os/shared/rpc";
import { runFileContentPath } from "@grasp-os/shared/run-files";
import type {
  WorkflowCandidateRun,
  WorkflowResourceRun,
} from "@grasp-os/shared/workflow-resources";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { callAppFunction } from "../src/app-functions.ts";
import type { Release } from "../src/app-releases.ts";
import { appFor, appKind } from "../src/apps.ts";
import { teamsOf } from "../src/auth/identity.ts";
import {
  erasePersonShared,
  eraseSource,
  workBrain,
} from "../src/brain-next.ts";
import type { SourceRef } from "../src/brain-next.ts";
import { builtins, fingerprintOf, thisRelease } from "../src/builtins.ts";
import {
  answerDecision,
  confirmDecision,
  decisionFor,
  reviewDecision,
  waitingDecisions,
} from "../src/decisions/decisions.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import { grantPermission, requestPermission } from "../src/permissions.ts";
import { rollback } from "../src/publish.ts";
import { httpCatalogContract } from "../src/release-contracts.ts";
import { approveResourceBinding } from "../src/resource-bindings.ts";
import { approveWorkflowBinding } from "../src/workflow-bindings.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import { editWorkflowDraft, workflowDraft } from "../src/workflow-editor.ts";
import { workflowFiles } from "../src/workflow-own.ts";
import { createWorkflowResource } from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { workflowStateOf } from "../src/workflow-state.ts";
import {
  candidateRunFor,
  startCandidateRun,
} from "../src/workflows/candidate-runs.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { runFilesFor } from "../src/workflows/run-file-downloads.ts";
import { workflowsToday } from "../src/workflows/today.ts";
import { testApp } from "./app-definitions.ts";
import { allEvents } from "./audit-events.ts";
import {
  copyOfStore,
  killStore,
  restoreStore,
} from "./brain-next-store-copy.ts";
import { httpApiOrigin, httpApiReceivedUrl } from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import { askedModel, jsonWorkflowAppsOf } from "./json-workflow-apps.ts";
import { runQuarterHourTasks } from "./maintenance.ts";
import { fakeProviderFor } from "./model-provider.ts";
import { noProducers } from "./no-producers.ts";
import { appWith, person, seal } from "./sealed-apps.ts";
import type { Fixture } from "./sealed-apps.ts";
import { outcome, routed, unique } from "./sign-in.ts";
import { testBinding } from "./test-env.ts";
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
const entitiesWorkflow = async (
  by: Member,
  admin: Member,
  { hold = false }: { hold?: boolean } = {}
) => {
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
        // A moment after it read, before its output leaves it.
        ...(hold ? [{ id: "hold", type: "wait", for: "5 seconds" }] : []),
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

/** A system fact about `about` resting on `source`'s first version, with `extra`. */
const memoryFrom = (
  about: string,
  source: SourceRef,
  statement: string,
  extra: { object?: string; validFrom?: Date; validUntil?: Date } = {}
) => ({
  about,
  type: "fact" as const,
  statement,
  speaker: { kind: "system" as const },
  basis: {
    kind: "source" as const,
    source: `${source.producer}:${source.id}`,
    version: 1,
    quote: statement,
  },
  ...extra,
});

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

  it("keeps every name a run is handed with the run: a related entity's and one found, each withheld once the source that named it is erased, and a name in a person's own word once its memory is retired", async () => {
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
      writer: ada.userId,
      change: "retire",
    });

    expect({
      before,
      retired: retired?.retiredAt instanceof Date,
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
      retired: true,
      after: {
        relation: { status: "completed", error: "brain.revoked", shows: [] },
        found: { status: "completed", error: "brain.revoked", shows: [] },
        // A memory its writer retired (or a share taken back) is no longer
        // passed on, as a chat withholds it (GRA-1985).
        said: { status: "completed", error: "brain.revoked", shows: [] },
      },
    });
  });

  it("keeps a card's own name with the run apart from its memories, and withholds a run whose related entity's naming source is narrowed to a team", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const team = await teamOf(ada);
    const workflow = await entitiesWorkflow(ada, admin);
    // A project named only by a source that is later narrowed to a team,
    // which a customer's relation, from another source, points to.
    const related = `Narrowed ${unique()}`;
    const holder = `Holder ${unique()}`;
    const relatedSource = await sourceForEveryone(`${related} is a project.`);
    const project = await namedBy("project", related, {
      source: relatedSource,
    });
    const linkSource = await sourceForEveryone(`${holder} works on it.`);
    const linked = await store().addMemories({
      change: crypto.randomUUID(),
      access: { kind: "audience", group: "company" },
      entities: [
        { key: "c", kind: "customer", names: [holder] },
        { key: "p", id: project.entity, kind: "project" },
      ],
      memories: [
        memoryFrom("c", linkSource, `${holder} works on it`, { object: "p" }),
      ],
    });
    // A supplier whose own name comes only from an ended memory of one
    // source, never on its card, and whose card rests on another.
    const early = `Early ${unique()}`;
    const later = `Later ${unique()}`;
    const naming = await sourceForEveryone(`${early} was here.`);
    const current = await sourceForEveryone(`${later} is here.`);
    const first = await store().addMemories({
      change: crypto.randomUUID(),
      access: { kind: "audience", group: "company" },
      entities: [{ key: "e", kind: "supplier", names: [early] }],
      memories: [
        memoryFrom("e", naming, `${early} was here`, {
          validFrom: new Date("2019-01-01T00:00:00Z"),
          validUntil: new Date("2020-01-01T00:00:00Z"),
        }),
      ],
    });
    const supplier = first.entities.e ?? "";
    await store().addMemories({
      change: crypto.randomUUID(),
      access: { kind: "audience", group: "company" },
      entities: [{ key: "e", id: supplier, kind: "supplier", names: [later] }],
      memories: [memoryFrom("e", current, `${later} is here`)],
    });

    const runs = {
      narrowed: await endedRun(ada, workflow.id, {
        entity: linked.entities.c ?? "",
        name: related,
      }),
      ownName: await endedRun(ada, workflow.id, {
        entity: supplier,
        name: `Nobody ${unique()}`,
      }),
    };
    const names = [related, early, later];
    const before = {
      narrowed: await showsOf(ada, workflow.id, runs.narrowed, names),
      ownName: await showsOf(ada, workflow.id, runs.ownName, names),
    };
    // A new version of the project's source, for the team alone.
    await store().addSource({
      source: `upload:${relatedSource.id}`,
      change: crypto.randomUUID(),
      text: `${related} is a project, for the team.`,
      access: { kind: "audience", group: `team:${team}` },
    });
    await eraseSource(env, {
      source: naming,
      readers: { kind: "none" },
      reason: "deleted",
    });

    const now = await store().readEntity({
      entity: supplier,
      reader: { person: null, groups: ["company"] },
    });

    expect({
      before,
      after: {
        narrowed: await showsOf(admin, workflow.id, runs.narrowed, names),
        ownName: await showsOf(admin, workflow.id, runs.ownName, names),
      },
      // The company now reads the supplier by its later name.
      nowNamed: now?.name,
    }).toStrictEqual({
      before: {
        narrowed: { status: "completed", error: null, shows: [related] },
        ownName: { status: "completed", error: null, shows: [early, later] },
      },
      after: {
        narrowed: { status: "completed", error: "brain.revoked", shows: [] },
        ownName: { status: "completed", error: "brain.revoked", shows: [] },
      },
      nowNamed: later,
    });
  });

  it("keeps what made a found entity match with the run: a name another source gave, erased or narrowed to a team, withholds the run", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const team = await teamOf(ada);
    const workflow = await entitiesWorkflow(ada, admin);
    // A customer named first by one source, and by a second name from
    // another: a find for the second name hands on the first.
    const ofSecond = async (first: string, second: string) => {
      const naming = await sourceForEveryone(`${first} is a customer.`);
      const customer = await namedBy("customer", first, { source: naming });
      const matching = await sourceForEveryone(`${first} is ${second}.`);
      await store().addMemories({
        change: crypto.randomUUID(),
        access: { kind: "audience", group: "company" },
        entities: [
          { key: "e", id: customer.entity, kind: "customer", names: [second] },
        ],
        memories: [memoryFrom("e", matching, `${first} is ${second}`)],
      });
      return { matching, customer: customer.entity };
    };
    const [erasedFirst, erasedSecond, narrowedFirst, narrowedSecond] = [
      `Acme ${unique()}`,
      `Initrode ${unique()}`,
      `Globex ${unique()}`,
      `Hooli ${unique()}`,
    ];
    const erased = await ofSecond(erasedFirst, erasedSecond);
    const narrowed = await ofSecond(narrowedFirst, narrowedSecond);
    const runs = {
      erased: await endedRun(ada, workflow.id, {
        entity: crypto.randomUUID(),
        name: erasedSecond,
      }),
      narrowed: await endedRun(ada, workflow.id, {
        entity: crypto.randomUUID(),
        name: narrowedSecond,
      }),
    };
    const names = [erasedFirst, narrowedFirst];
    const before = {
      erased: await showsOf(ada, workflow.id, runs.erased, names),
      narrowed: await showsOf(ada, workflow.id, runs.narrowed, names),
    };
    await eraseSource(env, {
      source: erased.matching,
      readers: { kind: "none" },
      reason: "deleted",
    });
    await store().addSource({
      source: `upload:${narrowed.matching.id}`,
      change: crypto.randomUUID(),
      text: `${narrowedFirst} is ${narrowedSecond}, for the team.`,
      access: { kind: "audience", group: `team:${team}` },
    });

    expect({
      before,
      after: {
        erased: await showsOf(admin, workflow.id, runs.erased, names),
        narrowed: await showsOf(admin, workflow.id, runs.narrowed, names),
      },
    }).toStrictEqual({
      before: {
        erased: { status: "completed", error: null, shows: [erasedFirst] },
        narrowed: {
          status: "completed",
          error: null,
          shows: [narrowedFirst],
        },
      },
      after: {
        erased: { status: "completed", error: "brain.revoked", shows: [] },
        narrowed: { status: "completed", error: "brain.revoked", shows: [] },
      },
    });
  });

  it("keeps what makes a card's entity seen: an entity with no name and no current memory, seen through an ended one, withholds the run once that one's source is erased", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const workflow = await entitiesWorkflow(ada, admin);
    const statement = `It ran until 2020 ${unique()}`;
    const source = await sourceForEveryone(`${statement}.`);
    const added = await store().addMemories({
      change: crypto.randomUUID(),
      access: { kind: "audience", group: "company" },
      entities: [{ key: "e", kind: "project" }],
      memories: [
        memoryFrom("e", source, statement, {
          validFrom: new Date("2019-01-01T00:00:00Z"),
          validUntil: new Date("2020-01-01T00:00:00Z"),
        }),
      ],
    });
    const entity = added.entities.e ?? "";
    const runId = await endedRun(ada, workflow.id, {
      entity,
      name: `Nobody ${unique()}`,
    });
    const before = await showsOf(ada, workflow.id, runId, [entity, statement]);
    await eraseSource(env, {
      source,
      readers: { kind: "none" },
      reason: "deleted",
    });

    expect({
      // Its card says only that it is there: its id, and no memory.
      before,
      after: await showsOf(admin, workflow.id, runId, [entity]),
    }).toStrictEqual({
      before: { status: "completed", error: null, shows: [entity] },
      after: { status: "completed", error: "brain.revoked", shows: [] },
    });
  });

  it("keeps what makes a memory confirmed: a rival it was confirmed over, no longer current and so on no page, narrowed to a team withholds the run", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const team = await teamOf(ada);
    const workflow = await entitiesWorkflow(ada, admin);
    const name = `Confirmed ${unique()}`;
    const active = await sourceForEveryone(`${name} is active.`);
    const lost = await sourceForEveryone(`${name} is lost.`);
    const status = (value: string, source: SourceRef, until?: Date) => ({
      ...memoryFrom(
        "c",
        source,
        `${name} is ${value}`,
        until === undefined ? {} : { validUntil: until }
      ),
      attribute: "status",
      value,
    });
    const made = await store().addMemories({
      change: crypto.randomUUID(),
      access: { kind: "audience", group: "company" },
      entities: [{ key: "c", kind: "customer", names: [name] }],
      memories: [status("active", active)],
    });
    const customer = made.entities.c ?? "";
    // A rival, current for a moment: confirmed over, then no longer
    // current, so on no page and no rival, while the company may read it.
    const until = new Date(Date.now() + 2000);
    await store().addMemories({
      change: crypto.randomUUID(),
      access: { kind: "audience", group: "company" },
      entities: [{ key: "c", kind: "customer", id: customer }],
      memories: [status("lost", lost, until)],
    });
    const confirmed = await store().confirmMemory({
      memory: made.memories[0] ?? "",
      reader: { person: ada.userId, groups: ["company"] },
    });
    await vi.waitFor(
      () => {
        expect(Date.now()).toBeGreaterThan(until.getTime() + 200);
      },
      { timeout: 15_000, interval: 250 }
    );
    const runId = await endedRun(ada, workflow.id, {
      entity: customer,
      name: `Nobody ${unique()}`,
    });
    const before = await recordOf(ada, workflow.id, runId);
    // The rival's source, for the team alone: the confirmation no longer
    // counts for the company.
    await store().addSource({
      source: `upload:${lost.id}`,
      change: crypto.randomUUID(),
      text: `${name} is lost, for the team.`,
      access: { kind: "audience", group: `team:${team}` },
    });

    expect({
      confirmed,
      before: {
        error: before.error,
        confirmed: JSON.stringify(before.result).includes(
          String.raw`\"confirmed\":true`
        ),
      },
      after: await recordOf(admin, workflow.id, runId),
    }).toStrictEqual({
      confirmed: "done",
      before: { error: null, confirmed: true },
      after: { status: "completed", result: null, error: "brain.revoked" },
    });
  });

  it("refuses a test run's card or page of entities that carries what it rests on, as a real answer that did would be", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const key = `brain-${unique()}`;
    await publishCatalogContract(env, admin, { key, kind: "brain" });
    /** A draft of Ada's whose one step is `action` on the Brain, answering `result`: its test runs. */
    const drafted = async (
      action: "entities.get" | "entities.find",
      args: Record<string, unknown>,
      result: string
    ) => {
      const workflow = await createWorkflowResource(
        env,
        ada,
        `card-${unique()}`
      );
      const { revision: base } = await workflowDraft(env, ada, workflow.id);
      const saved = await editWorkflowDraft(env, ada, workflow.id, {
        revision: base,
        source: JSON.stringify({
          $schema: workflowSchemaUrl,
          args: { kind: "object", fields: {} },
          returns: { kind: "object", fields: { name: { kind: "string" } } },
          result: { name: { $expr: result } },
          permissions: { brain: { docs: { contract: key } } },
          steps: [{ id: "read", type: "call", brain: "docs", action, args }],
        }),
      });
      expect(saved.problems).toStrictEqual([]);
      return async (answer: unknown) => {
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
    };
    const card = await drafted(
      "entities.get",
      { entity: crypto.randomUUID() },
      'read?.entity.name ?? ""'
    );
    const find = await drafted(
      "entities.find",
      { kind: "customer" },
      'read.entities.length > 0 ? "found" : ""'
    );
    const entity = {
      id: crypto.randomUUID(),
      kind: "customer",
      name: "Acme",
    } as const;
    const restsOn = [{ source: { producer: "upload", id: "u" }, version: 1 }];

    expect({
      card: await card(cardOf(entity)),
      cardCarrying: await card({ ...cardOf(entity), restsOn }),
      page: await find({ entities: [entity], next: null }),
      pageCarrying: await find({ entities: [entity], next: null, restsOn }),
    }).toStrictEqual({
      card: { status: "completed", result: { name: "Acme" } },
      cardCarrying: { status: "failed", code: "workflow.call_invalid" },
      page: { status: "completed", result: { name: "found" } },
      pageCarrying: { status: "failed", code: "workflow.call_invalid" },
    });
  });
});

// What a run read of a member a person's erasure took (GRA-1985, the
// threat model on the issue): her card, its names and facts, rest on
// memories her erasure takes, though the documents they were drawn from
// stay. Every memory an entity read rests on is kept with the run
// (`run_brain_memories`), and checked before anything leaves it, as the
// versions are: the run is refused (`brain.revoked`), its output withheld.

/**
 * Anna's card, for everyone: her name and address, and a fact about her
 * drawn from a document everyone may read, which stays; and a desk whose
 * address was hers, given by another group's memory, with a fact of its
 * own for everyone.
 */
const annasCard = async () => {
  const personId = crypto.randomUUID();
  const address = `anna.${crypto.randomUUID()}@acme.test`;
  const name = `Anna ${unique()}`;
  const fact = `${name} leads finance`;
  const note = await sourceForEveryone(`${fact}.`);
  const deskName = `Desk ${unique()}`;
  const deskFact = `${deskName} opens at eight`;
  const group = `team:${crypto.randomUUID()}`;
  // The desk's address, hers, in a memory only another group may read: a
  // card of the company's is never joined with it by that address.
  const desk = await store().addMemories({
    change: crypto.randomUUID(),
    access: { kind: "audience", group },
    entities: [
      {
        key: "d",
        kind: "team",
        names: [deskName],
        identifiers: [{ type: "email", value: address }],
      },
    ],
    memories: [
      {
        about: "d",
        type: "fact",
        statement: `${deskName} is shared`,
        speaker: { kind: "system" },
        basis: { kind: "writer", writer: "app:desks" },
      },
    ],
  });
  const deskId = desk.entities.d ?? "";
  await store().addMemories({
    change: crypto.randomUUID(),
    access: { kind: "audience", group: "company" },
    reader: { person: null, groups: [group, "company"] },
    entities: [{ key: "d", id: deskId, kind: "team", names: [deskName] }],
    memories: [
      {
        about: "d",
        type: "fact",
        statement: deskFact,
        speaker: { kind: "system" },
        basis: { kind: "writer", writer: "app:desks" },
      },
    ],
  });
  const card = await store().addMemories({
    change: crypto.randomUUID(),
    access: { kind: "audience", group: "company" },
    entities: [
      {
        key: "a",
        kind: "person",
        names: [name],
        identifiers: [{ type: "email", value: address }],
      },
    ],
    memories: [memoryFrom("a", note, fact)],
  });
  return {
    personId,
    address,
    name,
    fact,
    card: card.entities.a ?? "",
    desk: deskId,
    deskFact,
  };
};

/** A run of `id` for `by` on `args`, started: its ID. */
const startedRun = async (
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
  return runId;
};

/** How run `runId` of `id` ended: its status and error's code, once it has. */
const endingOf = async (by: Member, id: string, runId: string) =>
  await vi.waitFor(
    async () => {
      const run = await resourceRunFor(env, by, id, runId);
      expect(run.endedAt).not.toBeNull();
      return { status: run.status, error: run.error?.code ?? null };
    },
    { timeout: 30_000, interval: 100 }
  );

/** How many memories run `runId` keeps of what its entity reads rested on. */
const memoriesKeptBy = async (runId: string): Promise<number> =>
  (await env.DB.prepare(
    "SELECT count(*) AS n FROM run_brain_memories WHERE run_id = ?"
  )
    .bind(runId)
    .first<number>("n")) ?? 0;

/** How many memories people's erasures still hide in the shared store. */
const hiddenByErasures = async (): Promise<number> =>
  await runInDurableObject(
    inJurisdiction(env, env.BRAIN_STORE).getByName("brain"),
    (_instance, state) =>
      state.storage.sql
        .exec<{ count: number }>(
          "SELECT count(*) AS count FROM person_erasure_memories"
        )
        .one().count
  );

describe(
  "entities, as a workflow read them, once a person is erased",
  setUpTime,
  () => {
    it("refuses a run under way and withholds an ended run's output once a person's erasure took the card it read or found, also after the tick, an older copy and a lost storage; a desk that only held her address goes on", async () => {
      const admin = await person("admin");
      const ada = await person("builder");
      const workflow = await entitiesWorkflow(ada, admin);
      const holding = await entitiesWorkflow(ada, admin, { hold: true });
      const anna = await annasCard();
      const nobody = unique();
      const ended = {
        card: await endedRun(ada, workflow.id, {
          entity: anna.card,
          name: nobody,
        }),
        found: await endedRun(ada, workflow.id, {
          entity: crypto.randomUUID(),
          name: anna.name,
        }),
        desk: await endedRun(ada, workflow.id, {
          entity: anna.desk,
          name: nobody,
        }),
      };
      const underWay = {
        card: await startedRun(ada, holding.id, {
          entity: anna.card,
          name: nobody,
        }),
        found: await startedRun(ada, holding.id, {
          entity: crypto.randomUUID(),
          name: anna.name,
        }),
      };
      // Each has read, and waits before its output leaves it.
      await vi.waitFor(
        async () => {
          const kept = await Promise.all(
            Object.values(underWay).map(async (runId) => {
              const memories = await memoriesKeptBy(runId);
              return memories > 0;
            })
          );
          expect(kept).toStrictEqual([true, true]);
        },
        { timeout: 10_000, interval: 50 }
      );
      const names = [anna.name, anna.fact, anna.deskFact];
      const shown = async () => ({
        card: await showsOf(admin, workflow.id, ended.card, names),
        found: await showsOf(admin, workflow.id, ended.found, names),
        desk: await showsOf(admin, workflow.id, ended.desk, names),
      });
      const before = await shown();
      const older = await copyOfStore();

      await erasePersonShared(env, {
        personId: anna.personId,
        email: anna.address,
      });
      const refused = {
        card: await endingOf(ada, holding.id, underWay.card),
        found: await endingOf(ada, holding.id, underWay.found),
      };
      const afterErasure = await shown();
      for (let ticks = 0; ticks < 10; ticks += 1) {
        // oxlint-disable-next-line no-await-in-loop -- a tick at a time
        if ((await hiddenByErasures()) === 0) {
          break;
        }
        // oxlint-disable-next-line no-await-in-loop -- a tick at a time
        await workBrain(env, new Date(), noProducers);
      }
      const left = await hiddenByErasures();
      const afterTick = await shown();
      const now = await copyOfStore();
      await restoreStore(older);
      const olderCopy = await shown();
      await runInDurableObject(
        inJurisdiction(env, env.BRAIN_STORE).getByName("brain"),
        async (_instance, state) => {
          await state.storage.deleteAll();
        }
      );
      await killStore();
      const lost = await shown();
      await restoreStore(now);

      const withheld = {
        status: "completed",
        error: "brain.revoked",
        shows: [],
      };
      const takenAfter = {
        card: withheld,
        found: withheld,
        desk: { status: "completed", error: null, shows: [anna.deskFact] },
      };
      expect({
        before,
        refused,
        afterErasure,
        left,
        afterTick,
        olderCopy,
        lost,
      }).toStrictEqual({
        before: {
          card: {
            status: "completed",
            error: null,
            shows: [anna.name, anna.fact],
          },
          found: { status: "completed", error: null, shows: [anna.name] },
          desk: { status: "completed", error: null, shows: [anna.deskFact] },
        },
        refused: {
          card: { status: "failed", error: "brain.revoked" },
          found: { status: "failed", error: "brain.revoked" },
        },
        afterErasure: takenAfter,
        left: 0,
        afterTick: takenAfter,
        olderCopy: takenAfter,
        // A store holding nothing: no memory the desk's run rests on either.
        lost: { ...takenAfter, desk: withheld },
      });
    });

    it("gives a run's step nothing it read of her card when what it rests on can't be kept with the run first", async () => {
      const admin = await person("admin");
      const ada = await person("builder");
      const workflow = await entitiesWorkflow(ada, admin);
      const anna = await annasCard();
      // Core's database refuses to keep a memory with a run.
      await env.DB.prepare(
        `CREATE TRIGGER test_refuse_run_memories BEFORE INSERT ON run_brain_memories
      BEGIN SELECT RAISE(ABORT, 'refused by the test'); END`
      ).run();
      let ran: Awaited<ReturnType<typeof showsOf>>;
      try {
        const runId = await endedRun(ada, workflow.id, {
          entity: anna.card,
          name: anna.name,
        });
        ran = await showsOf(admin, workflow.id, runId, [anna.name, anna.fact]);
      } finally {
        await env.DB.prepare("DROP TRIGGER test_refuse_run_memories").run();
      }

      expect({ status: ran.status, shows: ran.shows }).toStrictEqual({
        status: "failed",
        shows: [],
      });
    });

    it("drops what a run's entity reads rested on with the run's details, once its retention is over", async () => {
      const admin = await person("admin");
      const ada = await person("builder");
      const workflow = await entitiesWorkflow(ada, admin);
      const anna = await annasCard();
      const runId = await endedRun(ada, workflow.id, {
        entity: anna.card,
        name: anna.name,
      });
      const kept = await memoriesKeptBy(runId);
      const day = 24 * 60 * 60 * 1000;
      await runQuarterHourTasks({}, new Date(Date.now() + 31 * day));

      expect({
        kept: kept > 0,
        after: await memoriesKeptBy(runId),
      }).toStrictEqual({ kept: true, after: 0 });
    });
  }
);

/**
 * A workflow of `by`'s that reads entity `args.entity`'s card, waits a
 * moment, then runs `after` (steps reading the card as `card`), with
 * `permissions` beside its Brain's, and its state `state` if any: bound
 * by `admin` to a grant of its own to read the Brain.
 */
const readThenWorkflow = async (
  by: Member,
  admin: Member,
  {
    after,
    permissions = {},
    state,
    first = {
      id: "card",
      type: "call",
      brain: "docs",
      action: "entities.get",
      args: { entity: { $expr: "args.entity" } },
    },
  }: {
    after: unknown[];
    permissions?: Record<string, unknown>;
    state?: Record<string, unknown>;
    first?: unknown;
  }
) => {
  const key = `brain-${unique()}`;
  await publishCatalogContract(env, admin, { key, kind: "brain" });
  const workflow = await createWorkflowResource(env, by, `then-${unique()}`);
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
      permissions: { ...permissions, brain: { docs: { contract: key } } },
      ...(state === undefined ? {} : { state }),
      steps: [first, { id: "hold", type: "wait", for: "5 seconds" }, ...after],
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

/** Waits until run `runId` keeps what its first read rested on: memories or versions. */
const hasRead = async (runId: string): Promise<void> => {
  await vi.waitFor(
    async () => {
      const kept = await env.DB.prepare(
        `SELECT (SELECT count(*) FROM run_brain_memories WHERE run_id = ?1)
        + (SELECT count(*) FROM run_brain_versions WHERE run_id = ?1) AS n`
      )
        .bind(runId)
        .first<number>("n");
      expect(kept).toBeGreaterThan(0);
    },
    { timeout: 10_000, interval: 50 }
  );
};

/** What reached the outside API so far, by its body. */
const receivedBodies = async (): Promise<string[]> => {
  const providers = testBinding("CONNECT_PROVIDERS");
  if (
    typeof providers !== "object" ||
    providers === null ||
    !("fetch" in providers)
  ) {
    throw new TypeError("Expected the providers Worker as CONNECT_PROVIDERS");
  }
  // SAFETY: checked just above to have `fetch`, as a Fetcher does.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const response = await (providers as Fetcher).fetch(httpApiReceivedUrl);
  return z
    .array(z.object({ body: z.string() }))
    .parse(await response.json())
    .map(({ body }) => body);
};

const idp = mockIdp();

describe(
  "what a run passes on once a person's erasure took what it read",
  setUpTime,
  () => {
    it("keeps nothing in the workflow's state of her card once her erasure landed after the read, and nothing of a recalled passage once its source is erased", async () => {
      const admin = await person("admin");
      const ada = await person("builder");
      const anna = await annasCard();
      const card = await readThenWorkflow(ada, admin, {
        state: { kept: { kind: "string" } },
        after: [
          {
            id: "found",
            type: "call",
            brain: "docs",
            action: "entities.find",
            args: { name: { $expr: "args.name" } },
            state: { kept: { $expr: 'card?.entity.name ?? ""' } },
          },
        ],
      });
      const word = `ledger${unique().replaceAll(/\W/gu, "")}`;
      const passage = `The ${word} closes on Friday.`;
      const note = await sourceForEveryone(passage);
      const recalled = await readThenWorkflow(ada, admin, {
        state: { kept: { kind: "string" } },
        first: {
          id: "recalled",
          type: "call",
          brain: "docs",
          action: "recall",
          args: {
            question: { $expr: "args.name" },
            budget: { tokens: 800 },
          },
        },
        after: [
          {
            id: "found",
            type: "call",
            brain: "docs",
            action: "entities.find",
            args: { name: { $expr: "args.name" } },
            state: { kept: { $expr: 'recalled.items[0]?.text ?? ""' } },
          },
        ],
      });
      const runs = {
        card: await startedRun(ada, card.id, {
          entity: anna.card,
          name: unique(),
        }),
        recalled: await startedRun(ada, recalled.id, {
          entity: crypto.randomUUID(),
          name: word,
        }),
      };
      await hasRead(runs.card);
      await hasRead(runs.recalled);

      await erasePersonShared(env, {
        personId: anna.personId,
        email: anna.address,
      });
      await eraseSource(env, {
        source: note,
        readers: { kind: "none" },
        reason: "deleted",
      });

      expect({
        card: await endingOf(ada, card.id, runs.card),
        recalled: await endingOf(ada, recalled.id, runs.recalled),
        state: {
          card: await workflowStateOf(env, card.id),
          recalled: await workflowStateOf(env, recalled.id),
        },
      }).toStrictEqual({
        card: { status: "failed", error: "brain.revoked" },
        recalled: { status: "failed", error: "brain.revoked" },
        state: { card: {}, recalled: {} },
      });
    });

    it("withholds a run's files that hold her card once her erasure lands, though written before it: off the workflow's files page, filled past them, off the run sheet, and not downloaded, as a missing file", async () => {
      const people = jsonWorkflowAppsOf(idp);
      const admin = await people.signedIn("admin");
      const ada = await people.signedIn("builder");
      const anna = await annasCard();
      const filesKey = `files-${unique()}`;
      await publishCatalogContract(env, admin.acting, {
        key: filesKey,
        kind: "files",
      });
      const workflow = await readThenWorkflow(ada.acting, admin.acting, {
        permissions: { files: { runFiles: { contract: filesKey } } },
        after: [
          {
            id: "written",
            type: "call",
            files: "runFiles",
            action: "write",
            args: {
              // Named after the card it read: what a page lists.
              name: { $expr: '(card?.entity.name ?? "none") + ".md"' },
              type: "text/markdown",
              text: { $expr: 'card?.entity.name ?? ""' },
            },
          },
        ],
      });
      await approveWorkflowBinding(env, admin.acting, workflow.id, {
        alias: "runFiles",
        target: { kind: "files" },
        reviewed: { version: 1 },
      });
      // A run that read a card nobody erases, its file older, and with
      // copies of it a whole page of files (100) besides hers.
      const kept = await written(`Bert ${unique()}`);
      const keptRun = await startedRun(ada.acting, workflow.id, {
        entity: kept.entity,
        name: unique(),
      });
      await endingOf(ada.acting, workflow.id, keptRun);
      await env.DB.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 99)
        INSERT INTO workflow_run_files (id, run_id, workflow_resource_id, opened_by, open_key, name, type, size, sha256, state, created_at, finished_at, deleted_at)
        SELECT lower(hex(randomblob(16))), run_id, workflow_resource_id, opened_by, open_key || '-' || i, name, type, size, sha256, state, created_at, finished_at - i, deleted_at
        FROM workflow_run_files, n WHERE run_id = ?`
      )
        .bind(keptRun)
        .run();
      const hers = await startedRun(ada.acting, workflow.id, {
        entity: anna.card,
        name: unique(),
      });
      const ended = await endingOf(ada.acting, workflow.id, hers);
      const [herFile] =
        (await runFilesFor(env, ada.acting, workflow.id, hers)) ?? [];
      /** What `by` lists of the workflow's files: how many, how many of hers, whether any names her. */
      const page = async (by: typeof ada) => {
        const files = await workflowFiles(env, by.acting, workflow.id);
        return {
          files: files.length,
          hers: files.filter(({ runId }) => runId === hers).length,
          names: JSON.stringify(files).includes(anna.name),
        };
      };
      /** A download of `file` of run `run` by Ada, as her run sheet's link asks: its status. */
      const download = async (run: string, file: string): Promise<number> => {
        const response = await routed(
          runFileContentPath(workflow.id, run, file),
          {
            headers: { cookie: ada.session, "sec-fetch-site": "same-origin" },
          }
        );
        await response.body?.cancel();
        return response.status;
      };
      const listedBefore = await runFilesFor(
        env,
        ada.acting,
        workflow.id,
        hers
      );
      const before = {
        ada: await page(ada),
        admin: await page(admin),
        sheet: listedBefore?.length,
        download: await download(hers, herFile?.id ?? ""),
      };

      await erasePersonShared(env, {
        personId: anna.personId,
        email: anna.address,
      });

      expect({
        ended,
        before,
        after: {
          ada: await page(ada),
          admin: await page(admin),
          sheet: await runFilesFor(env, ada.acting, workflow.id, hers),
          download: await download(hers, herFile?.id ?? ""),
        },
        missing: await download(hers, crypto.randomUUID()),
      }).toStrictEqual({
        ended: { status: "completed", error: null },
        before: {
          ada: { files: 100, hers: 1, names: true },
          admin: { files: 100, hers: 1, names: true },
          sheet: 1,
          download: 200,
        },
        after: {
          // As if her run wrote none: the page filled past it.
          ada: { files: 100, hers: 0, names: false },
          admin: { files: 100, hers: 0, names: false },
          sheet: null,
          download: 404,
        },
        missing: 404,
      });
    });

    it("asks no model with her card once her erasure landed after the read", async () => {
      const admin = await person("admin");
      const ada = await person("builder");
      const anna = await annasCard();
      const modelKey = `reader-${unique()}`;
      await publishCatalogContract(env, admin, {
        key: modelKey,
        kind: "model",
      });
      const workflow = await readThenWorkflow(ada, admin, {
        permissions: { ai: { contract: modelKey } },
        after: [
          {
            id: "ask",
            type: "generate",
            instructions: "Greet them.",
            input: { who: { $expr: 'card?.entity.name ?? ""' } },
            returns: { kind: "object", fields: { line: { kind: "string" } } },
          },
        ],
      });
      // Connected first: a model binding needs its model to be.
      const provider = await fakeProviderFor([askedModel], {
        text: '{"line": "Hello"}',
        inputTokens: 1,
        outputTokens: 1,
      });
      await approveWorkflowBinding(env, admin, workflow.id, {
        alias: "ai",
        target: { kind: "model", model: askedModel },
        reviewed: { version: 1 },
      });
      const runId = await startedRun(ada, workflow.id, {
        entity: anna.card,
        name: unique(),
      });
      await hasRead(runId);

      await erasePersonShared(env, {
        personId: anna.personId,
        email: anna.address,
      });

      expect({
        ending: await endingOf(ada, workflow.id, runId),
        asked: provider.requests.length,
      }).toStrictEqual({
        ending: { status: "failed", error: "brain.revoked" },
        asked: 0,
      });
    });

    it("sends nothing of her card through a connection once her erasure landed after the read", async () => {
      const people = jsonWorkflowAppsOf(idp);
      const admin = await people.signedIn("admin");
      const builder = await people.signedIn("builder");
      const anna = await annasCard();
      await builtins(env).ensureInstalled(await fingerprintOf(thisRelease));
      const { connectionId } = await admin.api.connections.createHttp({
        name: "Billing API",
        origin: httpApiOrigin,
        pathPrefixes: ["/v1/invoices"],
        methods: ["GET", "POST"],
        credential: {
          kind: "header",
          header: "x-api-key",
          secret: "the-billing-api-test-credential",
        },
      });
      const workflow = await readThenWorkflow(builder.acting, admin.acting, {
        permissions: {
          connections: { api: { contract: httpCatalogContract } },
        },
        after: [
          {
            id: "send",
            type: "call",
            connection: "api",
            action: "send",
            args: {
              method: "POST",
              path: "/v1/invoices",
              headers: { "content-type": "application/json" },
              body: { $expr: "JSON.stringify({ who: card?.entity.name })" },
            },
          },
        ],
      });
      const requested = await builder.api.permissions.request({
        subject: { type: "workflow", workflowId: workflow.id },
        object: { type: "connection", connectionId },
        actions: ["get", "send"],
        binding: `API_${unique().toUpperCase().replaceAll("-", "_")}`,
      });
      await admin.api.permissions.grant(requested.id, { version: null });
      await admin.api.workflowResources.approveBinding(workflow.id, {
        alias: "api",
        target: {
          kind: "connector",
          permissionId: requested.id,
          contract: httpContract,
        },
        reviewed: { version: 1 },
      });
      const runId = await startedRun(builder.acting, workflow.id, {
        entity: anna.card,
        name: unique(),
      });
      await hasRead(runId);

      await erasePersonShared(env, {
        personId: anna.personId,
        email: anna.address,
      });

      const ending = await endingOf(builder.acting, workflow.id, runId);
      const sentBodies = await receivedBodies();

      expect({
        ending,
        sent: sentBodies.filter((body) => body.includes(anna.name)),
      }).toStrictEqual({
        ending: { status: "failed", error: "brain.revoked" },
        sent: [],
      });
    });
  }
);

// What a run asks people about what it read (GRA-1988, the threat model on
// the issue): a decision's prompt and input are kept when it opens, and
// read by its recipients while it waits. Once the run may no longer read
// what they rest on, every way a recipient reads the ask shows it
// withheld, and an answer to it is never taken.

/**
 * A workflow of `by`'s that reads a card (`entities.get`) and asks
 * `reviewer` about it: its prompt names the card's entity, its input holds
 * the whole card. Its `brain` and decision bindings approved by `admin`.
 */
const askingAboutCard = async (by: Member, admin: Member, reviewer: Member) => {
  const brain = `brain-${unique()}`;
  await publishCatalogContract(env, admin, { key: brain, kind: "brain" });
  const contract = `card-review-${unique()}`;
  await publishCatalogContract(env, admin, {
    key: contract,
    kind: "decision",
    input: JSON.stringify(v.object({ card: v.string() }).descriptor),
    response: JSON.stringify(v.null().descriptor),
  });
  const workflow = await createWorkflowResource(env, by, `ask-${unique()}`);
  await publishDefinition(
    env,
    by,
    workflow.id,
    JSON.stringify({
      $schema: workflowSchemaUrl,
      // As `startedRun` starts one: `name` goes unread.
      args: {
        kind: "object",
        fields: { entity: { kind: "string" }, name: { kind: "string" } },
      },
      permissions: {
        brain: { docs: { contract: brain } },
        decisions: { review: { contract } },
      },
      steps: [
        {
          id: "card",
          type: "call",
          brain: "docs",
          action: "entities.get",
          args: { entity: { $expr: "args.entity" } },
        },
        {
          id: "asked",
          type: "decide",
          decision: "review",
          recipients: [`person:${reviewer.userId}`],
          prompt: { $expr: '"Go ahead with " + card?.entity.name + "?"' },
          input: { card: { $expr: "JSON.stringify(card)" } },
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
  await approveWorkflowBinding(env, admin, workflow.id, {
    alias: "review",
    target: { kind: "decision", deciders: [`person:${reviewer.userId}`] },
    reviewed: { version: 1 },
  });
  return workflow;
};

/** The decision run `runId` asked `reviewer`, once it waits in their inbox. */
const askedOfReviewer = async (
  reviewer: Member,
  runId: string
): Promise<string> =>
  await vi.waitFor(
    async () => {
      const row = await env.DB.prepare(
        "SELECT id FROM workflow_decisions WHERE resource_run_id = ?"
      )
        .bind(runId)
        .first<{ id: string }>();
      const waiting = await waitingDecisions(env, reviewer);
      const id = row?.id ?? "";
      expect(waiting.map((decision) => decision.id)).toContain(id);
      return id;
    },
    { timeout: 30_000, interval: 100 }
  );

/**
 * What `reviewer` reads of `decision`, every way they read it: its page,
 * their inbox, the review before an answer and their day's runs; whether
 * it is listed and shows an input, and which of `names` any of them shows.
 */
const askReadBy = async (
  reviewer: Member,
  decision: string,
  names: readonly string[]
) => {
  const page = await decisionFor(env, reviewer, decision);
  const waiting = await waitingDecisions(env, reviewer);
  const inbox = waiting.filter(({ id }) => id === decision);
  const review = await reviewDecision(env, reviewer, decision, {
    approved: false,
  });
  const today = await workflowsToday(env, reviewer);
  const asks = today.lanes
    .flatMap(({ runs }) => runs)
    .flatMap(({ waits }) => (waits?.decision === decision ? [waits.asks] : []));
  const text = JSON.stringify({ page, inbox, review, asks });
  return {
    inbox: inbox.length,
    today: asks.length,
    input: [page, ...inbox, review.decision].some(
      (view) => view.input !== undefined
    ),
    shows: names.filter((name) => text.includes(name)),
  };
};

/**
 * `by`'s answers to `decision` through the trusted host decision UI: an
 * approval, at each step it could be given (reviewed, confirmed, then
 * answered), each refused or not; then a rejection, reviewed, confirmed
 * and answered. Which of `names` any of it shows, and the refusals the
 * audit log keeps.
 */
const answeredBy = async (
  by: Member,
  decision: string,
  names: readonly string[]
) => {
  const approval = { approved: true };
  const { revision } = await decisionFor(env, by, decision);
  const approve = {
    review: await outcome(reviewDecision(env, by, decision, approval)),
    confirm: await outcome(
      confirmDecision(env, by, decision, revision, approval)
    ),
    // With no confirmation of it: none could be had.
    answer: await outcome(answerDecision(env, by, decision, approval, "")),
  };
  const review = await reviewDecision(env, by, decision, { approved: false });
  if (review.state === "recorded") {
    throw new Error("Answered already");
  }
  const { confirmation } = await confirmDecision(
    env,
    by,
    decision,
    review.decision.revision,
    review.response
  );
  const answered = await answerDecision(
    env,
    by,
    decision,
    review.response,
    confirmation
  );
  const events = await allEvents();
  const text = JSON.stringify({ review, answered });
  return {
    approve,
    refusalsAudited: events.filter(
      ({ action, target, detail }) =>
        action === "workflow.decision.answer_refused" &&
        target?.id === decision &&
        detail?.errorCode === "decision.withheld"
    ).length,
    status: answered.status,
    shows: names.filter((name) => text.includes(name)),
  };
};

/** What answering a withheld ask comes to: a rejection alone taken. */
const declinedOnly = {
  approve: {
    review: "decision.withheld",
    confirm: "decision.withheld",
    answer: "decision.withheld",
  },
  // The confirmation's and the answer's, as any refusal of them is.
  refusalsAudited: 2,
  status: "rejected",
  shows: [],
};

describe(
  "a decision's ask, once its run may no longer read it",
  setUpTime,
  () => {
    it("is withheld from its recipient everywhere they read it once a source the card it asks about rests on is erased: it can only be declined, and its run never goes on", async () => {
      const admin = await person("admin");
      const ada = await person("builder");
      // An admin sees every run of the day, so the ask shows there too.
      const reviewer = await person("admin");
      const workflow = await askingAboutCard(ada, admin, reviewer);
      const name = `Globex ${unique()}`;
      const source = await sourceForEveryone(`${name} is active.`);
      const drawn = await written(name, { source });
      const runId = await startedRun(ada, workflow.id, {
        entity: drawn.entity,
        name,
      });
      const decision = await askedOfReviewer(reviewer, runId);
      const before = await askReadBy(reviewer, decision, [name]);
      const { revision } = await decisionFor(env, reviewer, decision);

      await eraseSource(env, {
        source,
        readers: { kind: "none" },
        reason: "deleted",
      });
      const after = await askReadBy(reviewer, decision, [name]);
      const withheld = await decisionFor(env, reviewer, decision);
      const answered = await answeredBy(reviewer, decision, [name]);

      expect({
        before,
        after,
        sameRevision: withheld.revision === revision,
        answered,
        ending: await endingOf(ada, workflow.id, runId),
      }).toStrictEqual({
        before: { inbox: 1, today: 1, input: true, shows: [name] },
        // Still waiting for them, its words withheld, its input gone.
        after: { inbox: 1, today: 1, input: false, shows: [] },
        // What a reviewer confirms against holds nothing of what it asked.
        sameRevision: false,
        answered: declinedOnly,
        ending: { status: "failed", error: "brain.revoked" },
      });
    });

    it("is withheld from its recipient everywhere they read it once a person's erasure took the card it asks about: it can only be declined, and its run never goes on", async () => {
      const admin = await person("admin");
      const ada = await person("builder");
      const reviewer = await person("admin");
      const workflow = await askingAboutCard(ada, admin, reviewer);
      const anna = await annasCard();
      const names = [anna.name, anna.fact];
      const runId = await startedRun(ada, workflow.id, {
        entity: anna.card,
        name: unique(),
      });
      const decision = await askedOfReviewer(reviewer, runId);
      const before = await askReadBy(reviewer, decision, names);

      await erasePersonShared(env, {
        personId: anna.personId,
        email: anna.address,
      });
      const after = await askReadBy(reviewer, decision, names);
      const answered = await answeredBy(reviewer, decision, names);

      expect({
        before,
        after,
        answered,
        ending: await endingOf(ada, workflow.id, runId),
      }).toStrictEqual({
        before: { inbox: 1, today: 1, input: true, shows: names },
        after: { inbox: 1, today: 1, input: false, shows: [] },
        answered: declinedOnly,
        ending: { status: "failed", error: "brain.revoked" },
      });
    });
  }
);
