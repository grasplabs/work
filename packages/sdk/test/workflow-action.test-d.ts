// Compile-time guarantees of a workflow's own actions (GRA-704, GRA-700):
// a connector use declares the exact operations it calls, and
// `ctx.resources.<alias>.call` takes only those; an operation use takes
// its arguments alone; a model use's `generate` answers the shape it
// declared, and takes instructions and an input alone. This file is type-checked by `vp check` and never
// run: every `@ts-expect-error` below must stay an error.
import { expectTypeOf } from "vite-plus/test";

import { action, resource, v } from "../src/action.ts";
import type {
  ActionCtx,
  KnowledgeDocument,
  KnowledgeHit,
  ModelRequest,
  RunFile,
  TemplateContent,
} from "../src/action.ts";
import type { JsonValue } from "../src/value-descriptor.ts";

const mail = resource.connector("mail", {
  operations: ["mail.send", "mail.list"],
});
const lookup = resource.operation("lookup");
const writer = resource.model("writer", {
  output: v.object({ line: v.string(), score: v.number() }),
});

const docs = resource.knowledge("docs", { operations: ["search"] });
const letter = resource.template("letter");

declare const ctx: ActionCtx<
  readonly [
    typeof mail,
    typeof lookup,
    typeof writer,
    typeof docs,
    typeof letter,
  ]
>;

expectTypeOf(ctx.resources.docs.search).returns.resolves.toEqualTypeOf<
  KnowledgeHit[]
>();
expectTypeOf(
  ctx.resources.letter.read
).returns.resolves.toEqualTypeOf<TemplateContent>();

// A knowledge operation the use didn't declare.
// @ts-expect-error -- only "search"
void ctx.resources.docs.read;

// A knowledge use calls only search and read.
// @ts-expect-error -- no such operation
resource.knowledge("docs", { operations: ["delete"] });

// A files use: only the operations it declares (GRA-724).
const files = resource.files("files", { operations: ["write", "read"] });
declare const filing: ActionCtx<readonly [typeof files]>;
expectTypeOf(
  filing.resources.files.write
).returns.resolves.toEqualTypeOf<RunFile>();
expectTypeOf(
  filing.resources.files.read({ file: "f", as: "bytes" })
).resolves.toEqualTypeOf<Uint8Array>();
expectTypeOf(
  filing.resources.files.read({ file: "f" })
).resolves.toEqualTypeOf<string>();
// @ts-expect-error -- "list" isn't declared
void filing.resources.files.list;
// @ts-expect-error -- a files use writes, reads, lists or deletes
resource.files("files", { operations: ["append"] });
type FileWrite = Parameters<typeof filing.resources.files.write>[0];
// @ts-expect-error -- only the run file types
const html: FileWrite["type"] = "text/html";
void html;

declare const reading: ActionCtx<
  readonly [ReturnType<typeof resource.knowledge<"docs", "read">>]
>;
expectTypeOf(
  reading.resources.docs.read
).returns.resolves.toEqualTypeOf<KnowledgeDocument>();

expectTypeOf(ctx.resources.mail.call)
  .parameter(0)
  .toEqualTypeOf<"mail.list" | "mail.send">();
expectTypeOf(ctx.resources.lookup.call).parameters.toEqualTypeOf<[JsonValue]>();

expectTypeOf(ctx.resources.writer.generate).parameters.toEqualTypeOf<
  [ModelRequest]
>();
expectTypeOf(ctx.resources.writer.generate).returns.resolves.toEqualTypeOf<{
  line: string;
  score: number;
}>();

// A model use has no `call`.
// @ts-expect-error -- a model is asked with `generate`
void ctx.resources.writer.call;

// A model use without the shape of its answers.
// @ts-expect-error -- output is required
resource.model("writer");

// A model request names no model.
// @ts-expect-error -- instructions and an input alone
void ctx.resources.writer.generate({ instructions: "x", input: 1, model: "m" });

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
