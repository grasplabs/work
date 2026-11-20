import { z } from "zod";

import { hashOf } from "./files.ts";

// Which prompts and models drew a memory from its source (extraction.ts):
// the read call that proposed it and the check call that supported it,
// each by its prompt's version and the model the host says answered. Kept
// once per distinct four (`extractors`), which a memory points at; no read
// of memories returns it, only an export, for evaluating extraction: so a
// change of prompt or model can be measured against what an earlier one
// drew, and its memories found. Nothing in it is content or names a person.

/** A model call of extraction, as a memory records it. */
export const extractionCallSchema = z.strictObject({
  /** The SHA-256 of the call's instructions, as hex (`promptVersionOf`). */
  prompt: z.string().min(1),
  /** The model that answered, as the host names it. */
  model: z.string().min(1),
});
export type ExtractionCall = z.infer<typeof extractionCallSchema>;

/** The calls that drew a memory: the read call that proposed it, and the check call that supported it. */
export const extractorSchema = z.strictObject({
  read: extractionCallSchema,
  check: extractionCallSchema,
});
export type Extractor = z.infer<typeof extractorSchema>;

const encoder = new TextEncoder();

/**
 * The version of a prompt: the SHA-256 of its text, so any change to the
 * text is a new version, and no version is kept by hand beside it.
 */
export const promptVersionOf = async (instructions: string): Promise<string> =>
  await hashOf(encoder.encode(instructions));

/** The row of `extractor`, made the first time a memory names it. Run it in the add's transaction. */
export const extractorRowOf = (
  sql: SqlStorage,
  { read, check }: Extractor
): number =>
  sql
    .exec<{ row: number }>(
      `INSERT INTO extractors (read_prompt, read_model, check_prompt, check_model)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (read_prompt, read_model, check_prompt, check_model)
        DO UPDATE SET read_prompt = excluded.read_prompt
      RETURNING row`,
      read.prompt,
      read.model,
      check.prompt,
      check.model
    )
    .one().row;

/** An extractor's columns as a statement reads them, joined to a memory's (`extractorOfColumns`). */
export interface ExtractorColumns {
  read_prompt: SqlStorageValue;
  read_model: SqlStorageValue;
  check_prompt: SqlStorageValue;
  check_model: SqlStorageValue;
}

/** The extractor a memory's joined columns hold; null for a memory extraction didn't draw. */
export const extractorOfColumns = (
  columns: ExtractorColumns
): Extractor | null =>
  columns.read_prompt === null
    ? null
    : extractorSchema.parse({
        read: { prompt: columns.read_prompt, model: columns.read_model },
        check: { prompt: columns.check_prompt, model: columns.check_model },
      });
