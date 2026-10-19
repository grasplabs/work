// Compile-time guarantees of a workflow declaration (`resource.workflow`,
// spec 7.4, 10.4.1) and the reference generated from it: the App declares
// the output a run gives beside the input it takes, both required; and the
// reference its screens get (`workflows.<alias>` in `#grasp`, generated
// from the Notes fixture's declarations) takes and gives exactly what the
// declaration does. Type-checked by `vp check`, never run: every
// `@ts-expect-error` must stay an error.
import { expectTypeOf } from "vite-plus/test";

import { resource, v } from "../src/index.ts";
import type {
  WorkflowInputOf,
  WorkflowOutputOf,
  WorkflowResource,
} from "../src/index.ts";
import { useWorkflow } from "../src/react.ts";
import { workflows } from "./notes/.grasp/references.ts";
import type { archiveNotes } from "./notes/app.ts";
import { summarizeNote } from "./notes/app.ts";

/** The input a declaration takes, as a caller passes it. */
type DeclaredInput<Declared> =
  Declared extends WorkflowResource<string, infer Input> ? Input : never;

/** The output a declaration's completed run gives. */
type DeclaredOutput<Declared> =
  Declared extends WorkflowResource<string, unknown, infer Output>
    ? Output
    : never;

// The generated reference takes and gives what the App declared.
expectTypeOf<WorkflowInputOf<typeof workflows.summarizeNote>>().toEqualTypeOf<
  DeclaredInput<typeof summarizeNote>
>();
expectTypeOf<WorkflowOutputOf<typeof workflows.summarizeNote>>().toEqualTypeOf<
  DeclaredOutput<typeof summarizeNote>
>();
expectTypeOf<DeclaredOutput<typeof summarizeNote>>().toEqualTypeOf<{
  summary: string;
  words: number;
}>();
expectTypeOf<WorkflowOutputOf<typeof workflows.archiveNotes>>().toEqualTypeOf<
  DeclaredOutput<typeof archiveNotes>
>();
expectTypeOf<DeclaredOutput<typeof archiveNotes>>().toEqualTypeOf<null>();
expectTypeOf(workflows.summarizeNote.alias).toEqualTypeOf<"summarizeNote">();

// A declaration names its output as well as its input: neither is optional.
// @ts-expect-error -- no output
resource.workflow("followUp", { input: v.object({}) });
// @ts-expect-error -- no input
resource.workflow("followUp", { output: v.null() });
// @ts-expect-error -- an output is a value schema, not a descriptor or a type
resource.workflow("followUp", { input: v.object({}), output: "null" });

// A screen follows the generated reference, never the declaration itself.
export const UseDeclaration = (): null => {
  // @ts-expect-error -- a declaration isn't a reference: it pins no release
  useWorkflow(summarizeNote);
  return null;
};
