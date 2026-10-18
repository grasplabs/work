// Compile-time guarantees of a workflow's own actions (GRA-704): a
// connector use declares the exact operations it calls, and
// `ctx.resources.<alias>.call` takes only those; an operation use takes
// its arguments alone. This file is type-checked by `vp check` and never
// run: every `@ts-expect-error` below must stay an error.
import { expectTypeOf } from "vite-plus/test";

import { action, resource, v } from "../src/action.ts";
import type { ActionCtx } from "../src/action.ts";
import type { JsonValue } from "../src/value-descriptor.ts";

const mail = resource.connector("mail", {
  operations: ["mail.send", "mail.list"],
});
const lookup = resource.operation("lookup");

declare const ctx: ActionCtx<readonly [typeof mail, typeof lookup]>;

expectTypeOf(ctx.resources.mail.call)
  .parameter(0)
  .toEqualTypeOf<"mail.list" | "mail.send">();
expectTypeOf(ctx.resources.lookup.call).parameters.toEqualTypeOf<[JsonValue]>();

// An operation the use didn't declare.
// @ts-expect-error -- only "mail.send" and "mail.list"
void ctx.resources.mail.call("mail.delete", {});

// A binding the action didn't declare.
// @ts-expect-error -- no such resource
void ctx.resources.archive;

// A connector use without its operations.
// @ts-expect-error -- operations are required
resource.connector("mail");

// An operation use names nothing more.
// @ts-expect-error -- an App export is one operation
resource.operation("lookup", { operations: ["x"] });

export const notify = action({
  args: { to: v.string() },
  returns: v.object({ sent: v.boolean() }),
  uses: [mail],
  handler: async (handlerCtx, args) => {
    await handlerCtx.resources.mail.call("mail.send", { to: args.to });
    return { sent: true };
  },
});
