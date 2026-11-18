import { brainOf } from "@grasp-os/brain-next/contract";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { appFor } from "../src/apps.ts";
import { drainAuditOutboxes } from "../src/audit-drains.ts";
import type { Acting } from "../src/auth/identity.ts";
import {
  erasePersonShared,
  eraseSource,
  readSourceVersionAs,
  workBrain,
} from "../src/brain-next.ts";
import type { SourceRef } from "../src/brain-next.ts";
import { producersOf, relayHandOvers } from "../src/brain-sources.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import {
  grantPermission,
  requestPermission,
  revokePermission,
} from "../src/permissions.ts";
import { approveWorkflowBinding } from "../src/workflow-bindings.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import { workflowDraft } from "../src/workflow-editor.ts";
import { shareWorkflowResource } from "../src/workflow-members.ts";
import { createWorkflowResource } from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import {
  readWorkflowState,
  resetWorkflowState,
} from "../src/workflow-state.ts";
import { startCandidateRun } from "../src/workflows/candidate-runs.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { allEvents } from "./audit-events.ts";
import { runQuarterHourTasks } from "./maintenance.ts";
import { person } from "./sealed-apps.ts";
import { outcome, unique } from "./sign-in.ts";
import { publishDefinition } from "./workflow-publishing.ts";

// What a workflow keeps between its runs once what a run read to keep it
// is gone (GRA-1996; the threat model is on the issue): a run reads the
// Brain and keeps part of it in the workflow's state, and after the source
// is erased or narrowed, or a person is erased:
// 1. its builders and admins still read the copy;
// 2. the next run starts with it;
// 3. retention drops the run's evidence after 30 days, and the check
//    then finds nothing to refuse;
// 4. or, the other way, the copy is hidden for what protects no one: the
//    writer leaving, or a source widened again.
// Each through a real run, a real Brain and a real erasure.

/** Signing people in, publishing and granting can be slow on CI. */
const setUpTime = { timeout: 120_000 };

type Member = Acting & Identity;

const day = 24 * 60 * 60 * 1000;

/** The shared store, as core reaches it. */
const store = () => brainOf(inJurisdiction(env, env.BRAIN_STORE));

/** A source `group` (everyone, unless named) may read, saying `text`, as a new version. */
const sourceSaying = async (
  source: SourceRef,
  text: string,
  group = "company"
): Promise<void> => {
  await store().addSource({
    source: `${source.producer}:${source.id}`,
    change: crypto.randomUUID(),
    text,
    access: { kind: "audience", group },
  });
};

/**
 * A person's card everyone may read, drawn from a document that stays
 * after their erasure: their id, address, name, and the card's entity.
 */
const cardOfSomeone = async () => {
  const personId = crypto.randomUUID();
  const address = `anna.${crypto.randomUUID()}@acme.test`;
  const name = `Anna ${unique()}`;
  const statement = `${name} leads finance`;
  const note: SourceRef = { producer: "upload", id: crypto.randomUUID() };
  await sourceSaying(note, `${statement}.`);
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
    memories: [
      {
        about: "a",
        type: "fact",
        statement,
        speaker: { kind: "system" },
        basis: {
          kind: "source",
          source: `upload:${note.id}`,
          version: 1,
          quote: statement,
        },
      },
    ],
  });
  return { personId, address, name, entity: card.entities.a ?? "" };
};

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

/**
 * A step `id` that reads nothing it keeps and keeps `keep` (an expression)
 * as `kept`: a call, as only a call keeps state.
 */
const keepingCall = (id: string, keep: string) => ({
  id,
  type: "call",
  brain: "docs",
  action: "entities.find",
  args: { name: unique() },
  state: { kept: { $expr: keep } },
});

/**
 * A workflow of `by`'s whose run reads the Brain with `first` (its result
 * named by the step's ID), then, if its `keep` argument says so, keeps
 * `keep` (an expression over it) in the workflow's state as `kept`. With
 * `carry`, it reads nothing in the Brain and keeps `kept` as it found it
 * (`"notified"` when it found none) with `ask` added, unchanged for an
 * empty one, as a step carrying a value forward does, after a moment's
 * wait with `hold`. Bound by `admin` to a grant of
 * its own to read the Brain.
 */
const keepingWorkflow = async (
  by: Member,
  admin: Member,
  { first, keep }: { first: Record<string, unknown>; keep: string }
) => {
  const key = `brain-${unique()}`;
  await publishCatalogContract(env, admin, { key, kind: "brain" });
  const workflow = await createWorkflowResource(env, by, `keep-${unique()}`);
  await publishDefinition(
    env,
    by,
    workflow.id,
    JSON.stringify({
      $schema: workflowSchemaUrl,
      args: {
        kind: "object",
        fields: {
          entity: { kind: "string" },
          ask: { kind: "string" },
          keep: { kind: "boolean" },
          carry: { kind: "boolean" },
          hold: { kind: "boolean" },
        },
      },
      permissions: { brain: { docs: { contract: key } } },
      state: { kept: { kind: "string" } },
      // What it found kept as it started, returned whole.
      returns: { kind: "object", fields: { found: { kind: "string" } } },
      result: { found: { $expr: 'state.kept ?? ""' } },
      steps: [
        {
          id: "reading",
          type: "if",
          condition: { $expr: "args.carry === false" },
          // oxlint-disable-next-line unicorn/no-thenable -- the if step's list
          then: [
            first,
            {
              id: "keeping",
              type: "if",
              condition: { $expr: "args.keep" },
              // oxlint-disable-next-line unicorn/no-thenable -- the if step's list
              then: [keepingCall("keep", keep)],
            },
          ],
        },
        {
          id: "carrying",
          type: "if",
          condition: { $expr: "args.carry" },
          // oxlint-disable-next-line unicorn/no-thenable -- the if step's list
          then: [
            {
              id: "holding",
              type: "if",
              condition: { $expr: "args.hold" },
              // oxlint-disable-next-line unicorn/no-thenable -- the if step's list
              then: [{ id: "hold", type: "wait", for: "3 seconds" }],
            },
            keepingCall("carry", '(state.kept ?? "notified") + args.ask'),
          ],
        },
      ],
    })
  );
  const asked = await requestPermission(
    env,
    by,
    {
      subject: { type: "workflow", workflowId: workflow.id },
      object: { type: "platform" },
      actions: ["brain"],
      binding: `BRAIN_${unique().replaceAll(/\W/gu, "_").toUpperCase()}`,
    } satisfies PermissionRequest,
    rolesOf(by)
  );
  await grantPermission(env, admin, asked.id, { version: null });
  await approveWorkflowBinding(env, admin, workflow.id, {
    alias: "docs",
    target: { kind: "brain", permissionId: asked.id },
    reviewed: { version: 1 },
  });
  return { id: workflow.id, permissionId: asked.id };
};

/** A run of workflow `id` started for `by` on `args`: its ID. */
const started = async (
  by: Member,
  id: string,
  args: {
    entity: string;
    ask: string;
    keep: boolean;
    carry?: boolean;
    hold?: boolean;
  }
): Promise<string> => {
  const { runId } = await startWorkflow(
    env,
    { type: "person", person: by },
    id,
    {
      expected: 1,
      args: { carry: false, hold: false, ...args },
      key: unique(),
    }
  );
  if (runId === null) {
    throw new Error("The start admitted no run");
  }
  return runId;
};

/** Run `runId` of `id`, started for `by`, once it ended: how. */
const ended = async (by: Member, id: string, runId: string) =>
  await vi.waitFor(
    async () => {
      const run = await resourceRunFor(env, by, id, runId);
      expect(run.endedAt).not.toBeNull();
      return { status: run.status, error: run.error?.code ?? null };
    },
    { timeout: 30_000, interval: 100 }
  );

/** What `by` reads of key `kept` of workflow `id`'s state: its value, or why not. */
const keptFor = async (by: Member, id: string) => {
  const { entries } = await readWorkflowState(env, by, id);
  const kept = entries.find(({ key }) => key === "kept");
  return kept?.withheld ?? kept?.value;
};

/**
 * What the next run of workflow `id` started for `by` reads of what it
 * keeps, as its start froze it, and how many keys its start's event says
 * it reads as unset. It keeps nothing itself.
 */
const nextRunReads = async (by: Member, id: string) => {
  const runId = await started(by, id, {
    entity: unique(),
    ask: unique(),
    keep: false,
  });
  const frozen = await env.DB.prepare(
    `SELECT snapshots.body FROM workflow_start_receipts AS receipts
      JOIN workflow_state_snapshots AS snapshots ON snapshots.hash = receipts.state_hash
      WHERE receipts.id = ?`
  )
    .bind(runId)
    .first<string>("body");
  const events = await allEvents();
  const admitted = events.find(
    (event) =>
      event.action === "workflow.start.admitted" &&
      event.detail?.receipt === runId
  );
  await ended(by, id, runId);
  return {
    state: frozen === null ? null : z.json().parse(JSON.parse(frozen)),
    withheld: admitted?.detail?.stateWithheld ?? 0,
  };
};

/** How many rows of evidence core keeps of what run `runId` read. */
const evidenceOf = async (runId: string): Promise<number> =>
  (await env.DB.prepare(
    `SELECT (SELECT count(*) FROM run_brain_versions WHERE run_id = ?1)
      + (SELECT count(*) FROM run_brain_memories WHERE run_id = ?1) AS n`
  )
    .bind(runId)
    .first<number>("n")) ?? 0;

/**
 * `real`, running `between` once, just before the first statement that
 * reads what runs recalled (`run_brain_versions`) runs, alone or in a
 * batch: what lands between a read of what a workflow keeps and a read of
 * its writers' evidence, when the two are read apart.
 */
const evidenceHeld = (
  real: D1Database,
  between: () => Promise<void>
): D1Database => {
  let ran = false;
  const once = async (): Promise<void> => {
    if (!ran) {
      ran = true;
      await between();
    }
  };
  const recalled = /"run_brain_versions"/u;
  const unwrapped = new WeakMap<object, D1PreparedStatement>();
  const held = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get: (target, property) => {
        if (property === "bind") {
          return (...values: unknown[]) => held(target.bind(...values));
        }
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== "function") {
          return value;
        }
        return async (...args: unknown[]) => {
          await once();
          // oxlint-disable-next-line typescript/no-unsafe-return -- the statement's own answer
          return Reflect.apply(value, target, args);
        };
      },
    });
    unwrapped.set(proxy, statement);
    return proxy;
  };
  return {
    prepare: (query) => {
      const statement = real.prepare(query);
      return recalled.test(query) ? held(statement) : statement;
    },
    batch: async <T>(statements: D1PreparedStatement[]) => {
      if (statements.some((statement) => unwrapped.has(statement))) {
        await once();
      }
      return await real.batch<T>(
        statements.map((statement) => unwrapped.get(statement) ?? statement)
      );
    },
    exec: async (query) => await real.exec(query),
    // oxlint-disable-next-line typescript/no-deprecated -- D1Database still has it
    dump: async () => await real.dump(),
    withSession: (constraint) => real.withSession(constraint),
  };
};

/** Ada, who builds, an admin, and Ben, who builds the workflow with her. */
const people = async () => {
  const admin = await person("admin");
  const ada = await person("builder");
  const ben = await person("builder");
  return { admin, ada, ben };
};

/** Shares workflow `id` of `owner`'s with `ben` as a builder. */
const sharedWith = async (owner: Member, ben: Member, id: string) => {
  await shareWorkflowResource(env, owner, id, {
    type: "person",
    id: ben.userId,
    role: "builder",
  });
};

/** A workflow that keeps what a recall of `ask` found first. */
const recalling = {
  first: {
    id: "recalled",
    type: "call",
    brain: "docs",
    action: "recall",
    args: { question: { $expr: "args.ask" }, budget: { tokens: 800 } },
  },
  keep: 'recalled.items[0]?.text ?? ""',
};

/** The statements of a check of runs' evidence: its tables and its grants. */
const evidenceStatement =
  /"(?:run_brain_versions|run_brain_memories|run_chat_sources|permissions)"/u;

/**
 * What `read` costs of the check of runs' evidence: its statements on D1,
 * and its calls to the Brain's stores.
 */
const evidenceCostOf = async (
  read: () => Promise<unknown>
): Promise<{ statements: number; brainCalls: number }> => {
  const prepared = vi.spyOn(env.DB, "prepare");
  const stores = vi.spyOn(env.BRAIN_STORE, "getByName");
  try {
    await read();
    return {
      statements: prepared.mock.calls.filter(([query]) =>
        evidenceStatement.test(query)
      ).length,
      brainCalls: stores.mock.calls.length,
    };
  } finally {
    prepared.mockRestore();
    stores.mockRestore();
  }
};

/**
 * A workflow of `by`'s whose run recalls `args.ask` and keeps what it
 * found first under key `args.which`, one of `keys`: so each key can be
 * set by a run of its own. Bound by `admin` to a grant to read the Brain.
 */
const keyedWorkflow = async (
  by: Member,
  admin: Member,
  keys: readonly string[]
) => {
  const contract = `brain-${unique()}`;
  await publishCatalogContract(env, admin, { key: contract, kind: "brain" });
  const workflow = await createWorkflowResource(env, by, `keys-${unique()}`);
  await publishDefinition(
    env,
    by,
    workflow.id,
    JSON.stringify({
      $schema: workflowSchemaUrl,
      args: {
        kind: "object",
        fields: { ask: { kind: "string" }, which: { kind: "string" } },
      },
      permissions: { brain: { docs: { contract } } },
      state: Object.fromEntries(keys.map((key) => [key, { kind: "string" }])),
      steps: [
        recalling.first,
        ...keys.map((key) => ({
          id: `keeping${key}`,
          type: "if",
          condition: { $expr: `args.which === "${key}"` },
          // oxlint-disable-next-line unicorn/no-thenable -- the if step's list
          then: [
            {
              id: `keep${key}`,
              type: "call",
              brain: "docs",
              action: "entities.find",
              args: { name: unique() },
              state: { [key]: { $expr: recalling.keep } },
            },
          ],
        })),
      ],
    })
  );
  const asked = await requestPermission(
    env,
    by,
    {
      subject: { type: "workflow", workflowId: workflow.id },
      object: { type: "platform" },
      actions: ["brain"],
      binding: `BRAIN_${unique().replaceAll(/\W/gu, "_").toUpperCase()}`,
    } satisfies PermissionRequest,
    rolesOf(by)
  );
  await grantPermission(env, admin, asked.id, { version: null });
  await approveWorkflowBinding(env, admin, workflow.id, {
    alias: "docs",
    target: { kind: "brain", permissionId: asked.id },
    reviewed: { version: 1 },
  });
  return workflow.id;
};

describe("what a workflow keeps of what its run read", setUpTime, () => {
  it("withholds a key from its builders, its admins and the next run once a person's erasure took the card its run read: shown as withheld, read as unset, counted on the start", async () => {
    const { admin, ada, ben } = await people();
    const anna = await cardOfSomeone();
    const workflow = await keepingWorkflow(ada, admin, {
      first: {
        id: "card",
        type: "call",
        brain: "docs",
        action: "entities.get",
        args: { entity: { $expr: "args.entity" } },
      },
      keep: 'card?.entity.name ?? ""',
    });
    await sharedWith(ada, ben, workflow.id);
    const runId = await started(ada, workflow.id, {
      entity: anna.entity,
      ask: unique(),
      keep: true,
    });
    const run = await ended(ada, workflow.id, runId);
    const shownBefore = await readWorkflowState(env, admin, workflow.id);
    const before = {
      builder: await keptFor(ben, workflow.id),
      admin: await keptFor(admin, workflow.id),
      next: await nextRunReads(ben, workflow.id),
    };

    await erasePersonShared(env, {
      personId: anna.personId,
      email: anna.address,
    });
    const shownAfter = await readWorkflowState(env, admin, workflow.id);

    expect({
      run,
      before,
      after: {
        builder: await keptFor(ben, workflow.id),
        admin: await keptFor(admin, workflow.id),
        next: await nextRunReads(ben, workflow.id),
      },
      // What it takes counts no withheld value, so tells no length.
      bytes: { before: shownBefore.bytes > 0, after: shownAfter.bytes },
    }).toStrictEqual({
      run: { status: "completed", error: null },
      before: {
        builder: anna.name,
        admin: anna.name,
        next: { state: { kept: anna.name }, withheld: 0 },
      },
      after: {
        builder: "revoked",
        admin: "revoked",
        next: { state: {}, withheld: 1 },
      },
      bytes: { before: true, after: 0 },
    });
  });

  it("follows the source a run recalled: withheld once it is narrowed away from the company, back once it is widened again, withheld once it is erased; and never for the writer leaving", async () => {
    const { admin, ada, ben } = await people();
    const word = `ledger${unique().replaceAll(/\W/gu, "")}`;
    const passage = `The ${word} closes on Friday.`;
    const source: SourceRef = { producer: "upload", id: crypto.randomUUID() };
    await sourceSaying(source, passage);
    const workflow = await keepingWorkflow(ada, admin, recalling);
    await sharedWith(ada, ben, workflow.id);
    const runId = await started(ada, workflow.id, {
      entity: unique(),
      ask: word,
      keep: true,
    });
    await ended(ada, workflow.id, runId);
    const seen = async () => ({
      builder: await keptFor(ben, workflow.id),
      admin: await keptFor(admin, workflow.id),
      next: await nextRunReads(ben, workflow.id),
    });
    const kept = await seen();
    // Ada, whose run kept it, leaves: what her run read is the company's
    // still, so is the copy.
    await env.DB.prepare("DELETE FROM members WHERE user_id = ?")
      .bind(ada.userId)
      .run();
    const left = await seen();
    // A new version for a team alone: the version her run read is no
    // longer the company's.
    await sourceSaying(source, passage, `team:${crypto.randomUUID()}`);
    const narrowed = await seen();
    await sourceSaying(source, passage);
    const widened = await seen();
    await eraseSource(env, {
      source,
      readers: { kind: "none" },
      reason: "deleted",
    });
    const erased = await seen();

    const shown = { builder: passage, admin: passage };
    const withheld = { builder: "revoked", admin: "revoked" };
    expect({ kept, left, narrowed, widened, erased }).toStrictEqual({
      kept: { ...shown, next: { state: { kept: passage }, withheld: 0 } },
      left: { ...shown, next: { state: { kept: passage }, withheld: 0 } },
      narrowed: { ...withheld, next: { state: {}, withheld: 1 } },
      widened: { ...shown, next: { state: { kept: passage }, withheld: 0 } },
      erased: { ...withheld, next: { state: {}, withheld: 1 } },
    });
  });

  it("keeps a run's evidence past its retention while a key of its workflow names it, so the key still follows the source, not the workflow's grant; and drops it once no key does", async () => {
    const { admin, ada } = await people();
    const word = `ledger${unique().replaceAll(/\W/gu, "")}`;
    const passage = `The ${word} closes on Friday.`;
    const source: SourceRef = { producer: "upload", id: crypto.randomUUID() };
    await sourceSaying(source, passage);
    const workflow = await keepingWorkflow(ada, admin, recalling);
    const runId = await started(ada, workflow.id, {
      entity: unique(),
      ask: word,
      keep: true,
    });
    await ended(ada, workflow.id, runId);
    const read = await evidenceOf(runId);
    const past = new Date(Date.now() + 31 * day);
    await runQuarterHourTasks({}, past);
    const keptPast = await evidenceOf(runId);
    // The workflow's grant to read the Brain revoked: what its run read is
    // the company's still, so is the copy.
    await revokePermission(env, admin, workflow.permissionId);
    const afterRevoking = await keptFor(ada, workflow.id);

    await eraseSource(env, {
      source,
      readers: { kind: "none" },
      reason: "deleted",
    });
    const afterErasure = await keptFor(ada, workflow.id);
    await resetWorkflowState(env, ada, workflow.id);
    await runQuarterHourTasks({}, past);

    expect({
      read: read > 0,
      keptPast: keptPast === read,
      afterRevoking,
      afterErasure,
      afterReset: await evidenceOf(runId),
    }).toStrictEqual({
      read: true,
      keptPast: true,
      afterRevoking: passage,
      afterErasure: "revoked",
      afterReset: 0,
    });
  });

  it("shows a key it can't check now as such, and starts no run that would read it as unset", async () => {
    const { admin, ada } = await people();
    const word = `ledger${unique().replaceAll(/\W/gu, "")}`;
    const source: SourceRef = { producer: "upload", id: crypto.randomUUID() };
    await sourceSaying(source, `The ${word} closes on Friday.`);
    const workflow = await keepingWorkflow(ada, admin, recalling);
    const runId = await started(ada, workflow.id, {
      entity: unique(),
      ask: word,
      keep: true,
    });
    await ended(ada, workflow.id, runId);
    // A pin of the chat behind its run the check can't read: it throws,
    // refusing nothing.
    await env.DB.prepare(
      "INSERT INTO run_chat_sources (run_id, source_id, workspace_id, chat_id, agent_id, person_id) VALUES (?, 'brain-grant', '', '', '', ?)"
    )
      .bind(runId, ada.userId)
      .run();

    const builder = await keptFor(ada, workflow.id);
    const start = await outcome(
      started(ada, workflow.id, {
        entity: unique(),
        ask: unique(),
        keep: false,
      })
    );

    expect({ builder, start }).toStrictEqual({
      builder: "unchecked",
      start: "workflow.state_unchecked",
    });
  });

  it("starts a test run without a key whose run read what is gone: read as unset, counted on its start", async () => {
    const { admin, ada } = await people();
    const word = `ledger${unique().replaceAll(/\W/gu, "")}`;
    const source: SourceRef = { producer: "upload", id: crypto.randomUUID() };
    await sourceSaying(source, `The ${word} closes on Friday.`);
    const workflow = await keepingWorkflow(ada, admin, recalling);
    const runId = await started(ada, workflow.id, {
      entity: unique(),
      ask: word,
      keep: true,
    });
    await ended(ada, workflow.id, runId);
    await eraseSource(env, {
      source,
      readers: { kind: "none" },
      reason: "deleted",
    });
    const { revision } = await workflowDraft(env, ada, workflow.id);
    const test = await startCandidateRun(env, ada, workflow.id, {
      revision,
      args: {
        entity: unique(),
        ask: unique(),
        keep: false,
        carry: true,
        hold: false,
      },
      fixtures: {},
    });
    const frozen = await env.DB.prepare(
      `SELECT snapshots.body FROM workflow_candidate_runs AS runs
        JOIN workflow_state_snapshots AS snapshots ON snapshots.hash = runs.state_hash
        WHERE runs.id = ?`
    )
      .bind(test.runId)
      .first<string>("body");
    const events = await allEvents();
    const startedEvent = events.find(
      (event) =>
        event.action === "workflow.candidate.started" &&
        event.detail?.run === test.runId
    );

    expect({
      state: frozen === null ? null : z.json().parse(JSON.parse(frozen)),
      withheld: startedEvent?.detail?.stateWithheld ?? 0,
    }).toStrictEqual({ state: {}, withheld: 1 });
  });

  it("shows no value whose writer's evidence a release takes while the state is read: the rows and their evidence are one read", async () => {
    const { admin, ada } = await people();
    const word = `ledger${unique().replaceAll(/\W/gu, "")}`;
    const passage = `The ${word} closes on Friday.`;
    const source: SourceRef = { producer: "upload", id: crypto.randomUUID() };
    await sourceSaying(source, passage);
    const workflow = await keepingWorkflow(ada, admin, recalling);
    await ended(
      ada,
      workflow.id,
      await started(ada, workflow.id, {
        entity: unique(),
        ask: word,
        keep: true,
      })
    );
    // Its run past its details, its evidence kept for the key.
    const past = new Date(Date.now() + 31 * day);
    await runQuarterHourTasks({}, past);
    await eraseSource(env, {
      source,
      readers: { kind: "none" },
      reason: "deleted",
    });
    // As the state is read, the key goes and the sweep releases its
    // writer's evidence.
    const { entries } = await readWorkflowState(
      {
        ...env,
        DB: evidenceHeld(env.DB, async () => {
          await resetWorkflowState(env, ada, workflow.id);
          await runQuarterHourTasks({}, new Date(past.getTime() + 15 * 60_000));
        }),
      },
      ada,
      workflow.id
    );

    expect(entries.filter(({ value }) => value === passage)).toStrictEqual([]);
  });

  it("refuses a run that started from a copy once what its writer read is erased: what it sends, keeps and returns", async () => {
    const { admin, ada } = await people();
    const word = `ledger${unique().replaceAll(/\W/gu, "")}`;
    const source: SourceRef = { producer: "upload", id: crypto.randomUUID() };
    await sourceSaying(source, `The ${word} closes on Friday.`);
    const workflow = await keepingWorkflow(ada, admin, recalling);
    const reader = await started(ada, workflow.id, {
      entity: unique(),
      ask: word,
      keep: true,
    });
    await ended(ada, workflow.id, reader);
    // It starts from the copy, waits, and then keeps it changed.
    const carrier = await started(ada, workflow.id, {
      entity: unique(),
      ask: " (seen)",
      keep: true,
      carry: true,
      hold: true,
    });

    await eraseSource(env, {
      source,
      readers: { kind: "none" },
      reason: "deleted",
    });

    const carrierEnded = await ended(ada, workflow.id, carrier);
    const { entries } = await readWorkflowState(env, admin, workflow.id);

    expect({
      carrier: carrierEnded,
      writer: entries.find(({ key }) => key === "kept")?.runId,
      kept: await keptFor(admin, workflow.id),
    }).toStrictEqual({
      carrier: { status: "failed", error: "brain.revoked" },
      writer: reader,
      kept: "revoked",
    });
  });

  it("withholds a key a later run kept changed from a copy once what the copy's writer read is erased, one hop and no more", async () => {
    const { admin, ada } = await people();
    const word = `ledger${unique().replaceAll(/\W/gu, "")}`;
    const passage = `The ${word} closes on Friday.`;
    const source: SourceRef = { producer: "upload", id: crypto.randomUUID() };
    await sourceSaying(source, passage);
    const once = await keepingWorkflow(ada, admin, recalling);
    const twice = await keepingWorkflow(ada, admin, recalling);
    for (const workflow of [once, twice]) {
      // oxlint-disable-next-line no-await-in-loop -- one run after another
      await ended(
        ada,
        workflow.id,
        // oxlint-disable-next-line no-await-in-loop -- as it ran
        await started(ada, workflow.id, {
          entity: unique(),
          ask: word,
          keep: true,
        })
      );
    }
    /** A run of `workflow` keeping what it found with `added` after it. */
    const carried = async (workflow: { id: string }, added: string) => {
      const runId = await started(ada, workflow.id, {
        entity: unique(),
        ask: added,
        keep: true,
        carry: true,
      });
      return await ended(ada, workflow.id, runId);
    };
    await carried(once, " (seen)");
    await carried(twice, " (seen)");
    await carried(twice, " (again)");

    await eraseSource(env, {
      source,
      readers: { kind: "none" },
      reason: "deleted",
    });

    expect({
      once: {
        builder: await keptFor(ada, once.id),
        next: await nextRunReads(ada, once.id),
      },
      // Carried through two further runs and changed on the way: one hop
      // doesn't follow it (decision Q2).
      twice: await keptFor(ada, twice.id),
    }).toStrictEqual({
      once: { builder: "revoked", next: { state: {}, withheld: 1 } },
      twice: `${passage} (seen) (again)`,
    });
  });

  it("lets a run that was never shown a withheld key set it anew: its own value, shown and read by the next run", async () => {
    const { admin, ada } = await people();
    const word = `ledger${unique().replaceAll(/\W/gu, "")}`;
    const source: SourceRef = { producer: "upload", id: crypto.randomUUID() };
    await sourceSaying(source, `The ${word} closes on Friday.`);
    // A keeps a constant after reading the Brain: "notified".
    const workflow = await keepingWorkflow(ada, admin, {
      first: recalling.first,
      keep: '"notified"',
    });
    await ended(
      ada,
      workflow.id,
      await started(ada, workflow.id, {
        entity: unique(),
        ask: word,
        keep: true,
      })
    );
    await eraseSource(env, {
      source,
      readers: { kind: "none" },
      reason: "deleted",
    });
    const withheld = await keptFor(ada, workflow.id);
    // C starts without the key, reads nothing, and keeps "notified" itself.
    const fresh = await started(ada, workflow.id, {
      entity: unique(),
      ask: "",
      keep: true,
      carry: true,
    });
    const freshEnded = await ended(ada, workflow.id, fresh);

    expect({
      withheld,
      fresh: freshEnded,
      freshRead: await evidenceOf(fresh),
      after: await keptFor(ada, workflow.id),
      next: await nextRunReads(ada, workflow.id),
    }).toStrictEqual({
      withheld: "revoked",
      fresh: { status: "completed", error: null },
      freshRead: 0,
      after: "notified",
      next: { state: { kept: "notified" }, withheld: 0 },
    });
  });

  it("hands only how a run ended to its person's Brain when the kept state it started from was set by a run that read the Brain", async () => {
    const { admin, ada } = await people();
    const word = `ledger${unique().replaceAll(/\W/gu, "")}`;
    const source: SourceRef = { producer: "upload", id: crypto.randomUUID() };
    await sourceSaying(source, `The ${word} closes on Friday.`);
    const workflow = await keepingWorkflow(ada, admin, recalling);
    await ended(
      ada,
      workflow.id,
      await started(ada, workflow.id, {
        entity: unique(),
        ask: word,
        keep: true,
      })
    );
    // It reads nothing in the Brain, and returns the copy it started from.
    const carrier = await started(ada, workflow.id, {
      entity: unique(),
      ask: "",
      keep: false,
      carry: true,
    });
    const run = await resourceRunFor(env, ada, workflow.id, carrier);
    await ended(ada, workflow.id, carrier);
    const returned = await resourceRunFor(env, ada, workflow.id, carrier);
    await drainAuditOutboxes(env);
    await relayHandOvers(env);
    await workBrain(env, new Date(Date.now() + 60_000), producersOf(env));
    const kept = await readSourceVersionAs(env, ada.userId, {
      source: { producer: "run", id: carrier },
      version: 1,
    });

    expect({
      started: run.id,
      returnedTheCopy: JSON.stringify(returned.result).includes(word),
      kept: kept?.text,
    }).toStrictEqual({
      started: carrier,
      returnedTheCopy: true,
      kept: "Workflow run completed.",
    });
  });

  it("reads a key's writer and the runs whose state it started from in one snapshot with their evidence: releases landing as the state is read show nothing erased", async () => {
    const { admin, ada } = await people();
    const word = `ledger${unique().replaceAll(/\W/gu, "")}`;
    const passage = `The ${word} closes on Friday.`;
    const source: SourceRef = { producer: "upload", id: crypto.randomUUID() };
    await sourceSaying(source, passage);
    const workflow = await keepingWorkflow(ada, admin, recalling);
    await ended(
      ada,
      workflow.id,
      await started(ada, workflow.id, {
        entity: unique(),
        ask: word,
        keep: true,
      })
    );
    await ended(
      ada,
      workflow.id,
      await started(ada, workflow.id, {
        entity: unique(),
        ask: " (seen)",
        keep: true,
        carry: true,
      })
    );
    const past = new Date(Date.now() + 31 * day);
    await runQuarterHourTasks({}, past);
    await eraseSource(env, {
      source,
      readers: { kind: "none" },
      reason: "deleted",
    });
    // As the state is read, the key goes and two sweeps release the later
    // run and then the run whose copy it started from.
    const { entries } = await readWorkflowState(
      {
        ...env,
        DB: evidenceHeld(env.DB, async () => {
          await resetWorkflowState(env, ada, workflow.id);
          await runQuarterHourTasks({}, new Date(past.getTime() + 15 * 60_000));
          await runQuarterHourTasks({}, new Date(past.getTime() + 30 * 60_000));
        }),
      },
      ada,
      workflow.id
    );

    expect(
      entries.filter(({ value }) =>
        JSON.stringify(value ?? null).includes(word)
      )
    ).toStrictEqual([]);
  });

  it("keeps the evidence of a run another run started from past both runs' retention while a key names the later run, and releases it once none does", async () => {
    const { admin, ada } = await people();
    const word = `ledger${unique().replaceAll(/\W/gu, "")}`;
    const source: SourceRef = { producer: "upload", id: crypto.randomUUID() };
    await sourceSaying(source, `The ${word} closes on Friday.`);
    const workflow = await keepingWorkflow(ada, admin, recalling);
    const reader = await started(ada, workflow.id, {
      entity: unique(),
      ask: word,
      keep: true,
    });
    await ended(ada, workflow.id, reader);
    const carrier = await started(ada, workflow.id, {
      entity: unique(),
      ask: " (seen)",
      keep: true,
      carry: true,
    });
    await ended(ada, workflow.id, carrier);
    const read = await evidenceOf(reader);
    const past = new Date(Date.now() + 31 * day);
    await runQuarterHourTasks({}, past);
    const keptPast = await evidenceOf(reader);
    await eraseSource(env, {
      source,
      readers: { kind: "none" },
      reason: "deleted",
    });
    const afterErasure = await keptFor(ada, workflow.id);
    // Another workflow keeps a key all along: what it keeps holds up no
    // release of this one's.
    const other = await keepingWorkflow(ada, admin, recalling);
    await ended(
      ada,
      other.id,
      await started(ada, other.id, { entity: unique(), ask: "", keep: true })
    );
    await resetWorkflowState(env, ada, workflow.id);
    // The later run's release first, then its writer's, a sweep each.
    await runQuarterHourTasks({}, past);
    await runQuarterHourTasks({}, new Date(past.getTime() + 15 * 60 * 1000));

    expect({
      read: read > 0,
      keptPast: keptPast === read,
      afterErasure,
      afterReset: await evidenceOf(reader),
    }).toStrictEqual({
      read: true,
      keptPast: true,
      afterErasure: "revoked",
      afterReset: 0,
    });
  });

  it("keeps one hop past retention, not the whole chain: a key carried through three runs keeps its last run and that run's writer, and lets the first run's evidence go", async () => {
    const { admin, ada } = await people();
    const word = `ledger${unique().replaceAll(/\W/gu, "")}`;
    const source: SourceRef = { producer: "upload", id: crypto.randomUUID() };
    await sourceSaying(source, `The ${word} closes on Friday.`);
    const workflow = await keepingWorkflow(ada, admin, recalling);
    const first = await started(ada, workflow.id, {
      entity: unique(),
      ask: word,
      keep: true,
    });
    await ended(ada, workflow.id, first);
    const carriers: string[] = [];
    for (const added of [" (b)", " (c)", " (d)"]) {
      // oxlint-disable-next-line no-await-in-loop -- one run after another
      const runId = await started(ada, workflow.id, {
        entity: unique(),
        ask: added,
        keep: true,
        carry: true,
      });
      // oxlint-disable-next-line no-await-in-loop -- each ends first
      await ended(ada, workflow.id, runId);
      carriers.push(runId);
    }
    const read = await evidenceOf(first);
    const past = Date.now() + 31 * day;
    for (let sweep = 0; sweep < 3; sweep += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one sweep after another
      await runQuarterHourTasks({}, new Date(past + sweep * 15 * 60_000));
    }
    const ids = [first, ...carriers];
    const kept = await env.DB.prepare(
      `SELECT run_id FROM kept_run_evidence WHERE run_id IN (SELECT value FROM json_each(?))`
    )
      .bind(JSON.stringify(ids))
      .all<{ run_id: string }>();
    const links = await env.DB.prepare(
      `SELECT run_id, writer_run_id FROM run_state_writers WHERE run_id IN (SELECT value FROM json_each(?))`
    )
      .bind(JSON.stringify(ids))
      .all<{ run_id: string; writer_run_id: string }>();
    const { entries } = await readWorkflowState(env, ada, workflow.id);
    const [, second, third, last] = ids;

    expect({
      read: read > 0,
      firstAfter: await evidenceOf(first),
      kept: kept.results
        .map(({ run_id: id }) => id)
        .toSorted((a, b) => a.localeCompare(b)),
      links: links.results.map(({ run_id: run, writer_run_id: writer }) => [
        run,
        writer,
      ]),
      writer: entries.find(({ key }) => key === "kept")?.runId,
      shown: entries.find(({ key }) => key === "kept")?.withheld ?? "shown",
      second: second === undefined ? 0 : await evidenceOf(second),
    }).toStrictEqual({
      read: true,
      firstAfter: 0,
      kept: [third ?? "", last ?? ""].toSorted((a, b) => a.localeCompare(b)),
      links: [[last, third]],
      writer: last,
      shown: "shown",
      second: 0,
    });
  });

  it("refuses a start whose state names a run whose evidence is gone, as a sweep between its read and its admission leaves it", async () => {
    const { admin, ada } = await people();
    const word = `ledger${unique().replaceAll(/\W/gu, "")}`;
    const source: SourceRef = { producer: "upload", id: crypto.randomUUID() };
    await sourceSaying(source, `The ${word} closes on Friday.`);
    const workflow = await keepingWorkflow(ada, admin, recalling);
    const reader = await started(ada, workflow.id, {
      entity: unique(),
      ask: word,
      keep: true,
    });
    await ended(ada, workflow.id, reader);
    // Its details swept and nothing kept of it, as a release racing the
    // start would leave it.
    await env.DB.prepare(
      "UPDATE workflow_start_receipts SET input = NULL, params = NULL, state_hash = NULL, details_removed_at = ? WHERE id = ?"
    )
      .bind(Date.now(), reader)
      .run();

    await expect(
      outcome(
        started(ada, workflow.id, { entity: unique(), ask: "", keep: false })
      )
    ).resolves.toBe("workflow.start_denied");
  });

  it("checks the runs that set its keys together: what reading the state costs doesn't grow with how many runs set it", async () => {
    const { admin, ada } = await people();
    const word = `ledger${unique().replaceAll(/\W/gu, "")}`;
    const passage = `The ${word} closes on Friday.`;
    const source: SourceRef = { producer: "upload", id: crypto.randomUUID() };
    await sourceSaying(source, passage);
    const keys = Array.from({ length: 12 }, (_, at) => `k${at}`);
    const workflow = await keyedWorkflow(ada, admin, keys);
    /** Runs that each keep what they recalled under one of `some`. */
    const keptBy = async (some: readonly string[]) => {
      for (const which of some) {
        // oxlint-disable-next-line no-await-in-loop -- one run at a time
        const runId = await startWorkflow(
          env,
          { type: "person", person: ada },
          workflow,
          { expected: 1, args: { ask: word, which }, key: unique() }
        );
        // oxlint-disable-next-line no-await-in-loop -- as it ran
        await ended(ada, workflow, runId.runId ?? "");
      }
    };
    await keptBy(keys.slice(0, 2));
    const fewCost = await evidenceCostOf(
      async () => await readWorkflowState(env, ada, workflow)
    );
    await keptBy(keys.slice(2));
    const manyCost = await evidenceCostOf(
      async () => await readWorkflowState(env, ada, workflow)
    );
    const { entries } = await readWorkflowState(env, ada, workflow);

    expect({
      askedTheBrain: fewCost.brainCalls > 0,
      manyCost,
      writers: new Set(entries.map(({ runId }) => runId)).size,
      shown: entries.map(({ value }) => value),
    }).toStrictEqual({
      askedTheBrain: true,
      manyCost: fewCost,
      writers: keys.length,
      shown: keys.map(() => passage),
    });
  });
});
