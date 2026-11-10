// Compile-time guarantees of a workflow declaration (`permission.workflow`,
// spec 7.4, 10.4.1) and the reference generated from it: the App declares
// what a run returns beside the args it takes, both required; and the
// reference its pages get (`workflows.<alias>` in `@server/_generated/api`, generated
// from the Notes fixture's declarations) takes and gives exactly what the
// declaration does. Type-checked by `vp check`, never run: every
// `@ts-expect-error` must stay an error.
import { expectTypeOf } from "vite-plus/test";

import { permission, v } from "../src/index.ts";
import type {
  WorkflowArgsOf,
  WorkflowReturnOf,
  WorkflowPermission,
} from "../src/index.ts";
import { useWorkflow } from "../src/react.ts";
import type { archiveNotes } from "./notes/grasp.config.ts";
import { summarizeNote } from "./notes/grasp.config.ts";
import { workflows } from "./notes/server/_generated/api.ts";

/** The args a declaration takes, as a caller passes them. */
type DeclaredArgs<Declared> =
  Declared extends WorkflowPermission<string, infer Args> ? Args : never;

/** What a declaration's completed run returns. */
type DeclaredReturns<Declared> =
  Declared extends WorkflowPermission<string, unknown, infer Returns>
    ? Returns
    : never;

// The generated reference takes and gives what the App declared.
expectTypeOf<WorkflowArgsOf<typeof workflows.summarizeNote>>().toEqualTypeOf<
  DeclaredArgs<typeof summarizeNote>
>();
expectTypeOf<WorkflowReturnOf<typeof workflows.summarizeNote>>().toEqualTypeOf<
  DeclaredReturns<typeof summarizeNote>
>();
expectTypeOf<DeclaredReturns<typeof summarizeNote>>().toEqualTypeOf<{
  summary: string;
  words: number;
}>();
expectTypeOf<WorkflowReturnOf<typeof workflows.archiveNotes>>().toEqualTypeOf<
  DeclaredReturns<typeof archiveNotes>
>();
expectTypeOf<DeclaredReturns<typeof archiveNotes>>().toEqualTypeOf<null>();
expectTypeOf(workflows.summarizeNote.alias).toEqualTypeOf<"summarizeNote">();

// A declaration names what it returns as well as its args: neither is optional.
// @ts-expect-error -- no returns
permission.workflow("followUp", { args: v.object({}) });
// @ts-expect-error -- no args
permission.workflow("followUp", { returns: v.null() });
// @ts-expect-error -- returns is a value schema, not a descriptor or a type
permission.workflow("followUp", { args: v.object({}), returns: "null" });

// A page follows the generated reference, never the declaration itself.
export const UseDeclaration = (): null => {
  // @ts-expect-error -- a declaration isn't a reference: it pins no release
  useWorkflow(summarizeNote);
  return null;
};
