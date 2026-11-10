/** What the tests of grasp-workflow/2 runs on the run host share (workflow-schema-*.test.ts). */
import { appModuleName, generatedWorkflowEntry } from "@grasp-os/compiler";
import { checkWorkflow } from "@grasp-os/workflow-schema/check";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { generateWorkflow } from "@grasp-os/workflow-schema/generate";
import { sealedTableSchema } from "@grasp-os/workflow-schema/sealed";
import { env } from "cloudflare:workers";

import { buildGeneratedWorkflow } from "../src/pages.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import type { HostedSealedRun } from "../src/workflows/sealed-run.ts";
import { person } from "./sealed-run-harness.ts";
import { unique } from "./sign-in.ts";

// grasp-workflow/2's generated code, run end to end on the run host
// (sealed-run.ts) with the sealed table its generator made: a real
// published workflow's run, its bindings approved and its sensitive token
// set, its build's module and table in place of the old generator's. So
// every step kind of the format runs as the host holds a sealed build to
// it, refused nothing as tampering: the calls go out as sealed, the
// sensitive value put in by the host, the model asked, the waits slept,
// the `if` taken, the raise failing the run and the catch taking it.

/** The permissions and the sensitive token of `sealedWorkflow`'s workflow. */
export const declared = {
  params: {
    token: { label: "Token", type: { kind: "string" }, sensitive: true },
  },
  permissions: {
    connections: { mail: { contract: "composio.mail@1" } },
    ai: { contract: "summary" },
  },
  /** What the workflow keeps between runs: what the state tests write. */
  state: {
    last: { kind: "string" },
    previous: { kind: "string" },
    runs: { kind: "number", integer: true, min: 1 },
    kind: { kind: "string" },
    never: { kind: "boolean" },
    who: { kind: "person" },
    profile: { kind: "object", fields: { id: { kind: "string" } } },
    // An object whose field has a default: `{}` fits it.
    badge: {
      kind: "object",
      fields: { label: { kind: "string", default: "unknown" } },
    },
  },
};

/** An object of `fields`, every one required. */
export const objectOf = (fields: Record<string, unknown>) => ({
  kind: "object",
  fields,
});

/** The input `sealedWorkflow`'s runs start with: whom to greet. */
export const greeted = objectOf({ who: { kind: "string" } });

/** An input of `rows`, each an `item`: what a loop's tests give a run. */
export const rowsOf = (item: unknown) =>
  objectOf({ rows: { kind: "array", item } });

/** Where a build of the generated module keeps it: as the host's own. */
export const generatedPath = generatedWorkflowEntry;

/**
 * `steps` and their `output` (its schema and value), generated: the
 * module, built as the host's generated workflow is (type-checked against the SDK,
 * its types stripped, its imports by their flat names), and the run with
 * its table. The module takes `input`, as its run is given it.
 */
export const generated = async (
  steps: unknown[],
  output?: { schema: unknown; value: unknown },
  permissions: Record<string, unknown> = declared.permissions,
  state: Record<string, unknown> = declared.state,
  input: unknown = greeted
) => {
  const result = checkWorkflow({
    $schema: "https://grasp.work/schemas/grasp-workflow/2.json",
    args: input,
    params: declared.params,
    permissions,
    state,
    ...(output === undefined
      ? {}
      : { returns: output.schema, result: output.value }),
    steps,
  });
  if (!result.ok) {
    throw new Error(`Not a valid workflow: ${JSON.stringify(result.problems)}`);
  }
  const generation = generateWorkflow(result.workflow);
  // The table as core seals it (tasks.json): its own schema reads it.
  const table = sealedTableSchema.parse(
    structuredClone({
      tasks: generation.tasks,
      expressions: generation.expressions,
      workflow: generation.workflow,
      params: generation.params,
    })
  );
  const build = await buildGeneratedWorkflow(
    env,
    { [generatedPath]: generation.source },
    "workflow-schema-runs"
  );
  const source = build.ok
    ? build.modules[appModuleName(generatedPath)]
    : undefined;
  if (source === undefined) {
    throw new Error(`Not built: ${JSON.stringify(build)}`);
  }
  return {
    source,
    sealed: (run: HostedSealedRun): HostedSealedRun => ({
      ...run,
      build: { ...run.build, ...table },
    }),
  };
};

/**
 * What an engine ran of try `guarded` around step `fail`, by `tries`:
 * the retry rounds its policy decided and ran, and whether the catch took
 * the failure and ran its `tell`.
 */
export const guardedRan = (tries: ReadonlyMap<string, number>) => {
  const keys = [...tries.keys()];
  // In a loop's items, a task's later runs go on with their count.
  const of = (step: string): string | undefined =>
    keys.find((key) => key === step || key.startsWith(`${step}@`));
  return {
    decided: keys.filter((key) => key.endsWith(":decide")).length,
    retried: keys.filter((key) => key.endsWith(":run")).length,
    failed: tries.get(of("key:fail:task") ?? ""),
    // Its catch ran its `do`: it took the failure.
    told: of("key:tell:task") !== undefined,
  };
};

/** A module of calculations: `total` sums, `broken` always fails. */
const totalModule = `import { compute, v } from "@grasp-os/sdk/compute";

export const total = compute({
  input: v.array(v.number()).max(100),
  output: v.number(),
  handler: (amounts) => amounts.reduce((all, amount) => all + amount, 0),
});

export const broken = compute({
  input: v.number(),
  output: v.number(),
  handler: () => {
    throw new Error("Never adds up");
  },
});
`;

/**
 * Actions that answer whom they noted, reaching nothing: `remark` also
 * says which of its arguments it was given, its `note` optional.
 */
const noteModule = `import { action, v } from "@grasp-os/sdk/action";

export const note = action({
  args: { to: v.string() },
  returns: v.object({ status: v.string() }),
  uses: [],
  handler: async (_ctx, { to }) => ({ status: \`noted \${to}\` }),
});

export const remark = action({
  args: { to: v.string(), note: v.string().optional() },
  returns: v.object({ given: v.array(v.string()) }),
  uses: [],
  handler: async (_ctx, args) => ({ given: Object.keys(args).sort() }),
});
`;

/** The permissions of `localWorkflow`'s workflow, as grasp-workflow/2 declares them. */
export const local = {
  modules: {
    total: { kind: "compute", contract: "local:code/total.ts#total" },
    broken: { kind: "compute", contract: "local:code/total.ts#broken" },
    note: { kind: "action", contract: "local:code/note.ts#note" },
    remark: { kind: "action", contract: "local:code/note.ts#remark" },
  },
};

/**
 * A workflow of a builder's whose bindings reach its own modules, compute
 * `total` and `broken` and action `note`, published with them: after an
 * hour's wait, it calls each.
 */
export const localWorkflow = async () => {
  const by = await person("builder");
  const workflow = await createWorkflowResource(env, by, `local-${unique()}`);
  await publishWorkflowVersion(env, by, workflow.id, {
    definition: JSON.stringify({
      $schema: workflowSchemaUrl,
      args: objectOf({ who: { kind: "string" } }),
      returns: objectOf({ status: { kind: "string" } }),
      result: { status: "done" },
      permissions: local,
      steps: [
        { id: "linger", type: "wait", for: "1 hour" },
        { id: "add", type: "call", module: "total", args: [1, 2, 3] },
        { id: "fail", type: "call", module: "broken", args: 1 },
        {
          id: "tell",
          type: "call",
          module: "note",
          args: { to: { $expr: "args.who" } },
        },
      ],
    }),
    basedOn: null,
    modules: { "code/total.ts": totalModule, "code/note.ts": noteModule },
  });
  return { by, workflow };
};

/** A step calling `broken`, which always fails. */
export const fail = { id: "fail", type: "call", module: "broken", args: 1 };
