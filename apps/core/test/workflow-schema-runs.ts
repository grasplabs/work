/** What the tests of grasp-workflow/2 runs on the run host share (workflow-schema-*.test.ts). */
import { appModuleName, generatedWorkflowEntry } from "@grasp-os/compiler";
import { checkWorkflow } from "@grasp-os/workflow-schema/check";
import { generateWorkflow } from "@grasp-os/workflow-schema/generate";
import { sealedTableSchema } from "@grasp-os/workflow-schema/sealed";
import { env } from "cloudflare:workers";

import { buildGeneratedWorkflow } from "../src/pages.ts";
import type { HostedSealedRun } from "../src/workflows/sealed-run.ts";

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
