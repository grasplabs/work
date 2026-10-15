/* oxlint-disable no-template-curly-in-string, unicorn/no-thenable -- workflow expressions are written as ${ … } strings, and transitions as then */
import type { Role } from "@grasp-os/shared/roles";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

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
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { refusal, unique } from "./sign-in.ts";

// Scoped sequencing, switch, transitions and data flow of JSON workflows
// (@grasp-os/open-workflow's generate.ts, the SDK's open-workflow.ts and
// core's resource-host.ts), from their threat model: a transition only
// ever moves forward, so a cycle can't be published, generated or run; a
// task name is never code; a switch's choice, a skipped task and every
// transformation are recorded, so a replay takes the same path; a nested
// list's exit, export and output follow upstream's scope rules; a task's
// schema holds its data; and a run's host refuses any step twice.

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

/**
 * A definition of `name` running `tasks`, its input `{ who }`, its output
 * `{ status }`, and `more` at the top level.
 */
const definitionOf = (
  name: string,
  tasks: unknown[],
  more: Record<string, unknown> = {}
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
          params: {
            limit: {
              schema: { type: "integer", minimum: 0, maximum: 100 },
              label: "Limit",
              default: 5,
              sensitive: false,
            },
          },
          bindings: {},
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

/** Starts version 1 of workflow `id` for `who`, and waits for its end. */
const ranFor = async (
  by: Acting,
  id: string,
  who = "Ada"
): Promise<WorkflowResourceRun> => {
  const { runId } = await startWorkflow(
    env,
    { type: "person", person: by },
    id,
    { version: 1, input: { who }, key: unique() }
  );
  expect(runId).not.toBeNull();
  return await vi.waitFor(
    async () => {
      const run = await resourceRunFor(env, by, id, runId);
      expect(run.endedAt).not.toBeNull();
      return run;
    },
    { timeout: 30_000, interval: 100 }
  );
};

/** What a run ended with: its status, and its output or error code. */
const endOf = (run: WorkflowResourceRun) => ({
  status: run.status,
  ...(run.status === "completed"
    ? { output: run.output }
    : { code: run.error?.code }),
});

/** The task's problems a publication was refused for, by code and pointer. */
const problemsOf = async (by: Acting, tasks: unknown[]) => {
  const workflow = await createWorkflowResource(env, by, `flow-${unique()}`);
  const error = await refusal(
    publishWorkflowVersion(env, by, workflow.id, {
      definition: definitionOf(workflow.name, tasks),
      basedOn: null,
    })
  );
  return z
    .object({
      code: z.string(),
      details: z.object({
        problems: z.array(
          z
            .object({ code: z.string(), pointer: z.string() })
            .transform(({ code, pointer }) => ({ code, pointer }))
        ),
      }),
    })
    .parse(error);
};

const isAda = '${ $workflow.input.who == "Ada" }';

/** Spec 13.9's routing, by who: branches that join explicitly. */
const routing = [
  {
    route: {
      switch: [
        { ada: { when: isAda, then: "greet-ada" } },
        { anyone: { then: "greet-other" } },
      ],
    },
  },
  { "greet-ada": { set: { status: "ada" }, then: "finished" } },
  { "greet-other": { set: { status: "other" }, then: "finished" } },
  { finished: { set: "${ . }" } },
];

describe("switch and transitions in JSON workflows", () => {
  it("takes the first case that holds, else the default, and joins where each branch says", async () => {
    const by = await builder();
    const { workflow } = await published(by, (name) =>
      definitionOf(name, routing)
    );
    expect({
      ada: endOf(await ranFor(by, workflow.id, "Ada")),
      grace: endOf(await ranFor(by, workflow.id, "Grace")),
    }).toStrictEqual({
      ada: { status: "completed", output: { status: "ada" } },
      grace: { status: "completed", output: { status: "other" } },
    });
  });

  it("replays a switch's recorded choice after a wait, never choosing again", async () => {
    const by = await builder();
    const { workflow } = await published(by, (name) =>
      definitionOf(name, [
        {
          route: {
            switch: [
              {
                even: {
                  when: "${ $task.startedAt % 2 == 0 }",
                  then: "even",
                },
              },
              { odd: { then: "odd" } },
            ],
            export: { as: "${ {at: $task.startedAt} }" },
          },
        },
        { even: { set: { parity: 0 }, then: "pause" } },
        { odd: { set: { parity: 1 }, then: "pause" } },
        // Suspends the run: the next activation replays from the start.
        { pause: { wait: "PT1S" } },
        {
          finish: {
            set: {
              status:
                '${ (.parity | tostring) + " " + ($context.at | tostring) }',
            },
          },
        },
      ])
    );
    const run = await ranFor(by, workflow.id);
    const [parity, at] = z
      .object({ status: z.string() })
      .parse(run.output)
      .status.split(" ")
      .map(Number);
    expect({
      // The branch taken is the one the recorded time chose.
      consistent: parity === (at ?? 0) % 2,
      // Chosen before the wait: chosen again after it, the time would be
      // at least a second later.
      before: Date.parse(run.endedAt ?? "") - (at ?? 0) >= 1000,
    }).toStrictEqual({ consistent: true, before: true });
  });

  it("follows exit, export and output through a nested list, and skips a task whose if is false", async () => {
    const by = await builder();
    const countSchema = objectSchema({
      count: { type: "integer" },
      who: { type: "string" },
    });
    const { workflow } = await published(by, (name) =>
      definitionOf(
        name,
        [
          {
            prepare: {
              set: { count: 1 },
              // $input: the workflow's input, as its input.from made it.
              export: {
                as: "${ {count: .count, who: $input.who} }",
                schema: countSchema,
              },
            },
          },
          {
            inner: {
              do: [
                {
                  skipped: {
                    if: "${ $context.count > $params.limit }",
                    set: { status: "never" },
                  },
                },
                {
                  bump: {
                    input: { from: "${ {n: .count} }" },
                    set: { n: "${ .n + 1 }" },
                    output: {
                      as: "${ {n: .n} }",
                      schema: objectSchema({ n: { type: "integer" } }),
                    },
                    export: { as: "${ $context + {count: .n} }" },
                    then: "exit",
                  },
                },
                { unreached: { set: { status: "unreached" } } },
              ],
              output: {
                as: '${ {status: ("count " + ($context.count | tostring) + " after " + (.n | tostring))} }',
              },
              then: "done",
            },
          },
          { passed: { set: { status: "passed over" } } },
          { done: { set: "${ . }" } },
        ],
        {
          // The workflow's own transformations: before and after its list.
          input: {
            schema: objectSchema({ who: { type: "string" } }),
            from: "${ {who: (.who | ascii_upcase)} }",
          },
          output: {
            schema: objectSchema({ status: { type: "string" } }),
            as: '${ {status: (.status + " for " + $context.who + "/" + $workflow.input.who)} }',
          },
        }
      )
    );
    expect(endOf(await ranFor(by, workflow.id))).toStrictEqual({
      status: "completed",
      output: { status: "count 2 after 2 for ADA/Ada" },
    });
  });

  it("ends the whole workflow from inside a nested list, leaving the rest unrun", async () => {
    const by = await builder();
    const { workflow } = await published(by, (name) =>
      definitionOf(name, [
        {
          outer: {
            do: [
              { stop: { set: { status: "ended early" }, then: "end" } },
              { after: { set: { status: "after" } } },
            ],
            output: { as: '${ {status: "outer left"} }' },
          },
        },
        { later: { set: { status: "later" } } },
      ])
    );
    expect(endOf(await ranFor(by, workflow.id))).toStrictEqual({
      status: "completed",
      output: { status: "ended early" },
    });
  });

  it("fails a run whose task's data breaks the task's schema, unchanged by it", async () => {
    const by = await builder();
    const { workflow } = await published(by, (name) =>
      definitionOf(name, [
        {
          mark: {
            set: { status: "marked" },
            export: {
              as: '${ {count: "not a number"} }',
              schema: objectSchema({ count: { type: "integer" } }),
            },
          },
        },
      ])
    );
    expect(endOf(await ranFor(by, workflow.id))).toStrictEqual({
      status: "failed",
      code: "workflow.task_data_invalid",
    });
  });

  it("gives output.as and export.as the task's output as $task.output", async () => {
    const by = await builder();
    const { workflow } = await published(by, (name) =>
      definitionOf(name, [
        {
          mark: {
            set: { status: "done" },
            output: { as: "${ $task.output }" },
            export: { as: "${ {seen: $task.output.status} }" },
          },
        },
        { report: { set: { status: "${ $context.seen }" } } },
      ])
    );
    expect(endOf(await ranFor(by, workflow.id))).toStrictEqual({
      status: "completed",
      output: { status: "done" },
    });
  });

  it("takes an exported null as the context, held to its export schema", async () => {
    const by = await builder();
    const { workflow } = await published(by, (name) =>
      definitionOf(name, [
        { keep: { set: { status: "kept" }, export: { as: "${ {a: 1} }" } } },
        {
          clear: {
            set: { status: "cleared" },
            export: {
              as: "${ null }",
              schema: { format: "json", document: { type: "null" } },
            },
          },
        },
        {
          report: {
            set: {
              status: '${ if $context == null then "cleared" else "kept" end }',
            },
          },
        },
      ])
    );
    expect(endOf(await ranFor(by, workflow.id))).toStrictEqual({
      status: "completed",
      output: { status: "cleared" },
    });
  });

  it("refuses to publish a transition backwards or into another list, so no cycle exists", async () => {
    const by = await builder();
    expect({
      backwards: await problemsOf(by, [
        { first: { set: { status: "a" } } },
        { second: { set: { status: "b" }, then: "first" } },
      ]),
      // A switch's case is a transition like any other.
      throughSwitch: await problemsOf(by, [
        { first: { set: { status: "a" } } },
        {
          again: {
            switch: [
              { loop: { when: "${ true }", then: "first" } },
              { out: { then: "exit" } },
            ],
          },
        },
      ]),
      crossScope: await problemsOf(by, [
        {
          outer: {
            do: [{ inside: { set: { status: "a" }, then: "outside" } }],
          },
        },
        { outside: { set: { status: "b" } } },
      ]),
    }).toStrictEqual({
      backwards: {
        code: "workflow.definition_invalid",
        details: {
          problems: [
            { code: "flow.backward_transition", pointer: "/do/1/second/then" },
          ],
        },
      },
      throughSwitch: {
        code: "workflow.definition_invalid",
        details: {
          problems: [
            {
              code: "flow.backward_transition",
              pointer: "/do/1/again/switch/0/loop/then",
            },
          ],
        },
      },
      crossScope: {
        code: "workflow.definition_invalid",
        details: {
          problems: [
            {
              code: "flow.unknown_target",
              pointer: "/do/0/outer/do/0/inside/then",
            },
          ],
        },
      },
    });
  });

  it("lowers transitions to forward breaks out of counted labels, never a loop or a task's name", async () => {
    const by = await builder();
    const { workflow, version } = await published(by, (name) =>
      definitionOf(name, routing)
    );
    const { files } = await workflowSource(env, by, workflow.id, 1);
    const source = files[".grasp/workflow.ts"] ?? "";
    const labels = [...source.matchAll(/^\s*(?<label>[\w$]+): \{$/gmu)].map(
      (match) => match.groups?.label
    );
    expect({
      executable: version.build.executable,
      labels: labels.toSorted((a = "", b = "") => a.localeCompare(b)),
      breaks: [...source.matchAll(/break (?<label>[\w$]+);/gu)].map(
        (match) => match.groups?.label
      ),
      loops: /\b(?:while|for|continue)\b/u.test(source),
    }).toStrictEqual({
      executable: true,
      labels: ["t0_1", "t0_2", "t0_3"],
      breaks: ["t0_1", "t0_2", "t0_3", "t0_3"],
      loops: false,
    });
  });
});

/**
 * A host of a run of version 1 of workflow `id`, on steps that run at
 * once, its attempts always holding their lease: as the dispatcher makes
 * one for an activation.
 */
const hostOf = async (
  by: Acting,
  id: string,
  params?: Record<string, unknown>
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
      return await fn({ attempt: 1, idempotencyKey: `key:${name}:${count}` });
    },
    sleep: async () => {
      await Promise.resolve();
    },
    waitForEvent: async () => await Promise.reject(new Error("No waits here")),
  };
  return new ResourceRunHost(
    env,
    step,
    {
      runId: crypto.randomUUID(),
      workflowId: id,
      version: 1,
      principal: by.userId,
      input: { who: "Ada" },
      params: z.record(z.string(), z.json()).parse(params ?? { limit: 5 }),
      createdAt: Date.now(),
      build,
    },
    {
      leaseOf: () => ({ generation: 1, deadline: Date.now() + 60_000 }),
      tampered: () => {},
    }
  );
};

/** The code `settled` failed with, or "ok". */
const codeOf = (settled: Settled<unknown>): unknown =>
  settled.ok ? "ok" : settled.error.code;

describe("a run's host, against what generated code never asks", () => {
  it("refuses a step run twice in one activation, so not even a forged module loops", async () => {
    const by = await builder();
    const { workflow } = await published(by, (name) =>
      definitionOf(name, routing)
    );
    const host = await hostOf(by, workflow.id);
    const data = { input: { input: { who: "Ada" }, context: {} } };
    const finished = async () =>
      codeOf(
        // As the run's module answers: settled, in plain data.
        await host.do("task:finished", data, async (attempt) => {
          const evaluated = await attempt.evaluate(1, {
            input: { status: "x" },
            output: null,
          });
          return {
            ok: true,
            value: { output: evaluated.ok ? evaluated.value : null },
          };
        })
      );
    expect({ first: await finished(), again: await finished() }).toStrictEqual({
      first: "ok",
      again: "workflow.invalid",
    });
  });

  it("refuses a step the build doesn't have, and another step's expression", async () => {
    const by = await builder();
    const { workflow } = await published(by, (name) =>
      definitionOf(name, routing)
    );
    const data = { input: { input: { who: "Ada" }, context: {} } };
    const first = await hostOf(by, workflow.id);
    const enterOfSet = await first.do(
      "enter:finished",
      data,
      async () => await Promise.resolve(null)
    );
    // Slot 0 is route's condition; greet-ada's step asks for it.
    const second = await hostOf(by, workflow.id);
    const otherTask = await second.do(
      "task:greet-ada",
      data,
      async (attempt) => {
        await attempt.evaluate(0, { input: null, output: null });
        return null;
      }
    );
    expect({
      enterOfSet: codeOf(enterOfSet),
      otherTask: codeOf(otherTask),
    }).toStrictEqual({
      enterOfSet: "workflow.invalid",
      otherTask: "workflow.invalid",
    });
  });
});

/** `count` fields, each an expression. */
const fields = (count: number) =>
  Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `field${index}`,
      "${ $params.limit }",
    ])
  );

/** A task `typed` whose output must be `{ status }`, then one more. */
const typedOutput = [
  {
    typed: {
      set: { status: "typed" },
      output: { schema: objectSchema({ status: { type: "string" } }) },
    },
  },
  {
    gated: {
      input: { schema: objectSchema({ status: { type: "string" } }) },
      set: { status: "gated" },
    },
  },
];

/** `host`'s answer to step `name` of a module that answers `value`. */
const forged = async (
  host: ResourceRunHost,
  name: string,
  input: unknown,
  value: unknown
): Promise<unknown> =>
  codeOf(
    await host.do(
      name,
      { input: { input, context: {} } },
      async () => await Promise.resolve({ ok: true, value })
    )
  );

describe("a run's host, against a forged module", () => {
  it("holds what a step records to its task's schemas, whatever the module checked", async () => {
    const by = await builder();
    const { workflow } = await published(by, (name) =>
      definitionOf(name, typedOutput)
    );
    expect({
      honest: await forged(
        await hostOf(by, workflow.id),
        "task:typed",
        { who: "Ada" },
        { output: { status: "typed" } }
      ),
      badOutput: await forged(
        await hostOf(by, workflow.id),
        "task:typed",
        { who: "Ada" },
        { output: { status: 5 } }
      ),
      badInput: await forged(
        await hostOf(by, workflow.id),
        "task:gated",
        { status: 5 },
        { output: { status: "gated" } }
      ),
    }).toStrictEqual({
      honest: "ok",
      badOutput: "workflow.task_data_invalid",
      badInput: "workflow.task_data_invalid",
    });
  });

  it("takes a task as skipped only once its if answered false", async () => {
    const by = await builder();
    const { workflow } = await published(by, (name) =>
      definitionOf(name, [
        { maybe: { if: "${ $context == {} }", set: { status: "ran" } } },
      ])
    );
    // No if evaluated: a skip is the module's say-so alone.
    const unasked = await forged(
      await hostOf(by, workflow.id),
      "task:maybe",
      { who: "Ada" },
      { skipped: true }
    );
    // The if answered true: the task can't be skipped.
    const host = await hostOf(by, workflow.id);
    const held = await host.do(
      "task:maybe",
      { input: { input: { who: "Ada" }, context: {} } },
      async (attempt) => {
        await attempt.evaluate(0, { input: { who: "Ada" }, output: null });
        return { ok: true, value: { skipped: true } };
      }
    );
    expect({ unasked, held: codeOf(held) }).toStrictEqual({
      unasked: "workflow.invalid",
      held: "workflow.invalid",
    });
  });

  it("refuses a step's capture or an evaluation's data past what a step holds, before reading it", async () => {
    const by = await builder();
    const { workflow } = await published(by, (name) =>
      definitionOf(name, routing)
    );
    const huge = "x".repeat(2.5 * 1024 * 1024);
    const capture = await forged(
      await hostOf(by, workflow.id),
      "task:greet-ada",
      huge,
      { output: { status: "ada" } }
    );
    const host = await hostOf(by, workflow.id);
    const frame = await host.do(
      "task:finished",
      { input: { input: { status: "x" }, context: {} } },
      async (attempt) => {
        const evaluated = await attempt.evaluate(1, {
          input: huge,
          output: null,
        });
        return { ok: true, value: { output: codeOf(evaluated) } };
      }
    );
    expect({ capture, frame: codeOf(frame) }).toStrictEqual({
      capture: "workflow.invalid",
      frame: "workflow.invalid",
    });
  });

  it("gives expressions only the parameters the build may read", async () => {
    const by = await builder();
    const { workflow } = await published(by, (name) =>
      definitionOf(name, [
        { names: { set: { status: '${ $params | keys | join(",") }' } } },
      ])
    );
    // A value the run holds that the build doesn't name as readable, as a
    // sensitive one is.
    const host = await hostOf(by, workflow.id, { limit: 5, secret: "s3cret" });
    let read: unknown;
    await host.do(
      "task:names",
      { input: { input: { who: "Ada" }, context: {} } },
      async (attempt) => {
        const evaluated = await attempt.evaluate(0, {
          input: null,
          output: null,
        });
        read = evaluated.ok ? evaluated.value : evaluated.error.code;
        return { ok: true, value: { output: { status: "x" } } };
      }
    );
    expect(read).toBe("limit");
  });

  it("refuses a step its own task's expression of a stage it doesn't run", async () => {
    const by = await builder();
    const { workflow } = await published(by, (name) =>
      definitionOf(name, [
        {
          pause: {
            if: "${ true }",
            wait: "PT1S",
            output: { as: '${ {status: "waited"} }' },
          },
        },
      ])
    );
    // Slot 0 is the if, the enter step's; slot 1 is output.as, the leave
    // step's.
    const host = await hostOf(by, workflow.id);
    const entered = await host.do(
      "enter:pause",
      { input: { input: { who: "Ada" }, context: {} } },
      async (attempt) => {
        await attempt.evaluate(1, { input: null, output: null });
        return { ok: true, value: { output: null } };
      }
    );
    expect(codeOf(entered)).toBe("workflow.invalid");
  });

  it("refuses a check of a schema the step doesn't have, or one made twice", async () => {
    const by = await builder();
    const { workflow } = await published(by, (name) =>
      definitionOf(name, typedOutput)
    );
    const checking = async (kinds: string[]) => {
      const host = await hostOf(by, workflow.id);
      return codeOf(
        await host.do(
          "task:typed",
          { input: { input: { who: "Ada" }, context: {} } },
          async (attempt) => {
            for (const kind of kinds) {
              attempt.check(kind, { status: "typed" });
            }
            return await Promise.resolve({
              ok: true,
              value: { output: { status: "typed" } },
            });
          }
        )
      );
    };
    expect({
      once: await checking(["output"]),
      wrongKind: await checking(["input"]),
      twice: await checking(["output", "output"]),
    }).toStrictEqual({
      once: "ok",
      wrongKind: "workflow.invalid",
      twice: "workflow.invalid",
    });
  });
});

describe("what one attempt of a JSON workflow's step may spend", () => {
  it("charges each evaluation for the data it reads, past what jq meters", async () => {
    const by = await builder();
    const wide = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [
        `field${index}`,
        "${ .s | length }",
      ])
    );
    const { workflow } = await published(by, (name) =>
      definitionOf(name, [
        {
          big: {
            // 2^17 characters, doubled 17 times: cheap for jq to make.
            set: {
              s: '${ "x" | . + . | . + . | . + . | . + . | . + . | . + . | . + . | . + . | . + . | . + . | . + . | . + . | . + . | . + . | . + . | . + . | . + . }',
            },
          },
        },
        { wide: { set: wide } },
        { finish: { set: { status: "done" } } },
      ])
    );
    expect(endOf(await ranFor(by, workflow.id))).toStrictEqual({
      status: "failed",
      code: "expression.budget_exhausted",
    });
  });

  it("doesn't lower a step with more expressions than one attempt evaluates", async () => {
    const by = await builder();
    const { version } = await published(by, (name) =>
      definitionOf(name, [
        {
          finish: {
            set: fields(64),
            output: { as: fields(64) },
            export: { as: "${ $context }" },
          },
        },
      ])
    );
    expect(
      version.build.executable ? [] : version.build.unsupported
    ).toStrictEqual([
      {
        pointer: "/do/0/finish",
        taskId: "finish",
        feature: "step:expressions",
      },
    ]);
  });
});
