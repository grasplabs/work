import { z } from "zod";

// What a step of an answer gave back, as the person reads it. Core hands
// the model a code step's result, and a tool's that read from outside, as
// one JSON object (core's `describeRun`): the outside systems it read from
// (`readFrom`), what it logged (`logs`), what it returned (`returned`) or
// how it ended and why (`status`, `error`), and whether part was left out
// to fit (`cut`). Any other tool's result is its text, cut with a marker
// when it ran long (core's `describeText`). The thread draws each part as
// itself, never the JSON or its field names.

/** What a step gave back, read. */
export type StepResult =
  | { kind: "text"; text: string; cut: boolean }
  | {
      kind: "run";
      /** The connections it read from, by ID, each once. */
      readFrom: string[];
      logs: string[];
      /** What it returned, when it returned anything. */
      returned: { value: unknown } | undefined;
      /** Why it didn't complete, when it didn't. */
      error: string | undefined;
      cut: boolean;
    };

/**
 * A run's result as core writes it (core's `RunResult`): only these
 * fields, each of its own kind, `status` and `error` together; `{}` for a
 * run that returned, logged and read nothing.
 */
const runSchema = z
  .strictObject({
    readFrom: z.array(z.string()).optional(),
    logs: z.array(z.string()).optional(),
    returned: z.unknown().optional(),
    status: z.string().optional(),
    error: z.string().optional(),
    cut: z.literal(true).optional(),
  })
  .refine(
    ({ status, error }) => (status === undefined) === (error === undefined)
  );

/** How core ends a text it cut (core's `cutMarker`). */
const cutMarker = /\n… \(cut: over \d+ bytes of output\)$/u;

/** How core names a connection a run read from: `connection <id>`, then its actions. */
const connectionName = /^connection (?<id>\S+)/u;

/** `text` as a run's result, if it is one, and whether it returned anything. */
const runOf = (
  text: string
): { run: z.infer<typeof runSchema>; returns: boolean } | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const run = runSchema.safeParse(parsed);
  return run.success
    ? {
        run: run.data,
        returns:
          typeof parsed === "object" && parsed !== null && "returned" in parsed,
      }
    : undefined;
};

/**
 * What the step whose result core gave as `text` gave back; `from` a code
 * step, or a tool. A code step's result is always a run's. A tool's is a
 * run's only where it returned something other than words, read from
 * outside, or failed (core's `runTool`), so it says what it returned or
 * why it failed: words it returned (a file's, which may hold `{}` or
 * look like a run's in any other way) stay words.
 */
export const stepResultOf = (
  text: string,
  from: "code" | "tool"
): StepResult => {
  const parsed = runOf(text);
  const read =
    from === "tool" &&
    parsed !== undefined &&
    !parsed.returns &&
    parsed.run.error === undefined
      ? undefined
      : parsed;
  if (read === undefined) {
    const cut = cutMarker.test(text);
    return { kind: "text", text: text.replace(cutMarker, ""), cut };
  }
  const { run, returns } = read;
  const readFrom = (run.readFrom ?? []).flatMap(
    (name) => connectionName.exec(name)?.groups?.id ?? []
  );
  return {
    kind: "run",
    readFrom: [...new Set(readFrom)],
    logs: run.logs ?? [],
    returned: returns ? { value: run.returned } : undefined,
    error: run.error,
    cut: run.cut === true,
  };
};
