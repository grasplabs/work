import { v } from "../src/index.ts";
import type { Infer, InferInput, WorkflowReference } from "../src/index.ts";
import type { AnySchema } from "../src/value-schema.ts";
import { descriptorOf } from "../src/value-schema.ts";

// Workflow references as the generator writes them into `#grasp`: the
// App's release, the binding's alias, its contract ID and fingerprint, and
// the descriptors of its input and output, with their types in phantom
// members. The Notes fixture binds one workflow, `summarizeNote`, which
// takes a note's ID and gives its summary.

/** The release the Notes fixture's references belong to. */
export const notesRelease = { resourceId: "app_notes", resourceVersion: 3 };

/**
 * A reference to the workflow bound under `alias`, taking `input` and
 * giving `output`; `fingerprint` pins its contract.
 */
export const workflowReference = <
  const Alias extends string,
  Input extends AnySchema,
  Output extends AnySchema,
>(
  alias: Alias,
  contract: {
    readonly input: Input;
    readonly output: Output;
    readonly fingerprint: string;
  }
): WorkflowReference<Alias, InferInput<Input>, Infer<Output>> =>
  Object.freeze({
    kind: "workflow",
    visibility: "public",
    ...notesRelease,
    alias,
    contractId: `workflows.${alias}`,
    fingerprint: contract.fingerprint,
    input: descriptorOf(contract.input),
    output: descriptorOf(contract.output),
  });

export const workflows = {
  summarizeNote: workflowReference("summarizeNote", {
    input: v.object({
      noteId: v.id("notes"),
      style: v.enum(["short", "long"]).default("short"),
    }),
    output: v.object({ summary: v.string(), words: v.number().integer() }),
    fingerprint: "5".repeat(64),
  }),
  archiveNotes: workflowReference("archiveNotes", {
    input: v.object({}),
    output: v.null(),
    fingerprint: "a".repeat(64),
  }),
};
