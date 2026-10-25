import type { z } from "zod";

// The Brain's errors: plain `Error`s with a stable `code` (and `details`),
// own properties, so they read the same after crossing an RPC boundary.
// The Brain keeps no registry of codes: a host that tells expected errors
// from unexpected ones registers the Brain's families' messages
// (`messages`) with its own.

/** An `Error` with a stable code, as the Brain throws it. */
export type BrainCodedError<Code extends string = string> = Error & {
  code: Code;
  details?: Record<string, unknown>;
};

/**
 * What's wrong with some input, for an error's `details.issues`: each
 * issue as `path: message`, naming the field, never repeating its value.
 */
export const issuesOf = (error: z.ZodError): string[] =>
  error.issues.map(({ path, message }) => {
    const where = path.map(String).join(".");
    return where === "" ? message : `${where}: ${message}`;
  });

/**
 * One family of the Brain's errors: a fixed set of codes, each with the
 * message people see. Creates them, parses input or fails with one, and
 * reads a code back from anything caught.
 */
export const errorFamily = <Code extends string>(
  messages: Readonly<Record<Code, string>>
) => {
  const codes = new Set<unknown>(Object.keys(messages));
  const isCode = (value: unknown): value is Code => codes.has(value);
  const create = (
    code: Code,
    details?: Record<string, unknown>
  ): BrainCodedError<Code> =>
    Object.assign(
      new Error(messages[code]),
      details === undefined ? { code } : { code, details }
    );
  return {
    messages,
    create,
    /** `input` as `schema` has it, or error `code` saying why not. */
    parse: <Schema extends z.ZodType>(
      code: Code,
      schema: Schema,
      input: unknown
    ): z.output<Schema> => {
      const parsed = schema.safeParse(input);
      if (!parsed.success) {
        throw create(code, { issues: issuesOf(parsed.error) });
      }
      return parsed.data;
    },
    /** The error's code if it belongs to this family, otherwise undefined. */
    codeOf: (error: unknown): Code | undefined => {
      if (typeof error !== "object" || error === null || !("code" in error)) {
        return undefined;
      }
      return isCode(error.code) ? error.code : undefined;
    },
  };
};
