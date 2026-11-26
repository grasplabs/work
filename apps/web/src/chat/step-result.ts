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

/** The fields of a run's result; an object with any other is no run's. */
const runFields = new Set([
  "readFrom",
  "logs",
  "returned",
  "status",
  "error",
  "cut",
]);

/** How core ends a text it cut (core's `cutMarker`). */
const cutMarker = /\n… \(cut: over \d+ bytes of output\)$/u;

/** How core names a connection a run read from: `connection <id>`, then its actions. */
const connectionName = /^connection (?<id>\S+)/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((each): each is string => typeof each === "string")
    : [];

/** `text` as a run's result, if it is one. */
const runOf = (text: string): Record<string, unknown> | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return isRecord(parsed) &&
    Object.keys(parsed).length > 0 &&
    Object.keys(parsed).every((key) => runFields.has(key))
    ? parsed
    : undefined;
};

/** What the step whose result core gave as `text` gave back. */
export const stepResultOf = (text: string): StepResult => {
  const run = runOf(text);
  if (run === undefined) {
    const cut = cutMarker.test(text);
    return { kind: "text", text: text.replace(cutMarker, ""), cut };
  }
  const readFrom = strings(run.readFrom).flatMap(
    (name) => connectionName.exec(name)?.groups?.id ?? []
  );
  return {
    kind: "run",
    readFrom: [...new Set(readFrom)],
    logs: strings(run.logs),
    returned: "returned" in run ? { value: run.returned } : undefined,
    error: typeof run.error === "string" ? run.error : undefined,
    cut: run.cut === true,
  };
};
