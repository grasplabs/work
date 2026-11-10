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
export const purge = internalMutation({ args: {}, handler: async () => null });
`;

describe("the functions a server module's syntax declares", () => {
  test("are each `export const` of a builder, public or internal by its builder", () => {
    expect(serverFunctionsOf({ tasks, "crm/deals": tasks })).toStrictEqual({
      "tasks.add": "public",
      "tasks.count": "internal",
      "tasks.list": "public",
      "tasks.purge": "internal",
      "tasks.sync": "public",
      "crm.deals.add": "public",
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

  test("make the same generated modules whatever order the modules come in", () => {
    const definition = emptyDefinition("Tasks");
    expect(
      generatedServerSources({ tasks, "crm/deals": tasks }, definition)
    ).toStrictEqual(
      generatedServerSources({ "crm/deals": tasks, tasks }, definition)
    );
  });
});
