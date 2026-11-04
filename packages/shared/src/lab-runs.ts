/**
 * What a run of the Stephen Lab kept (scripts/lab/), as the lab writes it
 * and the admin's Stephen Lab reads it: one JSON file a run, committed with
 * the change it measured. Of the open set every case is kept with its
 * numbers (`scripts/lab/results/`); of the hidden set only its means and
 * how many cases it had (`scripts/lab/scores/`): no case, not even its id,
 * leaves the hidden set's own folder outside the repository.
 */
import { z } from "zod";

import { caseScoreSchema, meansOf } from "./lab-compare.ts";
import { labViaSchema } from "./lab.ts";
import { interviewerSchema } from "./onboarding.ts";

/** What was run: whole interviews, the notes of a fixed conversation, the next line at a fixed moment, or the drawing of fixed interviews. */
export const benches = ["whole", "notes", "ask", "draw"] as const;
export type Bench = (typeof benches)[number];

/** Which Stephen a result is of. */
export const stephenVersionSchema = z.object({
  interviewer: interviewerSchema,
  /** The mark of the text of someone's own interview, and of a lead's, in the run's language. */
  own: z.string(),
  lead: z.string(),
  /** The mark of how he talks and writes down, in every language: his text and the code around it. */
  talks: z.string(),
  /** The mark of how a piece of work is drawn. */
  draws: z.string(),
  /**
   * One name for every text of the release (`stephenVersion` in core's
   * onboarding/lab-marks.ts): what real interviews say they were held by,
   * so the admin sets them beside this run. Missing from runs kept before.
   */
  version: z.string().optional(),
  /** The commit the code was at, when git can say. */
  commit: z.string(),
});
export type StephenVersion = z.output<typeof stephenVersionSchema>;

/** Everything a run says but its cases. */
const runSchema = z.object({
  id: z.string(),
  at: z.string(),
  label: z.string(),
  bench: z.enum(benches),
  /** The open set, or the hidden one, of which only scores are kept. */
  set: z.enum(["open", "hidden"]),
  /** Whole interviews only: the key and the practice company they were played on. */
  key: z.string().optional(),
  practice: z.string().optional(),
  stephen: stephenVersionSchema,
  /** How the models were reached: always the local core's gateway, and from there the API or the lab's bridge to a subscription (`through`). */
  via: labViaSchema,
  /** Whole interviews only: "real" when the people had one temper each (people v1), "v2" when they had a mix and a state that drifts, with the seed that says who had which; "ideal" when they told all they knew. */
  people: z.enum(["real", "v2", "ideal", "person"]).optional(),
  seed: z.int().optional(),
  spent: z.string(),
});

/** A run as the lab keeps it, every case with its numbers. */
export const resultSchema = runSchema.extend({
  cases: z.array(caseScoreSchema),
  /** The folder in `out/runs/` with what this run wrote, case by case: the open set only. */
  details: z.string().optional(),
});
export type Result = z.output<typeof resultSchema>;

/** A hidden run as it may be read outside the hidden set: its means, and how many cases they are over. */
export const scoresSchema = runSchema.extend({
  set: z.literal("hidden"),
  means: z.record(z.string(), z.number()),
  cases: z.int().min(0),
});
export type Scores = z.output<typeof scoresSchema>;

/** What of a hidden run may leave its folder: never a case, nor its id, nor where it is kept. */
export const scoresOf = (result: Result): Scores => ({
  id: result.id,
  at: result.at,
  label: result.label,
  bench: result.bench,
  set: "hidden",
  stephen: result.stephen,
  via: result.via,
  ...(result.people === undefined ? {} : { people: result.people }),
  ...(result.seed === undefined ? {} : { seed: result.seed }),
  spent: result.spent,
  means: meansOf(result.cases),
  cases: result.cases.length,
});

/** The mark of the Stephen a result measured, as far as its bench goes: how he talks, or how work is drawn. */
export const markOf = (result: Pick<Result, "bench" | "stephen">): string =>
  result.bench === "draw" ? result.stephen.draws : result.stephen.talks;
