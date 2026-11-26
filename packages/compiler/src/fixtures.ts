import type {
  Exchange,
  FixtureCase,
  Fixtures,
} from "@grasp-os/runtime/connector";
import type { Json } from "@grasp-os/shared/json";
import { z } from "zod";

// What a connector's recorded vendor answers hold it to (GRA-2328): each
// case of its fixtures (@grasp-os/runtime/connector's fixtures.ts) is
// replayed, the vendor answering only as recorded, and the connector is
// refused when:
//
// - its output doesn't match its recordings: a call answers other than
//   it was recorded answering, or fails where it answered, as when
//   `returns` doesn't take what the vendor answered, or a tool sends a
//   request that wasn't recorded, sends one again, or leaves one out;
// - its paging never ends: past the vendor's last page it still answers a
//   `next`, or a `next` comes back;
// - its errors map to the wrong kind: an error case doesn't fail with the
//   kind it is recorded with.
//
// How a call is replayed is the caller's: connect's build runs the
// connector's bundle in workerd with the recordings as its only network.

/** One call of a tool, replayed. */
export interface Replayed {
  /** The connector's JSON-RPC answer to `tools/call`. */
  answer: unknown;
  /** The requests it sent that no recording matched. */
  unrecorded: readonly string[];
  /** The requests it sent again, past each recording of them. */
  repeated: readonly string[];
  /** The recorded requests it didn't send. */
  unsent: readonly string[];
}

/** Calls `tool` with `args`, its vendor answering only as `exchanges` say. */
export type ReplayCall = (
  tool: string,
  args: Readonly<Record<string, Json>>,
  exchanges: readonly Exchange[]
) => Promise<Replayed>;

const answerSchema = z.union([
  z.object({
    result: z.object({
      isError: z.boolean().optional(),
      structuredContent: z.record(z.string(), z.unknown()).optional(),
      content: z.array(z.looseObject({ text: z.string().optional() })),
    }),
  }),
  z.object({ error: z.object({ message: z.string() }) }),
]);

type Outcome =
  | { ok: true; output: Record<string, unknown> }
  | { ok: false; code: string | undefined; message: string };

const errorSchema = z.object({
  error: z.object({ code: z.string().optional() }),
});

const outcomeOf = (answer: unknown): Outcome => {
  const parsed = answerSchema.safeParse(answer);
  if (!parsed.success) {
    return { ok: false, code: undefined, message: "it answered no MCP result" };
  }
  if ("error" in parsed.data) {
    return { ok: false, code: undefined, message: parsed.data.error.message };
  }
  const { isError, structuredContent, content } = parsed.data.result;
  if (isError !== true) {
    return { ok: true, output: structuredContent ?? {} };
  }
  return {
    ok: false,
    code: errorSchema.safeParse(structuredContent).data?.error.code,
    message: content.map(({ text }) => text ?? "").join(" "),
  };
};

/** `value` as JSON, its objects' keys in order, so equal values compare equal. */
const canonical = (value: unknown): string | undefined =>
  JSON.stringify(value, (_key, each: unknown) =>
    typeof each === "object" && each !== null && !Array.isArray(each)
      ? Object.fromEntries(
          Object.entries(each).toSorted(([a], [b]) => (a < b ? -1 : 1))
        )
      : each
  );

/** What a call of the case at `index` is called in a problem. */
const labelOf = (fixture: FixtureCase, index: number): string =>
  `${fixture.tool} (case ${index + 1})`;

/** The problems of a request the replay found, from a call's `replayed`. */
const requestProblems = (label: string, replayed: Replayed): string[] => [
  ...replayed.unrecorded.map(
    (request) =>
      `${label}: output doesn't match its recordings: it sent ${request}, which isn't recorded`
  ),
  ...replayed.repeated.map(
    (request) =>
      `${label}: output doesn't match its recordings: it sent ${request} again`
  ),
  ...replayed.unsent.map(
    (request) =>
      `${label}: output doesn't match its recordings: it didn't send the recorded ${request}`
  ),
];

/**
 * What is wrong with the `next` the call at `index` of a paged case
 * answered, of `calls` recorded, its earlier ones' in `cursors`.
 */
const pagingProblem = (
  next: unknown,
  last: boolean,
  cursors: ReadonlySet<unknown>,
  index: number,
  calls: number
): string | undefined => {
  if (next !== null && typeof next !== "string") {
    return "it pages, and answers no next";
  }
  if (last && next !== null) {
    return `paging never ends: after the vendor's last recorded page it answers next "${next}"`;
  }
  if (cursors.has(next)) {
    return `paging never ends: its next "${next}" comes back`;
  }
  if (!last && next === null) {
    return `output doesn't match its recordings: its paging ends at page ${index + 1} of the ${calls} recorded`;
  }
  return undefined;
};

/**
 * How the call at `index` of a case ends it: the problems it found, or
 * the `next` to call the following page with.
 */
const endOf = (
  fixture: FixtureCase,
  label: string,
  outcome: Outcome,
  index: number,
  cursors: ReadonlySet<unknown>
): { problems: string[] } | { next: string } => {
  const { cursor, error, calls } = fixture;
  const last = index === calls.length - 1;
  const recorded = calls[index];
  if (error !== undefined && last) {
    const failedAs = outcome.ok
      ? "succeeded"
      : `failed as ${outcome.code ?? "an error of no kind"}`;
    return {
      problems:
        !outcome.ok && outcome.code === error
          ? []
          : [
              `${label}: errors map to the wrong kind: the vendor's ${recorded?.exchanges.at(-1)?.answer.status} is recorded as ${error}, and the call ${failedAs}`,
            ],
    };
  }
  if (!outcome.ok) {
    return {
      problems: [
        `${label}: output doesn't match its recordings: ${outcome.message}`,
      ],
    };
  }
  const answered = canonical(outcome.output);
  const matches = answered === canonical(recorded?.output);
  const mismatch = {
    problems: [
      `${label}: output doesn't match its recordings: it answered ${answered} on call ${index + 1}`,
    ],
  };
  if (cursor === undefined) {
    return matches ? { problems: [] } : mismatch;
  }
  // Paging first, so a list that pages wrongly is refused for that.
  const { next } = outcome.output;
  const paging = pagingProblem(next, last, cursors, index, calls.length);
  if (paging !== undefined) {
    return { problems: [`${label}: ${paging}`] };
  }
  if (!matches) {
    return mismatch;
  }
  return typeof next === "string" ? { next } : { problems: [] };
};

/** The problems replaying one case finds. */
const checkCase = async (
  fixture: FixtureCase,
  label: string,
  call: ReplayCall
): Promise<string[]> => {
  const { tool, cursor, calls } = fixture;
  if (calls.length === 0) {
    return [`${label}: nothing is recorded for it`];
  }
  if (cursor === undefined && calls.length > 1) {
    return [
      `${label}: ${calls.length} calls are recorded, and it names no cursor to page with`,
    ];
  }
  // Recorded on one page, a list that drops its cursor would pass.
  if (
    cursor !== undefined &&
    fixture.error === undefined &&
    calls.length === 1
  ) {
    return [
      `${label}: only one page is recorded: record it with arguments that list more than a page`,
    ];
  }
  const problems: string[] = [];
  let { args } = fixture;
  const cursors = new Set<unknown>(
    cursor === undefined ? [] : [fixture.args[cursor]]
  );
  for (const [index, { exchanges }] of calls.entries()) {
    // oxlint-disable-next-line no-await-in-loop -- each page needs the one before
    const replayed = await call(tool, args, exchanges);
    problems.push(...requestProblems(label, replayed));
    const ended = endOf(
      fixture,
      label,
      outcomeOf(replayed.answer),
      index,
      cursors
    );
    if ("problems" in ended || cursor === undefined) {
      return "problems" in ended ? [...problems, ...ended.problems] : problems;
    }
    cursors.add(ended.next);
    args = { ...fixture.args, [cursor]: ended.next };
  }
  return problems;
};

/**
 * The problems replaying each case of `fixtures` through `call` finds,
 * one line each, naming the tool and the case; none if every case
 * replays as recorded.
 */
export const checkFixtures = async (
  fixtures: Fixtures,
  call: ReplayCall
): Promise<string[]> => {
  const problems: string[] = [];
  for (const [index, fixture] of fixtures.cases.entries()) {
    // oxlint-disable-next-line no-await-in-loop -- one case at a time, as the vendor is replaced for each
    problems.push(...(await checkCase(fixture, labelOf(fixture, index), call)));
  }
  return problems;
};
