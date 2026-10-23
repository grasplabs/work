/**
 * Fixed input for the benches: interviews kept as they were said
 * (`vp run lab keep`), and moments, the first part of a conversation cut
 * where the next line matters. A bench gives Stephen the same input every
 * time, so two runs differ only by the Stephen they ran. Interviews a model
 * played, and the moments cut from them or written by a model, are kept in
 * git (`scripts/lab/fixtures/`); those people played stay out of it
 * (`scripts/lab/out/fixtures/`); everything of the hidden set is kept in
 * its own folder, outside the repository (keys/index.ts). Ported from the
 * prototype (grasplabs/prototype, packages/grasp: lab/fixtures.ts).
 */
import { rmSync } from "node:fs";
import path from "node:path";

import { factTags, interviewPhases } from "@grasp-os/shared/interview-links";
import { labWhoSchema } from "@grasp-os/shared/lab";
import { interviewLocaleSchema } from "@grasp-os/shared/onboarding";
import { z } from "zod";

import { allKept, keepJson, openFolder, setFolder } from "./kept.ts";
import type { CaseSet } from "./kept.ts";
import { handMoments, signals } from "./moments.ts";
import type { Moment } from "./moments.ts";

const saidSchema = z.object({
  from: z.enum(["stephen", "person"]),
  text: z.string(),
});

/** An interview kept as fixed input for the benches. */
export const transcriptSchema = z.object({
  id: z.string(),
  key: z.string(),
  employee: z.string(),
  locale: interviewLocaleSchema,
  by: z.enum(["model", "person"]),
  /** Who Stephen talked with, as his turns knew it: what a turn played back is told. None on an interview kept before it was kept. */
  who: labWhoSchema.nullable().default(null),
  lines: z.array(saidSchema),
  /** How many lines there were when the read-back began; none when that is not known. */
  readbackFrom: z.int().nullable(),
  /** The facts of their slice the person said, by id: judged once, when the transcript was kept. */
  said: z.array(z.string()),
  /** The notes Stephen had at the end, in the order he made them. */
  notes: z.array(
    z.object({ id: z.string(), tag: z.enum(factTags), text: z.string() })
  ),
  /** For each line of the person: how many notes he had before it, and the part he was in. None when a person played on the page. */
  notesAt: z.array(z.int()).nullable(),
  phaseAt: z.array(z.enum(interviewPhases)).nullable(),
  /** The mark of the text that held this interview. */
  stephen: z.string(),
});
export type Transcript = z.output<typeof transcriptSchema>;

/** A moment, as it is kept. */
export const momentSchema = z.object({
  id: z.string(),
  signal: z.literal(signals),
  locale: interviewLocaleSchema,
  who: labWhoSchema,
  lines: z.array(saidSchema),
  facts: z.array(
    z.object({ id: z.string(), tag: z.enum(factTags), text: z.string() })
  ),
  phase: z.enum(interviewPhases),
  minutes: z.number(),
  spoken: z.boolean().optional(),
  also: z.array(z.literal(signals)).optional(),
}) satisfies z.ZodType<Moment>;

/** Where fixtures of a kind are kept: in git for the open set, in the hidden set's own folder for the hidden one. */
const folderFor = (kind: "transcripts" | "moments", set: CaseSet): string =>
  path.join(setFolder("fixtures", set), kind);

/** Where interviews people played are kept: never in git. */
const playedByPeople = path.join(openFolder("out"), "fixtures", "transcripts");

/** Every interview kept of a set, oldest name first: for the open set, those people played too. */
export const transcriptsOf = (set: CaseSet): Transcript[] => [
  ...allKept(folderFor("transcripts", set), transcriptSchema),
  ...(set === "open" ? allKept(playedByPeople, transcriptSchema) : []),
];

/** The moments of a set a model cut or wrote. */
export const keptMoments = (set: CaseSet): Moment[] =>
  allKept(folderFor("moments", set), momentSchema);

/** Every moment of a set: for the open set the ones written by hand, then the ones kept; for the hidden set only the kept ones. */
export const momentsOf = (set: CaseSet): Moment[] => [
  ...(set === "open" ? handMoments : []),
  ...keptMoments(set),
];

/** Keeps a moment a model cut or wrote, and says where. */
export const keepMoment = (moment: Moment, set: CaseSet): string =>
  keepJson(path.join(folderFor("moments", set), `${moment.id}.json`), moment);

/** Takes a moment a model cut out again: one that turned out not plain. */
export const dropMoment = (id: string, set: CaseSet): void => {
  rmSync(path.join(folderFor("moments", set), `${id}.json`), { force: true });
};

/** Whether `id` is named by `only`: the start of an id, or a kind of moment. */
export const named = (
  only: readonly string[] | null,
  ...names: string[]
): boolean =>
  only === null ||
  only.some((each) =>
    names.some((name) => name === each || name.startsWith(each))
  );
