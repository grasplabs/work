/* oxlint-disable unicorn/no-thenable -- `then` is Open Workflow's flow directive, not a promise */
/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { v } from "@grasp-os/sdk";
import { describe, expect, it } from "vite-plus/test";

import type { CatalogContract, ValidateOptions } from "../src/catalog.ts";
import { maxDiagnostics } from "../src/diagnostics.ts";
import { profileLimits } from "../src/limits.ts";
import { validateWorkflow } from "../src/validate.ts";
import { documentAround, noteSummary, options } from "./fixtures.ts";

// The threat model: a definition comes from an agent or a person, and the
// catalog and module manifest from host code. A hostile definition tries to
// make validation itself expensive (size, nesting, many tasks, long chains,
// cycles, many expressions, many diagnostics); a broken catalog tries to
// run code while it is read. Every bound refuses with a diagnostic, and
// nothing caller code holds is read twice or through a getter.

const codesOf = async (input: string | Uint8Array): Promise<string[]> => {
  const result = await validateWorkflow(input, options);
  return result.ok ? [] : result.diagnostics.map(({ code }) => code);
};

const tasksOf = (count: number, task: (index: number) => unknown): unknown[] =>
  Array.from({ length: count }, (_, index) => ({
    [`task-${index}`]: task(index),
  }));

const plain = (tasks: unknown[]) =>
  JSON.stringify(
    documentAround(
      { name: "limits", input: { n: { type: "integer" } }, required: [] },
      tasks
    )
  );

/** The descriptor of an empty object, as a catalog states one. */
const emptyObject = JSON.stringify(v.object({}).descriptor);

/** The fixture catalog, with `contract` as notes.get. */
const withContract = (contract: CatalogContract): ValidateOptions => ({
  catalog: (key) => (key === "notes.get" ? contract : options.catalog(key)),
});

describe("the definition's text", () => {
  it("refuses text over the byte limit before parsing it", async () => {
    const padded = `${" ".repeat(profileLimits.maxDefinitionBytes)}{}`;
    await expect(codesOf(padded)).resolves.toStrictEqual(["json.too_large"]);
    // Counted in UTF-8 bytes, not characters.
    const wide = `"${"é".repeat(profileLimits.maxDefinitionBytes / 2)}"`;
    await expect(codesOf(wide)).resolves.toStrictEqual(["json.too_large"]);
  });

  it("refuses nesting past the depth limit without recursing into it", async () => {
    const depth = profileLimits.maxDefinitionDepth + 1;
    await expect(
      codesOf(`${"[".repeat(depth)}${"]".repeat(depth)}`)
    ).resolves.toStrictEqual(["json.too_deep"]);
    // Far deeper than any stack: refused at the limit, not by a crash.
    await expect(codesOf("[".repeat(500_000))).resolves.toStrictEqual([
      "json.too_deep",
    ]);
  });

  it("refuses more values than the limit, however small each is", async () => {
    const many = `[${"0,".repeat(profileLimits.maxDefinitionValues)}0]`;
    await expect(codesOf(many)).resolves.toStrictEqual([
      "json.too_many_values",
    ]);
  });
});

describe("the definition's structure", () => {
  it("stops at the task limit", async () => {
    const tasks = tasksOf(profileLimits.maxTasks + 1, () => ({
      set: { a: 1 },
    }));
    await expect(codesOf(plain(tasks))).resolves.toContain("task.too_many");
  });

  it("stops at 16 scopes", async () => {
    let task: unknown = { set: { a: 1 } };
    for (let level = 0; level < profileLimits.maxScopes; level += 1) {
      task = { do: [{ [`level-${level}`]: task }] };
    }
    await expect(codesOf(plain([{ top: task }]))).resolves.toContain(
      "task.scope_too_deep"
    );
  });

  it("stops at the expression limit", async () => {
    const tasks = tasksOf(profileLimits.maxExpressions / 4 + 1, () => ({
      set: { a: "${ 1 }", b: "${ 2 }", c: "${ 3 }", d: "${ 4 }" },
    }));
    await expect(codesOf(plain(tasks))).resolves.toContain(
      "expression.too_many"
    );
  });

  it("checks a long chain of forward transitions one by one", async () => {
    const count = profileLimits.maxTasks;
    const tasks = tasksOf(count, (index) =>
      index + 1 < count
        ? { set: { a: index }, then: `task-${index + 1}` }
        : { set: { a: index } }
    );
    await expect(codesOf(plain(tasks))).resolves.toStrictEqual([]);
  });

  it("finds a cycle through many reusable functions", async () => {
    const count = profileLimits.maxFunctions;
    const functions: Record<string, unknown> = {};
    for (let index = 0; index < count; index += 1) {
      functions[`fn-${index}`] = { call: `fn-${(index + 1) % count}` };
    }
    const definition = JSON.stringify(
      documentAround(
        { name: "cycle", input: {}, required: [], use: { functions } },
        [{ start: { call: "fn-0" } }]
      )
    );
    await expect(codesOf(definition)).resolves.toContain("flow.cycle");
  });

  it("never passes a definition because warnings filled the report", async () => {
    const bindings: Record<string, unknown> = {
      ...noteSummary.document.metadata.grasp.bindings,
    };
    for (let index = 0; index < 55; index += 1) {
      bindings[`unused${index}`] = { kind: "operation", contract: "notes.get" };
    }
    const withUnused = (tasks: unknown[]) =>
      JSON.stringify({
        ...noteSummary,
        document: {
          ...noteSummary.document,
          metadata: {
            grasp: { ...noteSummary.document.metadata.grasp, bindings },
          },
        },
        do: tasks,
      });
    const broken = await validateWorkflow(
      withUnused([
        ...noteSummary.do,
        { leak: { set: { a: "${ $secrets.key }" } } },
      ]),
      options
    );
    expect(broken.ok).toBeFalsy();
    expect(
      broken.ok ? [] : broken.diagnostics.map(({ code }) => code)
    ).toContain("expression.unavailable_variable");
    const fine = await validateWorkflow(withUnused(noteSummary.do), options);
    expect(fine.ok ? fine.warnings.length : 0).toBe(maxDiagnostics);
  });

  it("reports at most the diagnostic limit", async () => {
    const tasks = tasksOf(200, () => ({ set: { a: 1 }, bogus: true }));
    const result = await validateWorkflow(plain(tasks), options);
    expect(result.ok ? 0 : result.diagnostics.length).toBe(maxDiagnostics);
  });
});

describe("the host's catalog", () => {
  it("reads a contract through its own data properties, never a getter", async () => {
    let reads = 0;
    const contract: CatalogContract = {
      get kind() {
        reads += 1;
        return "operation" as const;
      },
    };
    const result = await validateWorkflow(
      JSON.stringify(noteSummary),
      withContract(contract)
    );
    expect(reads).toBe(0);
    expect(
      result.ok ? [] : result.diagnostics.map(({ code }) => code)
    ).toContain("binding.unknown_contract");
  });

  it("treats a catalog that throws, or a proxy, as no contract", async () => {
    const throwing = await validateWorkflow(JSON.stringify(noteSummary), {
      catalog: () => {
        throw new Error("catalog down: secret detail");
      },
    });
    expect(JSON.stringify(throwing)).not.toContain("secret detail");
    expect(throwing.ok).toBeFalsy();
    const proxy = new Proxy<CatalogContract>(
      { kind: "operation" },
      {
        getOwnPropertyDescriptor: () => {
          throw new Error("trap");
        },
      }
    );
    const proxied = await validateWorkflow(
      JSON.stringify(noteSummary),
      withContract(proxy)
    );
    expect(
      proxied.ok ? [] : proxied.diagnostics.map(({ code }) => code)
    ).toContain("binding.unknown_contract");
  });

  it("stops resolving contracts once their descriptors add up past the budget", async () => {
    // Each under the per-descriptor limit; 17 of them are over 4 MiB.
    const padded = `${JSON.stringify(v.object({ id: v.string() }).descriptor)}${" ".repeat(250_000)}`;
    const bindings: Record<string, unknown> = {};
    for (let index = 0; index < 17; index += 1) {
      bindings[`big${index}`] = { kind: "operation", contract: `big.${index}` };
    }
    const definition = {
      ...noteSummary,
      document: {
        ...noteSummary.document,
        metadata: {
          grasp: { ...noteSummary.document.metadata.grasp, bindings },
        },
      },
    };
    const result = await validateWorkflow(JSON.stringify(definition), {
      catalog: () => ({ kind: "operation", input: padded, output: padded }),
    });
    const unknown = result.ok
      ? []
      : result.diagnostics
          .filter(({ code }) => code === "binding.unknown_contract")
          .map(({ pointer }) => pointer);
    // Two descriptors a contract: the ninth runs out, and every one after it.
    expect(unknown[0]).toBe("/document/metadata/grasp/bindings/big8/contract");
    expect(unknown).toHaveLength(9);
  });

  it.each<[string, CatalogContract]>([
    ["operation", { kind: "operation", input: emptyObject }],
    ["compute", { kind: "compute", output: emptyObject }],
    ["connector", { kind: "connector" }],
    ["connector with no operations", { kind: "connector", operations: {} }],
    ["event", { kind: "event" }],
    ["event with no types", { kind: "event", eventTypes: [] }],
    ["workflow", { kind: "workflow", input: emptyObject, output: emptyObject }],
    ["decision", { kind: "decision", input: emptyObject }],
  ])(
    "refuses a %s contract without its required fields",
    async (_name, contract) => {
      const result = await validateWorkflow(
        JSON.stringify(noteSummary),
        withContract(contract)
      );
      expect(
        result.ok
          ? []
          : result.diagnostics.map(({ code, pointer }) => ({ code, pointer }))
      ).toContainEqual({
        code: "binding.unknown_contract",
        pointer: "/document/metadata/grasp/bindings/loadNote/contract",
      });
    }
  );

  it("refuses a definition's limits when the host gave no ceilings", async () => {
    const result = await validateWorkflow(JSON.stringify(noteSummary), {
      catalog: options.catalog,
    });
    expect(
      result.ok
        ? []
        : result.diagnostics.map(({ code, pointer }) => ({ code, pointer }))
    ).toContainEqual({
      code: "profile.limit_above_ceiling",
      pointer: "/document/metadata/grasp/limits/maxSteps",
    });
  });

  it("refuses oversized descriptors and too many event types", async () => {
    const huge = await validateWorkflow(
      JSON.stringify(noteSummary),
      withContract({ kind: "operation", input: " ".repeat(300 * 1024) })
    );
    expect(huge.ok).toBeFalsy();
    const events = await validateWorkflow(
      JSON.stringify(noteSummary),
      withContract({
        kind: "event",
        eventTypes: Array.from({ length: 65 }, (_, index) => `e${index}`),
      })
    );
    expect(
      events.ok ? [] : events.diagnostics.map(({ code }) => code)
    ).toContain("binding.unknown_contract");
  });
});
