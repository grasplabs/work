import { appLimits } from "@grasp-os/shared/app-limits";
import { appMaxOperations } from "@grasp-os/shared/function-limits";
import { describe, expect, test } from "vite-plus/test";

import { emptyDefinition } from "../src/definition.ts";
import { parseProgram } from "../src/oxc-parse.ts";
import { declaredFunctionsIn } from "../src/server-modules.ts";
import type { Declared } from "../src/server-modules.ts";
import {
  generatedServerSources,
  serverFunctionsIn,
} from "../src/server-syntax.ts";

// The functions an App's server modules declare, read from their syntax
// alone, as `server/_generated/` is made from them on every save: a
// parser's reading, so unit tests. That a seal refuses a function this
// doesn't read, and a stale copy, is core's (app-generated.test.ts).

const tasks = `import { v } from "@grasp-os/sdk";
import { action, internalMutation, internalQuery, mutation, query } from "@server/_generated/server";

export const list = query({ args: {}, handler: async () => [] });
export const add = mutation({ args: { title: v.string() }, handler: async () => null });
export const sync = action({ args: {}, handler: async () => null });
export const count = internalQuery({ args: {}, handler: async () => 0 });
export const purge = internalMutation({ args: {}, handler: async () => null }) satisfies object;
export const archive = (<object>internalMutation({ args: {}, handler: async () => null }));
`;

/** A query of a few lines, numbered `index`. */
const declaration = (
  index: number
): string => `export const list${index} = query({
  args: { id: v.id("tasks"), done: v.boolean() },
  handler: async (ctx, { done }) =>
    await ctx.db.query("tasks").withIndex("by_done", (q) => q.eq("done", done)).collect(),
});
`;

/** A module of queries `list0`… up to `length` characters, and their names. */
const moduleOf = (length: number): { source: string; names: string[] } => {
  let source = `import { v } from "@grasp-os/sdk";\nimport { query } from "@server/_generated/server";\n`;
  const names: string[] = [];
  for (let index = 0; ; index += 1) {
    const next = declaration(index);
    if (source.length + next.length > length) {
      return { source, names };
    }
    source += next;
    names.push(`list${index}`);
  }
};
/** What the parser itself reads of `source`, past any cache of reads. */
const read = (source: string): [string, Declared][] => [
  ...declaredFunctionsIn(parseProgram(source, "ts").program),
];

describe("the functions a server module's syntax declares", () => {
  test("are each `export const` of a builder, public or internal by its builder", () => {
    expect(
      serverFunctionsIn({
        "server/tasks.ts": tasks,
        "server/crm/deals.ts": tasks,
      })
    ).toStrictEqual({
      "tasks.add": { kind: "mutation", visibility: "public" },
      "tasks.archive": { kind: "mutation", visibility: "internal" },
      "tasks.count": { kind: "query", visibility: "internal" },
      "tasks.list": { kind: "query", visibility: "public" },
      "tasks.purge": { kind: "mutation", visibility: "internal" },
      "tasks.sync": { kind: "action", visibility: "public" },
      "crm.deals.add": { kind: "mutation", visibility: "public" },
      "crm.deals.archive": { kind: "mutation", visibility: "internal" },
      "crm.deals.count": { kind: "query", visibility: "internal" },
      "crm.deals.list": { kind: "query", visibility: "public" },
      "crm.deals.purge": { kind: "mutation", visibility: "internal" },
      "crm.deals.sync": { kind: "action", visibility: "public" },
    });
  });

  test("leave out what isn't a builder's call by name, which a seal then refuses", () => {
    const other = `import { query } from "@server/_generated/server";
const q = query;
const hidden = query({ args: {}, handler: async () => 1 });
export const aliased = q({ args: {}, handler: async () => 1 });
export const wrapped = Object.freeze(query({ args: {}, handler: async () => 1 }));
export { hidden };
export const limit = 10;
export declare const declared: ReturnType<typeof query>;
export type Row = { id: string };
export function helper() { return 1; }
`;
    expect(serverFunctionsIn({ "server/other.ts": other })).toStrictEqual({});
  });

  test("never hold a path a function can't have, nor a name a reference answers", () => {
    const named = `import { query } from "@server/_generated/server";
export const then = query({ args: {}, handler: async () => 1 });
export const name = query({ args: {}, handler: async () => 1 });
export const _hidden = query({ args: {}, handler: async () => 1 });
export const fine = query({ args: {}, handler: async () => 1 });
`;
    expect(
      serverFunctionsIn({
        "server/named.ts": named,
        "server/v1.0/extra.ts": named,
        "server/a/b/c/d.ts": named,
      })
    ).toStrictEqual({ "named.fine": { kind: "query", visibility: "public" } });
  });

  test("are none of a module nested too deep to read, and never fail the read", () => {
    const deep = `import { query } from "@server/_generated/server";
export const list = query({ args: {}, handler: async () => 1 });
export const sum = ${"a+".repeat(10_000)}a;
`;
    expect(
      serverFunctionsIn({ "server/deep.ts": deep, "server/tasks.ts": tasks })
    ).toStrictEqual(serverFunctionsIn({ "server/tasks.ts": tasks }));
  });

  test("are none of a module that doesn't parse", () => {
    expect(
      serverFunctionsIn({
        "server/broken.ts": "export const list = query({",
        "server/tasks.ts": tasks,
      })
    ).toStrictEqual(serverFunctionsIn({ "server/tasks.ts": tasks }));
  });

  test("are the same for a module as long as an App's file may be, whatever the parser read before", () => {
    const largest = moduleOf(appLimits.fileLength);
    const expected = largest.names.map((name): [string, Declared] => [
      name,
      { kind: "query", visibility: "public" },
    ]);
    const others = [0.85, 0.9, 0.95].map(
      (share) => moduleOf(Math.floor(appLimits.fileLength * share)).source
    );
    const reads = [
      read(largest.source),
      ...others.map((source) => read(source).length),
      read(largest.source),
      read(largest.source),
    ];
    expect({
      fits: largest.source.length <= appLimits.fileLength,
      first: reads[0],
      after: reads.slice(-2),
    }).toStrictEqual({
      fits: true,
      first: expected,
      after: [expected, expected],
    });
  });

  test("are at most as many as an App may register, the same ones whatever order the modules come in", () => {
    const many = `import { query } from "@server/_generated/server";
${Array.from({ length: appMaxOperations }, (_, index) => `export const f${index} = query({ args: {}, handler: async () => 1 });`).join("\n")}
`;
    const one = serverFunctionsIn({
      "server/many.ts": many,
      "server/tasks.ts": tasks,
    });
    const other = serverFunctionsIn({
      "server/tasks.ts": tasks,
      "server/many.ts": many,
    });
    expect({
      count: Object.keys(one).length,
      same:
        Object.keys(one).toSorted().join(",") ===
        Object.keys(other).toSorted().join(","),
      first: Object.keys(one).filter((path) => path.startsWith("tasks."))
        .length,
    }).toStrictEqual({ count: appMaxOperations, same: true, first: 0 });
  });

  test("make the same generated modules whatever order the modules come in", () => {
    const definition = emptyDefinition("Tasks");
    expect(
      generatedServerSources(
        { "server/tasks.ts": tasks, "server/crm/deals.ts": tasks },
        definition
      )
    ).toStrictEqual(
      generatedServerSources(
        { "server/crm/deals.ts": tasks, "server/tasks.ts": tasks },
        definition
      )
    );
  });
});
