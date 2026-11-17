import { brainOf } from "@grasp-os/brain-next/contract";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { appFor } from "../src/apps.ts";
import type { Acting } from "../src/auth/identity.ts";
import { erasePersonShared, eraseSource } from "../src/brain-next.ts";
import type { SourceRef } from "../src/brain-next.ts";
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
 * `carry`, it reads nothing in the Brain and keeps `kept` as it found it,
 * as a step carrying a value forward does. Bound by `admin` to a grant of
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
        },
      },
      permissions: { brain: { docs: { contract: key } } },
      state: { kept: { kind: "string" } },
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
          then: [keepingCall("carry", 'state.kept ?? ""')],
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
  args: { entity: string; ask: string; keep: boolean; carry?: boolean }
): Promise<string> => {
  const { runId } = await startWorkflow(
    env,
    { type: "person", person: by },
    id,
    { expected: 1, args: { carry: false, ...args }, key: unique() }
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
    const before = {
      builder: await keptFor(ben, workflow.id),
      admin: await keptFor(admin, workflow.id),
      next: await nextRunReads(ben, workflow.id),
    };

    await erasePersonShared(env, {
      personId: anna.personId,
      email: anna.address,
    });

    expect({
      run,
      before,
      after: {
        builder: await keptFor(ben, workflow.id),
        admin: await keptFor(admin, workflow.id),
        next: await nextRunReads(ben, workflow.id),
      },
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

  it("keeps the run that read a value as its writer when a later run that read nothing keeps it again unchanged, so the value still follows its source", async () => {
    const { admin, ada } = await people();
    const word = `ledger${unique().replaceAll(/\W/gu, "")}`;
    const passage = `The ${word} closes on Friday.`;
    const source: SourceRef = { producer: "upload", id: crypto.randomUUID() };
    await sourceSaying(source, passage);
    const workflow = await keepingWorkflow(ada, admin, recalling);
    const reader = await started(ada, workflow.id, {
      entity: unique(),
      ask: word,
      keep: true,
    });
    await ended(ada, workflow.id, reader);
    // A run that reads nothing in the Brain and keeps `kept` as it found
    // it: the same value, written again.
    const carrier = await started(ada, workflow.id, {
      entity: unique(),
      ask: unique(),
      keep: true,
      carry: true,
    });
    const carried = await ended(ada, workflow.id, carrier);
    const before = await readWorkflowState(env, ada, workflow.id);

    await eraseSource(env, {
      source,
      readers: { kind: "none" },
      reason: "deleted",
    });
    const after = await readWorkflowState(env, ada, workflow.id);

    expect({
      carried,
      carrierRead: await evidenceOf(carrier),
      writer: before.entries.find(({ key }) => key === "kept")?.runId,
      after: await keptFor(ada, workflow.id),
      // What it takes counts no withheld value, so tells no length.
      bytes: {
        before: before.bytes > 0,
        after: after.bytes,
      },
      next: await nextRunReads(ada, workflow.id),
    }).toStrictEqual({
      carried: { status: "completed", error: null },
      carrierRead: 0,
      writer: reader,
      after: "revoked",
      bytes: { before: true, after: 0 },
      next: { state: {}, withheld: 1 },
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
      args: { entity: unique(), ask: unique(), keep: false, carry: true },
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
