import { describe, expect, test } from "vite-plus/test";

import { lintServerCode } from "./server-lint.ts";

// The server code lint (server-lint.ts): a mutation that reads the clock
// or randomness is warned of, where it reads it; nothing else is.

const module = (body: string): Record<string, string> => ({
  "server/tasks.ts": `import { v } from "@grasp-os/sdk";
import { mutation, query, action } from "@server/_generated/server";

${body}
`,
});

const warned = (body: string) =>
  lintServerCode(module(body)).map(({ line, severity, message }) => ({
    line,
    severity,
    read: message.slice(0, message.indexOf(" answers")),
  }));

describe("a mutation's reads of the clock and randomness", () => {
  test("are warned of in a mutation's handler, each where it is", () => {
    expect(
      warned(`export const add = mutation({
  args: {},
  handler: async (ctx) => {
    const at = Date.now();
    const when = new Date();
    const id = crypto.randomUUID();
    return Math.random() + at + when.getTime() + id.length;
  },
});`)
    ).toStrictEqual([
      { line: 7, severity: "warning", read: "Date.now()" },
      { line: 8, severity: "warning", read: "new Date()" },
      { line: 9, severity: "warning", read: "randomUUID()" },
      { line: 10, severity: "warning", read: "Math.random()" },
    ]);
  });

  test("pass in queries, actions, a date it is given and code outside a handler", () => {
    expect(
      warned(`const startedAt = Date.now();
export const list = query({ args: {}, handler: () => Date.now() });
export const send = action({ args: {}, handler: () => Math.random() });
export const keep = mutation({
  args: { at: v.number() },
  handler: (_ctx, args) => new Date(args.at).toISOString() + String(startedAt),
});`)
    ).toStrictEqual([]);
  });
});
