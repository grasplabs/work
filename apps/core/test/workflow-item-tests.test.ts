/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { v } from "@grasp-os/sdk";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import type {
  WorkflowCandidateRun,
  WorkflowItemTest,
} from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { publishCatalogContract } from "../src/workflow-catalog.ts";
import { editWorkflowDraft, workflowDraft } from "../src/workflow-drafts.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
  shareWorkflowResource,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import {
  candidateRunFor,
  candidateRunTrace,
  sweepCandidateRuns,
} from "../src/workflows/candidate-runs.ts";
import { itemTestFor, startItemTest } from "../src/workflows/item-tests.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { allEvents } from "./audit-events.ts";
import { outcome, unique } from "./sign-in.ts";

// A test of a draft's checkpoint over recent real items
// (workflows/item-tests.ts), from its threat model: each item runs as a
// test run that calls nothing, a write least of all; it takes only runs
// whose details the tester sees, with their input still kept; what it
// ran on is its tester's alone to read; and it is recorded, item by item,
// then swept with the test runs.

/** A member of the organization with `role`, as their session has them. */
const person = async (role: Role): Promise<Identity> => {
  const userId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO organizations (id, name, slug, created_at) VALUES ('organization', 'Acme', 'acme', ?)"
    ).bind(Date.now()),
    env.DB.prepare(
      "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)"
    ).bind(userId, "Person", `${userId}@acme.test`, Date.now(), Date.now()),
    env.DB.prepare(
      "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, 'organization', ?, ?, ?)"
    ).bind(crypto.randomUUID(), userId, role, Date.now()),
  ]);
  return {
    userId,
    email: `${userId}@acme.test`,
    name: "Person",
    role,
    teams: [],
    staff: false,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
};

const objectSchema = (properties: Record<string, unknown>) => ({
  format: "json",
  document: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});

/** A definition of `name` at `version`: its bindings, input and tasks. */
const definitionOf = (
  name: string,
  version: string,
  {
    bindings = {},
    who = { type: "string" },
    tasks,
  }: {
    bindings?: Record<string, unknown>;
    who?: Record<string, unknown>;
    tasks: unknown[];
  }
): string =>
  JSON.stringify({
    document: {
      dsl: "1.0.3",
      namespace: workflowNamespace,
      name,
      version,
      title: name,
      metadata: {
        grasp: { profile: "grasp-open-workflow/1", params: {}, bindings },
      },
    },
    input: { schema: objectSchema({ who }) },
    output: { schema: objectSchema({ status: { type: "string" } }) },
    do: tasks,
  });

/** What version 1 does with an item: says who it was for. */
const echo = [{ echo: { set: { status: "${ $workflow.input.who }" } } }];

/** The descriptor of an object of string `fields`, as the catalog holds one. */
const descriptor = (fields: string[]): string =>
  JSON.stringify(
    v.object(Object.fromEntries(fields.map((field) => [field, v.string()])))
      .descriptor
  );

/** A connector contract sending mail, published by `admin`: its key. */
const mailContract = async (admin: Identity): Promise<string> => {
  const key = `connector-${unique()}`;
  await publishCatalogContract(env, admin, {
    key,
    kind: "connector",
    operations: {
      "mail.send": {
        input: descriptor(["to", "subject"]),
        output: descriptor(["messageId"]),
      },
    },
  });
  return key;
};

/** The draft's way with an item: it mails who it is for, through `mail`. */
const mailing = (key: string) => ({
  bindings: { mail: { kind: "connector", contract: key } },
  tasks: [
    {
      send: {
        call: "grasp.connector",
        with: {
          binding: "mail",
          operation: "mail.send",
          arguments: { to: "${ $workflow.input.who }", subject: "Hello" },
        },
        output: {
          as: '${ {status: ($workflow.input.who + " " + .messageId)} }',
        },
      },
    },
  ],
});

/**
 * A workflow of `by`'s, version 1 published (`echo`), and its draft saved
 * from `draft` as version 2.0.0: the draft's checked revision.
 */
const workflowOf = async (
  by: Identity,
  draft: Parameters<typeof definitionOf>[2]
) => {
  const workflow = await createWorkflowResource(env, by, `items-${unique()}`);
  await publishWorkflowVersion(env, by, workflow.id, {
    definition: definitionOf(workflow.name, "1.0.0", { tasks: echo }),
    basedOn: null,
  });
  const { revision: base } = await workflowDraft(env, by, workflow.id);
  const saved = await editWorkflowDraft(env, by, workflow.id, {
    expectedRevision: base,
    source: definitionOf(workflow.name, "2.0.0", draft),
    modules: {},
  });
  expect(saved.problems).toStrictEqual([]);
  return { workflow, revision: saved.revision };
};

/** Starts version 1 of workflow `id` for `by` on `who`, and waits for its end. */
const ranFor = async (
  by: Identity,
  id: string,
  who: string
): Promise<string> => {
  const { runId } = await startWorkflow(
    env,
    { type: "person", person: by },
    id,
    { version: 1, input: { who }, key: unique() }
  );
  if (runId === null) {
    throw new Error("The start made a run");
  }
  await vi.waitFor(
    async () => {
      const run = await resourceRunFor(env, by, id, runId);
      expect(run.endedAt).not.toBeNull();
    },
    { timeout: 30_000, interval: 100 }
  );
  return runId;
};

/** Test `testId` of workflow `id` once every item that ran ended. */
const settled = async (
  by: Identity,
  id: string,
  testId: string
): Promise<WorkflowItemTest> =>
  await vi.waitFor(
    async () => {
      const test = await itemTestFor(env, by, id, testId);
      const going = test.items.some(
        ({ run }) => run?.status === "starting" || run?.status === "running"
      );
      if (going) {
        throw new Error(`Test ${testId} is still going`);
      }
      return test;
    },
    { timeout: 30_000, interval: 100 }
  );

/** How an item's test run ended: its output, or its failure's code. */
const endOf = (run: WorkflowCandidateRun) =>
  run.status === "completed"
    ? { status: run.status, output: run.output }
    : { status: run.status, code: run.error?.code };

/** Each item of `test`: the run it took, and how the draft did on it. */
const resultsOf = (test: WorkflowItemTest) =>
  test.items.map(({ sourceRunId, sourceStatus, run, refusal }) => ({
    sourceRunId,
    sourceStatus,
    ...(run === null ? { refusal } : endOf(run)),
  }));

/** Starts a test for `by` of workflow `id`'s draft: the test's ID. */
const testStarted = async (
  by: Identity,
  id: string,
  input: Record<string, unknown>
): Promise<string> => {
  const { id: testId } = await startItemTest(env, by, id, input);
  return testId;
};

/** What the audit log says any call of test run `runId` reached. */
const callsOf = async (runId: string) => {
  const events = await allEvents();
  return events.filter(
    ({ action, target, detail }) =>
      (target?.id === runId &&
        (action === "workflow.run.called" ||
          action === "workflow.run.call_refused")) ||
      (action === "connection.call" && detail?.run === runId)
  );
};

/** The fixtures every test here starts with: the mail is never sent. */
const held = { mail: { output: { messageId: "held" } } };

describe("a test of a draft over recent real items", () => {
  it("runs the draft once on each of the tester's newest runs, newest first, every call answered from its fixtures and none made", async () => {
    const admin = await person("admin");
    const by = await person("builder");
    const key = await mailContract(admin);
    const { workflow, revision } = await workflowOf(by, mailing(key));
    await ranFor(by, workflow.id, "Ada");
    const grace = await ranFor(by, workflow.id, "Grace");
    const linus = await ranFor(by, workflow.id, "Linus");

    const started = await startItemTest(env, by, workflow.id, {
      revision,
      items: 2,
      fixtures: held,
    });
    const test = await settled(by, workflow.id, started.id);
    const runIds = test.items.flatMap(({ run }) => (run ? [run.id] : []));
    const calls = await Promise.all(runIds.map(callsOf));
    const traces = await Promise.all(
      runIds.map(
        async (runId) => await candidateRunTrace(env, by, workflow.id, runId)
      )
    );

    expect({
      draftRevision: test.draftRevision,
      results: resultsOf(test),
      calls: calls.flat(),
      steps: traces.map(({ steps }) =>
        steps.map(({ task, state }) => `${task} ${state}`)
      ),
    }).toStrictEqual({
      draftRevision: revision,
      results: [
        {
          sourceRunId: linus,
          sourceStatus: "completed",
          status: "completed",
          output: { status: "Linus held" },
        },
        {
          sourceRunId: grace,
          sourceStatus: "completed",
          status: "completed",
          output: { status: "Grace held" },
        },
      ],
      calls: [],
      steps: [["send reached"], ["send reached"]],
    });
  });

  it("records an item the draft refuses, or that has no answer for a call, and runs the rest", async () => {
    const by = await person("builder");
    const admin = await person("admin");
    const key = await mailContract(admin);
    const { workflow, revision } = await workflowOf(by, {
      ...mailing(key),
      who: { type: "string", maxLength: 4 },
    });
    const ada = await ranFor(by, workflow.id, "Ada");
    const grace = await ranFor(by, workflow.id, "Grace");

    const refused = await settled(
      by,
      workflow.id,
      await testStarted(by, workflow.id, { revision, fixtures: held })
    );
    const unanswered = await settled(
      by,
      workflow.id,
      await testStarted(by, workflow.id, { revision, fixtures: {} })
    );

    expect({
      refused: resultsOf(refused),
      unanswered: resultsOf(unanswered),
    }).toStrictEqual({
      refused: [
        {
          sourceRunId: grace,
          sourceStatus: "completed",
          refusal: "workflow.start_invalid",
        },
        {
          sourceRunId: ada,
          sourceStatus: "completed",
          status: "completed",
          output: { status: "Ada held" },
        },
      ],
      unanswered: [
        {
          sourceRunId: grace,
          sourceStatus: "completed",
          refusal: "workflow.start_invalid",
        },
        {
          sourceRunId: ada,
          sourceStatus: "completed",
          status: "failed",
          code: "workflow.candidate_unfixtured",
        },
      ],
    });
  });

  it("takes only runs whose details the tester sees: a builder's own, every run for an admin", async () => {
    const owner = await person("builder");
    const other = await person("builder");
    const admin = await person("admin");
    const { workflow, revision } = await workflowOf(owner, { tasks: echo });
    await shareWorkflowResource(env, owner, workflow.id, {
      type: "person",
      id: other.userId,
      role: "builder",
    });
    const mine = await ranFor(owner, workflow.id, "Ada");
    const theirs = await ranFor(other, workflow.id, "Grace");

    const sources = async (by: Identity) => {
      const { items } = await startItemTest(env, by, workflow.id, {
        revision,
        fixtures: {},
      });
      return items.map(({ sourceRunId }) => sourceRunId);
    };

    expect({
      owner: await sources(owner),
      other: await sources(other),
      admin: await sources(admin),
    }).toStrictEqual({
      owner: [mine],
      other: [theirs],
      admin: [theirs, mine],
    });
  });

  it("takes no run whose retention is over", async () => {
    const by = await person("builder");
    const { workflow, revision } = await workflowOf(by, { tasks: echo });
    await ranFor(by, workflow.id, "Ada");
    // Past the 30 days its details are kept.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 31 * 24 * 60 * 60 * 1000);
    let refused: unknown;
    try {
      refused = await outcome(
        startItemTest(env, by, workflow.id, {
          revision,
          fixtures: {},
        })
      );
    } finally {
      vi.useRealTimers();
    }
    expect(refused).toBe("workflow.item_test_empty");
  });

  it("is its tester's alone: no other builder reads it or the runs of its items, and a user starts none", async () => {
    const by = await person("builder");
    const other = await person("builder");
    const user = await person("user");
    const { workflow, revision } = await workflowOf(by, { tasks: echo });
    await shareWorkflowResource(env, by, workflow.id, {
      type: "person",
      id: other.userId,
      role: "builder",
    });
    await shareWorkflowResource(env, by, workflow.id, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    await ranFor(by, workflow.id, "Ada");
    const test = await startItemTest(env, by, workflow.id, {
      revision,
      fixtures: {},
    });
    const [item] = test.items;
    if (item?.run === null || item?.run === undefined) {
      throw new Error("The item ran");
    }
    const runId = item.run.id;
    const tester = await candidateRunFor(env, by, workflow.id, runId);

    expect({
      test: await outcome(itemTestFor(env, other, workflow.id, test.id)),
      run: await outcome(candidateRunFor(env, other, workflow.id, runId)),
      trace: await outcome(candidateRunTrace(env, other, workflow.id, runId)),
      tester: tester.id,
      user: await outcome(
        startItemTest(env, user, workflow.id, { revision, fixtures: {} })
      ),
    }).toStrictEqual({
      test: "workflow.item_test_unavailable",
      run: "workflow.candidate_unavailable",
      trace: "workflow.candidate_unavailable",
      tester: runId,
      user: "role.forbidden",
    });
  });

  it("is audited without its input, its rows never change, and it goes with its test runs after a week", async () => {
    const by = await person("builder");
    const { workflow, revision } = await workflowOf(by, { tasks: echo });
    await ranFor(by, workflow.id, "Ada");
    const test = await settled(
      by,
      workflow.id,
      await testStarted(by, workflow.id, { revision, fixtures: {} })
    );
    const events = await allEvents();
    const entries = events.filter(
      ({ action, detail }) =>
        action === "workflow.item_test.started" && detail?.test === test.id
    );
    // The trigger's refusal, in D1's words.
    const kept =
      "Error: D1_ERROR: workflow_item_tests record what happened: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)";
    const changed = await outcome(
      env.DB.prepare(
        "UPDATE workflow_item_tests SET source_run_id = 'another' WHERE test_id = ?"
      )
        .bind(test.id)
        .run()
    );
    await sweepCandidateRuns(env, new Date(Date.now() + 8 * 24 * 3_600_000));

    expect({
      entries: entries.map(({ actor, detail }) => ({ actor, detail })),
      changed,
      after: await outcome(itemTestFor(env, by, workflow.id, test.id)),
    }).toStrictEqual({
      entries: [
        {
          actor: { type: "person", userId: by.userId },
          detail: {
            test: test.id,
            candidate: true,
            revision,
            items: 1,
            started: 1,
          },
        },
      ],
      changed: kept,
      after: "workflow.item_test_unavailable",
    });
  });
});
