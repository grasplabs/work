import { appLimits } from "@grasp-os/shared/app-limits";
import { appMaxOperations } from "@grasp-os/shared/function-limits";
import { describe, expect, test } from "vite-plus/test";

import { emptyDefinition } from "../src/definition.ts";
import {
  generatedServerSources,
  serverFunctionsOf,
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

describe("the functions a server module's syntax declares", () => {
  test("are each `export const` of a builder, public or internal by its builder", () => {
    expect(serverFunctionsOf({ tasks, "crm/deals": tasks })).toStrictEqual({
      "tasks.add": "public",
      "tasks.archive": "internal",
      "tasks.count": "internal",
      "tasks.list": "public",
      "tasks.purge": "internal",
      "tasks.sync": "public",
      "crm.deals.add": "public",
      "crm.deals.archive": "internal",
      "crm.deals.count": "internal",
      "crm.deals.list": "public",
      "crm.deals.purge": "internal",
      "crm.deals.sync": "public",
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
    expect(serverFunctionsOf({ other })).toStrictEqual({});
  });

  test("never hold a path a function can't have, nor a name a reference answers", () => {
    const named = `import { query } from "@server/_generated/server";
export const then = query({ args: {}, handler: async () => 1 });
export const name = query({ args: {}, handler: async () => 1 });
export const _hidden = query({ args: {}, handler: async () => 1 });
export const fine = query({ args: {}, handler: async () => 1 });
`;
    expect(
      serverFunctionsOf({ named, "v1.0/extra": named, "a/b/c/d": named })
    ).toStrictEqual({ "named.fine": "public" });
  });

  test("are none of a module that doesn't parse", () => {
    expect(
      serverFunctionsOf({ broken: "export const list = query({", tasks })
    ).toStrictEqual(serverFunctionsOf({ tasks }));
  });

  test("are the same for a module as long as an App's file may be, whatever was read before", () => {
    let large = `import { v } from "@grasp-os/sdk";\nimport { query } from "@server/_generated/server";\n`;
    for (let index = 0; large.length < appLimits.fileLength; index += 1) {
      large += declaration(index);
    }
    large = large.slice(0, large.lastIndexOf("export const"));
    const each = [1, 2, 3].map(
      () => Object.keys(serverFunctionsOf({ tasks, large })).length
    );
    expect({
      fits: large.length <= appLimits.fileLength,
      same: new Set(each).size,
      read: (each[0] ?? 0) > 100,
    }).toStrictEqual({ fits: true, same: 1, read: true });
  });

  test("are at most as many as an App may register, the same ones whatever order the modules come in", () => {
    const many = `import { query } from "@server/_generated/server";
${Array.from({ length: appMaxOperations }, (_, index) => `export const f${index} = query({ args: {}, handler: async () => 1 });`).join("\n")}
`;
    const one = serverFunctionsOf({ many, tasks });
    const other = serverFunctionsOf({ tasks, many });
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
      generatedServerSources({ tasks, "crm/deals": tasks }, definition)
    ).toStrictEqual(
      generatedServerSources({ "crm/deals": tasks, tasks }, definition)
    );
  });
});
