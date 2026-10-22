/* oxlint-disable no-template-curly-in-string, unicorn/no-thenable -- workflow expressions are written as ${ … } strings, and transitions as then */
import type { Role } from "@grasp-os/shared/roles";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { namedError } from "@grasp-os/workerflow/errors";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { Acting } from "../src/auth/identity.ts";
import { loadWorkflowBuild } from "../src/workflow-builds.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
  workflowSource,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import type { Settled } from "../src/workflows/code.ts";
import type { RunStep } from "../src/workflows/host.ts";
import { ResourceRunHost } from "../src/workflows/resource-host.ts";
import { resourceRunTrace } from "../src/workflows/resource-run-trace.ts";
import {
  resourceRunFor,
  terminateResourceRun,
} from "../src/workflows/resource-runs.ts";
import {
  admittedFreely,
  endLiveRuns,
  resumed,
  runInstance,
  sleeping,
  stopped,
  woken,
} from "./runs.ts";
import { unique } from "./sign-in.ts";

// Typed failures of JSON workflows (spec 13.7): `raise` and `try`/`catch`,
// from their threat model. A catch takes only a failure of a step of a
// task in its own try list, decided by the host from its own record of
// the run (never from what the isolate threw), filtered by the error's
// literal properties and its when/exceptWhen; anything it doesn't take
// goes on unchanged. A wait, a pause or a cancellation is never a failure
// a catch sees. Its do runs as ordinary recorded steps, so a crash during
// it replays what ran and binds the caught error again from the journal.
// A forged module can't make the host say a catch took a failure, nor a
// raise pass as anything but the workflow's own error.

/** A builder of the organization, as their session has them. */
const builder = async (role: Role = "builder"): Promise<Acting> => {
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
  return { userId, role, teams: [], staff: false };
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

/** A domain error a raise raises: of the workflow's own type. */
/** Where the standard error types are. */
const standardTypes =
  "https://open-workflow-specification.org/spec/1.0.0/errors/";

const conflict = {
  type: "urn:grasp:error:invoice.conflict",
  status: 409,
  title: "The invoice changed meanwhile.",
};

/**
 * A definition of `name` running `tasks`, its input `{ who }`, its output
 * `{ status }`, and `more` at the top level.
 */
const definitionOf = (
  name: string,
  tasks: unknown[],
  more: Record<string, unknown> = {},
  bindings: Record<string, unknown> = {}
): string =>
  JSON.stringify({
    document: {
      dsl: "1.0.3",
      namespace: workflowNamespace,
      name,
      version: "1.0.0",
      title: name,
      metadata: {
        grasp: {
          profile: "grasp-open-workflow/1",
          params: {},
          bindings,
        },
      },
    },
    input: { schema: objectSchema({ who: { type: "string" } }) },
    output: { schema: objectSchema({ status: { type: "string" } }) },
    do: tasks,
    ...more,
  });

/** A workflow of `by`'s, published once from `definition`. */
const published = async (by: Acting, definition: (name: string) => string) => {
  const workflow = await createWorkflowResource(env, by, `flow-${unique()}`);
  const version = await publishWorkflowVersion(env, by, workflow.id, {
    definition: definition(workflow.name),
    basedOn: null,
  });
  return { workflow, version };
};

/** Starts version 1 of workflow `id` for `who`: its run's ID. */
const startFor = async (by: Acting, id: string, who = "Ada") => {
  const { runId } = await startWorkflow(
    env,
    { type: "person", person: by },
    id,
    { version: 1, input: { who }, key: unique() }
  );
  if (runId === null) {
    throw new Error("The start admitted no run");
  }
  return runId;
};

/** Run `runId` of workflow `id` once it has ended. */
const endedRun = async (
  by: Acting,
  id: string,
  runId: string
): Promise<WorkflowResourceRun> =>
  await vi.waitFor(
    async () => {
      const run = await resourceRunFor(env, by, id, runId);
      expect(run.endedAt).not.toBeNull();
      return run;
    },
    { timeout: 30_000, interval: 100 }
  );

/** Starts version 1 of workflow `id` for `who`, and waits for its end. */
const ranFor = async (by: Acting, id: string, who = "Ada") =>
  await endedRun(by, id, await startFor(by, id, who));

/** What a run ended with: its status, and its output or error code. */
const endOf = (run: WorkflowResourceRun) => ({
  status: run.status,
  ...(run.status === "completed"
    ? { output: run.output }
    : { code: run.error?.code }),
});

/** Publishes `tasks` and runs them once for `who`: how the run ended. */
const outcomeOf = async (tasks: unknown[], who = "Ada") => {
  const by = await builder();
  const { workflow } = await published(by, (name) => definitionOf(name, tasks));
  return endOf(await ranFor(by, workflow.id, who));
};

/**
 * How many attempts the engine started of each step of ended run `runId`
 * whose name starts with one of `steps`, from the run's own event stream.
 */
const attemptsOf = async (runId: string, steps: readonly string[]) => {
  using events = await runInstance(runId).subscribe({
    filter: ["attempt_started"],
  });
  const counts = Object.fromEntries(steps.map((step) => [step, 0]));
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- one event at a time, in order
    const { done, value } = await events.next();
    if (done === true) {
      return counts;
    }
    const step =
      value.type === "attempt_started"
        ? steps.find((name) => value.stepName.startsWith(name))
        : undefined;
    if (step !== undefined) {
      counts[step] = (counts[step] ?? 0) + 1;
    }
  }
};

/** A try `guard` around `tried`, its catch `handler`. */
const guarded = (tried: unknown[], handler: Record<string, unknown>) => ({
  guard: { try: tried, catch: handler },
});

/** A raise of the domain conflict, as a task `deny`. */
const deny = { deny: { raise: { error: conflict } } };

describe("raise and catch in JSON workflows", () => {
  it("catches a raised domain error by its type, runs its do on the try's own input, and goes on", async () => {
    await expect(
      outcomeOf([
        { greet: { set: { who: "${ .who }", step: "greeted" } } },
        guarded(
          [
            { "before-deny": { set: { step: "before" } } },
            deny,
            { unreached: { set: { status: "unreached" } } },
          ],
          {
            errors: { with: { type: conflict.type } },
            as: "failure",
            do: [
              {
                report: {
                  set: {
                    status:
                      '${ .step + ": " + $failure.title + " at " + $failure.instance + ", " + ($failure.status | tostring) }',
                  },
                },
              },
            ],
          }
        ),
      ])
    ).resolves.toStrictEqual({
      status: "completed",
      output: {
        status: `greeted: ${conflict.title} at /do/1/guard/try/1/deny, 409`,
      },
    });
  });

  it("catches in each item of a for loop, its do reading both the item and the error it caught", async () => {
    await expect(
      outcomeOf([
        { init: { set: "${ . }", export: { as: "${ {seen: []} }" } } },
        {
          each: {
            for: { each: "n", at: "i", in: "${ [1, 2, 3] }" },
            do: [
              guarded(
                [
                  {
                    deny: {
                      if: "${ $n != 2 }",
                      raise: { error: conflict },
                    },
                  },
                ],
                {
                  as: "failure",
                  do: [
                    {
                      note: {
                        set: '${ {status: "x"} }',
                        export: {
                          as: '${ $context + {seen: ($context.seen + [($n | tostring) + ":" + ($failure.status | tostring)])} }',
                        },
                      },
                    },
                  ],
                }
              ),
            ],
          },
        },
        {
          finished: {
            set: '${ {status: ($context.seen | join(","))} }',
          },
        },
      ])
    ).resolves.toStrictEqual({
      status: "completed",
      output: { status: "1:409,3:409" },
    });
  });

  it("fails a run with a raise nothing catches, as the workflow's own error", async () => {
    await expect(outcomeOf([deny])).resolves.toStrictEqual({
      status: "failed",
      code: "workflow.raised",
    });
  });

  it("lets a failure a catch's filter doesn't name go on unchanged, to the catch around it", async () => {
    const inner = guarded([deny], {
      errors: { with: { status: 404 } },
      do: [{ "not-found": { set: { status: "inner" } } }],
    });
    await expect(
      outcomeOf([
        {
          outer: {
            try: [inner],
            catch: {
              errors: { with: { type: conflict.type, status: 409 } },
              as: "failure",
              do: [{ report: { set: { status: "${ $failure.instance }" } } }],
            },
          },
        },
      ])
    ).resolves.toStrictEqual({
      status: "completed",
      // The error the raise raised, not one of the inner catch's.
      output: { status: "/do/0/outer/try/0/guard/try/0/deny" },
    });
    await expect(outcomeOf([inner])).resolves.toStrictEqual({
      status: "failed",
      code: "workflow.raised",
    });
  });

  it("takes a failure only when its when holds and its exceptWhen doesn't", async () => {
    const caughtWhen = async (handler: Record<string, unknown>) =>
      await outcomeOf(
        [
          guarded([deny], {
            as: "failure",
            ...handler,
            do: [{ caught: { set: { status: "caught" } } }],
          }),
        ],
        "Grace"
      );
    expect({
      when: await caughtWhen({ when: "${ $failure.status == 409 }" }),
      whenNot: await caughtWhen({ when: "${ $failure.status == 500 }" }),
      except: await caughtWhen({
        exceptWhen: '${ $workflow.input.who == "Grace" }',
      }),
      notExcept: await caughtWhen({
        exceptWhen: '${ $workflow.input.who == "Ada" }',
      }),
    }).toStrictEqual({
      when: { status: "completed", output: { status: "caught" } },
      whenNot: { status: "failed", code: "workflow.raised" },
      except: { status: "failed", code: "workflow.raised" },
      notExcept: { status: "completed", output: { status: "caught" } },
    });
  });

  it("catches a host failure as its standard error: a task's data off its schema as validation", async () => {
    await expect(
      outcomeOf([
        guarded(
          [
            {
              typed: {
                set: { status: 5 },
                output: {
                  schema: objectSchema({ status: { type: "string" } }),
                },
              },
            },
          ],
          {
            errors: {
              with: {
                type: "https://open-workflow-specification.org/spec/1.0.0/errors/validation",
                status: 400,
              },
            },
            as: "failure",
            do: [
              {
                report: {
                  set: { status: "${ $failure.instance }" },
                },
              },
            ],
          }
        ),
      ])
    ).resolves.toStrictEqual({
      status: "completed",
      output: { status: "/do/0/guard/try/0/typed" },
    });
  });

  it("follows its catch's then on the error path, and the try's own then otherwise", async () => {
    const tasks = [
      {
        guard: {
          try: [
            {
              "deny-grace": {
                if: '${ $workflow.input.who == "Grace" }',
                raise: { error: conflict },
              },
            },
          ],
          catch: { then: "fallback" },
          then: "tried",
        },
      },
      { skipped: { set: { status: "skipped" }, then: "end" } },
      { tried: { set: { status: "tried" }, then: "end" } },
      { fallback: { set: { status: "fallback" } } },
    ];
    const by = await builder();
    const { workflow } = await published(by, (name) =>
      definitionOf(name, tasks)
    );
    expect({
      ada: endOf(await ranFor(by, workflow.id, "Ada")),
      grace: endOf(await ranFor(by, workflow.id, "Grace")),
    }).toStrictEqual({
      ada: { status: "completed", output: { status: "tried" } },
      grace: { status: "completed", output: { status: "fallback" } },
    });
  });

  it("keeps what tasks before the failure exported, and gives the try's output to the next task", async () => {
    await expect(
      outcomeOf([
        guarded(
          [
            {
              mark: {
                set: { step: "marked" },
                export: { as: '${ { marked: "yes" } }' },
              },
            },
            deny,
          ],
          {}
        ),
        {
          after: {
            set: {
              status: '${ .who + " " + $context.marked }',
            },
          },
        },
      ])
    ).resolves.toStrictEqual({
      status: "completed",
      // Without do, the try answers its own input.
      output: { status: "Ada yes" },
    });
  });

  it("gives a catch around a loop what its items exported before one of them failed", async () => {
    await expect(
      outcomeOf([
        guarded(
          [
            {
              each: {
                for: { each: "n", in: '${ ["a", "b"] }' },
                do: [
                  {
                    mark: {
                      if: '${ $n == "a" }',
                      set: "${ . }",
                      export: { as: "${ $context + {marked: $n} }" },
                    },
                  },
                  {
                    deny: { if: '${ $n == "b" }', raise: { error: conflict } },
                  },
                ],
              },
            },
          ],
          {
            when: '${ $context.marked == "a" }',
            do: [{ report: { set: { status: "${ $context.marked }" } } }],
          }
        ),
      ])
    ).resolves.toStrictEqual({
      status: "completed",
      output: { status: "a" },
    });
  });

  it("gives a catch around loops one inside another what their items exported before one failed", async () => {
    await expect(
      outcomeOf([
        guarded(
          [
            {
              outer: {
                for: { each: "o", at: "oi", in: '${ ["o"] }' },
                do: [
                  {
                    "mark-outer": {
                      set: "${ . }",
                      export: { as: "${ $context + {outer: $o} }" },
                    },
                  },
                  {
                    inner: {
                      for: { each: "n", at: "ni", in: '${ ["a", "b"] }' },
                      do: [
                        {
                          mark: {
                            if: '${ $n == "a" }',
                            set: "${ . }",
                            export: { as: "${ $context + {inner: $n} }" },
                          },
                        },
                        {
                          deny: {
                            if: '${ $n == "b" }',
                            raise: { error: conflict },
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          ],
          {
            when: '${ $context.inner == "a" }',
            do: [
              {
                report: {
                  set: { status: "${ $context.outer + $context.inner }" },
                },
              },
            ],
          }
        ),
      ])
    ).resolves.toStrictEqual({
      status: "completed",
      output: { status: "oa" },
    });
  });
});

describe("a recovery that fails", () => {
  it("fails the run with the recovery's failure, its trace keeping the original failure too", async () => {
    const by = await builder();
    const { workflow } = await published(by, (name) =>
      definitionOf(name, [
        guarded([deny], {
          do: [
            {
              undo: {
                raise: {
                  error: {
                    type: "urn:grasp:error:invoice.undo_failed",
                    status: 500,
                    title: "The invoice couldn't be put back.",
                  },
                },
              },
            },
          ],
        }),
      ])
    );
    const run = await ranFor(by, workflow.id);
    const trace = await resourceRunTrace(env, by, workflow.id, run.id);
    expect({
      end: { ...endOf(run), message: run.error?.message },
      failed: trace.tasks
        .filter(({ state }) => state === "failed")
        .map(({ task }) => task)
        .toSorted(),
    }).toStrictEqual({
      end: {
        status: "failed",
        code: "workflow.raised",
        message: "The invoice couldn't be put back.",
      },
      failed: ["deny", "undo"],
    });
  });
});

describe("what a catch never takes", () => {
  afterEach(endLiveRuns);

  it("leaves a run waiting inside a try waiting, and its cancellation unseen by its catch", async () => {
    const by = await builder();
    const { workflow } = await published(by, (name) =>
      definitionOf(name, [
        guarded([{ pause: { wait: "PT1H" } }], {
          do: [{ recovered: { set: { status: "recovered" } } }],
        }),
      ])
    );
    const runId = await startFor(by, workflow.id);
    await sleeping(runId, "task:pause");
    await terminateResourceRun(env, by, workflow.id, runId);
    const run = await endedRun(by, workflow.id, runId);
    expect({
      status: run.status,
      caught: await attemptsOf(runId, ["catch:guard", "task:recovered"]),
    }).toStrictEqual({
      status: "cancelled",
      caught: { "catch:guard": 0, "task:recovered": 0 },
    });
  });
});

describe("a caught failure's recovery, through a crash", () => {
  afterEach(endLiveRuns);

  it("replays the failure, its catch and its finished recovery steps, binding the caught error again", async () => {
    const by = await builder();
    const { workflow } = await published(by, (name) =>
      definitionOf(name, [
        guarded([deny], {
          as: "failure",
          do: [
            {
              note: {
                set: { noted: "${ $failure.title }" },
                export: { as: "${ { noted: .noted } }" },
              },
            },
            { pause: { wait: "PT1H" } },
            {
              report: {
                set: {
                  status:
                    '${ $context.noted + " / " + ($failure.status | tostring) }',
                },
              },
            },
          ],
        }),
      ])
    );
    const runId = await startFor(by, workflow.id);
    await sleeping(runId, "task:pause");
    // A crash while the recovery waits; then its wait ends: the next
    // activation, in a fresh isolate and host, replays the raise's failure,
    // the catch and `note`, and reads $failure again.
    await stopped(runId);
    await resumed(runId);
    await woken(runId, "task:pause");
    const run = await endedRun(by, workflow.id, runId);
    expect({
      end: endOf(run),
      attempts: await attemptsOf(runId, [
        "task:deny",
        "catch:guard",
        "task:note",
        "task:report",
      ]),
    }).toStrictEqual({
      end: {
        status: "completed",
        output: { status: `${conflict.title} / 409` },
      },
      attempts: {
        "task:deny": 1,
        "catch:guard": 1,
        "task:note": 1,
        "task:report": 1,
      },
    });
  });
});

describe("raise and catch, as the build seals them", () => {
  it("lowers a try to a JavaScript try whose catch asks the host, never naming a task in code", async () => {
    const by = await builder();
    const { workflow, version } = await published(by, (name) =>
      definitionOf(name, [
        guarded([deny], {
          errors: { with: { status: 409 } },
          do: [{ recovered: { set: { status: "recovered" } } }],
        }),
      ])
    );
    const { files } = await workflowSource(env, by, workflow.id, 1);
    const source = files[".grasp/workflow.ts"] ?? "";
    expect({
      executable: version.build.executable,
      catches: [...source.matchAll(/flow\.catch\((?<id>"[^"]*")/gu)].map(
        (match) => match.groups?.id
      ),
      raises: [...source.matchAll(/flow\.raise\((?<id>"[^"]*")/gu)].map(
        (match) => match.groups?.id
      ),
      rethrows: /throw thrown\d+;/u.test(source),
      loops: /\b(?:while|for|continue)\b/u.test(source),
    }).toStrictEqual({
      executable: true,
      catches: ['"guard"'],
      raises: ['"deny"'],
      rethrows: true,
      loops: false,
    });
  });

  it("doesn't lower a catch that retries yet: it runs nothing", async () => {
    const by = await builder();
    const { version } = await published(by, (name) =>
      definitionOf(name, [
        guarded([deny], {
          retry: { limit: { attempt: { count: 3 } } },
        }),
      ])
    );
    expect(version.build).toStrictEqual({
      executable: false,
      unsupported: [
        {
          pointer: "/do/0/guard/catch/retry",
          taskId: "guard",
          feature: "catch.retry",
        },
      ],
    });
  });
});

/**
 * A host of a run of version 1 of workflow `id`, on steps that run at
 * once and fail as the engine fails them, its attempts always holding
 * their lease: as the dispatcher makes one for an activation.
 */
const hostOf = async (
  by: Acting,
  id: string,
  /** The attempt the engine claims of step `name`: the first, unless given. */
  attemptOf: (name: string) => number = () => 1,
  /** Steps the engine times out, as it ends an attempt it gave up on. */
  timesOut: ReadonlySet<string> = new Set()
): Promise<ResourceRunHost> => {
  const manifest = await env.DB.prepare(
    "SELECT manifest_hash AS hash FROM workflow_resource_versions WHERE workflow_resource_id = ? AND version = 1"
  )
    .bind(id)
    .first<{ hash: string }>();
  const build = await loadWorkflowBuild(env, id, 1, manifest?.hash ?? "");
  let count = 0;
  const step: RunStep = {
    do: async (name, _config, fn) => {
      count += 1;
      if (timesOut.has(name)) {
        throw namedError("TimeoutError", "The step ran out of time.");
      }
      return await fn({
        attempt: attemptOf(name),
        idempotencyKey: `key:${name}:${count}`,
      });
    },
    sleep: async () => {
      await Promise.resolve();
    },
    sleepUntil: async () => {
      await Promise.resolve();
    },
    waitForEvent: async () => await Promise.reject(new Error("No waits here")),
  };
  const runId = crypto.randomUUID();
  return new ResourceRunHost(
    env,
    step,
    {
      runId,
      workflowId: id,
      version: 1,
      principal: by.userId,
      input: { who: "Ada" },
      params: {},
      createdAt: Date.now(),
      build,
      calling: {
        runId,
        workflowId: id,
        version: 1,
        principal: by.userId,
        invoker: { type: "person", id: by.userId, appVersion: null },
        bindings: new Map(),
        restricted: false,
      },
      maxModelCalls: 1,
    },
    {
      leaseOf: () => ({ generation: 1, deadline: Date.now() + 60_000 }),
      tampered: () => {},
      admitAttempt: admittedFreely,
    }
  );
};

/** The code `settled` failed with, or its value. */
const answerOf = (settled: Settled<unknown>): unknown =>
  settled.ok ? settled.value : settled.error.code;

const input = { who: "Ada" };
const data = { input: { input, context: {} } };

/** A module's raise step for `deny`: its record, as the SDK makes it. */
const raiseStep = async (host: ResourceRunHost) =>
  answerOf(
    await host.do(
      "task:deny",
      data,
      async () => await Promise.resolve({ ok: true, value: { output: input } })
    )
  );

/** A module's catch step for `guard`, recording `caught` (the host's, unset). */
const catchStep = async (
  host: ResourceRunHost,
  caught?: boolean,
  name = "catch:guard"
) =>
  answerOf(
    await host.do(name, data, async (attempt) => {
      const decided = await attempt.catches();
      return {
        ok: true,
        value: {
          output: input,
          caught: caught ?? (decided.ok ? decided.value : null),
        },
      };
    })
  );

describe("a run's host, against a forged module's catches", () => {
  // The recovery's one expression is the table's first (slot 0): the
  // catch has no conditions, and the try list none.
  const caughtOnly = (name: string) =>
    definitionOf(name, [
      guarded([deny], {
        errors: { with: { status: 409 } },
        as: "failure",
        do: [{ recovered: { set: { status: "${ $failure.title }" } } }],
      }),
    ]);

  it("fails a raise's step with the sealed error, however the module records it", async () => {
    const by = await builder();
    const { workflow } = await published(by, caughtOnly);
    await expect(raiseStep(await hostOf(by, workflow.id))).resolves.toBe(
      "workflow.raised"
    );
  });

  it("says a catch took a failure only when one of its try list's steps failed, and holds the record to it", async () => {
    const by = await builder();
    const { workflow } = await published(by, caughtOnly);
    const unfailed = await hostOf(by, workflow.id);
    const failed = await hostOf(by, workflow.id);
    await raiseStep(failed);
    const lying = await hostOf(by, workflow.id);
    await raiseStep(lying);
    expect({
      // Nothing failed: nothing to catch, and a record saying otherwise is refused.
      nothing: await catchStep(unfailed),
      claimed: await catchStep(await hostOf(by, workflow.id), true),
      failed: await catchStep(failed),
      denied: await catchStep(lying, false),
    }).toStrictEqual({
      nothing: { output: input, caught: false },
      claimed: "workflow.invalid",
      failed: { output: input, caught: true },
      denied: "workflow.invalid",
    });
  });

  it("gives a recovery the caught error only once its catch took one", async () => {
    const by = await builder();
    const { workflow } = await published(by, caughtOnly);
    const recovered = async (host: ResourceRunHost) =>
      answerOf(
        await host.do("task:recovered", data, async (attempt) => {
          const status = await attempt.evaluate(0, { input, output: null });
          return {
            ok: true,
            value: { output: { status: status.ok ? status.value : null } },
          };
        })
      );
    const caught = await hostOf(by, workflow.id);
    await raiseStep(caught);
    await catchStep(caught);
    expect({
      uncaught: await recovered(await hostOf(by, workflow.id)),
      caught: await recovered(caught),
    }).toStrictEqual({
      uncaught: "workflow.invalid",
      caught: { output: { status: conflict.title } },
    });
  });

  it("takes no failure of a step outside its try list, nor a refusal of the module", async () => {
    const by = await builder();
    const { workflow } = await published(by, (name) =>
      definitionOf(name, [
        { first: { raise: { error: conflict } } },
        guarded([deny], {}),
      ])
    );
    const outside = await hostOf(by, workflow.id);
    await answerOf(
      await outside.do(
        "task:first",
        data,
        async () =>
          await Promise.resolve({ ok: true, value: { output: input } })
      )
    );
    const refused = await hostOf(by, workflow.id);
    // A step the build doesn't have: the host's refusal, never a catch's.
    await refused.do(
      "task:nowhere",
      data,
      async () => await Promise.resolve(null)
    );
    expect({
      outside: await catchStep(outside),
      refused: await catchStep(refused),
    }).toStrictEqual({
      outside: { output: input, caught: false },
      refused: "workflow.invalid",
    });
  });
});

/** A module's step `name` that fails as it reports, the host failing nothing. */
const failsAsReported = async (
  host: ResourceRunHost,
  name: string,
  code: string
) =>
  answerOf(
    await host.do(
      name,
      data,
      async () =>
        await Promise.resolve({
          ok: false,
          error: { name: "Error", message: "Relabelled.", code },
        })
    )
  );

describe("a run's host, against a forged module's failures", () => {
  it("fails a step with the host's own failure, never the code the module reports", async () => {
    const by = await builder();
    const typed = (type: string) => (name: string) =>
      definitionOf(name, [
        guarded([{ count: { set: { n: "${ .who | tonumber }" } } }], {
          errors: { with: { type: `${standardTypes}${type}` } },
        }),
      ]);
    const failed = async (type: string) => {
      const { workflow } = await published(by, typed(type));
      const host = await hostOf(by, workflow.id);
      // The host's evaluation fails (an expression's failure); the module
      // reports a denial instead.
      const step = answerOf(
        await host.do("task:count", data, async (attempt) => {
          const evaluated = await attempt.evaluate(0, { input, output: null });
          return {
            ok: false,
            error: {
              name: "Error",
              message: evaluated.ok ? "?" : "Denied.",
              code: "permission.denied",
            },
          };
        })
      );
      return { step, caught: await catchStep(host) };
    };
    expect({
      expression: await failed("expression"),
      authorization: await failed("authorization"),
    }).toStrictEqual({
      expression: {
        step: "expression.failed",
        caught: { output: input, caught: true },
      },
      authorization: {
        step: "expression.failed",
        caught: { output: input, caught: false },
      },
    });
  });

  it("takes a failure the host failed nothing of as the module's own, which no catch takes", async () => {
    const by = await builder();
    const { workflow } = await published(by, (name) =>
      definitionOf(name, [
        guarded([{ count: { set: { status: "counted" } } }], {}),
      ])
    );
    const host = await hostOf(by, workflow.id);
    expect({
      step: await failsAsReported(host, "task:count", "resource.busy"),
      caught: await catchStep(host),
    }).toStrictEqual({
      step: "workflow.invalid",
      caught: { output: input, caught: false },
    });
  });

  it("never lets a catch around a failing catch take a failure no catch may", async () => {
    const by = await builder();
    const { workflow } = await published(by, (name) =>
      definitionOf(name, [
        {
          outer: {
            try: [guarded([{ count: { set: { status: "counted" } } }], {})],
            catch: {},
          },
        },
      ])
    );
    const host = await hostOf(by, workflow.id);
    await failsAsReported(host, "task:count", "resource.busy");
    // The inner catch step fails on the host's word: its person left.
    const member = await env.DB.prepare(
      "SELECT id, role FROM members WHERE user_id = ?"
    )
      .bind(by.userId)
      .first<{ id: string; role: string }>();
    await env.DB.prepare("DELETE FROM members WHERE user_id = ?")
      .bind(by.userId)
      .run();
    const inner = await catchStep(host);
    await env.DB.prepare(
      "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, 'organization', ?, ?, ?)"
    )
      .bind(member?.id, by.userId, member?.role, Date.now())
      .run();
    expect({
      inner,
      outer: await catchStep(host, undefined, "catch:outer"),
    }).toStrictEqual({
      inner: "permission.person_inactive",
      outer: { output: input, caught: false },
    });
  });

  it("refuses a module going on past a failure no catch took, and says so as the run ends", async () => {
    const by = await builder();
    const { workflow } = await published(by, (name) =>
      definitionOf(name, [deny, { after: { set: { status: "after" } } }])
    );
    const host = await hostOf(by, workflow.id);
    await raiseStep(host);
    expect({
      untaken: host.failureUntaken,
      after: answerOf(
        await host.do(
          "task:after",
          data,
          async () =>
            await Promise.resolve({
              ok: true,
              value: { output: { status: "after" } },
            })
        )
      ),
    }).toStrictEqual({ untaken: true, after: "workflow.invalid" });
  });
});

/** An action that charges a card, as the workflow's own module. */
const chargeModule = `import { action, v } from "@grasp-os/sdk/action";

export const charge = action({
  args: { who: v.string() },
  returns: v.object({ status: v.string() }),
  uses: [],
  handler: async () => ({ status: "charged" }),
});
`;

describe("a call that runs its effect once, cut off", () => {
  it("never lets a catch of timeouts take an action left open, its effect maybe out", async () => {
    const by = await builder();
    const workflow = await createWorkflowResource(env, by, `flow-${unique()}`);
    const definition = definitionOf(
      workflow.name,
      [
        guarded(
          [
            {
              "charge-card": {
                call: "grasp.operation",
                with: {
                  binding: "charge",
                  arguments: { who: "${ $workflow.input.who }" },
                },
              },
            },
          ],
          // Any failure, a timeout's included.
          {}
        ),
      ],
      {},
      { charge: { kind: "operation", contract: "local:code/charge.ts#charge" } }
    );
    await publishWorkflowVersion(env, by, workflow.id, {
      definition,
      basedOn: null,
      modules: { "code/charge.ts": chargeModule },
    });
    const charge = async (host: ResourceRunHost) => {
      await host.do(
        "task:charge-card",
        data,
        async () => await Promise.resolve({ ok: true, value: null })
      );
      return await catchStep(host);
    };
    const notTaken = { output: input, caught: false };
    expect({
      // The engine claims a second attempt of the action's step: its first
      // was evicted mid-action, never marked as having not run, so its
      // effect may be out (left open), and the host refuses it unrun.
      leftOpen: await charge(
        await hostOf(by, workflow.id, (name) =>
          name === "task:charge-card" ? 2 : 1
        )
      ),
      // The engine gave up on the attempt as it ran.
      timedOut: await charge(
        await hostOf(by, workflow.id, () => 1, new Set(["task:charge-card"]))
      ),
    }).toStrictEqual({ leftOpen: notTaken, timedOut: notTaken });
  });

  it("lets a catch of timeouts take a timeout of a step whose work changes nothing outside", async () => {
    const by = await builder();
    const { workflow } = await published(by, (name) =>
      definitionOf(name, [
        guarded([{ count: { set: { status: "counted" } } }], {
          errors: { with: { type: `${standardTypes}timeout`, status: 408 } },
        }),
      ])
    );
    const host = await hostOf(
      by,
      workflow.id,
      () => 1,
      new Set(["task:count"])
    );
    await host.do(
      "task:count",
      data,
      async () => await Promise.resolve({ ok: true, value: null })
    );
    await expect(catchStep(host)).resolves.toStrictEqual({
      output: input,
      caught: true,
    });
  });
});

describe("a run's host, against a forged module's calls", () => {
  /** A guarded call of the time, its output and export held to schemas. */
  const stamped = (name: string) =>
    definitionOf(name, [
      guarded(
        [
          {
            stamp: {
              call: "grasp.now",
              output: { schema: objectSchema({ at: { type: "string" } }) },
              export: { schema: objectSchema({ at: { type: "string" } }) },
            },
          },
        ],
        {}
      ),
    ]);

  it("makes no call once anything of its step failed, so a catch never takes a failure with the call out", async () => {
    const by = await builder();
    const { workflow } = await published(by, stamped);
    const host = await hostOf(by, workflow.id);
    let called: unknown;
    const step = answerOf(
      await host.do("task:stamp", data, async (attempt) => {
        // A check failed (a catchable failure), then the call anyway.
        attempt.check("export", { at: 5 });
        called = answerOf(await attempt.call({ input }));
        return {
          ok: false,
          error: { name: "Error", message: "Failed." },
        };
      })
    );
    expect({
      called,
      step,
      caught: await catchStep(host),
    }).toStrictEqual({
      called: "workflow.invalid",
      step: "workflow.invalid",
      // The run refused: its catch never runs, and the run fails.
      caught: "workflow.invalid",
    });
  });

  it("fails a step whose call took effect with that, whatever failed after, which no catch takes", async () => {
    const by = await builder();
    const { workflow } = await published(by, stamped);
    const host = await hostOf(by, workflow.id);
    const step = answerOf(
      await host.do("task:stamp", data, async (attempt) => {
        const now = await attempt.call({ input });
        // Its output off its schema, once the call took effect.
        const checked = attempt.check("output", now.ok ? now.value : null);
        return {
          ok: false,
          error: checked.ok ? { name: "Error", message: "?" } : checked.error,
        };
      })
    );
    expect({
      step,
      caught: await catchStep(host),
    }).toStrictEqual({
      step: "workflow.failed_after_effect",
      caught: { output: input, caught: false },
    });
  });

  it("refuses anything else of a step while its call is out, failing the run, so no catch runs", async () => {
    const by = await builder();
    const { workflow } = await published(by, stamped);
    const host = await hostOf(by, workflow.id);
    let checked: unknown;
    const step = answerOf(
      await host.do("task:stamp", data, async (attempt) => {
        // The call starts; a failing check while it's in flight, to report
        // as the step's own while the call's effect goes out.
        const out = attempt.call({ input });
        checked = answerOf(attempt.check("export", { at: 5 }));
        await out;
        return { ok: false, error: { name: "Error", message: "Failed." } };
      })
    );
    expect({
      checked,
      step,
      caught: await catchStep(host),
    }).toStrictEqual({
      checked: "workflow.invalid",
      step: "workflow.invalid",
      caught: "workflow.invalid",
    });
  });

  it("makes no call of an attempt in a run it already refused", async () => {
    const by = await builder();
    const { workflow } = await published(by, stamped);
    const host = await hostOf(by, workflow.id);
    let called: unknown;
    await host.do("task:stamp", data, async (attempt) => {
      // An expression of no step of this task: refused, the run tainted.
      await attempt.evaluate(99, { input, output: null });
      called = answerOf(await attempt.call({ input }));
      return { ok: true, value: null };
    });
    expect(called).toBe("workflow.invalid");
  });
});
