/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import type {
  WorkflowResourceRun,
  WorkflowResourceVersion,
} from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import type { Acting } from "../src/auth/identity.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
  workflowSource,
  workflowVersions,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { artifactKey } from "./sealed-apps.ts";
import { outcome, refusal, unique } from "./sign-in.ts";

// A JSON workflow's own compute modules (workflow-modules.ts,
// resource-compute.ts), from the threat model on GRA-271: a calculation
// runs in an isolate with nothing to reach, not even the clock or
// randomness; it imports its own files and the compute SDK alone; it is
// called only through the contract sealed with its version, on both
// sides; and what runs is exactly what was published.

/** A builder of the organization, as their session has them. */
const builder = async (): Promise<Acting> => {
  const userId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO organizations (id, name, slug, created_at) VALUES ('organization', 'Acme', 'acme', ?)"
    ).bind(Date.now()),
    env.DB.prepare(
      "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)"
    ).bind(userId, "Person", `${userId}@acme.test`, Date.now(), Date.now()),
    env.DB.prepare(
      "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, 'organization', ?, 'builder', ?)"
    ).bind(crypto.randomUUID(), userId, Date.now()),
  ]);
  return { userId, role: "builder", teams: [], staff: false };
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

/** A module summing whole numbers: `total`, a calculation, and a helper. */
const totalModule = `import { compute, v } from "@grasp-os/sdk/compute";
import { sum } from "./sum.ts";

export const total = compute({
  input: v.array(v.number().integer().min(0)).max(100),
  output: v.number().integer().min(0),
  handler: (amounts) => sum(amounts),
});
`;

const sumModule = `export const sum = (amounts: readonly number[]): number =>
  amounts.reduce((all, amount) => all + amount, 0);
`;

/** A module whose `total` answers what `body` (a handler's body) does. */
const moduleAnswering = (
  body: string,
  output = "v.number()"
): string => `import { compute, v } from "@grasp-os/sdk/compute";

export const total = compute({
  input: v.array(v.number().integer().min(0)).max(100),
  output: ${output},
  handler: (amounts) => {
    ${body}
  },
});
`;

/**
 * A definition of `name`: binding `total` to `contract`, a task that calls
 * it on `args`, and a task that answers its result as the status.
 */
const definitionOf = (
  name: string,
  {
    contract = "local:code/total.ts#total",
    args = "${ [1, 2, 3] }",
    version = "1.0.0",
  }: { contract?: string; args?: unknown; version?: string } = {}
): string =>
  JSON.stringify({
    document: {
      dsl: "1.0.3",
      namespace: workflowNamespace,
      name,
      version,
      title: name,
      metadata: {
        grasp: {
          profile: "grasp-open-workflow/1",
          params: {},
          bindings: { total: { kind: "compute", contract } },
        },
      },
    },
    input: { schema: objectSchema({ who: { type: "string" } }) },
    output: { schema: objectSchema({ status: { type: "string" } }) },
    do: [
      {
        add: {
          call: "grasp.compute",
          with: { binding: "total", arguments: args },
        },
      },
      { answer: { set: { status: "${ tostring }" } } },
    ],
  });

/** A new workflow of `by`'s, published once with `modules`. */
const published = async (
  by: Acting,
  modules: Record<string, string>,
  options?: Parameters<typeof definitionOf>[1]
) => {
  const workflow = await createWorkflowResource(env, by, `c-${unique()}`);
  await publishWorkflowVersion(env, by, workflow.id, {
    definition: definitionOf(workflow.name, options),
    basedOn: null,
    modules,
  });
  const [version] = await workflowVersions(env, by, workflow.id);
  return { workflow, version };
};

/** What publishing `modules` was refused with: its code and details. */
const publicationRefusal = async (
  by: Acting,
  modules: Record<string, string>,
  options?: Parameters<typeof definitionOf>[1]
) => {
  const error = await refusal(published(by, modules, options));
  return z
    .object({ code: z.string(), details: z.unknown().optional() })
    .parse(error);
};

/** Runs version 1 of workflow `id` for `by`: how it ended. */
const ran = async (by: Acting, id: string) => {
  const { runId } = await startWorkflow(
    env,
    { type: "person", person: by },
    id,
    { version: 1, input: { who: "Ada" }, key: unique() }
  );
  if (runId === null) {
    throw new Error("The start admitted no run");
  }
  const run: WorkflowResourceRun = await vi.waitFor(
    async () => {
      const found = await resourceRunFor(env, by, id, runId);
      expect(found.endedAt).not.toBeNull();
      return found;
    },
    { timeout: 30_000, interval: 100 }
  );
  return run.status === "completed"
    ? { status: run.status, output: run.output }
    : { status: run.status, code: run.error?.code };
};

/** A version's executable identity; empty for one that isn't executable. */
const hashOf = (version: WorkflowResourceVersion | undefined): string =>
  version?.build.executable === true ? version.build.hash : "";

const totalModules = {
  "code/total.ts": totalModule,
  "code/sum.ts": sumModule,
};

describe("a JSON workflow's compute modules", () => {
  it("runs a calculation of its own modules, sealed and exported with the version", async () => {
    const by = await builder();
    const { workflow, version } = await published(by, totalModules);
    expect(version?.build.executable).toBeTruthy();
    await expect(ran(by, workflow.id)).resolves.toStrictEqual({
      status: "completed",
      output: { status: "6" },
    });
    // The version exports its modules exactly as published.
    const { files } = await workflowSource(env, by, workflow.id, 1);
    expect(files["code/total.ts"]).toBe(totalModule);
    expect(files["code/sum.ts"]).toBe(sumModule);
  });

  it("refuses a module that imports a package, the runtime or another SDK entry", async () => {
    const by = await builder();
    for (const specifier of [
      "decimal.js",
      "cloudflare:workers",
      "@grasp-os/sdk/open-workflow",
      "@grasp-os/sdk/compute-runner",
      "@grasp-os/sdk",
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      const refused = await publicationRefusal(by, {
        "code/total.ts": `import * as other from ${JSON.stringify(specifier)};\n${totalModule.replace('import { sum } from "./sum.ts";', `const sum = (all: number[]) => all.length + Object.keys(other).length;`)}`,
      });
      expect(refused.code).toBe("workflow.modules_invalid");
      expect(JSON.stringify(refused.details)).toContain(specifier);
    }
  });

  it("refuses modules that don't type-check against the compute SDK", async () => {
    const by = await builder();
    const refused = await publicationRefusal(by, {
      "code/total.ts": moduleAnswering('return "six";', "v.number()"),
    });
    expect(refused.code).toBe("workflow.modules_invalid");
  });

  it("takes the clock and randomness away before a module's own code runs", async () => {
    const by = await builder();
    for (const captured of [
      "Date.now()",
      "new Date().getTime()",
      "Math.random()",
      "crypto.getRandomValues(new Uint8Array(4))[0]",
      "performance.now()",
      "new Intl.DateTimeFormat().format()",
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      const refused = await publicationRefusal(by, {
        "code/total.ts": `const taken = ${captured};\n${moduleAnswering("return amounts.length + Number(taken);")}`,
      });
      expect(refused.code).toBe("workflow.modules_invalid");
    }
  });

  it("fails a run whose calculation reaches for the clock, randomness, timers or the network", async () => {
    const by = await builder();
    for (const body of [
      "return Date.now();",
      "return Math.random();",
      "return crypto.getRandomValues(new Uint8Array(1))[0] ?? 0;",
      "return (Date.prototype.constructor as DateConstructor).now();",
      'return typeof fetch === "function" ? 1 : Number("x");',
      'return typeof setTimeout === "function" ? 1 : Number("x");',
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      const { workflow } = await published(by, {
        "code/total.ts": moduleAnswering(body),
      });
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      const ended = await ran(by, workflow.id);
      expect(ended.status).toBe("failed");
      expect(["workflow.compute_failed", "workflow.call_invalid"]).toContain(
        ended.code
      );
    }
  });

  it("fails a run whose calculation answers a promise, throws, or answers off its contract", async () => {
    const by = await builder();
    for (const [body, code] of [
      [
        "return Promise.resolve(6) as unknown as number;",
        "workflow.compute_failed",
      ],
      ['throw new Error("no");', "workflow.compute_failed"],
      ["return -1;", "workflow.call_invalid"],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      const { workflow } = await published(by, {
        "code/total.ts": moduleAnswering(body, "v.number().min(0)"),
      });
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      await expect(ran(by, workflow.id)).resolves.toStrictEqual({
        status: "failed",
        code,
      });
    }
  });

  it("checks a call's arguments against the sealed contract before running anything", async () => {
    const by = await builder();
    // Its handler would answer a valid count for any list: only the
    // check before the call stops a list of strings.
    const { workflow } = await published(
      by,
      { "code/total.ts": moduleAnswering("return amounts.length;") },
      { args: "${ [$workflow.input.who] }" }
    );
    await expect(ran(by, workflow.id)).resolves.toStrictEqual({
      status: "failed",
      code: "workflow.call_invalid",
    });
  });

  it("resolves local bindings against compute() exports only, never a lookalike or another module", async () => {
    const by = await builder();
    const lookalike = `export const total = {
  "~compute": { input: { kind: "array" }, output: { kind: "number" } },
  handler: (amounts: number[]) => amounts.length,
};
`;
    for (const [modules, contract] of [
      [{ "code/total.ts": lookalike }, "local:code/total.ts#total"],
      [totalModules, "local:code/sum.ts#sum"],
      [totalModules, "local:code/total.ts#missing"],
      [totalModules, "local:code/other.ts#total"],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      const refused = await publicationRefusal(by, modules, { contract });
      expect(refused.code).toBe("workflow.definition_invalid");
      expect(JSON.stringify(refused.details)).toContain(
        "binding.unknown_contract"
      );
    }
  });

  it("makes other modules another program, and another publication of the same version", async () => {
    const by = await builder();
    const first = await published(by, totalModules);
    const second = await published(by, {
      ...totalModules,
      "code/sum.ts": `${sumModule}// changed\n`,
    });
    expect(first.version?.build.executable).toBeTruthy();
    expect(second.version?.build.executable).toBeTruthy();
    expect(hashOf(first.version)).not.toBe(hashOf(second.version));
    // The same definition and semantic version with other modules is
    // refused; with the same modules, the saved version answers.
    const again = await outcome(
      publishWorkflowVersion(env, by, first.workflow.id, {
        definition: definitionOf(first.workflow.name),
        basedOn: 1,
        modules: { ...totalModules, "code/sum.ts": `${sumModule}// other\n` },
      })
    );
    expect(again).toBe("workflow.version_exists");
    const retried = await publishWorkflowVersion(env, by, first.workflow.id, {
      definition: definitionOf(first.workflow.name),
      basedOn: null,
      modules: totalModules,
    });
    expect(retried.version).toBe(1);
  });

  it("refuses to run a module whose sealed bytes were changed", async () => {
    const by = await builder();
    const { workflow } = await published(by, totalModules);
    const row = await env.DB.prepare(
      "SELECT manifest FROM workflow_resource_versions WHERE workflow_resource_id = ? AND version = 1"
    )
      .bind(workflow.id)
      .first<{ manifest: string }>();
    const { artifacts } = z
      .object({
        build: z.object({
          artifacts: z.array(
            z.object({ path: z.string(), sha256: z.string() })
          ),
        }),
      })
      .parse(JSON.parse(row?.manifest ?? "{}")).build;
    const compiled = artifacts.find(({ path }) =>
      path.startsWith("compute/app~code~total")
    );
    expect(compiled).toBeDefined();
    await env.FILES.put(
      artifactKey(compiled?.sha256 ?? ""),
      "export const total = 1;"
    );
    await expect(ran(by, workflow.id)).resolves.toStrictEqual({
      status: "failed",
      code: "workflow.version_corrupt",
    });
  });

  it("refuses modules past their bounds and paths outside code/", async () => {
    const by = await builder();
    for (const modules of [
      { "src/total.ts": totalModule },
      { "code/../total.ts": totalModule },
      Object.fromEntries(
        Array.from({ length: 33 }, (_, index) => [`code/m${index}.ts`, ""])
      ),
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      const refused = await publicationRefusal(by, modules);
      expect(refused.code).toBe("workflow.resource_invalid");
    }
  });
});
