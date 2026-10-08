/* oxlint-disable unicorn/no-thenable -- `then` is Open Workflow's flow directive, not a promise */
/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { v } from "@grasp-os/sdk";
import { expressionErrors } from "@grasp-os/workflow-expressions/errors";
import { describe, expect, it } from "vite-plus/test";

import type { Diagnostic } from "../src/diagnostics.ts";
import { validateWorkflow } from "../src/validate.ts";
import { documentAround, fixtures, noteSummary, options } from "./fixtures.ts";

// What the profile accepts and refuses, through its one public entry point.
// Each refusal is checked for its stable code, its JSON Pointer and, inside
// a task, the task's ID: what the editor and an agent's repair loop act on.

const diagnose = async (
  definition: unknown
): Promise<readonly Diagnostic[]> => {
  const result = await validateWorkflow(
    typeof definition === "string" || definition instanceof Uint8Array
      ? definition
      : JSON.stringify(definition),
    options
  );
  return result.ok ? result.warnings : result.diagnostics;
};

/** The errors validation refuses `definition` with; none when it passes. */
const refusals = async (
  definition: unknown
): Promise<readonly Diagnostic[]> => {
  const diagnostics = await diagnose(definition);
  return diagnostics.filter(({ severity }) => severity === "error");
};

/** A document with every binding the probes use, around `tasks`. */
const probe = (tasks: unknown[], use?: unknown) =>
  documentAround(
    {
      name: "probe",
      params: {
        maxWords: {
          schema: { type: "integer", minimum: 1 },
          label: "Words",
          default: 120,
          sensitive: false,
        },
        nothing: {
          schema: { type: "null" },
          label: "Nothing",
          required: true,
          sensitive: false,
        },
        delay: {
          schema: { type: "string" },
          label: "Delay",
          default: "PT1S",
          sensitive: false,
        },
        enabled: {
          schema: { type: "boolean" },
          label: "Enabled",
          default: true,
          sensitive: false,
        },
      },
      bindings: {
        loadNote: { kind: "operation", contract: "notes.get" },
        jobStatus: { kind: "connector", contract: "job-status" },
        jobEvents: { kind: "event", contract: "job-events" },
        summaryChild: {
          kind: "workflow",
          contract: "grasp/summarize-note/1.0.0",
        },
        summaryModel: { kind: "model", contract: "note-summary" },
      },
      input: {
        noteId: {
          type: "string",
          "x-grasp-value": { kind: "id", table: "notes" },
        },
        flag: { type: "boolean" },
      },
      required: ["noteId"],
      ...(use === undefined ? {} : { use }),
    },
    tasks
  );

const done = { finish: { set: { status: "done" } } };
const withDocument = (changes: Record<string, unknown>) => ({
  ...noteSummary,
  document: { ...noteSummary.document, ...changes },
});
const withGrasp = (changes: Record<string, unknown>) =>
  withDocument({
    metadata: {
      grasp: { ...noteSummary.document.metadata.grasp, ...changes },
    },
  });

/** The collection fixture, validated. */
const collection = async () => {
  const result = await validateWorkflow(
    JSON.stringify(fixtures["13.9 collection"]),
    options
  );
  return result.ok ? result.workflow : undefined;
};

describe("definitions the profile accepts", () => {
  it.each(Object.entries(fixtures))("accepts %s", async (_name, definition) => {
    const result = await validateWorkflow(JSON.stringify(definition), options);
    expect(result.ok ? result.warnings : result.diagnostics).toStrictEqual([]);
  });

  it("accepts the definition as UTF-8 bytes", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(noteSummary));
    const result = await validateWorkflow(bytes, options);
    expect(result.ok).toBeTruthy();
  });

  it("records every task with the scope it sits in", async () => {
    const workflow = await collection();
    expect(workflow?.tasks).toStrictEqual([
      {
        id: "summarize-one",
        kind: "run",
        pointer: "/do/0/summarize-each/do/0/summarize-one",
        scope: ["summarize-each", "summarize-one"],
      },
      {
        id: "summarize-each",
        kind: "for",
        pointer: "/do/0/summarize-each",
        scope: ["summarize-each"],
      },
    ]);
    expect(Object.isFrozen(workflow?.definition)).toBeTruthy();
  });

  it("compiles every expression for its stage, with the loop's variables", async () => {
    const workflow = await collection();
    const key = workflow?.expressions.get(
      "/do/0/summarize-each/metadata/grasp/key"
    );
    expect(key?.stage).toBe("taskDefinition");
    expect(key?.loopVariables).toStrictEqual(["noteId", "index"]);
    expect([...(workflow?.bindings.keys() ?? [])]).toStrictEqual([
      "summaryChild",
    ]);
  });
});

describe("bounded JSON text", () => {
  it("refuses a key given twice in one object, which JSON.parse would hide", async () => {
    const text = JSON.stringify(noteSummary).replace(
      '"title":"Summarize note"',
      '"title":"Summarize note","title":"Other"'
    );
    await expect(refusals(text)).resolves.toContainEqual(
      expect.objectContaining({
        code: "json.duplicate_key",
        pointer: "/document/title",
      })
    );
  });

  it("refuses keys that reach the object prototype, anywhere", async () => {
    const text = JSON.stringify(noteSummary).replace(
      '"evaluate":{',
      '"evaluate":{"__proto__":{"polluted":true},'
    );
    await expect(refusals(text)).resolves.toContainEqual(
      expect.objectContaining({
        code: "json.prototype_key",
        pointer: "/evaluate/__proto__",
      })
    );
    const nested = JSON.stringify(noteSummary).replace(
      '"limits":{',
      '"limits":{"constructor":1,'
    );
    await expect(refusals(nested)).resolves.toContainEqual(
      expect.objectContaining({
        code: "json.prototype_key",
        pointer: "/document/metadata/grasp/limits/constructor",
      })
    );
  });

  it("refuses text that isn't one JSON value, or isn't text", async () => {
    await expect(
      refusals(`${JSON.stringify(noteSummary)} {}`)
    ).resolves.toContainEqual(
      expect.objectContaining({
        code: "json.invalid",
        pointer: "",
      })
    );
    await expect(refusals('{"document": 1e400}')).resolves.toContainEqual(
      expect.objectContaining({
        code: "json.invalid_number",
        pointer: "/document",
      })
    );
    await expect(refusals('{"a": "\\ud800"}')).resolves.toContainEqual(
      expect.objectContaining({
        code: "json.invalid_text",
        pointer: "/a",
      })
    );
    await expect(
      refusals(new Uint8Array([0x7b, 0xff, 0x7d]))
    ).resolves.toContainEqual(
      expect.objectContaining({
        code: "json.invalid_text",
        pointer: "",
      })
    );
  });
});

describe("the document and its Grasp metadata", () => {
  it.each([
    [
      "an unknown profile",
      withGrasp({ profile: "grasp-open-workflow/2" }),
      {
        code: "profile.unknown_profile",
        pointer: "/document/metadata/grasp/profile",
      },
    ],
    [
      "no profile at all",
      withDocument({ metadata: {} }),
      { code: "profile.unknown_profile", pointer: "/document/metadata/grasp" },
    ],
    [
      "another DSL",
      withDocument({ dsl: "1.0.0" }),
      { code: "profile.unsupported_dsl", pointer: "/document/dsl" },
    ],
    [
      "version latest",
      withDocument({ version: "latest" }),
      { code: "profile.invalid_value", pointer: "/document/version" },
    ],
    [
      "a top-level schedule",
      { ...noteSummary, schedule: { every: { hours: 1 } } },
      { code: "profile.unsupported_feature", pointer: "/schedule" },
    ],
    [
      "loose expressions",
      { ...noteSummary, evaluate: { language: "jq", mode: "loose" } },
      { code: "profile.unsupported_evaluate", pointer: "/evaluate" },
    ],
    [
      "secrets in use",
      { ...noteSummary, use: { secrets: ["apiKey"] } },
      { code: "profile.unsupported_feature", pointer: "/use/secrets" },
    ],
    [
      "authentication policies in use",
      { ...noteSummary, use: { authentications: {} } },
      { code: "profile.unsupported_feature", pointer: "/use/authentications" },
    ],
    [
      "an unknown document property",
      withDocument({ owner: "someone" }),
      { code: "profile.unknown_property", pointer: "/document/owner" },
    ],
    [
      "a parameter with both required and a default",
      withGrasp({
        params: {
          words: {
            schema: { type: "integer" },
            label: "Words",
            required: true,
            default: 1,
            sensitive: false,
          },
        },
      }),
      {
        code: "profile.invalid_value",
        pointer: "/document/metadata/grasp/params/words",
      },
    ],
    [
      "a parameter default its schema refuses",
      withGrasp({
        params: {
          words: {
            schema: { type: "integer", maximum: 10 },
            label: "Words",
            default: 11,
            sensitive: false,
          },
        },
      }),
      {
        code: "schema.invalid_default",
        pointer: "/document/metadata/grasp/params/words/default",
      },
    ],
    [
      "a limit above the host's ceiling",
      withGrasp({ limits: { maxSteps: 1001 } }),
      {
        code: "profile.limit_above_ceiling",
        pointer: "/document/metadata/grasp/limits/maxSteps",
      },
    ],
    [
      "a URL as a contract",
      withGrasp({
        bindings: {
          loadNote: {
            kind: "operation",
            contract: "https://example.com/notes",
          },
        },
      }),
      {
        code: "profile.invalid_value",
        pointer: "/document/metadata/grasp/bindings/loadNote/contract",
      },
    ],
    [
      "a contract the catalog doesn't have",
      withGrasp({
        bindings: { loadNote: { kind: "operation", contract: "notes.delete" } },
      }),
      {
        code: "binding.unknown_contract",
        pointer: "/document/metadata/grasp/bindings/loadNote/contract",
      },
    ],
    [
      "a contract of another kind",
      withGrasp({
        bindings: { loadNote: { kind: "connector", contract: "notes.get" } },
      }),
      {
        code: "binding.contract_mismatch",
        pointer: "/document/metadata/grasp/bindings/loadNote/kind",
      },
    ],
    [
      "a local module the manifest doesn't export",
      withGrasp({
        bindings: {
          loadNote: { kind: "compute", contract: "local:code/missing.ts#run" },
        },
      }),
      {
        code: "binding.unknown_contract",
        pointer: "/document/metadata/grasp/bindings/loadNote/contract",
      },
    ],
  ] as const)("refuses %s", async (_name, definition, expected) => {
    await expect(refusals(definition)).resolves.toContainEqual(
      expect.objectContaining(expected)
    );
  });

  it("warns about a binding nothing uses, and leaves it out of what it seals", async () => {
    const result = await validateWorkflow(
      JSON.stringify(probe([done])),
      options
    );
    // Advice, not an error: the definition still passes.
    expect(result.ok).toBeTruthy();
    const warnings = result.ok ? result.warnings : [];
    expect(
      warnings.map(({ code, pointer }) => ({ code, pointer }))
    ).toContainEqual({
      code: "binding.unreferenced",
      pointer: "/document/metadata/grasp/bindings/loadNote",
    });
    expect(result.ok ? result.workflow.bindings.size : undefined).toBe(0);
  });

  it("resolves local: keys only in the module manifest, and others only in the catalog", async () => {
    const shadow = withGrasp({
      bindings: {
        loadNote: { kind: "compute", contract: "local:code/total.ts#total" },
      },
    });
    const noModules = await validateWorkflow(JSON.stringify(shadow), {
      catalog: options.catalog,
    });
    expect(
      noModules.ok ? [] : noModules.diagnostics.map(({ code }) => code)
    ).toContain("binding.unknown_contract");
  });
});

describe("tasks and calls", () => {
  it.each([
    [
      "a raw protocol call",
      probe([
        {
          fetch: {
            call: "http",
            with: { method: "get", endpoint: "https://example.com" },
          },
        },
      ]),
      {
        code: "call.unsupported",
        pointer: "/do/0/fetch/call",
        taskId: "fetch",
      },
    ],
    [
      "an unknown named call",
      probe([{ fetch: { call: "grasp.fetch" } }]),
      {
        code: "call.unsupported",
        pointer: "/do/0/fetch/call",
        taskId: "fetch",
      },
    ],
    [
      "a shell run",
      probe([
        {
          sh: {
            run: { shell: { command: "ls" } },
            metadata: { grasp: { binding: "summaryChild" } },
          },
        },
      ]),
      {
        code: "profile.unsupported_feature",
        pointer: "/do/0/sh/run/shell",
        taskId: "sh",
      },
    ],
    [
      "a script run",
      probe([
        {
          js: {
            run: { script: { language: "js", code: "1" } },
            metadata: { grasp: { binding: "summaryChild" } },
          },
        },
      ]),
      {
        code: "profile.unsupported_feature",
        pointer: "/do/0/js/run/script",
        taskId: "js",
      },
    ],
    [
      "a container run",
      probe([
        {
          box: {
            run: { container: { image: "alpine" } },
            metadata: { grasp: { binding: "summaryChild" } },
          },
        },
      ]),
      {
        code: "profile.unsupported_feature",
        pointer: "/do/0/box/run/container",
        taskId: "box",
      },
    ],
    [
      "an unknown task property",
      probe([{ finish: { set: { a: 1 }, retry: 3 } }]),
      {
        code: "profile.unknown_property",
        pointer: "/do/0/finish/retry",
        taskId: "finish",
      },
    ],
    [
      "a task with two kinds",
      probe([{ both: { set: { a: 1 }, wait: "PT1S" } }]),
      { code: "task.ambiguous_kind", pointer: "/do/0/both", taskId: "both" },
    ],
    [
      "a task ID that isn't kebab-case",
      probe([{ Finish: { set: { a: 1 } } }]),
      { code: "task.invalid_id", pointer: "/do/0/Finish", taskId: "Finish" },
    ],
    [
      "a task ID used twice in different scopes",
      probe([{ outer: { do: [{ finish: { set: { a: 1 } } }] } }, done]),
      { code: "task.duplicate_id", pointer: "/do/1/finish", taskId: "finish" },
    ],
    [
      "an empty task list",
      probe([{ outer: { do: [] } }]),
      { code: "task.empty_list", pointer: "/do/0/outer/do", taskId: "outer" },
    ],
    [
      "a binding that isn't declared",
      probe([
        {
          load: {
            call: "grasp.operation",
            with: { binding: "saveNote", arguments: {} },
          },
        },
      ]),
      {
        code: "binding.unknown",
        pointer: "/do/0/load/with/binding",
        taskId: "load",
      },
    ],
    [
      "a binding of the wrong kind",
      probe([
        {
          load: {
            call: "grasp.operation",
            with: { binding: "jobStatus", arguments: {} },
          },
        },
      ]),
      {
        code: "binding.wrong_kind",
        pointer: "/do/0/load/with/binding",
        taskId: "load",
      },
    ],
    [
      "a binding chosen by an expression",
      probe([
        {
          load: {
            call: "grasp.operation",
            with: { binding: "${ $params.which }", arguments: {} },
          },
        },
      ]),
      {
        code: "profile.invalid_value",
        pointer: "/do/0/load/with/binding",
        taskId: "load",
      },
    ],
    [
      "literal arguments the contract refuses",
      probe([
        {
          load: {
            call: "grasp.operation",
            with: { binding: "loadNote", arguments: { id: "not-an-id" } },
          },
        },
      ]),
      {
        code: "call.invalid_arguments",
        pointer: "/do/0/load/with/arguments/id",
        taskId: "load",
      },
    ],
    [
      "arguments missing a required field",
      probe([
        {
          load: {
            call: "grasp.operation",
            with: { binding: "loadNote", arguments: { other: "${ . }" } },
          },
        },
      ]),
      {
        code: "call.invalid_arguments",
        pointer: "/do/0/load/with/arguments",
        taskId: "load",
      },
    ],
    [
      "a connector operation the binding doesn't allow",
      probe([
        {
          poll: {
            call: "grasp.connector",
            with: { binding: "jobStatus", operation: "cancel", arguments: {} },
          },
        },
      ]),
      {
        code: "binding.contract_mismatch",
        pointer: "/do/0/poll/with/operation",
        taskId: "poll",
      },
    ],
    [
      "an event type the event binding doesn't admit",
      probe([
        {
          announce: {
            emit: { event: { with: { type: "grasp.job.deleted" } } },
            metadata: { grasp: { binding: "jobEvents" } },
          },
        },
      ]),
      {
        code: "binding.contract_mismatch",
        pointer: "/do/0/announce/emit/event/with/type",
        taskId: "announce",
      },
    ],
    [
      "a listen without a timeout",
      probe([
        {
          await: {
            listen: { to: { one: { with: { type: "grasp.job.completed" } } } },
            metadata: { grasp: { binding: "jobEvents" } },
          },
        },
      ]),
      {
        code: "profile.missing_property",
        pointer: "/do/0/await/timeout",
        taskId: "await",
      },
    ],
    [
      "a listen until a condition",
      probe([
        {
          await: {
            listen: {
              to: {
                any: [{ with: { type: "grasp.job.completed" } }],
                until: "${ true }",
              },
            },
            timeout: { after: { minutes: 1 } },
            metadata: { grasp: { binding: "jobEvents" } },
          },
        },
      ]),
      {
        code: "profile.unsupported_feature",
        pointer: "/do/0/await/listen/to/until",
        taskId: "await",
      },
    ],
    [
      "a child workflow other than the one the binding pins",
      probe([
        {
          child: {
            run: {
              workflow: {
                namespace: "grasp",
                name: "summarize-note",
                version: "1.0.1",
              },
            },
            metadata: { grasp: { binding: "summaryChild" } },
          },
        },
      ]),
      {
        code: "binding.contract_mismatch",
        pointer: "/do/0/child/run/workflow/version",
        taskId: "child",
      },
    ],
    [
      "a detached child",
      probe([
        {
          child: {
            run: {
              workflow: {
                namespace: "grasp",
                name: "summarize-note",
                version: "1.0.0",
              },
              await: false,
            },
            metadata: { grasp: { binding: "summaryChild" } },
          },
        },
      ]),
      {
        code: "profile.invalid_value",
        pointer: "/do/0/child/run/await",
        taskId: "child",
      },
    ],
    [
      "a raised authorization error",
      probe([
        {
          deny: {
            raise: { error: { type: "urn:grasp:error:denied", status: 403 } },
          },
        },
      ]),
      {
        code: "profile.invalid_value",
        pointer: "/do/0/deny/raise/error/status",
        taskId: "deny",
      },
    ],
    [
      "a raised error built from data",
      probe([
        {
          deny: {
            raise: {
              error: {
                type: "urn:grasp:error:denied",
                status: 409,
                title: "${ $workflow.input.noteId }",
              },
            },
          },
        },
      ]),
      {
        code: "profile.invalid_value",
        pointer: "/do/0/deny/raise/error/title",
        taskId: "deny",
      },
    ],
    [
      "a nested loop whose default variables the outer loop has",
      probe([
        {
          outer: {
            for: { in: "${ [1] }" },
            do: [{ inner: { for: { in: "${ [2] }" }, do: [done] } }],
          },
        },
      ]),
      {
        code: "profile.invalid_value",
        pointer: "/do/0/outer/do/0/inner/for",
        taskId: "inner",
      },
    ],
    [
      "a raised host error type",
      probe([
        {
          deny: {
            raise: {
              error: {
                type: "https://open-workflow-specification.org/spec/1.0.0/errors/runtime",
                status: 500,
              },
            },
          },
        },
      ]),
      {
        code: "profile.invalid_value",
        pointer: "/do/0/deny/raise/error/type",
        taskId: "deny",
      },
    ],
    [
      "a calendar wait",
      probe([{ pause: { wait: "P1M" } }]),
      {
        code: "profile.invalid_value",
        pointer: "/do/0/pause/wait",
        taskId: "pause",
      },
    ],
    [
      "a wait shorter than a millisecond",
      probe([{ pause: { wait: "PT0.0001S" } }]),
      {
        code: "profile.invalid_value",
        pointer: "/do/0/pause/wait",
        taskId: "pause",
      },
    ],
    [
      "a zero wait",
      probe([{ pause: { wait: { seconds: 0 } } }]),
      {
        code: "profile.invalid_value",
        pointer: "/do/0/pause/wait",
        taskId: "pause",
      },
    ],
    [
      "six attempts",
      probe([
        {
          guarded: {
            try: [done],
            catch: { retry: { limit: { attempt: { count: 6 } } } },
          },
        },
      ]),
      {
        code: "profile.invalid_value",
        pointer: "/do/0/guarded/catch/retry/limit/attempt/count",
        taskId: "guarded",
      },
    ],
    [
      "concurrency above 8",
      probe([
        {
          each: {
            for: { in: "${ [1, 2] }" },
            do: [done],
            metadata: { grasp: { concurrency: 9 } },
          },
        },
      ]),
      {
        code: "profile.invalid_value",
        pointer: "/do/0/each/metadata/grasp/concurrency",
        taskId: "each",
      },
    ],
    [
      "a loop variable that shadows a workflow variable",
      probe([
        { each: { for: { each: "context", in: "${ [1] }" }, do: [done] } },
      ]),
      {
        code: "profile.invalid_value",
        pointer: "/do/0/each/for/each",
        taskId: "each",
      },
    ],
    [
      "a function called with arguments",
      probe([{ read: { call: "read-job", with: { id: 1 } } }], {
        functions: { "read-job": { set: { a: 1 } } },
      }),
      {
        code: "profile.unknown_property",
        pointer: "/do/0/read/with",
        taskId: "read",
      },
    ],
  ] as const)("refuses %s", async (_name, definition, expected) => {
    await expect(refusals(definition)).resolves.toContainEqual(
      expect.objectContaining(expected)
    );
  });
});

describe("a child run's input", () => {
  const childRun = (input?: unknown) =>
    probe([
      {
        child: {
          run: {
            workflow: {
              namespace: "grasp",
              name: "summarize-note",
              version: "1.0.0",
              ...(input === undefined ? {} : { input }),
            },
          },
          metadata: { grasp: { binding: "summaryChild" } },
        },
      },
    ]);

  it("checks an omitted input against the child's contract", async () => {
    await expect(refusals(childRun())).resolves.toContainEqual(
      expect.objectContaining({
        code: "call.invalid_arguments",
        pointer: "/do/0/child/run/workflow",
        taskId: "child",
        reason: "value.required",
      })
    );
  });

  it("accepts an omitted input when the child's contract allows none", async () => {
    const optionalInput = JSON.stringify(
      v.object({ noteId: v.id("notes").optional() }).descriptor
    );
    const result = await validateWorkflow(JSON.stringify(childRun()), {
      ...options,
      catalog: (key) => {
        const contract = options.catalog(key);
        return key === "grasp/summarize-note/1.0.0" && contract !== undefined
          ? { ...contract, input: optionalInput }
          : contract;
      },
    });
    expect(result.ok ? [] : result.diagnostics).toStrictEqual([]);
  });

  it("checks literal parts nested among expressions", async () => {
    await expect(
      refusals(
        probe([
          {
            load: {
              call: "grasp.operation",
              with: {
                binding: "loadNote",
                arguments: {
                  id: "${ $workflow.input.noteId }",
                  extra: { a: 1 },
                },
              },
            },
          },
        ])
      )
    ).resolves.toContainEqual(
      expect.objectContaining({
        code: "call.invalid_arguments",
        pointer: "/do/0/load/with/arguments/extra",
      })
    );
  });
});

describe("control flow", () => {
  it.each([
    [
      "a backward transition",
      probe([
        { first: { set: { a: 1 } } },
        { second: { set: { a: 2 }, then: "first" } },
      ]),
      {
        code: "flow.backward_transition",
        pointer: "/do/1/second/then",
        taskId: "second",
      },
    ],
    [
      "a transition to itself",
      probe([{ again: { set: { a: 1 }, then: "again" } }]),
      {
        code: "flow.backward_transition",
        pointer: "/do/0/again/then",
        taskId: "again",
      },
    ],
    [
      "a transition into another scope",
      probe([
        { outer: { do: [{ inner: { set: { a: 1 } } }] } },
        { jump: { set: { a: 1 }, then: "inner" } },
      ]),
      {
        code: "flow.unknown_target",
        pointer: "/do/1/jump/then",
        taskId: "jump",
      },
    ],
    [
      "a transition out of a scope",
      probe([
        { outer: { do: [{ inner: { set: { a: 1 }, then: "finish" } }] } },
        done,
      ]),
      {
        code: "flow.unknown_target",
        pointer: "/do/0/outer/do/0/inner/then",
        taskId: "inner",
      },
    ],
    [
      "a named transition between fork branches",
      probe([
        {
          both: {
            fork: {
              branches: [
                { left: { set: { a: 1 }, then: "right" } },
                { right: { set: { a: 2 } } },
              ],
            },
          },
        },
      ]),
      {
        code: "flow.not_allowed",
        pointer: "/do/0/both/fork/branches/0/left/then",
        taskId: "left",
      },
    ],
    [
      "a switch without a default case",
      probe([
        {
          route: {
            switch: [
              { yes: { when: "${ $workflow.input.flag }", then: "finish" } },
            ],
          },
        },
        done,
      ]),
      {
        code: "flow.switch_default",
        pointer: "/do/0/route/switch",
        taskId: "route",
      },
    ],
    [
      "a switch whose default isn't last",
      probe([
        {
          route: {
            switch: [
              { otherwise: { then: "finish" } },
              { yes: { when: "${ $workflow.input.flag }", then: "finish" } },
            ],
          },
        },
        done,
      ]),
      {
        code: "flow.switch_default",
        pointer: "/do/0/route/switch",
        taskId: "route",
      },
    ],
    [
      "a switch branch that falls through into another",
      probe([
        {
          route: {
            switch: [
              {
                approve: {
                  when: "${ $workflow.input.flag }",
                  then: "approved",
                },
              },
              { reject: { then: "rejected" } },
            ],
          },
        },
        { approved: { set: { status: "approved" } } },
        { rejected: { set: { status: "rejected" } } },
      ]),
      {
        code: "flow.switch_fallthrough",
        pointer: "/do/0/route/switch/1/reject/then",
        taskId: "route",
      },
    ],
    [
      "a function that calls itself through another",
      probe([{ start: { call: "ping" } }], {
        functions: {
          ping: { call: "pong" },
          pong: { call: "ping" },
        },
      }),
      {
        code: "flow.cycle",
        pointer: "/use/functions/pong/call",
        taskId: "pong",
      },
    ],
    [
      "a switch case that continues into another case's branch",
      probe([
        {
          route: {
            switch: [
              {
                large: {
                  when: "${ $workflow.input.flag }",
                  then: "large-body",
                },
              },
              { small: { then: "continue" } },
            ],
          },
        },
        { "small-body": { set: { size: "small" } } },
        { "large-body": { set: { size: "large" } } },
      ]),
      {
        code: "flow.switch_fallthrough",
        pointer: "/do/0/route/switch/1/small/then",
        taskId: "route",
      },
    ],
    [
      "a branch whose catch continues into another branch",
      probe([
        {
          route: {
            switch: [
              { risky: { when: "${ $workflow.input.flag }", then: "attempt" } },
              { safe: { then: "safe-body" } },
            ],
          },
        },
        {
          attempt: {
            try: [{ "attempt-step": { set: { a: 1 } } }],
            catch: { then: "continue" },
            then: "end",
          },
        },
        { "safe-body": { set: { size: "safe" } } },
      ]),
      {
        code: "flow.switch_fallthrough",
        pointer: "/do/0/route/switch/1/safe/then",
        taskId: "route",
      },
    ],
    [
      "a switch with a condition of its own",
      probe([
        {
          route: {
            if: "${ $workflow.input.flag }",
            switch: [{ otherwise: { then: "finish" } }],
          },
        },
        done,
      ]),
      { code: "flow.not_allowed", pointer: "/do/0/route/if", taskId: "route" },
    ],
    [
      "a chain of function calls deeper than 16 scopes",
      probe([{ start: { call: "f-0" } }], {
        functions: Object.fromEntries(
          Array.from({ length: 6 }, (_, index) => [
            `f-${index}`,
            index === 5
              ? { set: { last: true } }
              : {
                  do: [
                    {
                      [`f-${index}-a`]: {
                        do: [{ [`f-${index}-b`]: { call: `f-${index + 1}` } }],
                      },
                    },
                  ],
                },
          ])
        ),
      }),
      {
        code: "task.scope_too_deep",
        pointer: "/do/0/start/call",
        taskId: "start",
      },
    ],
    [
      "a reusable function that branches to a task it can't see",
      probe([{ start: { call: "route" } }, done], {
        functions: {
          route: {
            switch: [
              { yes: { when: "${ $workflow.input.flag }", then: "finish" } },
              { otherwise: { then: "exit" } },
            ],
          },
        },
      }),
      {
        code: "flow.unknown_target",
        pointer: "/use/functions/route/switch/0/yes/then",
        taskId: "route",
      },
    ],
    [
      "a workflow that runs itself",
      {
        ...noteSummary,
        document: {
          ...noteSummary.document,
          metadata: {
            grasp: {
              ...noteSummary.document.metadata.grasp,
              bindings: {
                ...noteSummary.document.metadata.grasp.bindings,
                self: {
                  kind: "workflow",
                  contract: "grasp/summarize-note/1.0.0",
                },
              },
            },
          },
        },
        do: [
          ...noteSummary.do,
          {
            again: {
              run: {
                workflow: {
                  namespace: "grasp",
                  name: "summarize-note",
                  version: "1.0.0",
                },
              },
              metadata: { grasp: { binding: "self" } },
            },
          },
        ],
      },
      {
        code: "flow.cycle",
        pointer: "/do/5/again/run/workflow",
        taskId: "again",
      },
    ],
  ] as const)("refuses %s", async (_name, definition, expected) => {
    await expect(refusals(definition)).resolves.toContainEqual(
      expect.objectContaining(expected)
    );
  });

  it("allows a skipped raise to fall through, and joins after explicit branches", async () => {
    const result = await validateWorkflow(
      JSON.stringify(
        probe([
          {
            route: {
              switch: [
                {
                  approve: { when: "${ $workflow.input.flag }", then: "guard" },
                },
                { reject: { then: "rejected" } },
              ],
            },
          },
          {
            guard: {
              raise: { error: { type: "urn:grasp:error:x", status: 409 } },
            },
          },
          { rejected: { set: { status: "rejected" } } },
        ])
      ),
      options
    );
    expect(result.ok).toBeTruthy();
  });
});

describe("expressions", () => {
  it.each([
    [
      "a variable its stage doesn't have",
      probe([{ early: { if: "${ $output.ready }", set: { a: 1 } } }]),
      {
        code: "expression.unavailable_variable",
        pointer: "/do/0/early/if",
        taskId: "early",
      },
    ],
    [
      "$secrets",
      probe([{ leak: { set: { key: "${ $secrets.apiKey }" } } }]),
      {
        code: "expression.unavailable_variable",
        pointer: "/do/0/leak/set/key",
        taskId: "leak",
      },
    ],
    [
      "a builtin outside the profile",
      probe([{ clock: { set: { at: "${ now }" } } }]),
      {
        code: "expression.unsupported",
        pointer: "/do/0/clock/set/at",
        taskId: "clock",
      },
    ],
    [
      "a parameter that isn't declared",
      probe([{ size: { set: { words: "${ $params.maxWord }" } } }]),
      {
        code: "expression.unknown_reference",
        pointer: "/do/0/size/set/words",
        taskId: "size",
      },
    ],
    [
      "a workflow input field that isn't declared",
      probe([{ size: { set: { id: "${ $workflow.input.noteID }" } } }]),
      {
        code: "expression.unknown_reference",
        pointer: "/do/0/size/set/id",
        taskId: "size",
      },
    ],
    [
      "a condition that is certainly not a boolean",
      probe([{ size: { if: "${ $params.maxWords }", set: { a: 1 } } }]),
      {
        code: "expression.type_mismatch",
        pointer: "/do/0/size/if",
        taskId: "size",
      },
    ],
    [
      "a condition written as a literal",
      probe([{ size: { if: "true", set: { a: 1 } } }]),
      { code: "expression.expected", pointer: "/do/0/size/if", taskId: "size" },
    ],
    [
      "a loop over something that is certainly not an array",
      probe([
        { each: { for: { in: "${ $workflow.input.noteId }" }, do: [done] } },
      ]),
      {
        code: "expression.type_mismatch",
        pointer: "/do/0/each/for/in",
        taskId: "each",
      },
    ],
    [
      "a condition that is certainly null, read through a null parameter",
      probe([{ size: { if: "${ $params.nothing.flag }", set: { a: 1 } } }]),
      {
        code: "expression.type_mismatch",
        pointer: "/do/0/size/if",
        taskId: "size",
      },
    ],
    [
      "a wait from a parameter that is neither milliseconds nor an ISO duration",
      probe([{ pause: { wait: "${ $params.enabled }" } }]),
      {
        code: "expression.type_mismatch",
        pointer: "/do/0/pause/wait",
        taskId: "pause",
      },
    ],
    [
      "a wait that is certainly neither milliseconds nor an ISO duration",
      probe([{ pause: { wait: "${ $workflow.input.flag }" } }]),
      {
        code: "expression.type_mismatch",
        pointer: "/do/0/pause/wait",
        taskId: "pause",
      },
    ],
    [
      "${ } with whitespace around it, which upstream reads as an expression",
      probe([{ size: { set: { words: " ${ $params.maxWords }" } } }]),
      {
        code: "expression.expected",
        pointer: "/do/0/size/set/words",
        taskId: "size",
      },
    ],
    [
      "a padded condition",
      probe([{ size: { if: "${ true } ", set: { a: 1 } } }]),
      {
        code: "expression.expected",
        pointer: "/do/0/size/if",
        taskId: "size",
        remedy: "Write the expression as ${ … } with nothing around it.",
      },
    ],
    [
      "a padded event source",
      probe([
        {
          announce: {
            emit: {
              event: {
                with: {
                  type: "grasp.job.timeout",
                  source: " ${ $workflow.input.noteId }",
                },
              },
            },
            metadata: { grasp: { binding: "jobEvents" } },
          },
        },
      ]),
      {
        code: "expression.expected",
        pointer: "/do/0/announce/emit/event/with/source",
        taskId: "announce",
      },
    ],
    [
      "a padded wait",
      probe([{ pause: { wait: " ${ $params.maxWords }" } }]),
      {
        code: "expression.expected",
        pointer: "/do/0/pause/wait",
        taskId: "pause",
      },
    ],
    [
      "a rebound parameter that hides an undeclared one",
      probe([{ size: { set: { a: "${ $params.nope as $params | 1 }" } } }]),
      {
        code: "expression.unsupported",
        pointer: "/do/0/size/set/a",
        taskId: "size",
      },
    ],
    [
      "a rebound workflow variable that hides an undeclared input field",
      probe([
        {
          size: {
            set: { a: "${ $workflow.input.noteID as $workflow | 1 }" },
          },
        },
      ]),
      {
        code: "expression.unsupported",
        pointer: "/do/0/size/set/a",
        taskId: "size",
      },
    ],
    [
      "an error field a caught error doesn't have",
      probe([
        {
          guard: {
            try: [{ "guarded-step": { set: { a: 1 } } }],
            catch: {
              as: "failure",
              do: [{ report: { set: { a: "${ $failure.nope }" } } }],
            },
          },
        },
      ]),
      {
        code: "expression.unknown_reference",
        pointer: "/do/0/guard/catch/do/0/report/set/a",
        taskId: "report",
      },
    ],
    [
      "an error field a caught error doesn't have, in catch.when",
      probe([
        {
          guard: {
            try: [{ "guarded-step": { set: { a: 1 } } }],
            catch: { as: "failure", when: "${ $failure.code == 503 }" },
          },
        },
      ]),
      {
        code: "expression.unknown_reference",
        pointer: "/do/0/guard/catch/when",
        taskId: "guard",
      },
    ],
    [
      "a catch variable outside its catch",
      probe([
        {
          guard: {
            try: [{ "guarded-step": { set: { a: 1 } } }],
            catch: { as: "failure" },
          },
        },
        { after: { set: { a: "${ $failure.status }" } } },
      ]),
      {
        code: "expression.unavailable_variable",
        pointer: "/do/1/after/set/a",
        taskId: "after",
      },
    ],
    [
      "a loop variable outside its loop",
      probe([
        { each: { for: { each: "item", in: "${ [1] }" }, do: [done] } },
        { after: { set: { a: "${ $item }" } } },
      ]),
      {
        code: "expression.unavailable_variable",
        pointer: "/do/1/after/set/a",
        taskId: "after",
      },
    ],
  ] as const)("refuses %s", async (_name, definition, expected) => {
    await expect(refusals(definition)).resolves.toContainEqual(
      expect.objectContaining(expected)
    );
  });

  it("leaves what it can't prove to run-time validation", async () => {
    const result = await validateWorkflow(
      JSON.stringify(
        probe([
          {
            dynamic: {
              if: "${ $context.anything.at.all }",
              set: { a: "${ $params | keys }" },
            },
          },
          {
            literal: {
              set: { text: "$ { not an expression }", note: "${ .x } total" },
            },
          },
        ])
      ),
      options
    );
    expect(result.ok).toBeTruthy();
    const compiled = result.ok ? [...result.workflow.expressions.keys()] : [];
    expect(compiled).toStrictEqual(["/do/0/dynamic/if", "/do/0/dynamic/set/a"]);
  });

  it("gives an expression error the message its family states", async () => {
    const [refusal] = await refusals(
      probe([{ clock: { set: { at: "${ now }" } } }])
    );
    expect(refusal?.message).toBe(
      expressionErrors.create("expression.unsupported").message
    );
  });

  it("reads a caught error's fields in catch.when and catch.do", async () => {
    await expect(
      refusals(
        probe([
          {
            guard: {
              try: [{ "guarded-step": { set: { a: 1 } } }],
              catch: {
                as: "failure",
                when: "${ $failure.status == 503 }",
                do: [
                  {
                    report: {
                      set: {
                        type: "${ $failure.type }",
                        detail: "${ $failure.detail }",
                        status: "${ $failure.status }",
                      },
                    },
                  },
                ],
              },
            },
          },
        ])
      )
    ).resolves.toStrictEqual([]);
  });

  it("takes a duration expression of whole milliseconds or an ISO 8601 duration", async () => {
    await expect(
      refusals(
        probe([
          { "pause-ms": { wait: "${ $params.maxWords }" } },
          { "pause-text": { wait: "${ $params.delay }" } },
          {
            "pause-iso": {
              wait: '${ "PT" + ($params.maxWords | tostring) + "S" }',
            },
          },
        ])
      )
    ).resolves.toStrictEqual([]);
  });

  it("reads a field of a null parameter as null, as jq does", async () => {
    await expect(
      refusals(probe([{ size: { set: { a: "${ $params.nothing.a.b }" } } }]))
    ).resolves.toStrictEqual([]);
  });

  it("never repeats a submitted key, name or value in a diagnostic's text", async () => {
    const marker = "echo7f3a";
    const diagnostics = await diagnose(
      probe([
        {
          load: {
            call: "grasp.operation",
            with: { binding: "loadNote", arguments: { id: marker } },
          },
        },
        { size: { set: { words: `\${ $params.${marker} }` } } },
        { field: { set: { id: `\${ $workflow.input.${marker} }` } } },
        { variable: { set: { a: `\${ $${marker} }` } } },
        {
          loop: {
            for: { each: `${marker}item`, at: `${marker}at`, in: "${ [1] }" },
            do: [{ "in-loop": { set: { a: "${ $nope }" } } }],
          },
        },
        {
          guard: {
            try: [{ "guarded-step": { set: { a: 1 } } }],
            catch: {
              as: `${marker}caught`,
              when: "${ $other }",
              do: [{ "in-catch": { set: { a: "${ $nope }" } } }],
            },
          },
        },
        { syntax: { set: { a: `\${ ${marker}( }` } } },
        { pause: { wait: `P${marker}` } },
        { extra: { set: { a: 1 }, [marker]: true } },
        {
          typed: {
            input: {
              schema: {
                format: "json",
                document: { type: "string", [marker]: 1 },
              },
            },
            set: { a: 1 },
          },
        },
      ])
    );
    expect(diagnostics.length).toBeGreaterThan(7);
    // The pointer says where; nothing else repeats the definition.
    const texts = diagnostics.map(({ pointer: _pointer, ...text }) => text);
    expect(JSON.stringify(texts)).not.toContain(marker);
  });
});

describe("inline data schemas", () => {
  const schemaOf = async (document: unknown) => {
    const definition = documentAround(
      { name: "schema", input: { value: document }, required: [] },
      [done]
    );
    const result = await validateWorkflow(JSON.stringify(definition), options);
    if (!result.ok) {
      return { diagnostics: result.diagnostics };
    }
    const schema = result.workflow.schemas.get("/input/schema");
    if (schema === undefined) {
      throw new Error("the input schema should be compiled");
    }
    return { schema };
  };

  it("compiles to the SDK's own descriptor, and validates with its interpreter", async () => {
    const { schema } = await schemaOf({
      type: "object",
      properties: {
        noteId: {
          type: "string",
          "x-grasp-value": { kind: "id", table: "notes" },
        },
        words: { type: "integer", minimum: 1, maximum: 500, default: 120 },
        email: { type: "string", format: "email" },
        tone: { enum: ["plain", "formal"] },
        reply: { anyOf: [{ type: "string", maxLength: 10 }, { type: "null" }] },
      },
      required: ["noteId"],
      additionalProperties: false,
    });
    const expected = v.object({
      value: v
        .object({
          noteId: v.id("notes"),
          words: v.number().integer().min(1).max(500).default(120),
          email: v.string().email().optional(),
          tone: v.enum(["plain", "formal"]).optional(),
          reply: v.string().max(10).nullable().optional(),
        })
        .optional(),
    });
    expect(schema?.descriptor).toStrictEqual(expected.descriptor);
    const id = "01928f3a-7b2c-7d4e-8f00-1a2b3c4d5e6f";
    // Native normalization: the default is filled in, nothing is coerced.
    expect(
      schema?.["~standard"].validate({ value: { noteId: id } })
    ).toStrictEqual({
      value: { value: { noteId: id, words: 120 } },
    });
    expect(
      schema?.["~standard"].validate({ value: { noteId: id, words: "120" } })
    ).toHaveProperty("issues");
  });

  it.each([
    [
      { type: "object", properties: {} },
      "schema.open_object",
      "/additionalProperties",
    ],
    [{ $ref: "https://example.com/schema.json" }, "schema.external", "/$ref"],
    [{ allOf: [{ type: "string" }] }, "schema.unsupported_keyword", "/allOf"],
    [
      { type: "string", pattern: "^a" },
      "schema.unsupported_keyword",
      "/pattern",
    ],
    [
      { type: "array", items: [{ type: "string" }] },
      "schema.unsupported_keyword",
      "/items",
    ],
    [
      { type: "string", format: "uri" },
      "schema.unsupported_keyword",
      "/format",
    ],
    [{ type: ["string", "null"] }, "schema.invalid", "/type"],
    [
      { type: "string", minimum: 1 },
      "schema.keyword_not_applicable",
      "/minimum",
    ],
    [{ type: "integer", maximum: 2 ** 60 }, "schema.invalid", "/maximum"],
    [
      { type: "string", "x-grasp-value": { kind: "id" } },
      "schema.invalid",
      "/x-grasp-value/table",
    ],
    [
      { type: "integer", "x-grasp-value": { kind: "person" } },
      "schema.invalid",
      "/type",
    ],
    [
      { type: "array", items: { type: "string", default: "a" } },
      "schema.default_not_allowed",
      "/items/default",
    ],
    [
      {
        anyOf: [
          {
            type: "object",
            properties: { a: { type: "string", default: "x" } },
            additionalProperties: false,
          },
          {
            type: "object",
            properties: { b: { type: "string" } },
            additionalProperties: false,
          },
        ],
      },
      "schema.ambiguous_any_of",
      "/anyOf/1",
    ],
  ] as const)("refuses %j", async (document, code, at) => {
    const { diagnostics } = await schemaOf(document);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code,
        pointer: `/input/schema/document/properties/value${at}`,
      })
    );
  });

  it("accepts a const beside its own type, and refuses one beside another", async () => {
    const { schema } = await schemaOf({ type: "string", const: "fixed" });
    expect(schema?.["~standard"].validate({ value: "fixed" })).toStrictEqual({
      value: { value: "fixed" },
    });
    const { diagnostics } = await schemaOf({ type: "integer", const: "fixed" });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "schema.invalid",
        pointer: "/input/schema/document/properties/value/type",
      })
    );
  });

  it("refuses schemas nested past the SDK's depth, anyOf included", async () => {
    let arrays: unknown = { type: "string" };
    for (let level = 0; level < 40; level += 1) {
      arrays = { type: "array", items: arrays };
    }
    let wrappers: unknown = { type: "string" };
    for (let level = 0; level < 70; level += 1) {
      wrappers = { anyOf: [wrappers, { type: "null" }] };
    }
    for (const document of [arrays, wrappers]) {
      // oxlint-disable-next-line no-await-in-loop -- two cases, in order
      const { diagnostics } = await schemaOf(document);
      expect(diagnostics?.map(({ code }) => code)).toContain(
        "schema.too_large"
      );
    }
  });

  it("accepts an anyOf told apart by a required constant", async () => {
    const { schema } = await schemaOf({
      anyOf: [
        {
          type: "object",
          properties: {
            kind: { const: "a" },
            size: { type: "integer", default: 1 },
          },
          required: ["kind"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: { kind: { const: "b" }, size: { type: "integer" } },
          required: ["kind"],
          additionalProperties: false,
        },
      ],
    });
    expect(
      schema?.["~standard"].validate({ value: { kind: "b" } })
    ).toStrictEqual({
      value: { value: { kind: "b" } },
    });
  });

  it("refuses an external model output schema", async () => {
    const definition = probe([
      {
        draft: {
          call: "grasp.model",
          with: {
            binding: "summaryModel",
            instructions: "Summarize.",
            input: {},
            outputSchema: {
              format: "json",
              resource: { endpoint: "https://example.com/schema.json" },
            },
          },
        },
      },
    ]);
    await expect(refusals(definition)).resolves.toContainEqual(
      expect.objectContaining({
        code: "schema.external",
        pointer: "/do/0/draft/with/outputSchema/resource",
        taskId: "draft",
      })
    );
  });
});
