/**
 * The Stephen Lab's runs, as the lab kept them in the repository
 * (scripts/lab/): every case of the open set's runs (`results/`), and of
 * the hidden set's only their means and how many cases (`scores/`). They
 * come into the admin with its build, so a change to Stephen and the runs
 * that measured it arrive together; nothing is written here, and no new
 * way into the admin is opened for them. A file that doesn't hold a run is
 * left out, as is a hidden run that somehow kept its cases.
 */
import { resultSchema, scoresSchema } from "@grasp-os/shared/lab-runs";
import type { Result, Scores } from "@grasp-os/shared/lab-runs";

const openFiles = import.meta.glob<unknown>(
  "../../../../scripts/lab/results/*.json",
  { eager: true, import: "default" }
);
const hiddenFiles = import.meta.glob<unknown>(
  "../../../../scripts/lab/scores/*.json",
  { eager: true, import: "default" }
);

/** The open set's runs, every case with its numbers. */
export const labResults: readonly Result[] = Object.values(openFiles).flatMap(
  (file) => {
    const parsed = resultSchema.safeParse(file);
    return parsed.success && parsed.data.set === "open" ? [parsed.data] : [];
  }
);

/** The hidden set's runs, as numbers only. */
export const labScores: readonly Scores[] = Object.values(hiddenFiles).flatMap(
  (file) => {
    const parsed = scoresSchema.safeParse(file);
    return parsed.success ? [parsed.data] : [];
  }
);
