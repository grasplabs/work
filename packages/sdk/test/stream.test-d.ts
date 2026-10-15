// Compile-time guarantees of foreground streaming actions (spec 10.7.6),
// against the Notes fixture's generated references and its server
// constructors: `useStream` and `client.stream` take only a streaming
// action and infer its arguments, progress and result; the hook's view
// narrows by status; a streaming action's handler gets a typed `emit`,
// another action's has none, and no function runs a streaming action
// nested. Type-checked by `vp check`, never run: every
// `@ts-expect-error` must stay an error.
import { expectTypeOf } from "vite-plus/test";

import type { GraspClient } from "../src/client.ts";
import { v } from "../src/index.ts";
import { useStream } from "../src/react.ts";
import type { GraspError } from "../src/react.ts";
import { serverModule } from "../src/server.ts";
import { api } from "./notes/.grasp/references.ts";
import schema from "./notes/schema.ts";

declare const client: GraspClient;

export const useChecks = (): void => {
  const exported = useStream(api.notes.exportAll);
  expectTypeOf(exported.run({ format: "csv" })).toEqualTypeOf<
    Promise<string>
  >();
  expectTypeOf(exported.cancel()).toEqualTypeOf<Promise<void>>();
  if (exported.status === "running" || exported.status === "recovering") {
    expectTypeOf(exported.progress).toEqualTypeOf<{ done: number } | null>();
  }
  if (exported.status === "completed") {
    expectTypeOf(exported.output).toEqualTypeOf<string>();
  }
  if (exported.status === "failed") {
    expectTypeOf(exported.error).toEqualTypeOf<GraspError>();
  }
  if (exported.status === "idle") {
    // @ts-expect-error -- an idle stream has no progress yet
    void exported.progress;
  }
  // @ts-expect-error -- no output before it completed
  void exported.output;
  // @ts-expect-error -- the wrong input
  void exported.run({ format: "xml" });
  // @ts-expect-error -- there is no `isRunning` alias beside `status`
  void exported.isRunning;
  // @ts-expect-error -- an action that answers once has useAction
  void useStream(api.notes.tally);
  // @ts-expect-error -- a mutation doesn't stream
  void useStream(api.notes.create);
};

expectTypeOf(
  client.stream(
    api.notes.exportAll,
    { format: "json" },
    {
      onProgress: (progress) => {
        expectTypeOf(progress).toEqualTypeOf<{ done: number }>();
      },
    }
  )
).toEqualTypeOf<Promise<string>>();
// @ts-expect-error -- progress goes somewhere: onProgress is required
void client.stream(api.notes.exportAll, { format: "json" }, {});
// @ts-expect-error -- an action that answers once doesn't stream
void client.stream(api.notes.tally, {}, { onProgress: () => {} });
// @ts-expect-error -- a streaming action isn't run with client.action
void client.action(api.notes.exportAll, { format: "json" });

const { action } = serverModule(schema);

export const streamed = action({
  args: { topic: v.string() },
  returns: v.object({ text: v.string() }),
  stream: v.object({ text: v.string() }),
  handler: async (ctx, args) => {
    await ctx.emit({ text: args.topic });
    // @ts-expect-error -- progress follows the stream schema
    await ctx.emit({ text: 1 });
    return { text: args.topic };
  },
});

export const single = action({
  args: {},
  returns: v.null(),
  uses: [streamed],
  handler: async (ctx) => {
    // Only a streaming action emits.
    expectTypeOf(ctx).not.toHaveProperty("emit");
    // @ts-expect-error -- a streaming action isn't run nested
    await ctx.runAction(streamed, { topic: "x" });
    return null;
  },
});
