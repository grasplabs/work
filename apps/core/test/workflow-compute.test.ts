import { workflowSdkModules } from "@grasp-os/compiler";
/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { platformLimits } from "@grasp-os/shared/platform-limits";
import { valueDepth } from "@grasp-os/shared/value-depth";
import { workflowModuleLimits } from "@grasp-os/shared/workflow-modules";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import type {
  WorkflowResourceRun,
  WorkflowResourceVersion,
} from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import type { Acting } from "../src/auth/identity.ts";
import { sandboxCpuHeader } from "../src/sandbox-headers.ts";
import { loadWorkflowBuild } from "../src/workflow-builds.ts";
import { jsonTextDepth, runCompute } from "../src/workflow-modules.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
  workflowSource,
  workflowVersions,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { callCompute } from "../src/workflows/resource-compute.ts";
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

/**
 * Ways module code could intercept what the clock wrappers hand on, each
 * an expression answering the current time, or throwing once it can't.
 */
const interceptions = [
  // A trap the proxy's handler lacks, looked up on `Object.prototype`.
  `(() => {
    let real: unknown;
    Reflect.set(Object.prototype, "has", (target: unknown) => {
      real = target;
      return false;
    });
    void ("x" in Date);
    Reflect.deleteProperty(Object.prototype, "has");
    if (typeof real !== "function") {
      throw new Error("no clock");
    }
    return (Reflect.construct(real, []) as Date).getTime();
  })()`,
  // `Reflect.construct`, replaced before `new Date(0)`.
  `(() => {
    let real: unknown;
    const original = Reflect.construct;
    Reflect.set(Reflect, "construct", (target: Function, args: unknown[]) => {
      real = target;
      return original(target, args);
    });
    void new Date(0);
    Reflect.set(Reflect, "construct", original);
    if (typeof real !== "function") {
      throw new Error("no clock");
    }
    return (original(real, []) as Date).getTime();
  })()`,
  // `Reflect.apply`, replaced before a date is formatted.
  `(() => {
    const found: unknown[] = [];
    const original = Reflect.apply;
    Reflect.set(Reflect, "apply", (fn: Function, self: unknown, args: unknown[]) => {
      found.push(fn);
      return original(fn, self, args);
    });
    const formatter = new Intl.DateTimeFormat();
    void formatter.format(0);
    Reflect.set(Reflect, "apply", original);
    for (const fn of found) {
      if (typeof fn === "function") {
        const bound: unknown = original(fn, formatter, []);
        if (typeof bound === "function") {
          const text: unknown = original(bound, undefined, []);
          if (typeof text === "string") {
            return text.length;
          }
        }
      }
    }
    throw new Error("no clock");
  })()`,
  // A date looked up on Array.prototype when none is given: to format,
  // and to format to parts.
  `(() => {
    Object.defineProperty(Array.prototype, "0", { value: 0, configurable: true });
    try {
      const text: unknown = Reflect.apply(Reflect.get(new Intl.DateTimeFormat(), "format"), undefined, []);
      if (typeof text !== "string") {
        throw new Error("no clock");
      }
      return text.length;
    } finally {
      Reflect.deleteProperty(Array.prototype, "0");
    }
  })()`,
  `(() => {
    Object.defineProperty(Array.prototype, "0", { value: 0, configurable: true });
    try {
      const formatter = new Intl.DateTimeFormat();
      const parts: unknown = Reflect.apply(Reflect.get(formatter, "formatToParts"), formatter, []);
      if (!Array.isArray(parts)) {
        throw new Error("no clock");
      }
      return parts.length;
    } finally {
      Reflect.deleteProperty(Array.prototype, "0");
    }
  })()`,
  // The platform's classes that read the clock, or make random values.
  'Number(Reflect.get(Reflect.construct(Reflect.get(globalThis, "File"), [[], "a"]), "lastModified"))',
  'Number(Reflect.get(Reflect.construct(Reflect.get(globalThis, "PerformanceMark"), ["a"]), "startTime"))',
  `(() => {
    const response: unknown = Reflect.construct(Reflect.get(globalThis, "Response"), [Reflect.construct(Reflect.get(globalThis, "FormData"), [])]);
    const headers: unknown = Reflect.get(Object(response), "headers");
    const type: unknown = Reflect.apply(Reflect.get(Object(headers), "get"), headers, ["content-type"]);
    if (typeof type !== "string") {
      throw new Error("no randomness");
    }
    return type.length;
  })()`,
];

/** `innermost` inside `levels` arrays, as JSON text. */
const nested = (levels: number, innermost: string): string =>
  `${"[".repeat(levels)}${innermost}${"]".repeat(levels)}`;

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
      ...interceptions,
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      const refused = await publicationRefusal(by, {
        "code/total.ts": `const taken = ${captured};\n${moduleAnswering("return amounts.length + Number(taken);")}`,
      });
      expect(refused.code).toBe("workflow.modules_invalid");
      // Refused as its code loaded, past the build and the type check.
      expect(JSON.stringify(refused.details)).toContain(
        "The modules failed as they loaded."
      );
    }
  });

  it("fails a run whose calculation reaches for the clock, randomness, timers or the network", async () => {
    const by = await builder();
    for (const body of [
      "return Date.now();",
      "return Math.random();",
      "return crypto.getRandomValues(new Uint8Array(1))[0] ?? 0;",
      "return (Date.prototype.constructor as DateConstructor).now();",
      // A proxy hands descriptor reads to its target.
      'return Number(Reflect.apply(Object.getOwnPropertyDescriptor(Date, "now")?.value, undefined, []));',
      'return typeof fetch === "function" ? 1 : Number("x");',
      'return typeof setTimeout === "function" ? 1 : Number("x");',
      // workerd keeps its platform globals on the global's prototype.
      'return typeof Reflect.get(Object.getPrototypeOf(globalThis), "setTimeout") === "function" ? 1 : Number("x");',
      'return typeof Reflect.get(Object.getPrototypeOf(globalThis), "fetch") === "function" ? 1 : Number("x");',
      'return typeof Reflect.get(Object.getPrototypeOf(globalThis), "WebSocket") === "function" ? 1 : Number("x");',
      // Generated code would import what the compiler never let it name.
      'return Number(Function("return 1")());',
      'return Number(Reflect.construct(Object.getPrototypeOf(async () => 0).constructor, ["return 1"]));',
      // What the clock wrappers hand on, intercepted.
      ...interceptions.map((intercept) => `return ${intercept};`),
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

  it("serializes a calculation's answer with what module code can't replace", async () => {
    const by = await builder();
    const { workflow } = await published(by, {
      "code/total.ts": `JSON.stringify = () => "{";\n${moduleAnswering("return amounts.length;")}`,
    });
    await expect(ran(by, workflow.id)).resolves.toStrictEqual({
      status: "completed",
      output: { status: "3" },
    });
  });

  it("refuses a thenable answer and reads exports with what module code can't replace", async () => {
    const by = await builder();
    // `Reflect.get` answering nothing would hide a promise's `then`.
    const hidden = await published(by, {
      "code/total.ts": `Reflect.set(Reflect, "get", () => undefined);\n${moduleAnswering("return Promise.resolve(6) as unknown as number;")}`,
    });
    await expect(ran(by, hidden.workflow.id)).resolves.toStrictEqual({
      status: "failed",
      code: "workflow.compute_failed",
    });
    // A `test` that matches nothing would hide every export.
    const unmatched = await published(by, {
      "code/total.ts": `RegExp.prototype.test = () => false;\n${moduleAnswering("return amounts.length;")}`,
    });
    await expect(ran(by, unmatched.workflow.id)).resolves.toStrictEqual({
      status: "completed",
      output: { status: "3" },
    });
  });

  it("counts an answer's depth as the SDK counts a value's", () => {
    // At the limit: an empty array 32 levels down, or a leaf 31 down, is
    // a value; one level more is not.
    const depths = Object.fromEntries(
      [
        "1",
        "[]",
        "[1]",
        '{"a":[]}',
        '{"a":"[[[{"}',
        '["\\"["]',
        nested(valueDepth, ""),
        nested(valueDepth - 1, "0"),
        nested(valueDepth, "0"),
      ].map((text) => [text, jsonTextDepth(text)])
    );
    expect(Object.values(depths)).toStrictEqual([
      1,
      1,
      2,
      2,
      2,
      2,
      valueDepth,
      valueDepth,
      valueDepth + 1,
    ]);
  });

  it("keeps dates a calculation is given working, a subclass of Date included", async () => {
    const by = await builder();
    const { workflow } = await published(by, {
      "code/total.ts": moduleAnswering(
        'class Stamp extends Date {}\n    const stamp = new Stamp(Date.UTC(2026, 0, amounts.length));\n    return stamp instanceof Stamp ? stamp.getUTCDate() : Number("x");'
      ),
    });
    await expect(ran(by, workflow.id)).resolves.toStrictEqual({
      status: "completed",
      output: { status: "3" },
    });
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
    // A module that patches the brand's registry before it exports one.
    const patched = `WeakMap.prototype.get = (() => (amounts: number[]) => amounts.length) as never;\n${lookalike}`;
    for (const [modules, contract] of [
      [{ "code/total.ts": lookalike }, "local:code/total.ts#total"],
      [{ "code/total.ts": patched }, "local:code/total.ts#total"],
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

  it("refuses code generated as a module loads", async () => {
    const by = await builder();
    for (const generated of [
      'Function("return 1")()',
      'eval("1")',
      '(() => 0).constructor("return 1")()',
      'Object.getPrototypeOf(function* () {}).constructor("yield 1")',
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      const refused = await publicationRefusal(by, {
        "code/total.ts": `const made: unknown = ${generated};\n${moduleAnswering("return amounts.length + (made === undefined ? 0 : 0);")}`,
      });
      expect(refused.code).toBe("workflow.modules_invalid");
      expect(JSON.stringify(refused.details)).toContain(
        "The modules failed as they loaded."
      );
    }
  });

  it("refuses an answer past a step's payload, or nested past a value's depth", async () => {
    const by = await builder();
    for (const [body, output] of [
      ['return "x".repeat(1_100_000);', "v.string()"],
      [
        "let deep: unknown[] = [];\n    for (let level = 0; level < 100_000; level += 1) {\n      deep = [deep];\n    }\n    return deep as never;",
        "v.array(v.number())",
      ],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      const { workflow } = await published(by, {
        "code/total.ts": moduleAnswering(body, output),
      });
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      await expect(ran(by, workflow.id)).resolves.toStrictEqual({
        status: "failed",
        code: "workflow.call_invalid",
      });
    }
  });

  it("refuses modules exporting more calculations, or larger contracts, than an inspection answers", async () => {
    const by = await builder();
    const many = `import { compute, v } from "@grasp-os/sdk/compute";\n${Array.from(
      { length: 257 },
      (_, index) =>
        `export const c${index} = compute({ input: v.number(), output: v.number(), handler: (n) => n });`
    ).join("\n")}\n`;
    const tooMany = await publicationRefusal(by, { "code/total.ts": many });
    expect(tooMany.code).toBe("workflow.modules_invalid");
    expect(JSON.stringify(tooMany.details)).toContain("more than 256");
    // Each contract within the SDK's bounds, past 1 MiB together.
    const fields = Array.from(
      { length: 5000 },
      (_, index) => `f${index}: v.string()`
    ).join(", ");
    const large = `import { compute, v } from "@grasp-os/sdk/compute";
const big = v.object({ ${fields} });
export const a = compute({ input: big, output: big, handler: (value) => value });
export const b = compute({ input: big, output: big, handler: (value) => value });
`;
    const tooLarge = await publicationRefusal(by, { "code/total.ts": large });
    expect(tooLarge.code).toBe("workflow.modules_invalid");
  });

  it('hands a calculation its input exactly, a "__proto__" key kept as its own', async () => {
    // A compiled module, as the build makes one, run directly: the host
    // refuses such a key in a contract's value before any call, so only
    // the request's own encoding is checked here.
    const sdk = await workflowSdkModules(env.ASSETS);
    const answer = await runCompute(
      env,
      {
        modules: {
          "app~code~keys.js": `import { compute, v } from "@grasp-os~sdk~compute.js";
export const keys = compute({ input: v.record(v.number()), output: v.array(v.string()), handler: (record) => Object.keys(record) });
`,
        },
        sdk: sdk.modules,
        paths: ["code/keys.ts"],
        module: "code/keys.ts",
        export: "keys",
        input: JSON.parse('{"__proto__": 1, "other": 2}'),
      },
      1024
    );
    expect(answer).toStrictEqual(["__proto__", "other"]);
  });

  it("answers a build of modules the sandbox host crashed as one to try again", async () => {
    const by = await builder();
    // A sandbox host whose supervisor reports every call crashed: the
    // load's doing, never the modules'.
    const crashing: Fetcher = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const sent = new Request(input, init);
        const { pathname } = new URL(sent.url);
        if (pathname === "/session") {
          const [client, server] = Object.values(new WebSocketPair());
          server?.accept();
          setTimeout(() => {
            server?.close(1011, "Crashed");
          }, 10);
          return await Promise.resolve(
            new Response(null, {
              status: 101,
              webSocket: client ?? null,
              headers: {
                [sandboxCpuHeader]: sent.headers.get(sandboxCpuHeader) ?? "",
              },
            })
          );
        }
        if (pathname.startsWith("/verdict/")) {
          return Response.json({
            verdict: "crashed",
            message: "Its process crashed.",
          });
        }
        return new Response(null, { status: 404 });
      },
      connect: () => {
        throw new Error("No sockets here");
      },
    };
    const workflow = await createWorkflowResource(env, by, `c-${unique()}`);
    const request = {
      definition: definitionOf(workflow.name),
      basedOn: null,
      // Modules no build has cached yet.
      modules: {
        ...totalModules,
        "code/sum.ts": `${sumModule}// ${unique()}\n`,
      },
    };
    const crashed = await outcome(
      publishWorkflowVersion(
        { ...env, SANDBOX_HOST: crashing },
        by,
        workflow.id,
        request
      )
    );
    const saved = await publishWorkflowVersion(env, by, workflow.id, request);
    expect({ crashed, executable: saved.build.executable }).toStrictEqual({
      crashed: "workflow.build_slow",
      executable: true,
    });
  });

  it("refuses a contract its version couldn't load, and loads every contract it publishes", async () => {
    const by = await builder();
    /** A module exporting `total` and `wide`, whose input has `fields` strings. */
    const wideModule = (fields: number) => `${totalModule}
const wideInput = v.object({ ${Array.from({ length: fields }, (_, index) => `f${index}: v.string()`).join(", ")} });
export const wide = compute({ input: wideInput, output: v.number(), handler: () => 0 });
`;
    // About 113 characters a field: 3000 fields are past the load's bound.
    const refused = await publicationRefusal(by, {
      "code/total.ts": wideModule(3000),
      "code/sum.ts": sumModule,
    });
    expect(refused.code).toBe("workflow.modules_invalid");
    expect(JSON.stringify(refused.details)).toContain(
      `more than ${workflowModuleLimits.descriptorChars} characters`
    );
    // 2000 are within it: published, it loads and runs.
    const { workflow } = await published(by, {
      "code/total.ts": wideModule(2000),
      "code/sum.ts": sumModule,
    });
    const build = await loadWorkflowBuild(env, workflow.id, 1);
    expect(build.compute.contracts.has("code/total.ts#wide")).toBeTruthy();
    await expect(ran(by, workflow.id)).resolves.toStrictEqual({
      status: "completed",
      output: { status: "6" },
    });
  });

  it("refuses arguments past what a step records before sending anything", async () => {
    const by = await builder();
    const half = Math.ceil(platformLimits.stepPayloadBytes / 2) + 1024;
    const args = [`\${ "x" * ${half} }`, `\${ "y" * ${half} }`];
    const modules = {
      "code/total.ts": `import { compute, v } from "@grasp-os/sdk/compute";
export const total = compute({ input: v.array(v.string()), output: v.number(), handler: (items) => items.length });
`,
    };
    const { workflow } = await published(by, modules, { args });
    await expect(ran(by, workflow.id)).resolves.toStrictEqual({
      status: "failed",
      code: "workflow.call_invalid",
    });
    // Directly, with a sandbox that fails any call made: none is.
    const build = await loadWorkflowBuild(env, workflow.id, 1);
    const noLoader: WorkerLoader = {
      get: () => {
        throw new Error("A sandbox call was made");
      },
      load: () => {
        throw new Error("A sandbox call was made");
      },
    };
    const unreachable: Env = {
      ...env,
      SANDBOX_HOST: undefined,
      LOADER: noLoader,
    };
    const code = await outcome(
      callCompute(
        unreachable,
        build.compute,
        build.sdk,
        {
          name: "grasp.compute",
          binding: "total",
          module: "code/total.ts",
          export: "total",
          arguments: { literal: [] },
        },
        ["x".repeat(half), "y".repeat(half)],
        Date.now() + 60_000
      )
    );
    expect(code).toBe("workflow.call_invalid");
  });

  it("refuses modules past their bounds and paths outside code/", async () => {
    const by = await builder();
    const padded = (chars: number) =>
      `${totalModule}// ${"x".repeat(chars - totalModule.length - 4)}\n`;
    for (const modules of [
      { "src/total.ts": totalModule },
      { "code/../total.ts": totalModule },
      Object.fromEntries(
        Array.from({ length: 33 }, (_, index) => [`code/m${index}.ts`, ""])
      ),
      // One module past 256 KiB.
      { "code/total.ts": padded(256 * 1024 + 1), "code/sum.ts": sumModule },
      // Each within it, past 1 MiB together.
      Object.fromEntries(
        Array.from({ length: 5 }, (_, index) => [
          `code/m${index}.ts`,
          padded(220 * 1024),
        ])
      ),
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      const refused = await publicationRefusal(by, modules);
      expect(refused.code).toBe("workflow.resource_invalid");
    }
  });
});
