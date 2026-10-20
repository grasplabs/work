/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { v } from "@grasp-os/sdk";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import {
  maxCandidateFixtureBytes,
  maxCandidateLifetimeMs,
  maxKeptCandidateRuns,
  maxLiveCandidateRuns,
  workflowNamespace,
} from "@grasp-os/shared/workflow-resources";
import type { WorkflowCandidateRun } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { queueOrphanedReservations } from "../src/release-retention.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import { editWorkflowDraft, workflowDraft } from "../src/workflow-drafts.ts";
import { setWorkflowParams } from "../src/workflow-params.ts";
import {
  createWorkflowResource,
  deleteWorkflowResource,
  publishWorkflowVersion,
  shareWorkflowResource,
} from "../src/workflow-resources.ts";
import {
  candidateRunFor,
  startCandidateRun,
  sweepCandidateRuns,
  terminateCandidateRun,
} from "../src/workflows/candidate-runs.ts";
import { runEngine } from "../src/workflows/engine.ts";
import { allEvents } from "./audit-events.ts";
import { withCpuKills } from "./cpu-kills.ts";
import { whileEngineRefuses } from "./runs.ts";
import { outcome, unique } from "./sign-in.ts";

// Test runs of a workflow's draft checkpoint (workflows/candidate-runs.ts),
// from their threat model: a test run makes no call of any kind, a call
// with no answer fails it, its parameters are never the values stored on
// the workflow (a sensitive one above all), it runs only the checkpoint it
// names, verified, starts nothing else, and only builders start or read
// one.

const identityOf = (userId: string, role: Role, staff = false): Identity => ({
  userId,
  email: `${userId}@acme.test`,
  name: "Person",
  role,
  teams: [],
  staff,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
});

/** A member of the organization with `role`, as their session has them. */
const person = async (role: Role, staff = false): Promise<Identity> => {
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
  return identityOf(userId, role, staff);
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

/** A definition of `name`: its bindings, parameters and tasks. */
const definitionOf = (
  name: string,
  {
    bindings = {},
    params = {},
    tasks,
  }: {
    bindings?: Record<string, unknown>;
    params?: Record<string, unknown>;
    tasks: unknown[];
  }
): string =>
  JSON.stringify({
    document: {
      dsl: "1.0.3",
      namespace: workflowNamespace,
      name,
      version: "1.0.0",
      title: name,
      metadata: {
        grasp: { profile: "grasp-open-workflow/1", params, bindings },
      },
    },
    input: { schema: objectSchema({ who: { type: "string" } }) },
    output: { schema: objectSchema({ status: { type: "string" } }) },
    do: tasks,
  });

type Definition = Parameters<typeof definitionOf>[1];

/**
 * A workflow of `by`'s whose draft holds `definition` (and `modules`),
 * checked: its revision. With `publish`, version 1 is published from it
 * first, so its parameters can be set.
 */
const drafted = async (
  by: Identity,
  definition: Definition,
  {
    modules = {},
    publish = false,
  }: { modules?: Record<string, string>; publish?: boolean } = {}
) => {
  const workflow = await createWorkflowResource(env, by, `test-${unique()}`);
  const source = definitionOf(workflow.name, definition);
  if (publish) {
    await publishWorkflowVersion(env, by, workflow.id, {
      definition: source,
      basedOn: null,
      modules,
    });
  }
  const { revision: base } = await workflowDraft(env, by, workflow.id);
  const saved = await editWorkflowDraft(env, by, workflow.id, {
    expectedRevision: base,
    source,
    modules,
  });
  expect(saved.problems).toStrictEqual([]);
  return { workflow, revision: saved.revision };
};

/** Test run `runId` of workflow `id` once it ended, as `by` reads it. */
const ended = async (
  by: Identity,
  id: string,
  runId: string
): Promise<WorkflowCandidateRun> =>
  await vi.waitFor(
    async () => {
      const run = await candidateRunFor(env, by, id, runId);
      if (run.status === "starting" || run.status === "running") {
        throw new Error(`Test run ${runId} is ${run.status}`);
      }
      return run;
    },
    { timeout: 20_000, interval: 100 }
  );

/** How run `run` ended: its status, and its output or error code. */
const endOf = (run: WorkflowCandidateRun) =>
  run.status === "completed"
    ? { status: run.status, output: run.output }
    : { status: run.status, code: run.error?.code };

/** What the audit log says any call of run `runId` reached. */
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

/** The descriptor of an object of string `fields`, as the catalog holds one. */
const descriptor = (fields: Record<string, string>): string =>
  JSON.stringify(
    v.object(
      Object.fromEntries(Object.keys(fields).map((name) => [name, v.string()]))
    ).descriptor
  );

/** `ms` from now. */
const later = (ms: number): Date => new Date(Date.now() + ms);

/** A count of `sql`'s rows, bound to `values`. */
const countOf = async (sql: string, ...values: string[]): Promise<number> => {
  const row = await env.DB.prepare(sql)
    .bind(...values)
    .first<{ n: number }>();
  return row?.n ?? 0;
};

/**
 * Runs `update` on a row the database's `trigger` keeps from changing, as
 * only a write around the platform could: the trigger dropped and put back
 * in the same transaction.
 */
const aroundTrigger = async (
  trigger: string,
  update: D1PreparedStatement
): Promise<void> => {
  const kept = await env.DB.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?"
  )
    .bind(trigger)
    .first<{ sql: string }>();
  if (kept === null) {
    throw new Error(`No trigger ${trigger}`);
  }
  await env.DB.batch([
    env.DB.prepare(`DROP TRIGGER ${trigger}`),
    update,
    env.DB.prepare(kept.sql),
  ]);
};

/** A catalog contract of `kind` published by `admin`: its key. */
const contract = async (
  admin: Identity,
  kind: "connector" | "operation" | "model" | "knowledge" | "template"
): Promise<string> => {
  const key = `${kind}-${unique()}`;
  if (kind === "connector") {
    await publishCatalogContract(env, admin, {
      key,
      kind,
      operations: {
        "mail.send": {
          input: descriptor({ to: "string", subject: "string" }),
          output: descriptor({ messageId: "string" }),
        },
      },
    });
  } else if (kind === "operation") {
    await publishCatalogContract(env, admin, {
      key,
      kind,
      input: descriptor({ who: "string" }),
      output: descriptor({ greeting: "string" }),
    });
  } else {
    await publishCatalogContract(env, admin, { key, kind });
  }
  return key;
};

/** A task sending mail through binding `mail`, its subject `subject`. */
const send = (subject = "Hello") => ({
  send: {
    call: "grasp.connector",
    with: {
      binding: "mail",
      operation: "mail.send",
      arguments: { to: "${ $workflow.input.who }", subject },
    },
    output: { as: "${ {status: .messageId} }" },
  },
});

/** A task looking up through binding `lookup`. */
const lookUp = {
  look: {
    call: "grasp.operation",
    with: {
      binding: "lookup",
      arguments: { who: "${ $workflow.input.who }" },
    },
    output: { as: "${ {status: .greeting} }" },
  },
};

/** A task asking binding `summary` to greet. */
const greet = {
  greet: {
    call: "grasp.model",
    with: {
      binding: "summary",
      instructions: "Greet them.",
      input: { who: "${ $workflow.input.who }" },
      outputSchema: objectSchema({ line: { type: "string" } }),
    },
    output: { as: "${ {status: .line} }" },
  },
};

/** The module of action `look`, reading `docs` and `letter`. */
const lookModule = `import { action, resource, v } from "@grasp-os/sdk/action";

export const look = action({
  args: { doc: v.string() },
  returns: v.object({ status: v.string() }),
  uses: [resource.knowledge("docs", { operations: ["read"] }), resource.template("letter")],
  handler: async (ctx, args) => {
    if (args.doc === "letter") {
      const letter = await ctx.resources.letter.read();
      return { status: JSON.stringify(letter.content) };
    }
    const found = await ctx.resources.docs.read({ id: args.doc });
    return { status: found.title };
  },
});
`;

/** The module of action `notify`, sending mail through `mail`. */
const notifyModule = `import { action, resource, v } from "@grasp-os/sdk/action";

export const notify = action({
  args: { to: v.string() },
  returns: v.object({ status: v.string() }),
  uses: [resource.connector("mail", { operations: ["mail.send"] })],
  handler: async (ctx, args) => {
    const sent = await ctx.resources.mail.call("mail.send", { to: args.to, subject: "Hello" });
    return { status: JSON.stringify(sent) };
  },
});
`;

/** A definition calling action `notify`, which sends through `mail`. */
const notifying = (key: string): Definition => ({
  bindings: {
    notify: { kind: "operation", contract: "local:code/notify.ts#notify" },
    mail: { kind: "connector", contract: key },
  },
  tasks: [
    {
      notify: {
        call: "grasp.operation",
        with: {
          binding: "notify",
          arguments: { to: "${ $workflow.input.who }" },
        },
      },
    },
  ],
});

/** A definition calling action `look`, which reads Knowledge or a template. */
const reading = (keys: {
  knowledge: string;
  template: string;
}): Definition => ({
  bindings: {
    look: { kind: "operation", contract: "local:code/look.ts#look" },
    docs: { kind: "knowledge", contract: keys.knowledge },
    letter: { kind: "template", contract: keys.template },
  },
  tasks: [
    {
      look: {
        call: "grasp.operation",
        with: {
          binding: "look",
          arguments: { doc: "${ $workflow.input.who }" },
        },
      },
    },
  ],
});

describe("test runs of a workflow's draft", () => {
  it("answers each kind of call from its fixture, checked as a real answer is, and fails at a call it has no answer for, calling nothing", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const keys = {
      connector: await contract(admin, "connector"),
      operation: await contract(admin, "operation"),
      model: await contract(admin, "model"),
      knowledge: await contract(admin, "knowledge"),
      template: await contract(admin, "template"),
    };
    const direct: {
      kind: string;
      definition: Definition;
      alias: string;
      answer: Record<string, string>;
      status: string;
    }[] = [
      {
        kind: "connector",
        definition: {
          bindings: { mail: { kind: "connector", contract: keys.connector } },
          tasks: [send()],
        },
        alias: "mail",
        answer: { messageId: "m-1" },
        status: "m-1",
      },
      {
        kind: "operation",
        definition: {
          bindings: { lookup: { kind: "operation", contract: keys.operation } },
          tasks: [lookUp],
        },
        alias: "lookup",
        answer: { greeting: "Hi Ada" },
        status: "Hi Ada",
      },
      {
        kind: "model",
        definition: {
          bindings: { summary: { kind: "model", contract: keys.model } },
          tasks: [greet],
        },
        alias: "summary",
        answer: { line: "Hello, Ada" },
        status: "Hello, Ada",
      },
    ];
    const read = { knowledge: keys.knowledge, template: keys.template };
    const throughAction = [
      {
        kind: "knowledge",
        who: "doc-1",
        alias: "docs",
        answer: { id: "doc-1", title: "Leave policy", text: "…" },
        status: "Leave policy",
      },
      {
        kind: "template",
        who: "letter",
        alias: "letter",
        answer: { content: { greeting: "Dear" } },
        status: JSON.stringify({ greeting: "Dear" }),
      },
    ] as const;
    const cases = [
      ...direct.map((each) => ({
        ...each,
        who: "Ada",
        modules: {},
      })),
      ...throughAction.map((each) => ({
        ...each,
        definition: reading(read),
        // The action itself is the workflow's own code: only its reads
        // are calls.
        modules: { "code/look.ts": lookModule },
      })),
      // A connector call an action makes, answered as a task's is.
      {
        kind: "connector (an action's)",
        who: "Ada",
        alias: "mail",
        answer: { messageId: "m-2" },
        status: JSON.stringify({ messageId: "m-2" }),
        definition: notifying(keys.connector),
        modules: { "code/notify.ts": notifyModule },
      },
    ];
    const results = await Promise.all(
      cases.map(async ({ kind, definition, modules, alias, answer, who }) => {
        const { workflow, revision } = await drafted(ada, definition, {
          modules,
        });
        const run = async (fixtures: Record<string, unknown>) => {
          const { runId } = await startCandidateRun(env, ada, workflow.id, {
            revision,
            input: { who },
            fixtures,
          });
          return { runId, run: await ended(ada, workflow.id, runId) };
        };
        const answered = await run({ [alias]: { output: answer } });
        const unanswered = await run({});
        // An answer a real call of it would refuse, refused the same way.
        const shaped = direct.some((each) => each.kind === kind);
        const misshapen = shaped
          ? await run({ [alias]: { output: { wrong: 1 } } })
          : undefined;
        return {
          kind,
          answered: endOf(answered.run),
          unanswered: endOf(unanswered.run),
          misshapen: misshapen === undefined ? undefined : endOf(misshapen.run),
          // Neither went out, nor was refused on its way: no call was made.
          calls: [
            ...(await callsOf(answered.runId)),
            ...(await callsOf(unanswered.runId)),
          ],
        };
      })
    );
    expect(results).toStrictEqual(
      cases.map(({ kind, status }) => ({
        kind,
        answered: { status: "completed", output: { status } },
        unanswered: { status: "failed", code: "workflow.candidate_unfixtured" },
        misshapen: direct.some((each) => each.kind === kind)
          ? { status: "failed", code: "workflow.call_invalid" }
          : undefined,
        calls: [],
      }))
    );
  });

  it("refuses a model request a real call would refuse, its fixture notwithstanding", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const key = await contract(admin, "model");
    const { workflow, revision } = await drafted(ada, {
      bindings: { summary: { kind: "model", contract: key } },
      tasks: [
        {
          greet: {
            ...greet.greet,
            with: { ...greet.greet.with, maxOutputTokens: "${ 0 }" },
          },
        },
      ],
    });
    const { runId } = await startCandidateRun(env, ada, workflow.id, {
      revision,
      input: { who: "Ada" },
      fixtures: { summary: { output: { line: "Hello" } } },
    });
    expect(endOf(await ended(ada, workflow.id, runId))).toStrictEqual({
      status: "failed",
      code: "workflow.call_invalid",
    });
  });

  it("runs with the parameters its start gives, else the defaults, never the values stored on the workflow, a sensitive one above all", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const key = await contract(admin, "connector");
    const { workflow, revision } = await drafted(
      ada,
      {
        bindings: { mail: { kind: "connector", contract: key } },
        params: {
          greeting: {
            schema: { type: "string", maxLength: 200 },
            label: "Greeting",
            default: "Hello",
            sensitive: false,
          },
          token: {
            schema: { type: "string", maxLength: 64 },
            label: "Token",
            default: "none",
            sensitive: true,
          },
        },
        // The token reaches the call as a binding argument, the only place
        // a sensitive parameter may go; the greeting comes back as output.
        tasks: [
          {
            send: {
              call: "grasp.connector",
              with: {
                binding: "mail",
                operation: "mail.send",
                arguments: { to: "Ada", subject: "${ $params.token }" },
              },
            },
          },
          { finish: { set: { status: "${ $params.greeting }" } } },
        ],
      },
      { publish: true }
    );
    const secret = `secret-${unique()}`;
    await setWorkflowParams(env, ada, workflow.id, {
      values: { greeting: "Stored", token: secret },
      expectedRevision: 0,
    });
    const run = async (params?: Record<string, unknown>) => {
      const { runId } = await startCandidateRun(env, ada, workflow.id, {
        revision,
        input: { who: "Ada" },
        ...(params === undefined ? {} : { params }),
        fixtures: { mail: { output: { messageId: "m-1" } } },
      });
      return { runId, run: await ended(ada, workflow.id, runId) };
    };
    const defaults = await run();
    const given = await run({ greeting: "Given" });
    const rows = await env.DB.prepare(
      "SELECT params FROM workflow_candidate_runs WHERE id IN (?, ?) ORDER BY created_at"
    )
      .bind(defaults.runId, given.runId)
      .all<{ params: string }>();
    const engine = await Promise.all(
      [defaults.runId, given.runId].map(
        async (id) => await runEngine(env).status(id)
      )
    );
    const kept = JSON.stringify({
      rows: rows.results,
      engine,
      events: await allEvents(),
      runs: [defaults.run, given.run],
    });
    expect({
      defaults: endOf(defaults.run),
      given: endOf(given.run),
      frozen: rows.results.map(({ params }): unknown => JSON.parse(params)),
      secretKept: kept.includes(secret),
    }).toStrictEqual({
      defaults: { status: "completed", output: { status: "Hello" } },
      given: { status: "completed", output: { status: "Given" } },
      // What the draft's code was given: the defaults, or the start's.
      frozen: [
        { greeting: "Hello", token: "none" },
        { greeting: "Given", token: "none" },
      ],
      // Nothing of a test run, nor the audit log, ever holds it.
      secretKept: false,
    });
  });

  it("starts no run of a version, schedule or trigger, and a draft that would start one never passes to be run", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const key = await contract(admin, "operation");
    const { workflow, revision } = await drafted(ada, {
      bindings: { lookup: { kind: "operation", contract: key } },
      tasks: [lookUp],
    });
    const { runId } = await startCandidateRun(env, ada, workflow.id, {
      revision,
      input: { who: "Ada" },
      fixtures: { lookup: { output: { greeting: "Hi" } } },
    });
    const run = await ended(ada, workflow.id, runId);
    const { results: admitted } = await env.DB.prepare(
      "SELECT DISTINCT resource FROM run_lineage_attempts WHERE run_id = ?"
    )
      .bind(runId)
      .all<{ resource: string }>();
    const count = async (table: string, column: string) =>
      await countOf(
        `SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`,
        workflow.id
      );
    // A draft whose task would start another run, or sleep for a schedule,
    // names a call no workflow has: it never becomes a checkpoint.
    const starting = await createWorkflowResource(env, ada, `test-${unique()}`);
    const { revision: base } = await workflowDraft(env, ada, starting.id);
    const saved = await editWorkflowDraft(env, ada, starting.id, {
      expectedRevision: base,
      source: definitionOf(starting.name, {
        tasks: [
          {
            again: {
              call: "grasp.start",
              with: { workflow: workflow.id, input: { who: "Ada" } },
            },
          },
        ],
      }),
      modules: {},
    });
    expect({
      end: endOf(run),
      runs: await count("workflow_resource_runs", "workflow_resource_id"),
      receipts: await count("workflow_start_receipts", "workflow_resource_id"),
      // Admitted in its workflow's test runs' own queue, never its runs'.
      admitted: admitted.map(({ resource }) => resource),
      startingChecked: saved.checkpoint?.revision === saved.revision,
      startingRun: await outcome(
        startCandidateRun(env, ada, starting.id, {
          revision: saved.revision,
          input: { who: "Ada" },
          fixtures: {},
        })
      ),
    }).toStrictEqual({
      end: { status: "completed", output: { status: "Hi" } },
      runs: 0,
      receipts: 0,
      admitted: [`candidate:${workflow.id}`],
      startingChecked: false,
      startingRun: "workflow.draft_unchecked",
    });
  });

  it("runs only the latest checked revision, as it named it, and refuses a build changed since it started", async () => {
    const ada = await person("builder");
    const { workflow, revision } = await drafted(ada, {
      tasks: [
        { hold: { wait: "PT1S" } },
        { finish: { set: { status: "${ $workflow.input.who }" } } },
      ],
    });
    // A later revision that doesn't pass: the checkpoint stays, but is no
    // longer the latest, so neither revision runs.
    const draft = await workflowDraft(env, ada, workflow.id);
    await editWorkflowDraft(env, ada, workflow.id, {
      expectedRevision: draft.revision,
      source: "{",
      modules: {},
    });
    const stale = await outcome(
      startCandidateRun(env, ada, workflow.id, {
        revision,
        input: { who: "Ada" },
        fixtures: {},
      })
    );
    const unchecked = await outcome(
      startCandidateRun(env, ada, workflow.id, {
        revision: revision + 1,
        input: { who: "Ada" },
        fixtures: {},
      })
    );
    // Back to a passing revision: it runs, until its sealed manifest is
    // changed under it, which its next activation refuses.
    const passing = await workflowDraft(env, ada, workflow.id);
    const saved = await editWorkflowDraft(env, ada, workflow.id, {
      expectedRevision: passing.revision,
      source: draft.source,
      modules: {},
    });
    const { runId } = await startCandidateRun(env, ada, workflow.id, {
      revision: saved.revision,
      input: { who: "Ada" },
      fixtures: {},
    });
    const tamper = env.DB.prepare(
      "UPDATE workflow_candidate_runs SET manifest = replace(manifest, '\"formatVersion\":1', '\"formatVersion\":1 ') WHERE id = ?"
    ).bind(runId);
    // Its row keeps what it pins: a change goes only around the trigger.
    const refusedTamper = await outcome(tamper.run());
    await aroundTrigger("workflow_candidate_runs_pinned", tamper);
    const changed = await ended(ada, workflow.id, runId);
    expect({
      stale,
      unchecked,
      wrongInput: await outcome(
        startCandidateRun(env, ada, workflow.id, {
          revision: saved.revision,
          input: { who: 7 },
          fixtures: {},
        })
      ),
      unknownParam: await outcome(
        startCandidateRun(env, ada, workflow.id, {
          revision: saved.revision,
          input: { who: "Ada" },
          params: { nothing: "here" },
          fixtures: {},
        })
      ),
      // A name every object inherits is no parameter either.
      inheritedParam: await outcome(
        startCandidateRun(env, ada, workflow.id, {
          revision: saved.revision,
          input: { who: "Ada" },
          params: { constructor: "here" },
          fixtures: {},
        })
      ),
      refusedTamper: refusedTamper.includes(
        "workflow_candidate_runs pin what they run"
      ),
      changed: endOf(changed),
    }).toStrictEqual({
      stale: "workflow.draft_conflict",
      unchecked: "workflow.draft_unchecked",
      wrongInput: "workflow.start_invalid",
      unknownParam: "workflow.params_invalid",
      inheritedParam: "workflow.params_invalid",
      refusedTamper: true,
      changed: { status: "failed", code: "workflow.version_corrupt" },
    });
  });

  it("replays its answered call after an attempt is cut off, never asking again, and settles a start the engine never confirmed", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const key = await contract(admin, "model");
    const { workflow, revision } = await drafted(ada, {
      bindings: { summary: { kind: "model", contract: key } },
      tasks: [
        {
          greet: {
            ...greet.greet,
            output: undefined,
            export: { as: "${ {line: .line} }" },
          },
        },
        { finish: { set: { status: "${ $context.line }" } } },
      ],
    });
    const start = {
      revision,
      input: { who: "Ada" },
      fixtures: { summary: { output: { line: "Hi" } } },
    };
    // The step after its call is stopped once its code returned: tried
    // again, it reads the call's answer as recorded, and the call isn't
    // made again.
    const killed = await withCpuKills(
      "task:finish",
      (attempt) => attempt === 1,
      async () => {
        const { runId } = await startCandidateRun(env, ada, workflow.id, start);
        return { runId, run: await ended(ada, workflow.id, runId) };
      },
      "end"
    );
    const attempts = await env.DB.prepare(
      "SELECT step_key AS step, attempt FROM run_lineage_attempts WHERE run_id = ? ORDER BY admitted_at"
    )
      .bind(killed.runId)
      .all<{ step: string; attempt: number }>();
    // The engine refuses everything as it is asked to take the run.
    const refused = await whileEngineRefuses(
      () => true,
      async () => await outcome(startCandidateRun(env, ada, workflow.id, start))
    );
    // Both left as if the start had stopped before the engine answered:
    // a sweep a start's grace later settles them, each as the engine has it.
    await env.DB.prepare(
      "UPDATE workflow_candidate_runs SET status = 'starting', failure_code = NULL, ended_at = NULL WHERE workflow_resource_id = ?"
    )
      .bind(workflow.id)
      .run();
    await sweepCandidateRuns(env, later(11 * 60 * 1000));
    const { results: rows } = await env.DB.prepare(
      "SELECT status, failure_code AS failureCode FROM workflow_candidate_runs WHERE workflow_resource_id = ? ORDER BY created_at"
    )
      .bind(workflow.id)
      .all<{ status: string; failureCode: string | null }>();
    expect({
      killed: endOf(killed.run),
      attempts: attempts.results.map(({ step, attempt }) => [
        step.includes("task:greet") ? "greet" : "finish",
        attempt,
      ]),
      refused: refused === "ok" ? "ok" : "refused",
      rows,
    }).toStrictEqual({
      killed: { status: "completed", output: { status: "Hi" } },
      attempts: [
        ["greet", 1],
        ["finish", 1],
        ["finish", 2],
      ],
      refused: "refused",
      rows: [
        { status: "completed", failureCode: null },
        { status: "failed", failureCode: "workflow.start_unconfirmed" },
      ],
    });
  });

  it("runs nothing more once its workflow is deleted", async () => {
    const ada = await person("builder");
    const { workflow, revision } = await drafted(ada, {
      tasks: [
        { hold: { wait: "PT1S" } },
        { finish: { set: { status: "done" } } },
      ],
    });
    const { runId } = await startCandidateRun(env, ada, workflow.id, {
      revision,
      input: { who: "Ada" },
      fixtures: {},
    });
    await deleteWorkflowResource(env, ada, workflow.id);
    const row = await vi.waitFor(
      async () => {
        const found = await env.DB.prepare(
          "SELECT status FROM workflow_candidate_runs WHERE id = ?"
        )
          .bind(runId)
          .first<{ status: string }>();
        if (found?.status === "starting" || found?.status === "running") {
          throw new Error(`Test run ${runId} is ${found.status}`);
        }
        return found;
      },
      { timeout: 20_000, interval: 100 }
    );
    const engine = await runEngine(env).status(runId);
    expect({
      row,
      code: engine?.status === "errored" ? engine.error.code : engine?.status,
    }).toStrictEqual({
      row: { status: "failed" },
      code: "workflow.resource_unavailable",
    });
  });

  it("lets a person have only so many test runs going at once, each with only so many bytes of answers", async () => {
    const ada = await person("builder");
    const grace = await person("builder");
    const { workflow, revision } = await drafted(ada, {
      tasks: [
        { hold: { wait: "PT5S" } },
        { finish: { set: { status: "done" } } },
      ],
    });
    await shareWorkflowResource(env, ada, workflow.id, {
      type: "person",
      id: grace.userId,
      role: "builder",
    });
    const start = { revision, input: { who: "Ada" }, fixtures: {} };
    const going = await Promise.all(
      Array.from(
        { length: maxLiveCandidateRuns },
        async () =>
          await outcome(startCandidateRun(env, ada, workflow.id, start))
      )
    );
    expect({
      going,
      past: await outcome(startCandidateRun(env, ada, workflow.id, start)),
      // Another builder's runs are their own.
      another: await outcome(startCandidateRun(env, grace, workflow.id, start)),
      tooMuch: await outcome(
        startCandidateRun(env, grace, workflow.id, {
          ...start,
          fixtures: {
            big: { output: "x".repeat(maxCandidateFixtureBytes) },
          },
        })
      ),
    }).toStrictEqual({
      going: Array.from({ length: maxLiveCandidateRuns }, () => "ok"),
      past: "workflow.candidate_limit",
      another: "ok",
      tooMuch: "workflow.resource_invalid",
    });
  });

  it("fails a wait longer than a test run may wait, and its builder can stop one that waits", async () => {
    const ada = await person("builder");
    const { workflow: long, revision: longRevision } = await drafted(ada, {
      tasks: [
        { hold: { wait: "P300D" } },
        { finish: { set: { status: "done" } } },
      ],
    });
    const { runId: longRun } = await startCandidateRun(env, ada, long.id, {
      revision: longRevision,
      input: { who: "Ada" },
      fixtures: {},
    });
    const { workflow, revision } = await drafted(ada, {
      tasks: [
        { hold: { wait: "PT10M" } },
        { finish: { set: { status: "done" } } },
      ],
    });
    const { runId } = await startCandidateRun(env, ada, workflow.id, {
      revision,
      input: { who: "Ada" },
      fixtures: {},
    });
    await vi.waitFor(
      async () => {
        const going = await candidateRunFor(env, ada, workflow.id, runId);
        if (going.status !== "running") {
          throw new Error(`Test run ${runId} is ${going.status}`);
        }
      },
      { timeout: 20_000, interval: 100 }
    );
    // A stop the engine refuses changes nothing, and can be asked again.
    const refusedStop = await whileEngineRefuses(
      () => true,
      async () =>
        await outcome(terminateCandidateRun(env, ada, workflow.id, runId))
    );
    const { status: afterRefused } = await candidateRunFor(
      env,
      ada,
      workflow.id,
      runId
    );
    const stopped = await terminateCandidateRun(env, ada, workflow.id, runId);
    const end = await ended(ada, workflow.id, runId);
    const again = await terminateCandidateRun(env, ada, workflow.id, runId);
    const longEnd = endOf(await ended(ada, long.id, longRun));
    // Both rows left behind the engine, as if their ends never reached
    // them: the failed one still `starting`, the stopped one `running` a
    // week and more after it started. A sweep takes each as the engine has
    // it, the failure's code kept, and removes the overdue one.
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE workflow_candidate_runs SET status = 'starting', failure_code = NULL, ended_at = NULL WHERE id = ?"
      ).bind(longRun),
      env.DB.prepare(
        "UPDATE workflow_candidate_runs SET status = 'running', ended_at = NULL, created_at = ? WHERE id = ?"
      ).bind(Date.now() - 8 * 24 * 60 * 60 * 1000, runId),
    ]);
    await sweepCandidateRuns(env, later(11 * 60 * 1000));
    const longRow = await env.DB.prepare(
      "SELECT status, failure_code AS failureCode FROM workflow_candidate_runs WHERE id = ?"
    )
      .bind(longRun)
      .first<{ status: string; failureCode: string | null }>();
    const events = await allEvents();
    expect({
      refusedStop: refusedStop === "ok" ? "ok" : "refused",
      afterRefused,
      long: longEnd,
      longRow,
      overdueGone: await outcome(candidateRunFor(env, ada, workflow.id, runId)),
      stopped: stopped.id,
      end: end.status,
      // Stopping one that ended changes nothing.
      again: again.status,
      recorded: events
        .filter(
          ({ action, detail }) =>
            action === "workflow.candidate.terminated" && detail?.run === runId
        )
        .map(({ detail }) => detail?.candidate),
    }).toStrictEqual({
      refusedStop: "refused",
      afterRefused: "running",
      long: { status: "failed", code: "workflow.candidate_wait_limit" },
      longRow: {
        status: "failed",
        failureCode: "workflow.candidate_wait_limit",
      },
      overdueGone: "workflow.candidate_unavailable",
      stopped: runId,
      end: "cancelled",
      again: "cancelled",
      recorded: [true],
    });
  });

  it("fails a test run that goes on past its lifetime, however its waits are chained", async () => {
    const ada = await person("builder");
    const { workflow, revision } = await drafted(ada, {
      tasks: [
        { first: { wait: "PT1S" } },
        { second: { wait: "PT1S" } },
        { finish: { set: { status: "done" } } },
      ],
    });
    const { runId } = await startCandidateRun(env, ada, workflow.id, {
      revision,
      input: { who: "Ada" },
      fixtures: {},
    });
    // Started longer ago than a test run may go on, as if its waits had
    // been chained that long: its next activation ends it.
    await env.DB.prepare(
      "UPDATE workflow_candidate_runs SET created_at = ? WHERE id = ?"
    )
      .bind(Date.now() - maxCandidateLifetimeMs - 60_000, runId)
      .run();
    expect(endOf(await ended(ada, workflow.id, runId))).toStrictEqual({
      status: "failed",
      code: "workflow.candidate_time_limit",
    });
  });

  it("keeps only so many test runs of a person's, refusing more until the sweep takes old ones, and ends overdue ones the engine lost", async () => {
    const ada = await person("builder");
    const { workflow, revision } = await drafted(ada, {
      tasks: [{ finish: { set: { status: "done" } } }],
    });
    const start = { revision, input: { who: "Ada" }, fixtures: {} };
    const { runId } = await startCandidateRun(env, ada, workflow.id, start);
    await ended(ada, workflow.id, runId);
    // The rest of what a person may keep, as if started and ended a week
    // and more ago; one of them still `running`, with no run in the engine.
    const weekAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const kept = Array.from(
      { length: maxKeptCandidateRuns - 1 },
      (_, index) => ({
        id: crypto.randomUUID(),
        status: index === 0 ? "running" : "completed",
      })
    );
    await env.DB.batch(
      kept.map(({ id, status }) =>
        env.DB.prepare(
          "INSERT INTO workflow_candidate_runs (id, workflow_resource_id, draft_revision, manifest, manifest_hash, build_hash, reservation, principal_id, input, params, fixtures, status, created_at, ended_at) SELECT ?, workflow_resource_id, draft_revision, manifest, manifest_hash, build_hash, ?, principal_id, input, params, fixtures, ?, ?, ? FROM workflow_candidate_runs WHERE id = ?"
        ).bind(
          id,
          `${workflow.id}~candidate~${id}`,
          status,
          weekAgo,
          status === "running" ? null : weekAgo,
          runId
        )
      )
    );
    const full = await outcome(startCandidateRun(env, ada, workflow.id, start));
    await sweepCandidateRuns(env);
    const lost = kept[0]?.id ?? "";
    expect({
      full,
      lostGone: await outcome(candidateRunFor(env, ada, workflow.id, lost)),
      remaining: await countOf(
        "SELECT COUNT(*) AS n FROM workflow_candidate_runs WHERE workflow_resource_id = ?",
        workflow.id
      ),
      afterSweep: await outcome(
        startCandidateRun(env, ada, workflow.id, start)
      ),
    }).toStrictEqual({
      full: "workflow.candidate_kept_limit",
      // Ended failed, as the engine had no record of it, then taken.
      lostGone: "workflow.candidate_unavailable",
      // Only the run of this week is left.
      remaining: 1,
      afterSweep: "ok",
    });
  });

  it("is started, read and stopped only by the workflow's builders, never its users, others or Grasp staff", async () => {
    const ada = await person("builder");
    const user = await person("builder");
    const other = await person("builder");
    const staff = await person("admin", true);
    const { workflow, revision } = await drafted(ada, {
      tasks: [{ finish: { set: { status: "done" } } }],
    });
    await shareWorkflowResource(env, ada, workflow.id, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    const start = { revision, input: { who: "Ada" }, fixtures: {} };
    const { runId } = await startCandidateRun(env, ada, workflow.id, start);
    await ended(ada, workflow.id, runId);
    const starts = await Promise.all(
      [user, other, staff].map(
        async (by) =>
          await outcome(startCandidateRun(env, by, workflow.id, start))
      )
    );
    const reads = await Promise.all(
      [user, other, staff].map(
        async (by) =>
          await outcome(candidateRunFor(env, by, workflow.id, runId))
      )
    );
    const stops = await Promise.all(
      [user, other, staff].map(
        async (by) =>
          await outcome(terminateCandidateRun(env, by, workflow.id, runId))
      )
    );
    // Another of Ada's workflows never answers for this one's test run.
    const { workflow: elsewhere } = await drafted(ada, {
      tasks: [{ finish: { set: { status: "done" } } }],
    });
    expect({
      starts,
      reads,
      stops,
      elsewhere: await outcome(candidateRunFor(env, ada, elsewhere.id, runId)),
    }).toStrictEqual({
      // Its user sees the workflow, but builds nothing of it; anyone else
      // doesn't see it; staff never start, read or stop one.
      starts: [
        "role.forbidden",
        "workflow.resource_unavailable",
        "role.forbidden",
      ],
      reads: [
        "role.forbidden",
        "workflow.resource_unavailable",
        "role.forbidden",
      ],
      stops: [
        "role.forbidden",
        "workflow.resource_unavailable",
        "role.forbidden",
      ],
      elsewhere: "workflow.candidate_unavailable",
    });
  });

  it("is kept only for a week, then goes with its engine record and its build's reservation", async () => {
    const ada = await person("builder");
    const { workflow, revision } = await drafted(ada, {
      tasks: [{ finish: { set: { status: "done" } } }],
    });
    const { runId } = await startCandidateRun(env, ada, workflow.id, {
      revision,
      input: { who: "Ada" },
      fixtures: {},
    });
    await ended(ada, workflow.id, runId);
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    const reserved = async () =>
      await countOf(
        "SELECT COUNT(*) AS n FROM sdk_release_artifacts WHERE app_id = ?",
        `${workflow.id}~candidate~${runId}`
      );
    // A week less a minute: kept, and so is its build's reservation, past
    // any grace of the release sweep.
    await sweepCandidateRuns(env, later(weekMs - 60_000));
    await queueOrphanedReservations(env, later(weekMs - 60_000));
    const keptEarly = await outcome(
      candidateRunFor(env, ada, workflow.id, runId)
    );
    const reservedEarly = await reserved();
    await sweepCandidateRuns(env, later(weekMs + 60_000));
    await queueOrphanedReservations(env, later(weekMs + 60_000));
    expect({
      keptEarly,
      reservedEarly: reservedEarly > 0,
      afterWeek: await outcome(candidateRunFor(env, ada, workflow.id, runId)),
      engine: await runEngine(env).status(runId),
      reservedAfter: await reserved(),
    }).toStrictEqual({
      keptEarly: "ok",
      reservedEarly: true,
      afterWeek: "workflow.candidate_unavailable",
      engine: undefined,
      reservedAfter: 0,
    });
  });
});
